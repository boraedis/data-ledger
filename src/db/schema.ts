import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ACCOUNT_KINDS } from "@/lib/account-kinds";

// drizzle has no built-in bytea column; passkey public keys are raw COSE
// bytes and shouldn't round-trip through base64 text just to fit a type.
// Typed over a plain ArrayBuffer because WebAuthn's verify step rejects the
// wider ArrayBufferLike (a SharedArrayBuffer view) at the type level.
const bytea = customType<{ data: Uint8Array<ArrayBuffer>; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value),
});

// ---------------------------------------------------------------------------
// Auth (#2). Single owner, so there is no users table: every passkey and
// session belongs to the owner by definition.
// ---------------------------------------------------------------------------

export const passkeys = pgTable("passkeys", {
  // The WebAuthn credential ID, base64url — what the browser hands back on
  // every sign-in, so it's the natural lookup key.
  id: text("id").primaryKey(),
  publicKey: bytea("public_key").notNull(),
  // Signature counter. Most synced passkeys always report 0, but hardware
  // keys increment it, and a counter that goes backwards means a cloned key.
  counter: integer("counter").notNull().default(0),
  transports: text("transports").array(),
  // Shown on the settings page so the owner can tell their devices apart.
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  // SHA-256 of the session ID in the cookie, never the ID itself: a leaked
  // copy of this table can't be turned back into a working cookie.
  idHash: text("id_hash").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const challengePurpose = pgEnum("challenge_purpose", ["register", "login"]);

// WebAuthn challenges are kept server-side and deleted on first use, so a
// captured response can't be replayed even within the challenge's lifetime
// — something a signed-cookie challenge can't guarantee.
export const authChallenges = pgTable("auth_challenges", {
  challenge: text("challenge").primaryKey(),
  purpose: challengePurpose("purpose").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// Finance core. Deliberately minimal — just enough for the synthetic seed to
// have somewhere to land. The connector (#4), operations layer (#3) and
// categorization (#6) sub-issues own growing these, so nothing here
// anticipates their columns.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bank connections (#4). Infrastructure, like passkeys: credentials and sync
// bookkeeping live here and are managed outside the operations layer. The
// ledger data a sync brings in (accounts, transactions) goes through the
// import operation, so it's logged and undoable like any other write.
// ---------------------------------------------------------------------------

export const connectionStatus = pgEnum("connection_status", ["active", "broken"]);

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Which connector implementation; nothing outside src/lib/connectors
  // branches on this.
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  // The connector's credential (SimpleFIN: the access URL, which embeds a
  // password), AES-256-GCM encrypted with CONNECTION_ENCRYPTION_KEY. Never
  // logged, never sent to a model, never shown after it's stored.
  encryptedSecret: text("encrypted_secret").notNull(),
  // "broken" when the provider rejects the credential outright (revoked,
  // unpaid); per-institution trouble is in sync_runs.messages instead.
  status: connectionStatus("status").notNull().default("active"),
  lastError: text("last_error"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncRunStatus = pgEnum("sync_run_status", ["running", "success", "partial", "failed", "skipped"]);

// One row per attempt. Doubles as the request ledger for the provider's
// rate limit, and as the history behind the health view.
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(), // "cron" | "manual" | "setup"
    status: syncRunStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Requests actually sent to the provider: 0 for a skipped run, more
    // than 1 when a long window is fetched in chunks. Summed for the rate
    // budget.
    requests: integer("requests").notNull().default(0),
    // Provider messages to show the owner (SimpleFIN asks that they always
    // be shown), already reduced to safe display text.
    messages: jsonb("messages").$type<SyncMessage[]>().notNull().default([]),
    error: text("error"),
    commandId: uuid("command_id"),
    inserted: integer("inserted").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    removed: integer("removed").notNull().default(0),
  },
  (t) => [index("sync_runs_connection_started_idx").on(t.connectionId, t.startedAt)],
);

export type SyncMessage = {
  code: string;
  message: string;
  institutionId?: string;
  accountExternalId?: string;
};

export { ACCOUNT_KINDS, countsTowardBudgetsByDefault, type AccountKind } from "@/lib/account-kinds";

// Kinds and their budget defaults live in src/lib/account-kinds.ts so the
// client can use them without importing the schema.
export const accountType = pgEnum("account_type", ACCOUNT_KINDS);

// Where a row came from. "seed" marks synthetic data, which is what lets the
// seed script prove it never touches a database holding anything real.
export const dataSource = pgEnum("data_source", ["seed", "simplefin"]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The provider's name for the account, refreshed by every sync.
  name: text("name").notNull(),
  // The owner's name for it, if they set one. Shown in place of `name` and
  // never touched by a sync, the same split as raw description vs. derived
  // merchant for transactions.
  displayName: text("display_name"),
  institution: text("institution").notNull(),
  type: accountType("type").notNull(),
  // Whether this account's transactions count as spending/income in budgets
  // and spending queries (#7 must filter on it). Off for investment, loan
  // and asset kinds by default, so a brokerage's buys and dividends never
  // read as spending. Only the owner changes it; syncs don't.
  countsTowardBudgets: boolean("counts_toward_budgets").notNull().default(true),
  source: dataSource("source").notNull(),
  // The connector's own ID for the account, so re-syncs update rather than
  // duplicate. Null only for seed rows.
  externalId: text("external_id"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Null for seed rows. Set null (not cascade) if a connection is removed:
  // the account and its history stay in the ledger.
  connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "set null" }),
  // The provider's ID for the institution behind this account — what
  // per-institution health groups by.
  institutionId: text("institution_id"),
  // Balances are for display and reconciliation only; they never go to a
  // model (AGENTS.md).
  balanceCents: bigint("balance_cents", { mode: "number" }),
  availableBalanceCents: bigint("available_balance_cents", { mode: "number" }),
  balanceAt: timestamp("balance_at", { withTimezone: true }),
}, (t) => [uniqueIndex("accounts_connection_external_idx").on(t.connectionId, t.externalId)]);

export const categoryKind = pgEnum("category_kind", ["expense", "income", "transfer"]);

// The owner's own category tree (#6) — nothing is inherited from a bank.
// Two levels: a top-level category ("Food") and optional children
// ("Groceries", "Dining"). Names are unique among siblings, so "Other" can
// exist under several parents.
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: categoryKind("kind").notNull(),
    // Restrict, not cascade: deleting a parent must be a deliberate move of
    // its children first, never a silent loss of categories.
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, { onDelete: "restrict" }),
  },
  (t) => [unique("categories_parent_name_unique").on(t.parentId, t.name).nullsNotDistinct()],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    postedOn: date("posted_on").notNull(),
    // Integer cents, signed: negative is money leaving the account. Never a
    // float — budgets sum thousands of these and must reconcile exactly.
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    // The raw bank description, untouched. Cleanup and merchant matching are
    // derived from it, never written over it.
    description: text("description").notNull(),
    externalId: text("external_id"),
    // Pending transactions can vanish or reappear under a new ID once they
    // post; the import operation reconciles them (src/operations/import.ts).
    pending: boolean("pending").notNull().default(false),
    // Extra raw fields some providers give, kept for merchant normalization
    // (#6). Like description, never overwritten by derived values.
    payee: text("payee"),
    memo: text("memo"),
    // Derived: a clean merchant name from payee/description
    // (src/lib/categorize/merchant.ts). What rules and merchant memory key
    // on. Recomputable at any time; the raw fields above are the truth.
    merchant: text("merchant"),
    // True when the transaction is divided into transaction_splits, each
    // with its own category; categoryId is then null. A split transaction
    // counts as categorized (it's out of the inbox and the pipeline).
    isSplit: boolean("is_split").notNull().default(false),
    // When the spending actually "happened" for budgeting, if not when it
    // posted: concert tickets bought in March for a show in July. Budgets
    // use experiencedOn ?? postedOn.
    experiencedOn: date("experienced_on"),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_posted_on_idx").on(t.postedOn),
    index("transactions_merchant_idx").on(t.merchant),
    uniqueIndex("transactions_account_external_idx").on(t.accountId, t.externalId),
  ],
);

// ---------------------------------------------------------------------------
// Splits and tags (#6, phase 2).
// ---------------------------------------------------------------------------

// The parts of a split transaction. They always sum exactly to the
// transaction's amount, with the same sign (enforced by transactions.split).
export const transactionSplits = pgTable(
  "transaction_splits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascade is a backstop only: every code path that removes a
    // transaction removes its splits first, through tracked writes, so
    // undo can restore them.
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    note: text("note"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("transaction_splits_transaction_idx").on(t.transactionId)],
);

// Free-form labels, orthogonal to categories ("vacation-2026",
// "tax-deductible", "for Alex"). Unique ignoring case.
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_name_lower_idx").on(sql`lower(${t.name})`)],
);

// A plain id primary key (not a composite) because tracked writes, and so
// undo, need one; the unique index is the real identity.
export const transactionTags = pgTable(
  "transaction_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("transaction_tags_unique_idx").on(t.transactionId, t.tagId),
    index("transaction_tags_tag_idx").on(t.tagId),
  ],
);

// ---------------------------------------------------------------------------
// Categorization rules (#6): the owner's deterministic "this → that". Rules
// run before merchant memory and any model, in priority order, and only
// ever fill in an uncategorized transaction — they never overwrite.
// ---------------------------------------------------------------------------

export const ruleMatchField = pgEnum("rule_match_field", ["merchant", "description"]);
// No regex on purpose: a user-supplied pattern run against every
// transaction is a ReDoS waiting to happen, and these three cover the
// real cases.
export const ruleMatchType = pgEnum("rule_match_type", ["equals", "contains", "starts_with"]);

export const rules = pgTable("rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchField: ruleMatchField("match_field").notNull(),
  matchType: ruleMatchType("match_type").notNull(),
  // Compared case-insensitively.
  pattern: text("pattern").notNull(),
  // Optional narrowing: one account, and/or an amount range on the
  // transaction's absolute value in cents (so "over $100" reads naturally
  // for both spending and refunds).
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  minAmountCents: bigint("min_amount_cents", { mode: "number" }),
  maxAmountCents: bigint("max_amount_cents", { mode: "number" }),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "restrict" }),
  // Lower runs first; ties broken by age, oldest first.
  priority: integer("priority").notNull().default(100),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Command log (#3). One row per write — applied, proposed, rejected or
// undone — from any actor. Reads aren't logged: Tally reads constantly and
// the log is for "who changed what", not an access trail.
// ---------------------------------------------------------------------------

export const commandStatus = pgEnum("command_status", ["proposed", "applied", "rejected", "undone"]);

// One row-level change made by a write: `before` null means the row was
// inserted, `after` null means it was deleted. Rows are Postgres's own
// to_jsonb() of the full row, so undo can restore them with
// jsonb_populate_record without any per-table code.
export type RowChange = {
  table: string;
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export const commandLog = pgTable(
  "command_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // "user", "tally", "import" or "rule:<id>". Text rather than an enum so
    // rule IDs fit; the runtime validates the shape.
    actor: text("actor").notNull(),
    operation: text("operation").notNull(),
    input: jsonb("input").notNull(),
    reason: text("reason").notNull(),
    status: commandStatus("status").notNull(),
    changes: jsonb("changes").$type<RowChange[]>().notNull().default([]),
    // For proposals: who approved or rejected it, and when.
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // An undo is itself a logged command pointing at what it reversed; the
    // reversed command points back.
    undoOf: uuid("undo_of"),
    undoneBy: uuid("undone_by"),
  },
  (t) => [index("command_log_created_at_idx").on(t.createdAt), index("command_log_status_idx").on(t.status)],
);
