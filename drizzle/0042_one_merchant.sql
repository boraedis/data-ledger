-- One merchant everywhere (#292): recurring decisions and alerts are about
-- a merchant, by id, instead of the cleaned name a charge happened to have.
-- The name stays, for display and for a name with no merchant.
DROP INDEX "recurring_series_merchant_account_idx";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Each stored name to its merchant: the one called that, else the one with
-- it as a spelling, case-insensitive as rules (#289) do.
UPDATE "recurring_series" s SET "merchant_id" = (
  SELECT m."id" FROM "merchants" m
  WHERE lower(m."name") = lower(s."merchant")
     OR EXISTS (SELECT 1 FROM "merchant_aliases" a WHERE a."merchant_id" = m."id" AND lower(a."alias") = lower(s."merchant"))
  ORDER BY (lower(m."name") = lower(s."merchant")) DESC, m."id"
  LIMIT 1
);--> statement-breakpoint
UPDATE "alerts" al SET "merchant_id" = (
  SELECT m."id" FROM "merchants" m
  WHERE lower(m."name") = lower(al."merchant")
     OR EXISTS (SELECT 1 FROM "merchant_aliases" a WHERE a."merchant_id" = m."id" AND lower(a."alias") = lower(al."merchant"))
  ORDER BY (lower(m."name") = lower(al."merchant")) DESC, m."id"
  LIMIT 1
);--> statement-breakpoint
-- One decision per merchant and account: where two spellings each had one,
-- the one under the merchant's name wins, else the newest.
DELETE FROM "recurring_series" s
WHERE s."merchant_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "recurring_series" o JOIN "merchants" m ON m."id" = o."merchant_id"
  WHERE o."id" <> s."id" AND o."merchant_id" = s."merchant_id" AND o."account_id" = s."account_id"
    AND (
      (o."merchant" = m."name") > (s."merchant" = m."name")
      OR ((o."merchant" = m."name") = (s."merchant" = m."name") AND (o."created_at", o."id") > (s."created_at", s."id"))
    )
);--> statement-breakpoint
-- Recurring alerts name their series in the dedupe key; it now goes by the
-- merchant's id, so rewrite it, or an alert already answered would be
-- raised again. A key that would collide with one already there (or
-- another rewritten here) stays; the alert still moves. Suspicious-charge
-- flags are keyed by transaction and need nothing.
WITH moved AS (
  SELECT al."id", replace(al."dedupe_key", '|' || al."merchant" || '|', '|' || al."merchant_id"::text || '|') AS "key"
  FROM "alerts" al
  WHERE al."merchant_id" IS NOT NULL AND al."kind" IN ('price_increase', 'trial_converted', 'missing_charge', 'upcoming_renewal', 'overlapping_subscriptions')
), ranked AS (
  SELECT moved.*, row_number() OVER (PARTITION BY moved."key" ORDER BY moved."id") AS n FROM moved
)
UPDATE "alerts" al SET "dedupe_key" = ranked."key"
FROM ranked
WHERE al."id" = ranked."id" AND ranked.n = 1 AND ranked."key" <> al."dedupe_key"
  AND NOT EXISTS (SELECT 1 FROM "alerts" x WHERE x."dedupe_key" = ranked."key");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_series_merchant_id_account_idx" ON "recurring_series" USING btree ("merchant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_series_merchant_account_idx" ON "recurring_series" USING btree ("merchant","account_id") WHERE "recurring_series"."merchant_id" is null;
