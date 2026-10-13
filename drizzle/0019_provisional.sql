CREATE TYPE "public"."provisional_source" AS ENUM('email', 'apple_pay');--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "provisional_source" "provisional_source";--> statement-breakpoint
CREATE INDEX "transactions_provisional_idx" ON "transactions" USING btree ("provisional_source");