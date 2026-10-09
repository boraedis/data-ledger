# Data Ledger

A personal, single-user finance app: automatic bank sync, categorization
that learns instead of nagging, flexible budgets, subscription tracking, and
an assistant — **Tally** — that works on the same operations the UI does.

Sibling to [Data Diary](https://github.com/boraedis/data-diary). The two are
deliberately independent: Data Ledger owns accounts, transactions, budgets
and bank connections; Data Diary treats it as one more external source and
pulls a narrow, aggregate-only feed at the very end (see "Diary bridge").

> **Status:** in production — auth, database, seed and the operations
> layer (#3) are in place; no finance features yet. The founding epic and its
> sub-issues on the [Data Ledger project board](https://github.com/users/boraedis/projects/4) (founding epic: #1)
> are the build order.

## Why this exists

The legacy Data Diary had a Plaid-backed finance section that never worked,
and was cut from the rebuild rather than ported. The commercial tools in use
today fall short in specific, known ways, and each one is a design input
here:

| Pain point | Design answer |
|---|---|
| Every category needs its own hard monthly budget, even "misc" | Category targets plus one **unallocated buffer**; Tally suggests a new category once a pattern shows up in the buffer |
| Annual expenses don't fit a monthly grid | Each target has a **period** (monthly / annual / custom), with an optional sinking-fund view and per-category rollover |
| Auto-categorization is poor and fixing it is endless | A layered **categorization pipeline** (rules → merchant memory → LLM with confidence → small review inbox); every correction can become a rule |
| Friends reimbursing shared spending looks like income, and the spend looks inflated | **Shared expenses and reimbursements** are first-class: your share counts against the budget, the rest is an expected reimbursement matched to the incoming Venmo/Zelle, never income |
| Subscriptions are opaque | Recurring detection, price-increase / duplicate / trial-conversion alerts |

Budgeting style: **category targets + savings goals** (not envelope /
zero-based).

## Architecture

```
                ┌──────────────── UI (Next.js) ────────────────┐
 Connectors ──► │   Domain operations (typed, schema'd)        │ ◄── Tally (chat, tool calling)
 (SimpleFIN;    │   categorize, createRule, setTarget,         │ ◄── MCP server (Claude Code /
  Plaid later)  │   matchReimbursement, querySpend, …          │      desktop on your own data)
                │          ↓ every write goes through ↓         │ ◄── Nightly pipeline
                │   Command log: actor · reason · undo          │
                └──────────────────────────────────────────────┘
```

Three load-bearing decisions, made up front so agentic features aren't a
retrofit:

1. **One operations layer.** Every action is a typed function with an input
   schema. The UI calls it, Tally calls it as a tool, the MCP server exposes
   it. One implementation, three surfaces.
2. **Provenance on every write.** The command log records who made a change
   (`user`, `rule:<id>`, `tally`, `import`), why, and how to undo it. An
   assistant editing money data is only trustworthy if every edit is
   visible and reversible.
3. **Tally proposes, you approve.** Read tools run freely. Write tools
   produce proposals accepted in one tap; specific trusted actions can be
   promoted to auto-apply later.

### Bank connection

**SimpleFIN Bridge** is the primary connector (~$15/yr, up to 25
institutions, read-only, daily refresh). It returns raw descriptions with no
categories or merchant cleanup — acceptable, because categorization is ours
anyway. Everything sits behind a `Connector` interface
(`sync(since) → RawTransaction[]`) so Plaid's free Trial plan (10 lifetime
Items, richer merchant data) can be added later per-institution without
touching anything downstream. Teller was considered and set aside (narrower
coverage; personal use of its dev tier is a grey area).

Manual CSV upload is deliberately **not** a supported workflow — sync is
automatic or it isn't done.

### Categorization pipeline

1. User rules (deterministic, free)
2. Merchant memory — how this merchant was categorized before
3. LLM classifier with a confidence score
4. Above threshold → applied (with provenance); below → review inbox
5. Corrections offered back as rules, and kept as labeled examples for evals

Only the description, amount and date are ever sent to a model — never
account numbers, balances or connection tokens.

### Nightly pipeline

Sync → categorize → detect recurring → match reimbursements → anomaly
checks → digest. Runs as a durable workflow so a failed step retries rather
than half-completing.

### Diary bridge

At the end, a read-only, versioned API (`/api/bridge/v1/…`) serving
aggregates only — daily spend by category, recurring charges, and later
merchant→place links — behind a server-to-server token. No
transaction-level endpoint. Data Diary consumes it like any other import,
and finance-derived charts are never public there.

## Stack

Same as Data Diary, so the new learning is finance and agents rather than
tooling: Next.js on Vercel, Neon Postgres + Drizzle, Tailwind + shadcn/ui.
Additions: AI SDK with Claude via Vercel AI Gateway (Tally), Vercel
Workflow + Cron (nightly pipeline), an MCP server, passkey auth with short
sessions, and connection tokens encrypted at rest. Vercel's `eve` agent
framework is worth a spike before committing to hand-wired AI SDK +
Workflow.

## Environments

- **Production** — real data.
- **Preview / PR databases** — **seeded synthetic data only.** Unlike Data
  Diary, preview databases are never branched from production, so real
  transactions are never copied into a PR environment.

## Setup (owner-only steps)

1. Rotate the legacy app's Plaid / FMP / Firebase keys if not already done.
2. Subscribe to SimpleFIN Bridge, link every institution, and check
   coverage and description quality (including whether Venmo connects
   directly) before the connector sub-issue starts.
3. Create the Vercel project and Neon project.

4. Generate `SESSION_SECRET` and `OWNER_SETUP_TOKEN` (see `.env.example`)
   and set them, plus `DATABASE_URL`, `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`,
   in Vercel's production environment.

## Development

Requires Node 20.18+ (CI uses 22).

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run db:migrate           # apply drizzle/ to DATABASE_URL
npm run db:seed              # synthetic data only — see below
npm run dev
```

Open http://localhost:3000. On a database with no passkey yet, the login
page asks for `OWNER_SETUP_TOKEN` and registers your first passkey; after
that it's passkey sign-in only. Add a second device under Settings early.

| Script | What it does |
|---|---|
| `dev` / `build` / `start` | Next.js |
| `lint` | ESLint |
| `typecheck` | `next typegen` then `tsc --noEmit` |
| `test` | Vitest, including migrations + seed against in-process Postgres (PGlite) |
| `db:generate` | Diff `src/db/schema.ts` into a new SQL migration in `drizzle/` |
| `db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `db:seed` | Replace synthetic data in `DATABASE_URL` |
| `db:studio` | Drizzle Studio |

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | everywhere | Neon connection string |
| `SESSION_SECRET` | everywhere | Signs session cookies (32+ chars) |
| `OWNER_SETUP_TOKEN` | everywhere | Registers the first passkey on an empty database; inert afterwards (24+ chars) |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | production (required) | The domain passkeys are bound to. Elsewhere they're derived from the request, so each preview URL works |

### Authentication

Single owner, passkeys only (WebAuthn, user verification required). No
password exists to leak or phish.

- **Every route is gated by default** in `src/proxy.ts`; the only public
  paths are `/login` and `/api/auth/*`. The proxy checks the cookie's
  signature and expiry; pages then re-check the session row in the database
  (`requireOwner()`), which is what makes sign-out and revocation real.
- **Sessions last 12 hours, absolute** — no sliding renewal. The cookie is
  `HttpOnly`, `SameSite=Strict`, and `Secure` outside localhost; the
  database stores only a hash of the session ID.
- **Challenges are single-use**, stored server-side and deleted on first
  use.
- **Recovery** if every passkey is lost: delete the rows in `passkeys` (and
  `sessions`) directly in Neon, then sign in with `OWNER_SETUP_TOKEN` again.
  Rotate the token afterwards.

### Database migrations

Schema lives in `src/db/schema.ts`. To change it:

1. Edit the schema, then `npm run db:generate -- --name <what-changed>`.
2. Read the generated SQL in `drizzle/` and commit it with the change — the
   SQL is what gets reviewed and what runs.
3. `npm run db:migrate` applies it.

This is a deliberate break from Data Diary's `drizzle-kit push`. Push diffs
live against the database and can't be reviewed ahead of time, and its
rename-vs-drop prompt fails in CI. Committed migrations are reviewable, and
`scripts/migrate.ts` applies all pending ones in a single transaction, so a
failure rolls back cleanly instead of leaving the schema half-changed. CI
applies every migration to an empty in-process Postgres on each PR.

**Production** migrations run automatically from
`.github/workflows/migrate-prod.yml` whenever a merge to `main` changes
`drizzle/` (one-time setup is in that file's header). Vercel deploys the
same commit in parallel, so write migrations that are safe with both the
old and new code: add before you use, stop using before you drop.

## Operations layer

Every change to ledger data is an **operation** (`src/operations/`): a
named, typed function with a zod input schema, marked read or write. The
registry (`registry.ts`) is the single list the UI, Tally, the MCP server
and the nightly pipeline all draw from; `describeOperations()` gives each
one's JSON Schema for tool-calling surfaces.

Everything runs through `execute()` in `runtime.ts`, which:

- validates input and the **actor** (`user`, `tally`, `import`, `rule:<id>`);
- applies a write and its **command log** entry in one transaction, with a
  required one-line reason;
- turns **Tally's writes into proposals** (status `proposed`, nothing
  applied) until the owner approves or rejects them. Any actor can also ask
  to propose. Promoting an operation to auto-apply for Tally is an explicit
  code change, not a request flag;
- leaves reads unlogged — the log answers "who changed what", not "who
  looked".

**Undo is generic.** Write handlers never touch the database directly; they
call `ctx.insert` / `ctx.update` / `ctx.remove`, which snapshot each row
before and after (`to_jsonb`) into the log entry. Undo restores those
snapshots in reverse order, refuses if any row has changed since (undo the
newer change first), and is itself logged. Database-side effects such as
`ON DELETE SET NULL` aren't captured, so an operation that would trigger
one makes those changes itself first.

**Writing around the layer is a lint error.** ESLint flags
`insert`/`update`/`delete`/`execute` on a `db`/`tx` handle (or `getDb()`)
anywhere outside the runtime, auth, seed and tests. It relies on handles
being named `db` or `tx`, so it catches accidents, not determination.

The **Activity** page lists the log, with Approve/Reject on proposals and
Undo on applied writes.

To add an operation: define it with `defineRead` / `defineWrite` next to
its neighbours, add it to `operations` in `registry.ts`, and add any new
table it writes to `trackedTables`. Write the description for a model as
much as a person: it becomes Tally's and MCP's tool description.

### Synthetic data

`npm run db:seed` writes ~6 months of invented transactions across four
fake accounts (checking, savings, a credit card and a payment app): payroll,
rent, subscriptions (one with a price rise), annual charges, everyday card
spend, and shared dinners that friends pay back. Every merchant, employer,
institution and person in it is made up (`src/lib/seed/generate.ts`).

It is safe to re-run, and it **refuses to touch a database that holds any
non-synthetic account**, so pointing it at production by mistake does
nothing. Preview databases are created empty and seeded this way — never
branched from production.
