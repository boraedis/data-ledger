# Working in this repo

Data Ledger is a personal, single-user finance app (see README.md for the
design). This file is context for anyone — human or AI agent — picking up
work here across sessions.

## This repo is public. Real financial data never enters it.

This is the rule that matters most, and it applies to every surface, not
just committed files:

- **No real data in code, fixtures, seeds, tests, or eval sets.** Use
  synthetic transactions, made-up merchants and invented people. Evals
  built from real categorization history live in the database, never in a
  committed file.
- **No real data in issues, PR descriptions, PR comments, commit messages,
  or screenshots.** When describing a bug, restate it with synthetic values
  ("a $42.50 Venmo from *Alex* matched the wrong dinner"), never paste a
  real transaction, balance, account number, merchant descriptor tied to a
  real account, or a friend's real name.
- **No personal config committed.** Categorization rules, payroll
  descriptors, account nicknames and the like are user data stored in the
  database, not repo config.
- **Secrets only in env vars.** Secret scanning and push protection are
  enabled on this repo. The legacy app committed its Plaid secret — don't
  repeat that.
- **Preview/PR databases are seeded with synthetic data**, never branched
  from production.

If a task seems to require real data in any of these places, stop and ask.

## Architecture invariants

- **Every write goes through the operations layer.** UI, Tally (the
  assistant), the MCP server and the nightly pipeline all call the same
  typed operations; nothing writes to the database around them.
- **Every write is logged with provenance** — actor (`user`, `rule:<id>`,
  `tally`, `import`), reason, and enough to undo it.
- **Tally proposes; the user approves** writes, unless an action has been
  explicitly promoted to auto-apply.
- **Minimal data to models.** Description, amount and date only — never
  account numbers, balances or connection tokens.
- **Connectors sit behind one interface.** Nothing downstream knows which
  aggregator a transaction came from.
- **Reimbursements are not income.** Budgets count net spend (your share);
  gross is available for display only.

## Conventions (carried over from Data Diary)

- **Comments explain *why*,** including what was deliberately not done and
  why.
- **One GitHub issue → one branch → one PR**, with `Closes #N` in the PR
  body. Follow-up feedback on an open PR lands on the same branch. Epic
  sub-issues may use an `epic/<slug>` branch as in Data Diary if a feature
  should reach `main` only once complete.
- After opening or meaningfully updating a PR, comment on its linked issue
  mapping what shipped to the acceptance criteria, and say explicitly what
  couldn't be verified.
- **Verification is `npx tsc --noEmit` + `npx eslint .`** (plus tests once
  they exist) — clean before every commit. Never imply visual or
  bank-connection behavior was confirmed when it wasn't.
- PRs squash-merge.

## Working with GitHub issues

Every issue needs **two** labels: a type (`bug`, `enhancement`,
`UI improvement`, `epic`, `Epic sub-issue`, `idea`) and an effort size
(`LOE: xs` / `s` / `m` / `l` / `xl` / `xxl`; `idea` issues skip LOE).

Issues are tracked on the **Data Ledger** GitHub Project board (separate
from Data Diary's), with `Status` (Backlog → Todo → In Progress → Done),
`Priority` (Urgent / High / Medium / Low) and `LOE` (mirrors the label,
kept in sync manually). New issues go on the board:

```bash
gh project item-add 4 --owner boraedis --url <issue-url>
```

Epics and sub-issues use GitHub's native parent/sub-issue linking.
