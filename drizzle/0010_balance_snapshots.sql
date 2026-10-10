CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"on" date NOT NULL,
	"balance_cents" bigint NOT NULL,
	"balance_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "balance_snapshots_account_on_idx" ON "balance_snapshots" USING btree ("account_id","on");--> statement-breakpoint
CREATE INDEX "balance_snapshots_on_idx" ON "balance_snapshots" USING btree ("on");