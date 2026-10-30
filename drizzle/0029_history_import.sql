ALTER TYPE "public"."data_source" ADD VALUE 'import';--> statement-breakpoint
CREATE TABLE "import_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mapping" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_mappings_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source" "data_source";--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;