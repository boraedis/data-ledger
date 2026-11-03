CREATE TYPE "public"."trade_side" AS ENUM('buy', 'sell', 'transfer_in', 'transfer_out');--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"on" date NOT NULL,
	"symbol" text NOT NULL,
	"side" "trade_side" NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trades_account_symbol_on_idx" ON "trades" USING btree ("account_id","symbol","on");--> statement-breakpoint
-- Positions entered by hand before trades existed (#231) become an opening
-- buy, dated the day each was entered, so every manual position equals what
-- its trades add up to from the start.
INSERT INTO "trades" ("account_id", "on", "symbol", "side", "quantity", "price", "created_at")
SELECT "account_id", ("created_at" AT TIME ZONE 'UTC')::date, upper("symbol"), 'buy', "quantity", "unit_price", "created_at"
FROM "manual_positions";
