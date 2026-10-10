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
 Connectors ──► │   Domain operations (typed, schema'd)        │ ◄── Tally (chat, tool calling,
 (SimpleFIN;    │   categorize, createRule, setTarget,         │      self-hosted open model)
  Plaid later)  │   matchReimbursement, querySpend, …          │
                │          ↓ every write goes through ↓         │ ◄── Nightly pipeline
                │   Command log: actor · reason · undo          │
                └──────────────────────────────────────────────┘
```

Three load-bearing decisions, made up front so agentic features aren't a
retrofit:

1. **One operations layer.** Every action is a typed function with an input
   schema. The UI calls it, Tally calls it as a tool, the nightly pipeline
   runs it. One implementation, every surface.
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

Runs after every sync (and after each correction in the inbox), only on
uncategorized transactions in accounts that count toward budgets, and
never overwrites a category that's already set:

1. **Rules** — the owner's own, in priority order: merchant or description
   equals / contains / starts with a pattern, optionally limited to one
   account or an amount range. No regex (a user pattern run over every
   transaction is a ReDoS risk, and these cover the real cases).
2. **Merchant memory** — if this merchant's last few categorizations
   (up to 5) all agree, repeat it; one past categorization is enough. If
   they disagree, it only *suggests* in the inbox.
3. **The model** (see "Model service"), only for what rules and memory
   left — and memory's mixed-history cases stay the owner's call. Answers
   at or above `MODEL_AUTO_APPLY_THRESHOLD` (default 90%) are applied as
   actor `model`, one undoable batch; the rest become **suggestions**,
   pre-selected in the inbox with the model's confidence. Each transaction
   goes to the model once (even "don't know" is recorded), so it's never
   paid for twice.
4. Everything else waits in the **review inbox**.

The model step runs only when asked: **nightly**, and from the inbox's
**Ask the model** button. A cold start takes ~2½–4½ minutes (measured on
the A100; most of it is vLLM's startup profiling, not something a cache
fixes) and a function gets 5 — and on Vercel's Hobby plan a daily cron can
fire anywhere in its hour — so the nightly model work is a
**self-continuing job**: when the sync cron finishes it triggers
`/api/cron/classify`, which answers 202 at once and works after
responding until just before its own deadline (its first call is what
wakes the GPU). If there's work left, or the model was still booting, it
triggers itself again and the next run finds the model warm; it stops
when nothing is left for the model, and never goes past 6 links.

Merchant memory treats the model's confident answers like any other
categorization history, so a merchant the model files once is then
handled by memory. Undoing a model batch doesn't undo memory batches
that followed from it. Inbox corrections and "Sync now" never wake the GPU.
If the model is unreachable or out of time, nothing breaks — those
transactions stay in the inbox and are tried next time.

**How good is it on *your* data?** Settings → Model → **Evaluate on my
history** asks the model about up to 30 transactions you've already
categorized (that it has never seen), hiding the answer, and stores only
the scores: right / wrong / "don't know", and for each threshold how many
would be auto-applied and how many of those would be right. It also names
the lowest threshold with no wrong auto-applied answer, to set
`MODEL_AUTO_APPLY_THRESHOLD` from.

Rules and memory key on a **merchant name** derived from the raw
description (`src/lib/categorize/merchant.ts`): processor prefixes, store
numbers, dates, card masks and reference codes are stripped, so
"SQ *CORNER BEAN CAFE #12 06/28" and "POS PURCHASE CORNER BEAN CAFE #7"
are both "Corner Bean Cafe". The raw description is never modified.

Each rule's results are one command (actor `rule:<id>`) and memory's are
one command (actor `memory`), so Activity reads "Rule … categorized 23
transactions" and each batch is undoable as a whole.

**Inbox** (`/inbox`) is keyboard-first: ↑/↓ moves, typing filters
categories, Tab cycles matches, Enter assigns, **Shift+Enter assigns and
creates a "merchant is …" rule**. Every assignment re-runs the pipeline, so
the rest of that merchant's transactions clear themselves. On a phone, tap
a transaction and pick from the list that opens under it.

**Categories** are the owner's tree (two levels; no bank categories), with
rules managed on the same page (`/categories`). A category in use can't be
deleted — recategorize or move what uses it first.

**Splits, tags and experience dates** live on each transaction's page
(`/transactions/<id>`, reached from the Transactions list or the inbox):

- **Split** a transaction into 2–20 parts, each with its own category and
  note. Parts are integer cents with the transaction's sign and must add
  up exactly. A split counts as categorized; choosing a single category
  replaces it.
- **Tags** are free-form labels alongside categories ("vacation-2026",
  "tax-deductible"), matched ignoring case, created as you type them.
- **Experience date** is when a purchase was actually *for* — tickets
  bought in March for July. Budgets use it instead of the posted date.

All three carry over when a pending transaction posts under a new ID. The
definition budgets build on is `transactions.spendingLines`: one line per
categorized transaction or split part, dated by experience date when set,
budget accounts only by default.

Only the description, amount and date are ever sent to a model — never
account numbers, balances or connection tokens — and that model is always
the owner's own (see below).

### AI: one self-hosted model

The app has **one model**, and every AI feature goes through it: Tally's
chat (#11), the categorization classifier (#6), the nightly digest, alerts
and suspicious-transaction checks. It's an **open-weight model in the
owner's own container** (#39), so no AI company processes the data — no
Claude, OpenAI or Gemini APIs, no third-party inference APIs (even "zero
retention" ones), no AI gateways, and no external assistants connecting
in. The container runs on a GPU platform that scales to zero, the same
trust level as Vercel and Neon.

See "Model service" below for how it's hosted, called and chosen.

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
Additions: Vercel Workflow + Cron (nightly pipeline), passkey auth with
short sessions, connection tokens encrypted at rest, and one self-hosted
open-weight model served by vLLM on Modal (see "AI: one self-hosted
model").

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

### Local database (no Neon needed)

`npm run db:local` serves an in-process Postgres (PGlite) on
`localhost:54329`, stored in `.pglite/` (git-ignored). Point
`DATABASE_URL` at it and everything — app, migrations, seed — uses the
plain `pg` driver instead of Neon's:

```bash
npm run db:local   # leave running in its own terminal
```

with `DATABASE_URL=postgresql://postgres@localhost:54329/postgres` in
`.env.local`, then `npm run db:migrate`, `npm run db:seed`, `npm run dev`.
PGlite is single-session, so the local pool holds one connection: run the
seed and migrations *before* `npm run dev`, not alongside it. Any other
local Postgres works the same way.

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
| `db:local` | Local PGlite server on port 54329 (see "Local database") |
| `model:eval` | Score the configured model on synthetic categorization and tool calls |

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | everywhere | Neon connection string |
| `SESSION_SECRET` | everywhere | Signs session cookies (32+ chars) |
| `OWNER_SETUP_TOKEN` | everywhere | Registers the first passkey on an empty database; inert afterwards (24+ chars) |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | production (required) | The domain passkeys are bound to. Elsewhere they're derived from the request, so each preview URL works |
| `CONNECTION_ENCRYPTION_KEY` | everywhere | Encrypts bank-connection credentials at rest (32 bytes, base64). Changing it orphans stored connections |
| `CRON_SECRET` | production | Bearer token Vercel Cron sends to `/api/cron/sync` (16+ chars) |
| `MODEL_BASE_URL` | optional | The model's OpenAI-compatible base URL, ending in `/v1`. Unset = no AI features; everything else works |
| `MODEL_API_KEY` | with the above | The key the model server requires (same value as its `VLLM_API_KEY`) |
| `MODEL_NAME` | optional | Model name to request; defaults to `ledger`, the name `model/serve.py` serves under |
| `MODEL_AUTO_APPLY_THRESHOLD` | optional | Confidence (0–1) at or above which the model's category is applied rather than suggested; default 0.9 |

### Authentication

Single owner, passkeys only (WebAuthn, user verification required). No
password exists to leak or phish.

- **Every route is gated by default** in `src/proxy.ts`; the only public
  paths are `/login`, `/api/auth/*`, and `/api/cron/sync` (which requires
  `CRON_SECRET` instead of a session).
- **Production has one domain.** Requests to any other production hostname
  (Vercel's per-deployment URLs) redirect to `WEBAUTHN_ORIGIN`, since
  passkeys only work on the domain they were created for. The proxy checks the cookie's
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

## Bank sync

Bank data arrives through **connectors** (`src/lib/connectors/`): one
interface, `fetch(since) → { accounts with balances, transactions,
messages }`, in the app's own shapes (integer cents, `YYYY-MM-DD`). Nothing
past that boundary knows which provider was used. SimpleFIN Bridge is the
only implementation today.

**Connecting:** Settings → Bank connections → paste a SimpleFIN setup
token. The server claims it (only ever against `bridge.simplefin.org` /
`beta-bridge.simplefin.org`), stores the resulting access URL encrypted
with AES-256-GCM, and runs the first sync right away. A token that's
already been claimed is reported as a possible compromise, as SimpleFIN's
spec asks.

**Syncing** (`src/lib/sync/run.ts`) runs daily from Vercel Cron at 10:17
UTC (off the hour, as Bridge asks; `vercel.json`) — with model
categorization chained after it — and on demand from
Settings. Each run:

- fetches from 5 days before the last success (Bridge's recommended
  overlap), or 90 days back the first time;
- splits anything longer than **45 days** into chunks with explicit end
  dates. Bridge's docs say 90 days per request, but the live server warns
  past 45 and slides the window on longer requests, dropping the newest
  transactions;
- stays under **20 requests per connection per 24 hours** (Bridge expects
  ≤24 and disables tokens that go well past it), counted per request, so a
  two-request backfill can't overshoot;
- applies everything through the `import.applySnapshot` operation, which
  only the `import` actor may run. A sync is therefore one logged, undoable
  command. Matching is on provider IDs, unchanged rows aren't written, and
  bank fields never overwrite the owner's category;
- reconciles **pending → posted**: a pending transaction inside the window
  that the bank no longer returns is removed, and a newly posted one with
  the same account and amount within 5 days inherits its category.

**Health:** a 403 or 402 marks the connection broken (only reconnecting
fixes it); other failures just fail that night. Provider messages are kept
per institution and always shown, as Bridge asks. An institution with no
new data in 72 hours is flagged stale. Any of these shows a banner on every
page.

Account kinds aren't provided by SimpleFIN, so they're guessed from the
account name once, when first seen: checking, savings, credit, payment
app, brokerage, retirement, loan or other asset. The guess errs toward
recognizing investment accounts ("IRA", "401(k)", "Brokerage"…), because it
also decides whether a new account **counts toward budgets**: investment,
retirement, loan and asset accounts start excluded, so a brokerage's trades
and dividends never read as spending before you've looked at it.

On the **Accounts** page you can change an account's kind, give it your own
name, and include or exclude it from budgets, all through the
`accounts.update` operation, so each change is logged and undoable. Syncs
refresh the bank's own name and balance but never touch your name, kind or
budget flag. Every spending query and budget must filter on
`countsTowardBudgets` (`budgetAccountIds()` in `src/operations/accounts.ts`;
`transactions.list` takes `budgetOnly`).

### Net worth

Banks only ever report a balance "as of now", so history that isn't
captured on the day is lost for good. Every sync therefore records each
account's balance in `balance_snapshots`, one row per account per UTC day
(a second sync that day replaces it), inside the same undoable import
command. History starts the day this shipped; it can't be backfilled.

**Net worth = assets − liabilities.** Providers disagree on the sign of a
debt (a card owing $500 arrives as `-500.00` from some and `500.00` from
others), so credit cards and loans always count as **what's owed,
−|balance|**. Every other kind counts as reported, so an overdrawn checking
account is negative. The one known miss: a card with a credit balance
counts as a small debt rather than a small asset. Stored balances are never
rewritten; the convention is applied when reading
(`src/lib/net-worth.ts`), so fixing an account's kind also fixes its
history. Between snapshots a balance carries forward. Only USD is summed;
an account in another currency is listed but left out.

**Manual accounts** cover what no aggregator does: a home, a car, a loan
from a friend, an account at an unsupported institution. Add one under
Accounts → Manual with a kind and a value as of a date; for a loan or credit
kind the value is the amount owed. Each update (`accounts.setManualValue`)
is a dated balance snapshot, so manual accounts feed net-worth history like
synced ones. Back-dating an entry fills in history without replacing the
current value, and a second entry for the same date corrects the first. They
are marked "Manual" wherever they appear, never count toward budgets, and
syncs never touch them. Creating, updating and removing them (which removes
their history too) are owner-only operations, logged and undoable; Tally
can't run them, since it would see the values.

Net worth is deliberately **not** an operation: every registered read
becomes one of Tally's tools, and balances never go to a model.

## Operations layer

Every change to ledger data is an **operation** (`src/operations/`): a
named, typed function with a zod input schema, marked read or write. The
registry (`registry.ts`) is the single list the UI, Tally and the nightly
pipeline all draw from; `describeOperations()` gives each
one's JSON Schema for tool-calling surfaces.

Everything runs through `execute()` in `runtime.ts`, which:

- validates input and the **actor** (`user`, `tally`, `import`, `rule:<id>`),
  including operations restricted to certain actors (`allowedActors`);
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
much as a person: it becomes Tally's tool description.

## Model service

**Hosting** (`model/serve.py`): vLLM serving one pinned open-weight model
behind an OpenAI-compatible API, in a Modal container that scales to zero
3 minutes after the last request. Every request needs the API key (vLLM
enforces it; the server refuses to start without one). Model weights and
compiled kernels live on Modal volumes, so only the first-ever boot
downloads them. The first request after idle meets a **cold start** —
about 3½ minutes on the A100 with weights cached (measured Oct 2026).

**Owner setup:**

1. Create a Modal account, then install the CLI locally:
   ```bash
   pip install modal && modal setup
   ```
2. Create the server's API key as a Modal secret (it never enters the repo):
   ```bash
   modal secret create data-ledger-model VLLM_API_KEY="$(openssl rand -base64 32)"
   ```
3. Deploy, and note the URL it prints:
   ```bash
   modal deploy model/serve.py
   ```
4. In Vercel (Production), set `MODEL_BASE_URL` to that URL plus `/v1`
   and `MODEL_API_KEY` to the same key. Redeploy.
5. Settings → Model → **Test model** confirms the round trip.

Changing models is a pull request to `model/serve.py`, justified by
`npm run model:eval` numbers. Moving the model to home hardware later is
just a different `MODEL_BASE_URL`.

**Calling it** (`src/lib/model/`): every feature uses `chat()`, never its
own HTTP client.

- **Cold starts are expected:** 502/503/504 are retried with backoff — up
  to 10 minutes for background work, 5 for interactive — then reported as
  "still starting up".
- **Minimal data is enforced here, not per feature:** transactions reach
  the model only through `modelTransaction()` (description, amount, date),
  and tool results through `toolResult()`, which strips balances, account
  numbers, provider ids and credentials at any depth.
- **Every call is logged without content** in `model_calls` (feature,
  latency, tokens, cold-start retries, outcome) — never the prompt or the
  reply. Settings shows the recent numbers.
- **No model is a normal state:** with `MODEL_BASE_URL` unset, AI features
  simply don't run.

**Choosing the model:** `npm run model:eval` scores whatever
`MODEL_BASE_URL` points at, using only the seed's invented merchants: how
many transactions it categorizes correctly (and whether its confidence is
higher when it's right), and whether it calls the right tools with sane
arguments.

