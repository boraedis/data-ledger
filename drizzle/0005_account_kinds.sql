ALTER TYPE "public"."account_type" ADD VALUE 'brokerage';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'retirement';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'loan';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'other_asset';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "counts_toward_budgets" boolean DEFAULT true NOT NULL;