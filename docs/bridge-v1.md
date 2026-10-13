# Diary bridge, v1

Data Diary uses this contract to read from Data Ledger (#12). It is a
read-only, aggregate-only API. Data Diary treats it as one more import
source, and finance-derived charts there are never public.

Version 1 is frozen once Data Diary consumes it. Fields are never renamed
or removed in place; a breaking change ships as `/api/bridge/v2/`
alongside v1. New optional fields may be added to v1, so ignore fields
you don't recognize.

## What's deliberately not here

- **No transactions.** There is no transaction-level endpoint: no
  descriptions, transaction ids, accounts, account numbers or balances.
- **No writes.** Every endpoint is `GET`.
- **No passthrough.** Each response is built field by field
  (`src/lib/bridge/v1.ts`). Nothing returns an internal query's rows, so a
  new column in the ledger can't appear here by accident.

## Auth

Every request carries the shared server-to-server token:

```
Authorization: Bearer <BRIDGE_TOKEN>
```

- **Where it lives:** `BRIDGE_TOKEN` is set in both apps' environments,
  never in code. It must be at least 32 characters; generate one with
  `openssl rand -base64 32`. If it's unset or shorter, the bridge refuses
  every request.
- **Separate from the cron token:** it is not `CRON_SECRET`, so either
  can be rotated without breaking the other.
- **Rotating:** set the new value in both apps, then redeploy both.
- **Base URL:** call production's canonical domain. Bridge routes are
  never redirected, so a deployment-specific URL also works.

## Common behavior

- **Format:** responses are JSON, with `Cache-Control: no-store`.
- **Money:** amounts are integer cents in USD; `1299` is $12.99.
- **Dates:** `YYYY-MM-DD`, in the ledger's own day; no times or time zones.
- **Errors:** `401 {"error":"Unauthorized"}` for a missing or wrong token,
  and `400 {"error":"…"}` for bad parameters. Anything 5xx is safe to retry
  later.

## `GET /api/bridge/v1/spend/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`

Net spend per day per expense category, with `from` and `to` inclusive.
Both are required, and a request may cover at most 400 days.

```json
{
  "version": "v1",
  "from": "2026-06-01",
  "to": "2026-06-30",
  "days": [
    { "date": "2026-06-02", "categoryId": "5b0c…", "category": "Groceries", "parentCategory": "Food", "spentCents": 8423 },
    { "date": "2026-06-02", "categoryId": "9e41…", "category": "Coffee", "parentCategory": "Food", "spentCents": 475 }
  ]
}
```

These are the same numbers the ledger's Budgets page counts:

- **Which date:** the day it was experienced (when the owner set one),
  otherwise the posted day.
- **What counts:** only accounts that count toward budgets. A split
  transaction counts in its parts.
- **Net of friends' shares:** what friends owe on a shared expense
  doesn't count, so only the owner's share does.
- **Not spend:** income, transfers and uncategorized transactions are
  left out.
- **Refunds:** a refund reduces its day, so `spentCents` can be negative.
  Days with nothing are omitted, not sent as zero.
- **Joining:** use `categoryId`; names can be renamed. `parentCategory`
  is `null` for a top-level category.
- **Numbers can change:** a recategorization or a newly shared expense
  can change past days, so re-fetch a window instead of appending.

Rows are sorted by date, then category.

## `GET /api/bridge/v1/recurring`

Recurring charges as of today, taking no parameters.

```json
{
  "version": "v1",
  "on": "2026-06-30",
  "charges": [
    {
      "merchant": "Streamly",
      "status": "confirmed",
      "cadence": "monthly",
      "typicalCents": 1599,
      "latestCents": 1599,
      "variable": false,
      "lastOn": "2026-06-12",
      "nextExpectedOn": "2026-07-12",
      "annualizedCents": 19188,
      "active": true
    }
  ]
}
```

- **`status`:** `confirmed` means the owner marked it as a subscription
  or bill. `suggested` means the ledger detected it and the owner hasn't
  decided. Charges the owner dismissed are left out.
- **`cadence`:** one of `weekly`, `biweekly`, `monthly`, `quarterly`,
  `semiannual` or `annual`.
- **`active`:** `false` once charges have stopped.
- **Same merchant, two accounts:** this gives two rows, because the
  account isn't included.

Rows are sorted by merchant.

## Later

- **Merchant→place links**, joining a merchant to a Data Diary place.
  They'll be added to v1 as a new endpoint once the ledger has them.
