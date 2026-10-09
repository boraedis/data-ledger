CREATE TYPE "public"."command_status" AS ENUM('proposed', 'applied', 'rejected', 'undone');--> statement-breakpoint
CREATE TABLE "command_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"operation" text NOT NULL,
	"input" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" "command_status" NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"undo_of" uuid,
	"undone_by" uuid
);
--> statement-breakpoint
CREATE INDEX "command_log_created_at_idx" ON "command_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "command_log_status_idx" ON "command_log" USING btree ("status");