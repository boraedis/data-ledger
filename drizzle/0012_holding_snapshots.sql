CREATE TABLE "holding_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"on" date NOT NULL,
	"external_id" text NOT NULL,
	"symbol" text,
	"description" text NOT NULL,
	"shares" numeric NOT NULL,
	"market_value_cents" bigint NOT NULL,
	"cost_basis_cents" bigint,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "holding_snapshots" ADD CONSTRAINT "holding_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holding_snapshots_account_on_external_idx" ON "holding_snapshots" USING btree ("account_id","on","external_id");--> statement-breakpoint
CREATE INDEX "holding_snapshots_on_idx" ON "holding_snapshots" USING btree ("on");