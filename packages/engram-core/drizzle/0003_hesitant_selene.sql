CREATE TYPE "public"."metrics_event_kind" AS ENUM('gap_recorded');--> statement-breakpoint
CREATE TABLE "metrics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "metrics_event_kind" NOT NULL,
	"query_text" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_metrics_events_kind_created" ON "metrics_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_metrics_events_query" ON "metrics_events" USING hash ("query_text");