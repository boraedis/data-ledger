ALTER TYPE "public"."trade_source" ADD VALUE 'import';--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "import_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "trades_import_key_idx" ON "trades" USING btree ("account_id","import_key") WHERE "trades"."import_key" is not null;