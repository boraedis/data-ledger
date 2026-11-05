CREATE TYPE "public"."trade_source" AS ENUM('hand', 'opening', 'position_gap');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('draft', 'confirmed', 'dismissed');--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "symbol" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "on_from" date;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "position_id" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "status" "trade_status" DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "source" "trade_source" DEFAULT 'hand' NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trades_transaction_idx" ON "trades" USING btree ("transaction_id") WHERE "trades"."transaction_id" is not null;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_confirmed_complete" CHECK ("trades"."status" <> 'confirmed' or ("trades"."symbol" is not null and "trades"."on_from" is null));--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_draft_identified" CHECK ("trades"."symbol" is not null or "trades"."position_id" is not null);