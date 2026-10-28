import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
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

// Devices that receive push notifications (#29): one row per browser or
// home-screen install that said yes. Infrastructure like sessions, written
// by src/lib/push directly. The endpoint is the push service's URL for
// that device; p256dh and auth are the keys every payload is encrypted
// with, so the push service carries notifications without reading them.
// A device is revoked by deleting its row (Settings), or automatically
// once the push service says the subscription is gone.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  // "iPhone", "Mac · Safari": enough to tell devices apart in Settings.
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  // The last failure's HTTP status and a short reason; no payload.
  lastError: text("last_error"),
});

// Tokens the iOS Shortcut sends with each Apple Pay purchase (#32): one
// per device, created and revoked in Settings. Only a SHA-256 of the token
// is stored, as with sessions: a leaked copy of this table can't be used
// to post purchases. Infrastructure, written by src/lib/shortcuts.
export const shortcutTokens = pgTable("shortcut_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// Wallet card names a purchase alert used that no account is mapped to
// yet, so Settings can offer them instead of asking the owner to type the
// exact name. Removed once mapped. Names only; the purchase itself isn't
// kept (the daily sync brings it anyway).
export const unmappedWalletCards = pgTable("unmapped_wallet_cards", {
  name: text("name").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
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
// "manual" is an account the owner keeps up by hand (#26): a home, a car, a
// private loan, an institution no aggregator covers. Its value only changes
// through the accounts.*Manual operations, and no sync ever touches it
// (syncs match on connection, which a manual account doesn't have).
export const dataSource = pgEnum("data_source", ["seed", "simplefin", "manual"]);

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
  // The card's name in Apple Wallet, which is all an Apple Pay purchase
  // alert says about the card (#32). Set by the owner; it maps the alert
  // to this account. Unique, ignoring case, so an alert never has two
  // candidates.
  walletCardName: text("wallet_card_name"),
}, (t) => [
  uniqueIndex("accounts_connection_external_idx").on(t.connectionId, t.externalId),
  uniqueIndex("accounts_wallet_card_name_idx").on(sql`lower(${t.walletCardName})`),
]);

// One balance per account per day, recorded by every sync (#25). Banks only
// ever report a balance "as of now", so history that isn't captured on the
// day is gone for good — this table is the only place net-worth history can
// come from. The balance is stored exactly as the provider reported it, with
// no sign normalization: how a kind's balance counts toward net worth is
// decided when reading (src/lib/net-worth.ts), so correcting an account's
// kind later also corrects its past.
export const balanceSnapshots = pgTable(
  "balance_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // The day this was recorded (UTC). A second sync the same day replaces
    // the first rather than adding a row.
    on: date("on").notNull(),
    balanceCents: bigint("balance_cents", { mode: "number" }).notNull(),
    // When the provider says the balance was true, which can lag the sync.
    balanceAt: timestamp("balance_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("balance_snapshots_account_on_idx").on(t.accountId, t.on), index("balance_snapshots_on_idx").on(t.on)],
);

// Investment positions, one row per holding per account per UTC day (#23),
// recorded by every sync that returns them — position history, built the
// same way as balance_snapshots and for the same reason: providers only
// report what's held now. Display and history only: an account's value in
// net worth is still its balance (which already includes these), so
// holdings are never added on top. They never become transactions, never
// count toward budgets, and never go to a model.
export const holdingSnapshots = pgTable(
  "holding_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    on: date("on").notNull(),
    // The provider's ID for the position, or its symbol when it has none;
    // what makes a same-day re-sync update rather than duplicate.
    externalId: text("external_id").notNull(),
    symbol: text("symbol"),
    description: text("description").notNull(),
    // Exact decimal, as the provider sent it: fractional shares often carry
    // more places than any float would keep faithfully.
    shares: numeric("shares").notNull(),
    marketValueCents: bigint("market_value_cents", { mode: "number" }).notNull(),
    // Total cost of the position, when the brokerage provides it.
    costBasisCents: bigint("cost_basis_cents", { mode: "number" }),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("holding_snapshots_account_on_external_idx").on(t.accountId, t.on, t.externalId),
    index("holding_snapshots_on_idx").on(t.on),
  ],
);

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

// Where a provisional transaction came from (#30): a near-real-time alert
// that arrived before the bank's own data. Null on everything the sync
// brings in.
export const provisionalSource = pgEnum("provisional_source", ["email", "apple_pay"]);

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
    // The other side of a transfer between two of the owner's own accounts
    // (#24): money moved, nothing was spent or earned. Both sides point at
    // each other. A paired transaction is out of the inbox and out of
    // spending without needing a category. Set by the transfer matcher
    // (src/lib/investments/transfers.ts) or the owner. SET NULL is a
    // backstop only: unpairing goes through transactions.unmatchTransfer,
    // which clears both sides as tracked writes.
    transferPairId: uuid("transfer_pair_id").references((): AnyPgColumn => transactions.id, { onDelete: "set null" }),
    // The owner said this isn't a transfer; the matcher leaves it alone.
    transferRejected: boolean("transfer_rejected").notNull().default(false),
    // The owner said this incoming payment isn't paying anyone back (a gift,
    // a sale); it's no longer proposed as a reimbursement match (#8).
    notReimbursement: boolean("not_reimbursement").notNull().default(false),
    // Set on a provisional transaction (#30): one created from a purchase
    // alert (#31 email, #32 Apple Pay) before the bank reported it. The
    // nightly pipeline matches it to the synced transaction, carries the
    // owner's work over and removes it (src/operations/provisional.ts). Its
    // externalId is "<source>:<the alert's own id>", so a re-delivered
    // alert can't create it twice.
    provisionalSource: provisionalSource("provisional_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_posted_on_idx").on(t.postedOn),
    index("transactions_provisional_idx").on(t.provisionalSource),
    index("transactions_transfer_pair_idx").on(t.transferPairId),
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

// ---------------------------------------------------------------------------
// Tally, the chat assistant (#11).
// ---------------------------------------------------------------------------

// Conversations with Tally, kept so a reload doesn't lose the thread or its
// proposals. Infrastructure rather than ledger data — like model_calls —
// written directly by src/lib/tally, not through operations: nothing here
// changes the books. Any change Tally wants is a proposal in command_log.
export const tallyConversations = pgTable("tally_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The first question, shortened, for the list.
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tallyRole = pgEnum("tally_role", ["user", "assistant", "tool"]);

// One message in the model's own shape (OpenAI-style), replayed as context
// for the next turn. Tool results are stored as the model saw them —
// already redacted (src/lib/model/redact.ts).
export const tallyMessages = pgTable(
  "tally_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => tallyConversations.id, { onDelete: "cascade" }),
    role: tallyRole("role").notNull(),
    content: text("content"),
    // Assistant turns that called tools: [{ id, name, arguments }].
    toolCalls: jsonb("tool_calls").$type<{ id: string; name: string; arguments: string }[]>(),
    // Tool results: which call they answer, and the proposal it made if any.
    toolCallId: text("tool_call_id"),
    commandId: uuid("command_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tally_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

// The nightly digest, written by Tally from the day's facts (sync status,
// inbox, alerts, budget pace). One per day; Home shows the latest. The
// facts it was written from are kept beside it, so a surprising sentence
// can be checked against what the model was actually told.
export const digests = pgTable("digests", {
  id: uuid("id").primaryKey().defaultRandom(),
  on: date("on").notNull().unique(),
  content: text("content").notNull(),
  facts: jsonb("facts").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Savings goals (#10).
// ---------------------------------------------------------------------------

// Something to save toward. Progress comes from linked accounts' balances
// and/or transfers tagged with the goal's tag (src/lib/goals/progress.ts);
// nothing about progress is stored, so it's always current and its history
// can be rebuilt from balance snapshots.
export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  targetCents: bigint("target_cents", { mode: "number" }).notNull(),
  // Optional: without one there's no pace, only a projection from the trend.
  targetDate: date("target_date"),
  // Where the even-pace line starts: the day the goal was set.
  startOn: date("start_on").notNull(),
  // Transfers tagged with this count toward the goal. Restrict:
  // tags.delete refuses while a goal uses the tag.
  tagId: uuid("tag_id").references(() => tags.id, { onDelete: "restrict" }),
  // Reached or given up on: kept for the record, off the main list.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Accounts whose balance counts toward a goal (savings, a brokerage for a
// down payment). Cascade is a backstop; goals.update relinks through
// tracked writes.
export const goalAccounts = pgTable(
  "goal_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("goal_accounts_goal_account_idx").on(t.goalId, t.accountId)],
);

// ---------------------------------------------------------------------------
// Recurring charges and alerts (#9).
// ---------------------------------------------------------------------------

// The owner's decisions about detected recurring charges. Detection itself
// is computed when read (src/lib/recurring/detect.ts) from merchant, cadence
// and amount, so improving it never needs a backfill; only what the owner
// said is stored. A series is one merchant in one account. Dismissed means
// "not a subscription"; cancelled (#82) means it was one and the owner
// ended it, so a later charge is worth an alert.
export const recurringStatus = pgEnum("recurring_status", ["confirmed", "dismissed", "cancelled"]);

export const recurringSeries = pgTable(
  "recurring_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant: text("merchant").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    status: recurringStatus("status").notNull(),
    // Set only while cancelled. The yearly cost and grace window are a
    // snapshot from cancel time: detection forgets a series once its charges
    // age out, and "saved per year" shouldn't shrink when that happens.
    cancelledOn: date("cancelled_on"),
    cancelledAnnualCents: integer("cancelled_annual_cents"),
    cancelGraceDays: integer("cancel_grace_days"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("recurring_series_merchant_account_idx").on(t.merchant, t.accountId)],
);

export const alertKind = pgEnum("alert_kind", [
  "price_increase",
  "duplicate_charge",
  "overlapping_subscriptions",
  "trial_converted",
  "missing_charge",
  "charged_after_cancel",
]);

// Things worth the owner's attention, written by the nightly pipeline
// (alerts.refresh) and read by the digest: Home in the app today, push or
// email later (#29), which marks notifiedAt. dedupeKey makes each alert
// happen once — a dismissed alert is never raised again for the same event.
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: alertKind("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    merchant: text("merchant").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    // The day the thing happened (the charge, or the day a charge was due).
    occurredOn: date("occurred_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("alerts_dedupe_idx").on(t.dedupeKey), index("alerts_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Pay stubs (#60).
// ---------------------------------------------------------------------------

// What a deduction on a pay stub is. Grouped for reading (taxes, insurance,
// retirement and benefits, other) in src/lib/pay/stubs.ts; the tax
// estimate (#61) sums the tax kinds.
export const payLineKind = pgEnum("pay_line_kind", [
  "federal_income_tax",
  "state_income_tax",
  "local_income_tax",
  "social_security",
  "medicare",
  "state_disability",
  "health_insurance",
  "dental_insurance",
  "vision_insurance",
  "retirement_pretax",
  "retirement_roth",
  "hsa",
  "fsa",
  "other",
]);

// One pay period's stub: gross pay, what was withheld, and the net that
// reached the bank. Amounts and labels only. A stub's SSN, employer ID and
// address are never entered or stored (AGENTS.md). Written through
// payStubs.* operations, so every change is logged and undoable.
export const payStubs = pgTable(
  "pay_stubs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The owner's name for the employer, a label like an account nickname.
    employer: text("employer").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payDate: date("pay_date").notNull(),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    // Gross minus every line, exactly: checked on save.
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    // The bank deposit of the net pay. While linked, budgets count the
    // deposit as gross income less each deduction, never the net twice
    // (transactions.spendingLines). Set null if the deposit is ever removed
    // (a sync's pending row replaced); the stub stays.
    depositTransactionId: uuid("deposit_transaction_id")
      .unique()
      .references(() => transactions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pay_stubs_pay_date_idx").on(t.payDate)],
);

// One deduction on a pay stub: a kind, the stub's own label for it
// ("Fed Withholding", "401K"), and the amount withheld, positive cents.
// The category is where it counts in budgets (Taxes, Health Insurance; a
// transfer category for a 401(k), which isn't spending). Without one, it's
// netted against gross instead.
export const payStubLines = pgTable(
  "pay_stub_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payStubId: uuid("pay_stub_id")
      .notNull()
      .references(() => payStubs.id, { onDelete: "cascade" }),
    kind: payLineKind("kind").notNull(),
    label: text("label").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("pay_stub_lines_stub_idx").on(t.payStubId)],
);

export const filingStatus = pgEnum("filing_status", ["single", "married_joint", "married_separate", "head_of_household"]);

// The owner's own inputs to the tax estimate (#61), one row per tax year:
// what pay stubs can't say. User data, set through taxes.setAssumptions;
// never repo config. All amounts are yearly, positive cents.
export const taxAssumptions = pgTable("tax_assumptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  year: integer("year").notNull().unique(),
  filingStatus: filingStatus("filing_status").notNull().default("single"),
  // Taxable income not on these pay stubs: interest, side income, a
  // spouse's wages on a joint return.
  otherIncomeCents: bigint("other_income_cents", { mode: "number" }).notNull().default(0),
  // Null takes the standard deduction; a number is the itemized total.
  itemizedDeductionsCents: bigint("itemized_deductions_cents", { mode: "number" }),
  creditsCents: bigint("credits_cents", { mode: "number" }).notNull().default(0),
  // Federal tax paid outside payroll: estimated payments, or withholding
  // on other income.
  otherPaymentsCents: bigint("other_payments_cents", { mode: "number" }).notNull().default(0),
});

// ---------------------------------------------------------------------------
// Shared expenses and reimbursements (#8).
// ---------------------------------------------------------------------------

// The people who pay the owner back. Deliberately light: a name and the
// spellings payment apps use for it ("ALEX R", "A RIVERA"). Data Diary's
// people catalog joins later, through the bridge.
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Extra spellings to recognize in payment descriptions.
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("people_name_lower_idx").on(sql`lower(${t.name})`)],
);

// What one person owes on one shared expense. The owner's share is the
// expense minus these. Net spend drops by the owed amount as soon as it's
// recorded — your share is what counts, whether or not they've paid yet.
// A forgiven reimbursement stops being owed: its unpaid part returns to
// the owner's spend.
export const reimbursements = pgTable(
  "reimbursements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The shared expense. Cascade is a backstop: only posted transactions
    // can be shared, and only pending ones are ever removed by a sync.
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    // Positive cents owed.
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    forgiven: boolean("forgiven").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reimbursements_transaction_idx").on(t.transactionId), index("reimbursements_person_idx").on(t.personId)],
);

// Money received against what's owed: part of an incoming payment applied
// to one reimbursement. One payment can cover several reimbursements (one
// Venmo for two dinners) and one reimbursement can be paid in parts. The
// matched part of a payment is never income.
export const reimbursementMatches = pgTable(
  "reimbursement_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reimbursementId: uuid("reimbursement_id")
      .notNull()
      .references(() => reimbursements.id, { onDelete: "cascade" }),
    // The incoming payment.
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reimbursement_matches_reimbursement_idx").on(t.reimbursementId), index("reimbursement_matches_transaction_idx").on(t.transactionId)],
);

// ---------------------------------------------------------------------------
// Budgets (#7): category targets with periods, rollover and one buffer.
// ---------------------------------------------------------------------------

// One version of a category's target. Targets are never edited in place
// across periods: a change adds a version effective from the start of the
// current period, so earlier periods keep the target they had
// (src/lib/budgets/engine.ts). A version for the same category and start
// date is a correction and is updated instead.
//
// categoryId null is the unallocated buffer: one amount every expense
// category without its own target draws from, so "misc" never needs a
// category of its own.
export const budgetTargets = pgTable(
  "budget_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Restrict: categories.delete refuses while a target refers to it.
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    // First day this version applies; always the first of a month.
    effectiveFrom: date("effective_from").notNull(),
    // Spend allowed per period, positive cents. Null ends the target from
    // effectiveFrom on (its history stays).
    amountCents: bigint("amount_cents", { mode: "number" }),
    // Period length in months: 1 monthly, 12 annual, anything else custom
    // (3 quarterly, 6 twice a year).
    periodMonths: integer("period_months").notNull().default(1),
    // Periods are counted from this month (first of month): an annual
    // target anchored on January runs Jan–Dec.
    anchorOn: date("anchor_on").notNull(),
    // Unspent budget (or overspend) carries into the next period.
    rollover: boolean("rollover").notNull().default(false),
    // Show the monthly set-aside for a multi-month target.
    sinkingFund: boolean("sinking_fund").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("budget_targets_category_from_unique").on(t.categoryId, t.effectiveFrom).nullsNotDistinct()],
);

// Mid-period rebalancing (budgets.rebalance): money moved between two
// targets for the period containing `on` only. Written in pairs (−x from
// one, +x to the other) sharing a rebalanceId. Targets themselves are
// untouched, so next period starts clean.
export const budgetAdjustments = pgTable(
  "budget_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rebalanceId: uuid("rebalance_id").notNull(),
    // Null is the buffer, as in budget_targets.
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    on: date("on").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("budget_adjustments_on_idx").on(t.on)],
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

// ---------------------------------------------------------------------------
// Model calls (#39): one row per request to the self-hosted model, for cost
// and reliability — and deliberately nothing else. No prompt, no response,
// no transaction text: the call log must never become a second copy of
// the data the model saw.
// ---------------------------------------------------------------------------

export const modelCallStatus = pgEnum("model_call_status", ["ok", "error", "unavailable"]);

export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Which part of the app asked: "categorize", "tally", "digest", "test"…
    feature: text("feature").notNull(),
    status: modelCallStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    latencyMs: integer("latency_ms").notNull(),
    // Retries while the GPU was cold-starting (503s). Tells cold-start
    // cost apart from a slow model.
    coldStartRetries: integer("cold_start_retries").notNull().default(0),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    // Our own short description (HTTP status, timeout), never the server's
    // response body, which could echo the prompt.
    error: text("error"),
  },
  (t) => [index("model_calls_started_idx").on(t.startedAt)],
);

// ---------------------------------------------------------------------------
// Model categorization (#6 phase 3).
// ---------------------------------------------------------------------------

// The model's opinion of an uncategorized transaction. Kept separately from
// the transaction (not as columns on it) so writing a suggestion never
// touches the transaction row — and so never blocks undoing the owner's own
// edits to it. A row with a null category means "the model looked and had
// no answer"; either way the transaction isn't sent to the model again.
export const categorySuggestions = pgTable(
  "category_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // Set null rather than restrict: a stale suggestion must never stop the
    // owner deleting a category.
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    confidence: doublePrecision("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("category_suggestions_transaction_idx").on(t.transactionId)],
);

// Results of evaluating the model on the owner's own categorized history.
// Numbers only — which transactions were sampled, and what the model said
// about them, are never stored (AGENTS.md: evals from real history stay in
// the database, and even here only as aggregates).
export type ThresholdStat = { threshold: number; applied: number; correct: number };

export const modelEvals = pgTable("model_evals", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sampleSize: integer("sample_size").notNull(),
  // At any confidence: the model's top answer was right / wrong / it said "none".
  correct: integer("correct").notNull(),
  wrong: integer("wrong").notNull(),
  abstained: integer("abstained").notNull(),
  // How many would be auto-applied at each threshold, and how many of those
  // would be right.
  thresholds: jsonb("thresholds").$type<ThresholdStat[]>().notNull(),
  latencyMs: integer("latency_ms").notNull(),
});
