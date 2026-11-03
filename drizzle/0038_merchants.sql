CREATE TABLE "merchant_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_aliases_alias_unique" UNIQUE("alias")
);
--> statement-breakpoint
CREATE TABLE "merchant_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_type_id_merchant_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."merchant_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_aliases_merchant_idx" ON "merchant_aliases" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_name_idx" ON "merchants" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_merchant_id_idx" ON "transactions" USING btree ("merchant_id");--> statement-breakpoint
-- The built-in merchant types (#285); the owner can add more.
INSERT INTO "merchant_types" ("name", "built_in") VALUES
	('Restaurant', true), ('Cafe', true), ('Bar', true), ('Grocery', true), ('Convenience store', true), ('Gas station', true),
	('Pharmacy', true), ('Retail', true), ('Online shopping', true), ('Subscription', true), ('Utility', true), ('Bank', true),
	('Payment app', true), ('Transport', true), ('Travel', true), ('Entertainment', true), ('Health', true), ('Insurance', true),
	('Government', true), ('Employer', true)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
-- Backfill: one merchant per distinct cleaned name (names that differ only
-- in case are one merchant, as the unique index has it, named by the most
-- common spelling), each cleaned name an alias of it, and every
-- transaction with a cleaned name linked. Rows
-- with no cleaned name yet are linked by the nightly merchant backfill once
-- it derives one, as are any inserted by older code during the deploy.
INSERT INTO "merchants" ("name")
SELECT mode() WITHIN GROUP (ORDER BY "merchant") FROM "transactions" WHERE "merchant" IS NOT NULL AND "merchant" <> '' GROUP BY lower("merchant");--> statement-breakpoint
INSERT INTO "merchant_aliases" ("alias", "merchant_id")
SELECT DISTINCT t."merchant", m."id" FROM "transactions" t JOIN "merchants" m ON lower(m."name") = lower(t."merchant")
WHERE t."merchant" IS NOT NULL AND t."merchant" <> '';--> statement-breakpoint
UPDATE "transactions" t SET "merchant_id" = a."merchant_id" FROM "merchant_aliases" a WHERE a."alias" = t."merchant";
