CREATE TYPE "public"."model_call_status" AS ENUM('ok', 'error', 'unavailable');--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature" text NOT NULL,
	"status" "model_call_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latency_ms" integer NOT NULL,
	"cold_start_retries" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "model_calls_started_idx" ON "model_calls" USING btree ("started_at");