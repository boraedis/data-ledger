import {
  bigint,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

export const accountType = pgEnum("account_type", ["checking", "savings", "credit", "payment_app"]);

// Where a row came from. "seed" marks synthetic data, which is what lets the
// seed script prove it never touches a database holding anything real.
export const dataSource = pgEnum("data_source", ["seed", "simplefin"]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  institution: text("institution").notNull(),
  type: accountType("type").notNull(),
  source: dataSource("source").notNull(),
  // The connector's own ID for the account, so re-syncs update rather than
  // duplicate. Null only for seed rows.
  externalId: text("external_id"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const categoryKind = pgEnum("category_kind", ["expense", "income", "transfer"]);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: categoryKind("kind").notNull(),
  },
  (t) => [uniqueIndex("categories_name_idx").on(t.name)],
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
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_posted_on_idx").on(t.postedOn),
    uniqueIndex("transactions_account_external_idx").on(t.accountId, t.externalId),
  ],
);

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
