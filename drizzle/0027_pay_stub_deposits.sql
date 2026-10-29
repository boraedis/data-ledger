CREATE TABLE "pay_stub_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_stub_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	CONSTRAINT "pay_stub_deposits_transaction_id_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
ALTER TABLE "pay_stubs" DROP CONSTRAINT "pay_stubs_deposit_transaction_id_unique";--> statement-breakpoint
ALTER TABLE "pay_stubs" DROP CONSTRAINT "pay_stubs_deposit_transaction_id_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "pay_stub_deposits" ADD CONSTRAINT "pay_stub_deposits_pay_stub_id_pay_stubs_id_fk" FOREIGN KEY ("pay_stub_id") REFERENCES "public"."pay_stubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_stub_deposits" ADD CONSTRAINT "pay_stub_deposits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pay_stub_deposits_stub_idx" ON "pay_stub_deposits" USING btree ("pay_stub_id");--> statement-breakpoint
-- Existing links move to the new table before the column goes (#91).
INSERT INTO "pay_stub_deposits" ("pay_stub_id", "transaction_id")
  SELECT "id", "deposit_transaction_id" FROM "pay_stubs" WHERE "deposit_transaction_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_stubs" DROP COLUMN "deposit_transaction_id";