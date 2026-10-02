import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type StoredRiskFinding = {
  memberId: string;
  displayName: string;
  email: string;
  riskLevel: "low" | "review" | "high";
  score: number;
  reasons: string[];
  transactionCount: number;
};

export const membersTable = pgTable(
  "equitrust_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("equitrust_members_clerk_user_id_idx").on(table.clerkUserId),
    uniqueIndex("equitrust_members_email_idx").on(table.email),
  ],
);

export const accountsTable = pgTable(
  "equitrust_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => membersTable.id, { onDelete: "cascade" }),
    balanceCents: integer("balance_cents").notNull().default(0),
    creditLimitCents: integer("credit_limit_cents").notNull().default(500000),
    creditUsedCents: integer("credit_used_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("equitrust_accounts_member_id_idx").on(table.memberId),
  ],
);

export const transactionsTable = pgTable(
  "equitrust_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => membersTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    amountCents: integer("amount_cents").notNull(),
    balanceAfterCents: integer("balance_after_cents").notNull(),
    creditUsedAfterCents: integer("credit_used_after_cents").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("posted"),
    reference: text("reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("equitrust_transactions_reference_idx").on(table.reference),
  ],
);

export const loanApplicationsTable = pgTable(
  "equitrust_loan_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => membersTable.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    purpose: text("purpose").notNull(),
    termMonths: integer("term_months").notNull(),
    status: text("status").notNull().default("pending"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const administratorGrantsTable = pgTable(
  "equitrust_administrator_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    grantedByMemberId: uuid("granted_by_member_id")
      .notNull()
      .references(() => membersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("equitrust_administrator_grants_email_idx").on(table.email),
  ],
);

export const platformSettingsTable = pgTable("equitrust_platform_settings", {
  id: text("id").primaryKey().default("default"),
  siteName: text("site_name").notNull().default("Equitrust Finance"),
  tagline: text("tagline")
    .notNull()
    .default("A stronger future, built together."),
  announcement: text("announcement")
    .notNull()
    .default("Welcome to your cooperative finance workspace."),
  supportEmail: text("support_email").notNull().default("ourgroup1@gmail.com"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditEventsTable = pgTable("equitrust_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorMemberId: uuid("actor_member_id")
    .notNull()
    .references(() => membersTable.id),
  action: text("action").notNull(),
  targetId: text("target_id").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const fraudScansTable = pgTable("equitrust_fraud_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  initiatedByMemberId: uuid("initiated_by_member_id")
    .notNull()
    .references(() => membersTable.id),
  scannedAccounts: integer("scanned_accounts").notNull(),
  scannedTransactions: integer("scanned_transactions").notNull(),
  findings: jsonb("findings")
    .$type<StoredRiskFinding[]>()
    .notNull()
    .default([]),
  method: text("method").notNull(),
  disclaimer: text("disclaimer").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Member = typeof membersTable.$inferSelect;
export type Account = typeof accountsTable.$inferSelect;
export type LedgerTransaction = typeof transactionsTable.$inferSelect;
export type LoanApplicationRecord = typeof loanApplicationsTable.$inferSelect;