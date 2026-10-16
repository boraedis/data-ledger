CREATE TYPE "public"."pay_line_kind" AS ENUM('federal_income_tax', 'state_income_tax', 'local_income_tax', 'social_security', 'medicare', 'state_disability', 'health_insurance', 'dental_insurance', 'vision_insurance', 'retirement_pretax', 'retirement_roth', 'hsa', 'fsa', 'other');--> statement-breakpoint
CREATE TABLE "pay_stub_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_stub_id" uuid NOT NULL,
	"kind" "pay_line_kind" NOT NULL,
	"label" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"category_id" uuid,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_stubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employer" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"gross_cents" bigint NOT NULL,
	"net_cents" bigint NOT NULL,
	"deposit_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_stubs_deposit_transaction_id_unique" UNIQUE("deposit_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "pay_stub_lines" ADD CONSTRAINT "pay_stub_lines_pay_stub_id_pay_stubs_id_fk" FOREIGN KEY ("pay_stub_id") REFERENCES "public"."pay_stubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_stub_lines" ADD CONSTRAINT "pay_stub_lines_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_stubs" ADD CONSTRAINT "pay_stubs_deposit_transaction_id_transactions_id_fk" FOREIGN KEY ("deposit_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pay_stub_lines_stub_idx" ON "pay_stub_lines" USING btree ("pay_stub_id");--> statement-breakpoint
CREATE INDEX "pay_stubs_pay_date_idx" ON "pay_stubs" USING btree ("pay_date");