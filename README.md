# Data Ledger

A personal, single-user finance app: automatic bank sync, categorization
that learns instead of nagging, flexible budgets, subscription tracking, and
an assistant — **Tally** — that works on the same operations the UI does.

Sibling to [Data Diary](https://github.com/boraedis/data-diary). The two are
deliberately independent: Data Ledger owns accounts, transactions, budgets
and bank connections; Data Diary treats it as one more external source and
pulls a narrow, aggregate-only feed at the very end (see "Diary bridge").

> **Status:** planning. No app code yet — the founding epic and its
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

Install / env-var / script docs land here with the scaffold sub-issue.
