CREATE TABLE "tally_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tally_promotions_operation_unique" UNIQUE("operation")
);
--> statement-breakpoint
ALTER TABLE "command_log" ADD COLUMN "auto_applied" boolean DEFAULT false NOT NULL;