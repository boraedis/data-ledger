ALTER TABLE "rules" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing "merchant is …" rules (#289) go to the merchant they name: the
-- one called that, else the one with that spelling as an alias, both
-- case-insensitive as the rule always compared. A pattern naming no merchant
-- stays unlinked and keeps matching by text. Contains / starts-with and
-- description rules are patterns, not a merchant, and are left as they are.
UPDATE "rules" r SET "merchant_id" = (
  SELECT m."id" FROM "merchants" m
  WHERE lower(m."name") = lower(trim(r."pattern"))
     OR EXISTS (SELECT 1 FROM "merchant_aliases" a WHERE a."merchant_id" = m."id" AND lower(a."alias") = lower(trim(r."pattern")))
  ORDER BY (lower(m."name") = lower(trim(r."pattern"))) DESC, m."id"
  LIMIT 1
)
WHERE r."match_field" = 'merchant' AND r."match_type" = 'equals';
