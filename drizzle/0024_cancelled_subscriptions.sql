ALTER TYPE "public"."alert_kind" ADD VALUE 'charged_after_cancel';--> statement-breakpoint
ALTER TYPE "public"."recurring_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "recurring_series" ADD COLUMN "cancelled_on" date;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD COLUMN "cancelled_annual_cents" integer;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD COLUMN "cancel_grace_days" integer;