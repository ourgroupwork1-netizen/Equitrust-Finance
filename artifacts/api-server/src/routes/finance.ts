import { and, desc, eq, gte } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateLoanApplicationBody,
  CreateLoanApplicationResponse,
  CreateTransactionBody,
  CreateTransactionResponse,
  GetFinanceDashboardResponse,
  GetTransactionParams,
  GetTransactionResponse,
  ListLoanApplicationsResponse,
  ListTransactionsResponse,
  RunFraudScanResponse,
} from "@workspace/api-zod";
import {
  accountsTable,
  auditEventsTable,
  db,
  loanApplicationsTable,
  transactionsTable,
} from "@workspace/db";
import { runFraudDetection } from "../lib/fraudDetection";
import {
  memberIdFromRequest,
  requireMember,
} from "../middlewares/memberAuth";

const router: IRouter = Router();
const MAX_TRANSACTION_CENTS = 5_000_000;

router.use(requireMember);

router.get("/finance/dashboard", async (req, res): Promise<void> => {
  const member = req.equitrustMember!;
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.memberId, member.id))
    .limit(1);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentDeposits = await db
    .select({ amountCents: transactionsTable.amountCents })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.memberId, member.id),
        eq(transactionsTable.type, "deposit"),
        gte(transactionsTable.createdAt, since),
      ),
    );
  const monthlyInflowCents = recentDeposits.reduce(
    (total, row) => total + row.amountCents,
    0,
  );
  const score =
    50 +
    Math.min(recentDeposits.length * 4, 20) +
    (account.balanceCents >= 100_000 ? 15 : 0) +
    (monthlyInflowCents >= 50_000 ? 15 : 0);

  const dashboard = {
    memberId: member.id,
    displayName: member.displayName,
    email: member.email,
    role: member.role,
    balanceCents: account.balanceCents,
    creditLimitCents: account.creditLimitCents,
    creditUsedCents: account.creditUsedCents,
    availableCreditCents: Math.max(
      0,
      account.creditLimitCents - account.creditUsedCents,
    ),
    cooperativeScore: Math.min(score, 100),
    monthlyInflowCents,
    isSimulated: true,
  };
  res.json(GetFinanceDashboardResponse.parse(dashboard));
});

router.get("/finance/transactions", async (req, res): Promise<void> => {
  const transactions = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.memberId, memberIdFromRequest(req)))
    .orderBy(desc(transactionsTable.createdAt))
    .limit(200);
  res.json(
    ListTransactionsResponse.parse(transactions.map((item) => ({
      id: item.id,
      type: item.type,
      amountCents: item.amountCents,
      balanceAfterCents: item.balanceAfterCents,
      description: item.description,
      status: item.status,
      reference: item.reference,
      createdAt: item.createdAt,
    }))),
  );
});

router.get(
  "/finance/transactions/:transactionId",
  async (req, res): Promise<void> => {
    const params = GetTransactionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [transaction] = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.id, params.data.transactionId),
          eq(transactionsTable.memberId, memberIdFromRequest(req)),
        ),
      )
      .limit(1);
    if (!transaction) {
      res.status(404).json({ error: "Transaction not found." });
      return;
    }
    res.json(
      GetTransactionResponse.parse({
        id: transaction.id,
        type: transaction.type,
        amountCents: transaction.amountCents,
        balanceAfterCents: transaction.balanceAfterCents,
        description: transaction.description,
        status: transaction.status,
        reference: transaction.reference,
        createdAt: transaction.createdAt,
      }),
    );
  },
);

router.post("/finance/transactions", async (req, res): Promise<void> => {
  const parsed = CreateTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const memberId = memberIdFromRequest(req);
  const { amountCents, type } = parsed.data;
  if (!Number.isSafeInteger(amountCents) || amountCents > MAX_TRANSACTION_CENTS) {
    res.status(400).json({ error: "Transaction amount is outside the allowed range." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.memberId, memberId))
      .for("update")
      .limit(1);
    if (!account) {
      return { ok: false as const, error: "Account not found.", status: 404 as const };
    }

    let balanceCents = account.balanceCents;
    let creditUsedCents = account.creditUsedCents;
    if (type === "deposit") {
      balanceCents += amountCents;
    } else if (type === "withdrawal") {
      if (amountCents > balanceCents) {
        return { ok: false as const, error: "There are not enough available funds for this withdrawal.", status: 400 as const };
      }
      balanceCents -= amountCents;
    } else if (type === "credit") {
      if (creditUsedCents + amountCents > account.creditLimitCents) {
        return { ok: false as const, error: "This amount exceeds your available cooperative credit.", status: 400 as const };
      }
      balanceCents += amountCents;
      creditUsedCents += amountCents;
    } else if (type === "credit_repayment") {
      if (amountCents > creditUsedCents || amountCents > balanceCents) {
        return { ok: false as const, error: "The repayment cannot exceed your credit balance or available funds.", status: 400 as const };
      }
      balanceCents -= amountCents;
      creditUsedCents -= amountCents;
    }

    await tx
      .update(accountsTable)
      .set({ balanceCents, creditUsedCents, updatedAt: new Date() })
      .where(eq(accountsTable.id, account.id));

    const [created] = await tx
      .insert(transactionsTable)
      .values({
        accountId: account.id,
        memberId,
        type,
        amountCents,
        balanceAfterCents: balanceCents,
        creditUsedAfterCents: creditUsedCents,
        description: parsed.data.description.trim(),
        status: amountCents >= 1_000_000 ? "flagged" : "posted",
        reference: `EQF-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
      })
      .returning();

    return { ok: true as const, transaction: created };
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  req.log.info(
    { transactionId: result.transaction.id, type, amountCents },
    "Simulated finance transaction recorded",
  );
  res.status(201).json(
    CreateTransactionResponse.parse({
      id: result.transaction.id,
      type: result.transaction.type,
      amountCents: result.transaction.amountCents,
      balanceAfterCents: result.transaction.balanceAfterCents,
      description: result.transaction.description,
      status: result.transaction.status,
      reference: result.transaction.reference,
      createdAt: result.transaction.createdAt,
    }),
  );
});

router.get("/finance/loans", async (req, res): Promise<void> => {
  const applications = await db
    .select()
    .from(loanApplicationsTable)
    .where(eq(loanApplicationsTable.memberId, memberIdFromRequest(req)))
    .orderBy(desc(loanApplicationsTable.createdAt));
  res.json(
    ListLoanApplicationsResponse.parse(
      applications.map((application) => ({
        id: application.id,
        amountCents: application.amountCents,
        purpose: application.purpose,
        termMonths: application.termMonths,
        status: application.status,
        createdAt: application.createdAt,
      })),
    ),
  );
});

router.post("/finance/loans", async (req, res): Promise<void> => {
  const parsed = CreateLoanApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const memberId = memberIdFromRequest(req);
  const [pending] = await db
    .select({ id: loanApplicationsTable.id })
    .from(loanApplicationsTable)
    .where(
      and(
        eq(loanApplicationsTable.memberId, memberId),
        eq(loanApplicationsTable.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) {
    res.status(400).json({
      error: "You already have a loan application awaiting review.",
    });
    return;
  }

  const [application] = await db
    .insert(loanApplicationsTable)
    .values({ ...parsed.data, memberId, purpose: parsed.data.purpose.trim() })
    .returning();
  res.status(201).json(
    CreateLoanApplicationResponse.parse({
      id: application.id,
      amountCents: application.amountCents,
      purpose: application.purpose,
      termMonths: application.termMonths,
      status: application.status,
      createdAt: application.createdAt,
    }),
  );
});

router.post("/finance/fraud-scan", async (req, res): Promise<void> => {
  const results = await runFraudDetection({
    memberId: memberIdFromRequest(req),
    initiatedByMemberId: memberIdFromRequest(req),
    useAi: false,
  });
  res.json(RunFraudScanResponse.parse(results));
});

export default router;