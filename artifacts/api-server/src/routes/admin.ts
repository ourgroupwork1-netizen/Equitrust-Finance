import {
  count,
  desc,
  eq,
  gte,
  inArray,
  sql,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  DecideLoanApplicationBody,
  DecideLoanApplicationParams,
  DecideLoanApplicationResponse,
  GetAdminOverviewResponse,
  GrantAdministratorBody,
  GrantAdministratorResponse,
  ListAdminLoanApplicationsResponse,
  ListAdministratorsResponse,
  ListMembersResponse,
  RunAdminFraudScanResponse,
  UpdateMemberStatusBody,
  UpdateMemberStatusParams,
  UpdateMemberStatusResponse,
  UpdatePlatformSettingsBody,
  UpdatePlatformSettingsResponse,
} from "@workspace/api-zod";
import {
  accountsTable,
  administratorGrantsTable,
  auditEventsTable,
  db,
  loanApplicationsTable,
  membersTable,
  platformSettingsTable,
  transactionsTable,
} from "@workspace/db";
import { runFraudDetection } from "../lib/fraudDetection";
import {
  memberIdFromRequest,
  requireAdmin,
  requireMember,
  requireOwner,
} from "../middlewares/memberAuth";

const router: IRouter = Router();
router.use(requireMember, requireAdmin);

router.get("/admin/overview", async (_req, res): Promise<void> => {
  const [members] = await db
    .select({ total: count() })
    .from(membersTable);
  const [active] = await db
    .select({ total: count() })
    .from(membersTable)
    .where(eq(membersTable.status, "active"));
  const [blocked] = await db
    .select({ total: count() })
    .from(membersTable)
    .where(eq(membersTable.status, "blocked"));
  const [balance] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${accountsTable.balanceCents}), 0)`,
    })
    .from(accountsTable);
  const [pending] = await db
    .select({ total: count() })
    .from(loanApplicationsTable)
    .where(eq(loanApplicationsTable.status, "pending"));
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ total: count() })
    .from(transactionsTable)
    .where(gte(transactionsTable.createdAt, since));

  res.json(
    GetAdminOverviewResponse.parse({
      memberCount: members.total,
      activeMembers: active.total,
      blockedMembers: blocked.total,
      totalBalanceCents: Number(balance.total),
      pendingLoans: pending.total,
      recentTransactions: recent.total,
    }),
  );
});

router.get("/admin/members", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: membersTable.id,
      displayName: membersTable.displayName,
      email: membersTable.email,
      role: membersTable.role,
      status: membersTable.status,
      balanceCents: accountsTable.balanceCents,
      createdAt: membersTable.createdAt,
    })
    .from(membersTable)
    .innerJoin(accountsTable, eq(accountsTable.memberId, membersTable.id))
    .orderBy(desc(membersTable.createdAt))
    .limit(500);
  res.json(ListMembersResponse.parse(rows));
});

router.patch(
  "/admin/members/:memberId",
  async (req, res): Promise<void> => {
    const params = UpdateMemberStatusParams.safeParse(req.params);
    const body = UpdateMemberStatusBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const actorId = memberIdFromRequest(req);
    const [target] = await db
      .select()
      .from(membersTable)
      .where(eq(membersTable.id, params.data.memberId))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Member not found." });
      return;
    }
    if (target.id === actorId || target.role !== "member") {
      res.status(400).json({
        error: "Administrators cannot change their own status or block another administrator.",
      });
      return;
    }
    const [updated] = await db
      .update(membersTable)
      .set({ status: body.data.status, updatedAt: new Date() })
      .where(eq(membersTable.id, target.id))
      .returning();
    const [account] = await db
      .select({ balanceCents: accountsTable.balanceCents })
      .from(accountsTable)
      .where(eq(accountsTable.memberId, target.id))
      .limit(1);
    await db.insert(auditEventsTable).values({
      actorMemberId: actorId,
      action: body.data.status === "blocked" ? "member.blocked" : "member.restored",
      targetId: target.id,
      details: { email: target.email },
    });
    res.json(
      UpdateMemberStatusResponse.parse({
        id: updated.id,
        displayName: updated.displayName,
        email: updated.email,
        role: updated.role,
        status: updated.status,
        balanceCents: account?.balanceCents ?? 0,
        createdAt: updated.createdAt,
      }),
    );
  },
);

router.get("/admin/loans", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: loanApplicationsTable.id,
      amountCents: loanApplicationsTable.amountCents,
      purpose: loanApplicationsTable.purpose,
      termMonths: loanApplicationsTable.termMonths,
      status: loanApplicationsTable.status,
      createdAt: loanApplicationsTable.createdAt,
      memberId: membersTable.id,
      displayName: membersTable.displayName,
      email: membersTable.email,
    })
    .from(loanApplicationsTable)
    .innerJoin(
      membersTable,
      eq(loanApplicationsTable.memberId, membersTable.id),
    )
    .orderBy(desc(loanApplicationsTable.createdAt))
    .limit(500);
  res.json(ListAdminLoanApplicationsResponse.parse(rows));
});

router.patch(
  "/admin/loans/:loanId",
  async (req, res): Promise<void> => {
    const params = DecideLoanApplicationParams.safeParse(req.params);
    const body = DecideLoanApplicationBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const actorId = memberIdFromRequest(req);
    const result = await db.transaction(async (tx) => {
      const [application] = await tx
        .select()
        .from(loanApplicationsTable)
        .where(eq(loanApplicationsTable.id, params.data.loanId))
        .for("update")
        .limit(1);
      if (!application) return { ok: false as const, error: "Loan application not found.", status: 404 as const };
      if (application.status !== "pending") {
        return { ok: false as const, error: "This application has already been reviewed.", status: 400 as const };
      }
      const [member] = await tx
        .select()
        .from(membersTable)
        .where(eq(membersTable.id, application.memberId))
        .limit(1);
      if (!member || member.status !== "active") {
        return { ok: false as const, error: "This member account is not active.", status: 400 as const };
      }
      let account:
        | (typeof accountsTable.$inferSelect)
        | undefined;
      if (body.data.status === "approved") {
        const [lockedAccount] = await tx
          .select()
          .from(accountsTable)
          .where(eq(accountsTable.memberId, member.id))
          .for("update")
          .limit(1);
        if (!lockedAccount) return { ok: false as const, error: "Member account not found.", status: 404 as const };
        account = lockedAccount;
      }

      const [updated] = await tx
        .update(loanApplicationsTable)
        .set({ status: body.data.status, updatedAt: new Date() })
        .where(eq(loanApplicationsTable.id, application.id))
        .returning();

      if (body.data.status === "approved" && account) {
        const balanceCents = account.balanceCents + application.amountCents;
        await tx
          .update(accountsTable)
          .set({ balanceCents, updatedAt: new Date() })
          .where(eq(accountsTable.id, account.id));
        await tx.insert(transactionsTable).values({
          accountId: account.id,
          memberId: member.id,
          type: "loan_disbursement",
          amountCents: application.amountCents,
          balanceAfterCents: balanceCents,
          creditUsedAfterCents: account.creditUsedCents,
          description: "Simulated loan disbursement after administrator approval",
          status: "posted",
          reference: `EQF-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
        });
      }

      await tx.insert(auditEventsTable).values({
        actorMemberId: actorId,
        action: `loan.${body.data.status}`,
        targetId: application.id,
        details: { memberId: member.id, amountCents: application.amountCents },
      });

      return {
        ok: true as const,
        application: {
          ...updated,
          memberId: member.id,
          displayName: member.displayName,
          email: member.email,
        },
      };
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(DecideLoanApplicationResponse.parse(result.application));
  },
);

router.post("/admin/fraud-scan", async (req, res): Promise<void> => {
  const results = await runFraudDetection({
    initiatedByMemberId: memberIdFromRequest(req),
  });
  res.json(RunAdminFraudScanResponse.parse(results));
});

router.get("/admin/admins", async (_req, res): Promise<void> => {
  const [grants, members] = await Promise.all([
    db.select().from(administratorGrantsTable),
    db
      .select()
      .from(membersTable)
      .where(inArray(membersTable.role, ["admin", "owner"])),
  ]);
  const membersByEmail = new Map(members.map((member) => [member.email, member]));
  const grantsByEmail = new Map(grants.map((grant) => [grant.email, grant]));
  const emails = new Set([...membersByEmail.keys(), ...grantsByEmail.keys()]);
  const rows = [...emails].map((email) => {
    const member = membersByEmail.get(email);
    const grant = grantsByEmail.get(email);
    return {
      email,
      role: member?.role === "owner" ? "owner" : "admin",
      status: member ? "active" : "invited",
      createdAt: grant?.createdAt ?? member?.createdAt ?? new Date(),
    };
  });
  res.json(ListAdministratorsResponse.parse(rows));
});

router.post(
  "/admin/admins",
  requireOwner,
  async (req, res): Promise<void> => {
    const parsed = GrantAdministratorBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const email = parsed.data.email.trim().toLowerCase();
    const ownerEmail = req.equitrustMember!.email;
    if (email === ownerEmail) {
      res.status(400).json({ error: "The platform owner already has administrator access." });
      return;
    }

    const actorId = memberIdFromRequest(req);
    const [grant] = await db
      .insert(administratorGrantsTable)
      .values({ email, grantedByMemberId: actorId })
      .onConflictDoUpdate({
        target: administratorGrantsTable.email,
        set: { grantedByMemberId: actorId },
      })
      .returning();
    const [existingMember] = await db
      .select()
      .from(membersTable)
      .where(eq(membersTable.email, email))
      .limit(1);
    if (existingMember && existingMember.role === "member") {
      await db
        .update(membersTable)
        .set({ role: "admin", updatedAt: new Date() })
        .where(eq(membersTable.id, existingMember.id));
    }
    await db.insert(auditEventsTable).values({
      actorMemberId: actorId,
      action: "administrator.granted",
      targetId: email,
      details: { email },
    });
    res.status(201).json(
      GrantAdministratorResponse.parse({
        email,
        role: "admin",
        status: existingMember ? "active" : "invited",
        createdAt: grant.createdAt,
      }),
    );
  },
);

router.patch(
  "/admin/platform-settings",
  async (req, res): Promise<void> => {
    const parsed = UpdatePlatformSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const actorId = memberIdFromRequest(req);
    const [settings] = await db
      .insert(platformSettingsTable)
      .values({ id: "default", ...parsed.data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettingsTable.id,
        set: { ...parsed.data, updatedAt: new Date() },
      })
      .returning();
    await db.insert(auditEventsTable).values({
      actorMemberId: actorId,
      action: "platform.settings.updated",
      targetId: "default",
      details: { changedFields: Object.keys(parsed.data) },
    });
    res.json(UpdatePlatformSettingsResponse.parse(settings));
  },
);

export default router;