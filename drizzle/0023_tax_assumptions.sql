CREATE TYPE "public"."filing_status" AS ENUM('single', 'married_joint', 'married_separate', 'head_of_household');--> statement-breakpoint
CREATE TABLE "tax_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"year" integer NOT NULL,
	"filing_status" "filing_status" DEFAULT 'single' NOT NULL,
	"other_income_cents" bigint DEFAULT 0 NOT NULL,
	"itemized_deductions_cents" bigint,
	"credits_cents" bigint DEFAULT 0 NOT NULL,
	"other_payments_cents" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tax_assumptions_year_unique" UNIQUE("year")
);
