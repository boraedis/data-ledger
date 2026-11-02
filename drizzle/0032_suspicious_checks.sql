CREATE TYPE "public"."alert_verdict" AS ENUM('fine', 'suspicious');--> statement-breakpoint
ALTER TYPE "public"."alert_kind" ADD VALUE 'unusual_amount';--> statement-breakpoint
ALTER TYPE "public"."alert_kind" ADD VALUE 'new_merchant';--> statement-breakpoint
ALTER TYPE "public"."alert_kind" ADD VALUE 'possible_duplicate';--> statement-breakpoint
ALTER TYPE "public"."alert_kind" ADD VALUE 'foreign_fee';--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "verdict" "alert_verdict";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "amount_cents" integer;