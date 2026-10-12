ALTER TABLE "transactions" ADD COLUMN "transfer_pair_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_rejected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_pair_id_transactions_id_fk" FOREIGN KEY ("transfer_pair_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_transfer_pair_idx" ON "transactions" USING btree ("transfer_pair_id");