import { desc, eq, inArray } from "drizzle-orm";
import {
  accountsTable,
  db,
  fraudScansTable,
  membersTable,
  transactionsTable,
} from "@workspace/db";
import {
  analyzeTransactionSignals,
  FraudAnalysisUnavailableError,
  MAX_AI_ACCOUNTS_PER_SCAN,
  OPENAI_FRAUD_MODEL,
  type AnonymizedAccountSignal,
} from "./openaiFraudAnalysis";

const DISCLAIMER =
  "AI scores are review-priority indicators, not fraud probabilities or proof. Up to 100 recently active accounts and 50 recent transactions per account are considered. Only transaction type, amount, approximate age, and prior review status are sent to OpenAI; names, emails, descriptions, account IDs, and transaction references are excluded. OpenAI API charges may apply. Findings never block accounts or decide loans; an administrator must review any action.";
const RULES_ONLY_DISCLAIMER =
  "This transparent rules-based screen is not AI and does not determine fraud. No transaction data was sent to an AI provider. Findings never block accounts or decide loans; an administrator must review any action.";

type DetectionInput = {
  memberId?: string;
  initiatedByMemberId: string;
  useAi: boolean;
};

export async function runFraudDetection({
  memberId,
  initiatedByMemberId,
  useAi,
}: DetectionInput) {
  let accountQuery = db
    .select({
      memberId: membersTable.id,
      displayName: membersTable.displayName,
      email: membersTable.email,
      accountId: accountsTable.id,
    })
    .from(accountsTable)
    .innerJoin(membersTable, eq(accountsTable.memberId, membersTable.id));
  const accountRows = memberId
    ? await accountQuery.where(eq(membersTable.id, memberId))
    : await accountQuery;

  const accountIds = accountRows.map((row) => row.accountId);
  const transactionRows = accountIds.length
    ? await db
        .select({
          id: transactionsTable.id,
          accountId: transactionsTable.accountId,
          type: transactionsTable.type,
          amountCents: transactionsTable.amountCents,
          balanceAfterCents: transactionsTable.balanceAfterCents,
          status: transactionsTable.status,
          createdAt: transactionsTable.createdAt,
        })
        .from(transactionsTable)
        .where(inArray(transactionsTable.accountId, accountIds))
        .orderBy(desc(transactionsTable.createdAt))
        .limit(memberId ? 80 : 2500)
    : [];

  const byAccount = new Map<string, typeof transactionRows>();
  for (const transaction of transactionRows) {
    const current = byAccount.get(transaction.accountId) ?? [];
    if (current.length < 50) current.push(transaction);
    byAccount.set(transaction.accountId, current);
  }

  const findings = accountRows
    .map((account) => {
      const transactions = byAccount.get(account.accountId) ?? [];
      const reasons: string[] = [];
      let score = 0;
      const now = Date.now();
      const recent10Minutes = transactions.filter(
        (transaction) =>
          now - transaction.createdAt.getTime() <= 10 * 60 * 1000,
      );
      const recentHour = transactions.filter(
        (transaction) => now - transaction.createdAt.getTime() <= 60 * 60 * 1000,
      );
      const outgoing = recentHour.filter((transaction) =>
        ["withdrawal", "credit_repayment"].includes(transaction.type),
      );
      const outgoingTotal = outgoing.reduce(
        (total, transaction) => total + transaction.amountCents,
        0,
      );
      const largest = transactions.reduce(
        (highest, transaction) =>
          Math.max(highest, transaction.amountCents),
        0,
      );
      const repeatedAmounts = new Map<number, number>();
      for (const transaction of recentHour) {
        repeatedAmounts.set(
          transaction.amountCents,
          (repeatedAmounts.get(transaction.amountCents) ?? 0) + 1,
        );
      }

      if (largest >= 1_000_000) {
        score += 55;
        reasons.push("A recent transaction is unusually large for this demo account.");
      } else if (largest >= 250_000) {
        score += 35;
        reasons.push("A recent transaction is above the large-amount review threshold.");
      }
      if (recent10Minutes.length >= 6) {
        score += 35;
        reasons.push(
          `${recent10Minutes.length} transactions occurred within a 10-minute window.`,
        );
      }
      if (outgoing.length >= 4 && outgoingTotal >= 200_000) {
        score += 30;
        reasons.push(
          "Several withdrawals or credit repayments moved funds in a short period.",
        );
      }
      if ([...repeatedAmounts.values()].some((count) => count >= 3)) {
        score += 20;
        reasons.push("The same transaction amount was repeated several times.");
      }
      if (transactions.some((transaction) => transaction.status === "flagged")) {
        score += 25;
        reasons.push("A transaction was already marked for manual review.");
      }

      score = Math.min(score, 100);
      const riskLevel: "low" | "review" | "high" =
        score >= 70 ? "high" : score >= 35 ? "review" : "low";
      return {
        memberId: account.memberId,
        displayName: account.displayName,
        email: account.email,
        riskLevel,
        score,
        reasons,
        transactionCount: transactions.length,
      };
    })
    .filter((finding) => finding.score >= 25);

  const accountById = new Map(
    accountRows.map((account) => [account.accountId, account]),
  );
  const selectedEntries = useAi
    ? [...byAccount.entries()]
        .sort(
          (a, b) =>
            b[1][0].createdAt.getTime() - a[1][0].createdAt.getTime(),
        )
        .slice(0, MAX_AI_ACCOUNTS_PER_SCAN)
    : [];
  const scanTime = Date.now();
  const aiAccounts: AnonymizedAccountSignal[] = selectedEntries.map(
    ([, transactions], accountRef) => ({
      accountRef,
      transactions: transactions.map((transaction) => ({
        type: transaction.type,
        amountCents: transaction.amountCents,
        minutesAgo: Math.max(
          0,
          Math.floor(
            (scanTime - transaction.createdAt.getTime()) / 60_000,
          ),
        ),
        previouslyFlagged: transaction.status === "flagged",
      })),
    }),
  );

  let aiFindings;
  try {
    aiFindings = useAi
      ? await analyzeTransactionSignals(aiAccounts)
      : [];
  } catch (error) {
    if (error instanceof FraudAnalysisUnavailableError) throw error;
    throw new FraudAnalysisUnavailableError(502);
  }

  const findingsByMemberId = new Map(
    findings.map((finding) => [finding.memberId, finding]),
  );
  for (const aiFinding of aiFindings) {
    const [accountId] = selectedEntries[aiFinding.accountRef] ?? [];
    const account = accountId ? accountById.get(accountId) : undefined;
    if (!account) throw new FraudAnalysisUnavailableError(502);

    const existing = findingsByMemberId.get(account.memberId);
    const riskLevel: "review" | "high" =
      Math.max(existing?.score ?? 0, aiFinding.score) >= 70
        ? "high"
        : "review";
    const aiReasons = aiFinding.reasons.map(
      (reason) => `AI review: ${reason}`,
    );

    if (existing) {
      existing.score = Math.max(existing.score, aiFinding.score);
      existing.riskLevel = riskLevel;
      existing.reasons = [...new Set([...existing.reasons, ...aiReasons])].slice(
        0,
        6,
      );
    } else {
      const finding = {
        memberId: account.memberId,
        displayName: account.displayName,
        email: account.email,
        riskLevel,
        score: aiFinding.score,
        reasons: aiReasons,
        transactionCount: byAccount.get(accountId)?.length ?? 0,
      };
      findings.push(finding);
      findingsByMemberId.set(account.memberId, finding);
    }
  }

  const method = !useAi
    ? "Transparent rules-based anomaly screening; no AI request was made."
    : aiAccounts.length
      ? `OpenAI ${OPENAI_FRAUD_MODEL} review plus transparent rules-based checks; AI reviewed up to ${MAX_AI_ACCOUNTS_PER_SCAN} most recently active accounts.`
      : "No recent transactions were available; no OpenAI request was made. Rules-based checks only.";
  const disclaimer = useAi ? DISCLAIMER : RULES_ONLY_DISCLAIMER;

  const result = {
    scannedAccounts: accountRows.length,
    scannedTransactions: transactionRows.length,
    findings,
    method,
    disclaimer,
    createdAt: new Date(),
  };

  await db.insert(fraudScansTable).values({
    initiatedByMemberId,
    scannedAccounts: result.scannedAccounts,
    scannedTransactions: result.scannedTransactions,
    findings,
    method,
    disclaimer,
  });

  return result;
}