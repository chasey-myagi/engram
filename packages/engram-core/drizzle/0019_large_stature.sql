CREATE TABLE "worker_failure" (
	"id" uuid PRIMARY KEY NOT NULL,
	"worker_name" text NOT NULL,
	"event_type" text NOT NULL,
	"error" text NOT NULL,
	"payload_digest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_worker_failure_worker_created" ON "worker_failure" USING btree ("worker_name","created_at");