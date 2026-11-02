CREATE TYPE "public"."asset_class" AS ENUM('crypto', 'equity');--> statement-breakpoint
CREATE TABLE "daily_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"symbol" text NOT NULL,
	"on" date NOT NULL,
	"price" numeric NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"symbol" text NOT NULL,
	"price" numeric,
	"as_of" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "daily_prices_class_symbol_on_idx" ON "daily_prices" USING btree ("asset_class","symbol","on");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_class_symbol_idx" ON "quotes" USING btree ("asset_class","symbol");