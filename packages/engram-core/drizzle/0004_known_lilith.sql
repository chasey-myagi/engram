CREATE TYPE "public"."l5_candidate_status" AS ENUM('queued');--> statement-breakpoint
CREATE TABLE "l5_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_event_id" uuid NOT NULL,
	"query" text NOT NULL,
	"claim_id" uuid,
	"confirmed_by" text NOT NULL,
	"status" "l5_candidate_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l5_candidates_source_event_id_unique" UNIQUE("source_event_id")
);
--> statement-breakpoint
CREATE TABLE "regression_pool" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_event_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"query" text,
	"outcome" text NOT NULL,
	"task_id" text,
	"predicted_confidence" double precision,
	"calibration_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regression_pool_source_event_id_unique" UNIQUE("source_event_id")
);
--> statement-breakpoint
ALTER TABLE "l5_candidates" ADD CONSTRAINT "l5_candidates_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regression_pool" ADD CONSTRAINT "regression_pool_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l5_candidates_status" ON "l5_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_regression_pool_claim" ON "regression_pool" USING btree ("claim_id");