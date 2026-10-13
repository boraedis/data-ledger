CREATE TABLE "budget_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rebalance_id" uuid NOT NULL,
	"category_id" uuid,
	"on" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid,
	"effective_from" date NOT NULL,
	"amount_cents" bigint,
	"period_months" integer DEFAULT 1 NOT NULL,
	"anchor_on" date NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"sinking_fund" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_targets_category_from_unique" UNIQUE NULLS NOT DISTINCT("category_id","effective_from")
);
--> statement-breakpoint
ALTER TABLE "budget_adjustments" ADD CONSTRAINT "budget_adjustments_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_targets" ADD CONSTRAINT "budget_targets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_adjustments_on_idx" ON "budget_adjustments" USING btree ("on");