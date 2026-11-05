CREATE TABLE "intraday_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"symbol" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"price" numeric NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intraday_prices_class_symbol_hour_idx" ON "intraday_prices" USING btree ("asset_class","symbol","hour");