CREATE TABLE "manual_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"quantity" numeric NOT NULL,
	"unit_price" numeric NOT NULL,
	"price_on" date NOT NULL,
	"cost_basis_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manual_positions" ADD CONSTRAINT "manual_positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "manual_positions_account_symbol_idx" ON "manual_positions" USING btree ("account_id",upper("symbol"));