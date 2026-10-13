CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reimbursement_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reimbursement_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reimbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"forgiven" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "not_reimbursement" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reimbursement_matches" ADD CONSTRAINT "reimbursement_matches_reimbursement_id_reimbursements_id_fk" FOREIGN KEY ("reimbursement_id") REFERENCES "public"."reimbursements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_matches" ADD CONSTRAINT "reimbursement_matches_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_name_lower_idx" ON "people" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "reimbursement_matches_reimbursement_idx" ON "reimbursement_matches" USING btree ("reimbursement_id");--> statement-breakpoint
CREATE INDEX "reimbursement_matches_transaction_idx" ON "reimbursement_matches" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "reimbursements_transaction_idx" ON "reimbursements" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "reimbursements_person_idx" ON "reimbursements" USING btree ("person_id");