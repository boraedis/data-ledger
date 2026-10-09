CREATE TYPE "public"."connection_status" AS ENUM('active', 'broken');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'success', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" "sync_run_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"requests" integer DEFAULT 0 NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"command_id" uuid,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "institution_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "balance_cents" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "available_balance_cents" bigint;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "balance_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "payee" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "memo" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_connection_started_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_connection_external_idx" ON "accounts" USING btree ("connection_id","external_id");