CREATE TYPE "public"."trade_kind" AS ENUM('trade', 'reinvestment', 'split', 'transfer', 'fee');--> statement-breakpoint
CREATE TABLE "trade_kind_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"position" text NOT NULL,
	"side" "trade_side" NOT NULL,
	"kind" "trade_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "kind" "trade_kind" DEFAULT 'trade' NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "ratio" numeric;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "paired_trade_id" uuid;--> statement-breakpoint
ALTER TABLE "trade_kind_memory" ADD CONSTRAINT "trade_kind_memory_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trade_kind_memory_account_position_side_idx" ON "trade_kind_memory" USING btree ("account_id","position","side");--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_paired_trade_id_trades_id_fk" FOREIGN KEY ("paired_trade_id") REFERENCES "public"."trades"("id") ON DELETE set null ON UPDATE no action;