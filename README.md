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

0. **Transfers** (#24) — a cash-account transaction and one in a
   brokerage or retirement account with exactly opposite amounts, within 5
   days, are paired as the two sides of a transfer (actor `matcher`, one
   undoable command per run). A paired transaction needs no category: it
   leaves the inbox and never counts as spending or income. Only
   unambiguous pairs — on a tie for closest date, neither is paired — and
   never a cash side the owner already categorized. "Not a transfer" on the
   transaction page unpairs both sides and the matcher leaves them alone.
   Cash↔investment only for now: between two everyday accounts (say, a
   $20 card charge and a $20 payment-app receipt) a coincidental match is
   too likely.
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

### Budgets

**Category targets plus one buffer** (#7; rules in `src/lib/budgets/engine.ts`).

- **Targets and periods:** a target is an amount per period for an expense category. A period is N months counted from an anchor month: 1 is monthly, 12 annual (January by default), anything else custom, such as every 3 or 6 months.
- **Parents and children:** a target on a parent covers its children, unless a child has its own target.
- **The buffer:** one target with no category, which every expense category without a target draws from, so "misc" never needs a category of its own. What drew from it is listed by category, which is where a new target suggests itself.
- **Net spend:** spending minus refunds, in accounts that count toward budgets, by experience date (`transactions.spendingLines`). Income and transfer categories, uncategorized transactions and matched transfers never count. Shared expenses count only your share; "Show gross" shows spending as charged.
- **Versioned:** a change starts a new version at the beginning of the current period, so earlier periods keep the target they had. Browse earlier months on the Budgets page to see them as they were.
  - **Same-period edits** correct that version instead of adding one.
  - **Schedule changes:** if the period itself changes (monthly → annual in October), the new schedule's first period starts at that boundary and is prorated by months, so nothing is counted twice.
  - **New annual targets** cover the whole year, giving true year-to-date figures.
  - **Removing a target** keeps its history; its spending falls to the buffer from then on.
- **Rollover:** per target, the remainder (or overspend) carries into the next period while rollover stays on. A gap resets it.
- **Annual and other multi-month targets** show year-to-date (period-to-date) spend against an even-pace marker. With a sinking fund, they also show the monthly set-aside and how much should be set aside by now.
- **Rebalancing:** `budgets.rebalance` moves money between two targets for the current period only, as a dated adjustment pair. Both targets stay as they are.
- **Operations:**
  - **Reads:** `budgets.status` and `budgets.targets`. Budget figures come from transactions, not balances, so Tally may read them.
  - **Writes:** `budgets.setTarget`, `removeTarget` and `rebalance`. All are logged and undoable, and Tally's are proposals.

### Savings goals

**Goals** (#10) are something to save toward: a target, and optionally a date.

- **Where progress comes from:**
  - the **linked accounts' balances** (savings, or a brokerage for a down payment; never cards or loans);
  - **transfers tagged** with the goal's tag. Tag the transfer *out* of your everyday account: it counts as `−amount`, so money moved back counts against the goal.
  - A tagged transaction in a linked account is skipped, because it's already in that balance.
  - Progress before the goal was set counts, so a goal starts from what's already saved.
- **History:** progress is never stored. It's rebuilt from the daily balance snapshots (#25) plus cumulative tagged transfers, which gives every goal a chart. It isn't an operation, because it includes balances. `goals.list` and `goals.create`, `update` and `archive` carry only the definitions, so Tally can see and propose goals without seeing balances.
- **Pace:**
  - **With a date:** an even line from where you were when the goal was set to the target. You're *on track* within 1% of the target, *behind by $X* below that, and the page shows what it takes per month to finish on time.
  - **Without a date:** the last 90 days' trend projects when you'd reach it.
- **Sinking funds:** budgets (#7) and goals share the same pace math (`src/lib/pace.ts`). Budget targets with a sinking fund are also listed on the Goals page.

### Shared expenses and reimbursements

Spending friends pay back mustn't inflate your spending, and their payments
mustn't look like income (#8).

- **People** are a light list (`people.*`): a name plus the spellings payment apps use for it. Data Diary's people catalog joins through the bridge later.
- **Sharing an expense:** on a posted expense's page, record what each person owes, or split it evenly; you keep any leftover cent. Your share is the rest. **Net spend counts only your share, from the moment it's recorded**, whether or not they've paid yet. `transactions.spendingLines` is net by default and takes `gross: true` for spending as charged; the Budgets page has a "Show gross" toggle.
- **Matching payments:** the Owed page proposes incoming payments (checking, savings, payment apps) as matches, using the name in the description, the amount and the timing (`src/lib/reimbursements/match.ts`).
  - **Kinds of match:** exact, several expenses one payment covers, partial (applied oldest first), or more than owed (the rest stays an ordinary transaction).
  - **Strong evidence first:** exact and combined matches across all payments are assigned before partial ones, so an unrelated earlier payment from the same friend can't claim the debt.
  - **You confirm:** nothing is matched until you do (`reimbursements.match`).
- **What a match does:** the matched part of a payment is never income, even if the payment was categorized. A fully matched payment leaves the inbox.
- **"Not a reimbursement"** stops a payment being proposed.
- **Forgiving** stops expecting the rest of a debt; its unpaid part counts as your spend again.
- **Owed to me** shows what each person still owes, with aging buckets (0–30, 31–60, 61–90, over 90 days since the expense), and every open item.
- **Logging:** every change is a logged, undoable operation. Payment names and amounts are ordinary transaction data, so Tally may read them.

### Pay stubs

Each pay stub is recorded as structured income (#60, `payStubs.*`), so a paycheck is its gross pay and every deduction, not just the deposit. The Pay page lists them and shows the year's totals.
- **What's stored:** an employer label, the period, the pay date, gross, each deduction and net. Each deduction has a kind, the stub's own label, positive cents and an optional category. Kinds are grouped into tax, insurance, retirement and savings, and other (`src/lib/pay/stubs.ts`). Amounts and labels only: an SSN, employer ID or address is never entered or stored.
- **Checked on save:** gross minus the deductions must equal net exactly.
- **Faster entry:** a new stub starts from the last one, moved on one period.
- **Linked to the deposit:** the deposit of exactly the net amount near the pay date is linked when there's only one candidate, both on save and nightly as `matcher`. Otherwise you pick it. Only posted deposits can be linked.
- **Counted as gross:** a linked deposit counts in budgets as gross pay in the deposit's category, plus a negative line per deduction in that deduction's category (`transactions.spendingLines`). A deduction without a category is taken off the gross instead. The parts always add up to the deposit, so the net is never counted twice. Use a transfer category for a 401(k): it's savings, not spending.

**Tax estimate** (#61, Wealth → Taxes, `/pay/taxes`): the year's position from these stubs. It's an estimate from your own numbers, not tax advice.
- **Withholding:** per tax so far, with the stub count, and projected to year end at the pace of the last three stubs. The cadence comes from the pay dates. Insurance and retirement deductions are shown separately, since they aren't taxes.
- **Federal balance:** wages less the usual pre-tax deductions (401(k), HSA, FSA, insurance), plus other income, less the standard or itemized deduction. That goes through the year's brackets and credits, and is set against withholding plus other payments, giving a likely refund or amount owed.
- **Social Security and Medicare:** checked against what they should come to on your wages.
- **Not modelled:** state income tax (only what's withheld is shown) and Additional Medicare Tax.
- **Your inputs:** filing status, other income, itemized deductions, credits and other payments, stored per year through `taxes.setAssumptions`.
- **Starting mid-year:** a year whose first stub starts after January says its figures are too low.
- **Federal figures:** come from `src/lib/taxes/tables.ts`, one entry per year with its sources. A year without one gets the pace but no estimate. Add the next year when the IRS publishes it.
- **Kept from Tally:** both operations are owner-only, so none of this reaches the model.

### Recurring charges and alerts

**Detection** (#9; `src/lib/recurring/detect.ts`, rule-based) is computed each time it's read, from the last ~400 days of spending in budget accounts. Transfers (paired, or filed under a transfer category) never count.
- **What a series is:** one merchant in one account. It recurs when its charges land on a steady cadence (weekly, every 2 weeks, monthly, quarterly, twice a year, annual) within a tolerance.
- **How much evidence:** three charges for most cadences, two for annual.
- **Duplicates:** a same-amount charge days after another is one occurrence plus a possible duplicate.
- **Fixed or variable:** a plan within 25% of its usual amount is fixed-price; anything wider is variable (a utility bill).
- **What's stored:** only your decisions (`recurring_series`: confirmed or dismissed), so better detection never needs a backfill.
- **Tracking:** a confirmed series is tracked, with its next expected charge and yearly cost on the Subscriptions page. A dismissed one is never suggested or alerted on again.

**Alerts** (`alerts`) are raised by `alerts.refresh` after every nightly sync, as `matcher`, or on demand with "Check now". Each one says what happened, about events in the last 90 days:
- **Price increase:** a fixed-price series charging more than last time. A step up from a token trial charge doesn't count.
- **Duplicate charge:** the same amount again within 3 days, for a series that charges at most every two weeks.
- **Paying twice:** the same merchant billing in two accounts.
- **Trial ended:** a token charge of 20% or less of the usual price, followed within 40 days by the first full one.
- **Missing charge:** a *confirmed* series past its due date plus tolerance. A merely detected one may simply have ended.

Each event has a dedupe key, so it's raised once, and a dismissed alert never comes back. **Home is the digest:** open alerts plus the inbox, budgets over target and what's owed. `alerts.notifiedAt` is there for push or email delivery (#29) to mark what it has sent.

### Provisional transactions

Near-real-time purchase alerts (#28: bank emails #31, Apple Pay #32) can't wait for the daily sync, so each one creates a **provisional transaction** (`transactions.provisional_source`, #30) that you can categorize, split, tag or share on the spot. The sync stays the source of truth.
- **Created only by an alert** (`transactions.createProvisional`, actor `alert`), keyed on the alert's own id, so a re-delivered alert is recorded once. If the bank already reported the purchase, nothing is added.
- **Matched nightly**, first in the pipeline, as `matcher` (`src/lib/provisional/match.ts`). A match needs the same account, the exact amount, and a bank row dated from a day before to five days after, which arrived after the alert. Everything you set carries over to the bank's row (category or split, experience date, tags, shares friends owe), unless the bank's row already has its own. The provisional row is then removed, as one undoable command, like pending → posted.
- **Never counted twice:** a provisional transaction counts as spending until the bank's data for its account reaches its date. From then on the bank's version counts, whether or not the two were matched.
- **Review:** after a week without a match it's flagged, in the Inbox's "Waiting for the bank" and on Home. Usually the bank charged a different amount (a tip), so you pick the right charge from a short list. Otherwise it was declined or misread, and you discard it. Both are operations (`transactions.matchProvisional`, `transactions.discardProvisional`) and can be undone.
- **Kept out of** transfer matching, recurring-charge detection and reimbursement payments, where a second copy of a purchase would mislead.
- **Apple Pay** (#32): an iOS Shortcuts automation posts each purchase (merchant, amount, the card's Wallet name, the time) to `/api/shortcuts/purchase` with a per-device token from Settings, stored only as a hash and revocable there. The Wallet name maps to an account (`accounts.wallet_card_name`, set in Settings). An unmapped name isn't recorded, but is offered in Settings and sends a notification. A created purchase sends a push that opens it. Setup: [docs/apple-pay-shortcut.md](docs/apple-pay-shortcut.md).
- **Filing from the notification** (#34): a purchase notification opens `/transactions/[id]/quick`, a phone-first screen showing the likely categories as big buttons (`transactions.categoryChoices`, ranked in `src/lib/categorize/choices.ts`): a matching rule, then what you've filed this merchant under before, then the model's guess, then recently used categories, never income for money out. One tap files it; Undo is right there. "Other category" searches the rest, and "Split" itemizes a mixed basket, with the last part taking whatever's left. Every change goes through `transactions.setCategory` or `transactions.split` as `user`.

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

### Tally, the assistant

**Tally** (#11, `/tally`) is the chat face of the same model.

- **Tools are the operations registry** (`src/lib/tally/tools.ts`): every operation Tally may run, with its own description and input schema. A new operation is a new tool.
  - Operations restricted to other actors (the sync's import, the pipeline's batches, owner-only manual accounts) aren't offered.
  - **Reads run immediately. Writes run as actor `tally`,** which the runtime always turns into a **proposal**. It shows inline in the chat with Approve / Reject, and in Activity. Nothing changes until you approve, and the applied command stays logged as `tally`.
- **Minimal data at the tool boundary:** every result passes through `toolResult()`, which redacts sensitive keys and caps size so a long list can't crowd out the conversation (it asks for a narrower request instead). Balances never reach it: net worth, investments and goal progress aren't operations.
- **Streaming:** replies stream from the model through the gateway (`chatStream`) to the page as newline-delimited JSON from `/api/tally`.
- **Cold start:** the first message after the model has been idle meets a cold start (~3–4 minutes). The page shows "Waking the model up", with a timer, instead of hanging. Once warm, replies take seconds.
- **History:** conversations are stored (`tally_conversations`, `tally_messages`; the conversation, not the books), so a reload keeps the thread and its proposals.
- **The nightly digest** is written by Tally at the end of the nightly classify chain, while the model is warm.
  - **Facts it gets:** sync status, new transactions, the inbox, open alerts, budget pace and what's owed, in fixed order and with no balances. It's told to use only those facts.
  - **Storage:** the note is stored beside the facts (`digests`), so any sentence can be checked against what it was told.
  - **Where it shows:** at the top of Home.

### Push notifications

The app notifies the owner's devices itself, with Web Push (#29); no notification service is in between.
- **Installable:** a web app manifest and icons (`src/app/manifest.ts`, `public/icons/`, from `scripts/generate-icons.mjs`). On an iPhone, add it from Safari's Share menu (Add to Home Screen); iOS allows push only for a home-screen app (iOS 16.4+).
- **Devices:** each device opts in from Settings → Notifications and gets a row in `push_subscriptions`. Settings lists them with when they were last notified, and Remove revokes one. A device the push service reports as gone is removed automatically.
- **Private on the way:** every payload is encrypted to the device's own keys, so the push service (Apple's, for an iPhone) delivers it without being able to read it. VAPID keys sign each push, so only this app can send to these devices.
- **Minimal on the lock screen:** a merchant and an amount, never balances or account numbers. `sendPush` (`src/lib/push/send.ts`) is the one way to notify; the purchase-alert and suspicious-charge flows (#31–#33) will use it.
- **What notifies today:** alerts raised by the nightly sync, once each (`alerts.notifiedAt`). Several at once become one summary. Only alerts from the last two days are sent, so turning notifications on doesn't replay old ones.
- **The service worker** (`public/sw.js`) only shows notifications and opens the app where one points. It caches nothing, so no ledger page is stored on the device.

### Nightly pipeline

Sync → match provisional transactions → categorize → detect recurring → match reimbursements → anomaly
checks → digest. (Today: the sync cron categorizes and raises
recurring-charge alerts, then hands the rest to the model's classify chain,
whose last link has Tally write the digest; reimbursement matches are
proposed on read.) Runs as a durable workflow so a failed step retries rather
than half-completing.

### Diary bridge

A read-only, versioned API serving aggregates only (#12). Data Diary
consumes it like any other import, and finance-derived charts are never
public there. The contract for the Diary side is
[docs/bridge-v1.md](docs/bridge-v1.md).

- **Endpoints:** `GET /api/bridge/v1/spend/daily?from&to` gives net spend
  per day per expense category, the same numbers Budgets counts.
  `GET /api/bridge/v1/recurring` gives recurring charges, minus any the
  owner dismissed. Merchant→place links come later.
- **Auth:** a server-to-server bearer token, `BRIDGE_TOKEN`, separate
  from `CRON_SECRET`. Unset or short means every request is refused.
  The proxy lists each bridge path exactly, so a new endpoint is public
  only by a deliberate edit.
- **No transaction-level endpoint and no passthrough:** every response
  field is chosen by name in `src/lib/bridge/v1.ts`. No ids beyond
  categories, and no descriptions, accounts or balances.

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
| `BRIDGE_TOKEN` | optional | Bearer token Data Diary sends to the bridge (32+ chars). Unset = bridge off |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | Push notifications (#29): the key pair from `npx web-push generate-vapid-keys`, and a `mailto:` or https contact. Unset = no notifications |

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

**Connecting:** Settings → Connections → paste a SimpleFIN setup
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

- records **investment holdings** where the provider sends them (Bridge
  includes a `holdings` list per account; not in the published protocol):
  symbol, description, shares as an exact decimal (Postgres `numeric`,
  never a float), market value and total cost basis in cents. One row per
  position per account per day in `holding_snapshots`, replaced by a later
  sync that day, inside the same undoable import command. A zero cost basis
  is stored as unknown, and a position whose numbers can't be read exactly
  is skipped. Holdings are display and history only: an account's net-worth
  value is still its balance, which already includes them, and they never
  become transactions, count toward budgets, or go to a model.

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

**Investment activity** (#24). Brokerage and retirement accounts start
outside budgets, so their buys, sells and dividends never read as spending
or paycheck income. Each of their transactions is labelled by description
rules (`src/lib/investments/activity.ts`, no model): dividend (including
capital-gain distributions), interest, reinvestment, buy, sell, fee,
transfer or other. Labels are computed when read, so changing an account's
kind relabels its history. Dividends and interest that paid money in are
**investment income**, reported on their own (`investments.income`, and on
the Net worth page), never mixed into budget income.

**Investments page** (#27), display only, never advice:
- **Totals and freshness:** the total across brokerage and retirement accounts, each account's value with the day its balance and positions are as of.
- **Unrealized gain or loss:** market value minus cost basis, per position and in total. It covers only positions with a cost basis, and says how many are left out, so the gain is never overstated.
- **Allocation:** by account, and by holding. A holding in several accounts is combined, and the part of a balance the position list doesn't cover shows as "cash and other". An account whose provider doesn't report positions appears whole.
- **Value over time:** per account, from balance snapshots, with that day's position total from holding snapshots.
- **Source of the numbers:** an account's value is always its balance; positions are never added on top. Built in `src/lib/investments/summary.ts`, not an operation, for the same reason as net worth.

Net worth and the investments page are deliberately **not** operations:
every registered read becomes one of Tally's tools, and balances and
holdings never go to a model.

## Operations layer

Every change to ledger data is an **operation** (`src/operations/`): a
named, typed function with a zod input schema, marked read or write. The
registry (`registry.ts`) is the single list the UI, Tally and the nightly
pipeline all draw from; `describeOperations()` gives each
one's JSON Schema for tool-calling surfaces.

Everything runs through `execute()` in `runtime.ts`, which:

- validates input and the **actor** (`user`, `tally`, `import`, `rule:<id>`,
  `memory`, `model`, `matcher`),
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

