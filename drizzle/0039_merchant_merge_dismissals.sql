CREATE TABLE "merchant_merge_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_a_id" uuid NOT NULL,
	"merchant_b_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_merge_dismissals" ADD CONSTRAINT "merchant_merge_dismissals_merchant_a_id_merchants_id_fk" FOREIGN KEY ("merchant_a_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_merge_dismissals" ADD CONSTRAINT "merchant_merge_dismissals_merchant_b_id_merchants_id_fk" FOREIGN KEY ("merchant_b_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_merge_dismissals_pair_idx" ON "merchant_merge_dismissals" USING btree ("merchant_a_id","merchant_b_id");