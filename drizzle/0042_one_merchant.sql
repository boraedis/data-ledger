-- One merchant everywhere (#292). Recurring decisions and alerts were stored
-- under the cleaned name a charge happened to have; features now see a
-- transaction's merchant by its merchant's name, so what was decided under
-- any spelling moves to that name. Data only: no schema change.
--
-- Recurring decisions: one per merchant and account. Where two spellings of
-- one merchant both had one in the same account, the one already under the
-- merchant's name wins, else the newest.
WITH map AS (
  SELECT a."alias", m."name" FROM "merchant_aliases" a JOIN "merchants" m ON m."id" = a."merchant_id" WHERE a."alias" <> m."name"
)
DELETE FROM "recurring_series" s USING map
WHERE s."merchant" = map."alias" AND EXISTS (
  SELECT 1 FROM "recurring_series" o LEFT JOIN map om ON om."alias" = o."merchant"
  WHERE o."id" <> s."id" AND o."account_id" = s."account_id" AND coalesce(om."name", o."merchant") = map."name"
    AND (o."merchant" = map."name" OR o."created_at" > s."created_at" OR (o."created_at" = s."created_at" AND o."id" > s."id"))
);
--> statement-breakpoint
WITH map AS (
  SELECT a."alias", m."name" FROM "merchant_aliases" a JOIN "merchants" m ON m."id" = a."merchant_id" WHERE a."alias" <> m."name"
)
UPDATE "recurring_series" s SET "merchant" = map."name" FROM map WHERE s."merchant" = map."alias";
--> statement-breakpoint
-- Alerts, verdicts included, and their dedupe keys, so an alert already
-- answered isn't raised again under the merchant's name. A key that would
-- collide with one already there (or another moved in this same statement)
-- stays as it was; the alert still moves.
WITH map AS (
  SELECT a."alias", m."name" FROM "merchant_aliases" a JOIN "merchants" m ON m."id" = a."merchant_id" WHERE a."alias" <> m."name"
), moved AS (
  SELECT al."id", map."name", replace(al."dedupe_key", '|' || map."alias" || '|', '|' || map."name" || '|') AS "key",
    row_number() OVER (PARTITION BY replace(al."dedupe_key", '|' || map."alias" || '|', '|' || map."name" || '|') ORDER BY al."created_at", al."id") AS n
  FROM "alerts" al JOIN map ON map."alias" = al."merchant"
)
UPDATE "alerts" al SET
  "merchant" = moved."name",
  "dedupe_key" = CASE WHEN moved.n = 1 AND NOT EXISTS (SELECT 1 FROM "alerts" x WHERE x."dedupe_key" = moved."key") THEN moved."key" ELSE al."dedupe_key" END
FROM moved WHERE al."id" = moved."id";
