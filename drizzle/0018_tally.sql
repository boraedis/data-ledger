CREATE TYPE "public"."tally_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"on" date NOT NULL,
	"content" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digests_on_unique" UNIQUE("on")
);
--> statement-breakpoint
CREATE TABLE "tally_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tally_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "tally_role" NOT NULL,
	"content" text,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tally_messages" ADD CONSTRAINT "tally_messages_conversation_id_tally_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."tally_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tally_messages_conversation_idx" ON "tally_messages" USING btree ("conversation_id","created_at");