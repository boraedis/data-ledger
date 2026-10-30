CREATE TYPE "public"."employer_pay_kind" AS ENUM('retirement_match', 'hsa', 'life_insurance', 'imputed_income', 'other');--> statement-breakpoint
CREATE TYPE "public"."hsa_coverage" AS ENUM('self', 'family');--> statement-breakpoint
CREATE TABLE "pay_stub_employer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_stub_id" uuid NOT NULL,
	"kind" "employer_pay_kind" NOT NULL,
	"label" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tax_assumptions" ADD COLUMN "hsa_coverage" "hsa_coverage";--> statement-breakpoint
ALTER TABLE "tax_assumptions" ADD COLUMN "hsa_catch_up" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_stub_employer_lines" ADD CONSTRAINT "pay_stub_employer_lines_pay_stub_id_pay_stubs_id_fk" FOREIGN KEY ("pay_stub_id") REFERENCES "public"."pay_stubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pay_stub_employer_lines_stub_idx" ON "pay_stub_employer_lines" USING btree ("pay_stub_id");