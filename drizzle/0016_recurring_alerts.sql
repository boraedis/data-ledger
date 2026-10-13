CREATE TYPE "public"."alert_kind" AS ENUM('price_increase', 'duplicate_charge', 'overlapping_subscriptions', 'trial_converted', 'missing_charge');--> statement-breakpoint
CREATE TYPE "public"."recurring_status" AS ENUM('confirmed', 'dismissed');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"merchant" text NOT NULL,
	"account_id" uuid,
	"transaction_id" uuid,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant" text NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "recurring_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_idx" ON "alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_series_merchant_account_idx" ON "recurring_series" USING btree ("merchant","account_id");