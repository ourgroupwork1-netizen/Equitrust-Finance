import { desc, eq, inArray } from "drizzle-orm";
import {
  accountsTable,
  db,
  fraudScansTable,
  membersTable,
  transactionsTable,
} from "@workspace/db";

const METHOD = "Transparent rules-based anomaly screening";
const DISCLAIMER =
  "Risk indicators are not proof of fraud. This scan does not block accounts or make lending decisions; an administrator must review any action.";

type DetectionInput = {
  memberId?: string;
  initiatedByMemberId: string;
};

export async function runFraudDetection({
  memberId,
  initiatedByMemberId,
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

  const result = {
    scannedAccounts: accountRows.length,
    scannedTransactions: transactionRows.length,
    findings,
    method: METHOD,
    disclaimer: DISCLAIMER,
    createdAt: new Date(),
  };

  await db.insert(fraudScansTable).values({
    initiatedByMemberId,
    scannedAccounts: result.scannedAccounts,
    scannedTransactions: result.scannedTransactions,
    findings,
    method: METHOD,
    disclaimer: DISCLAIMER,
  });

  return result;
}