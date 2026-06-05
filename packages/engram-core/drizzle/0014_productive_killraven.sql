CREATE TABLE "dimension_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"dimension" text NOT NULL,
	"value" double precision NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_dimension_events_dim_created" ON "dimension_events" USING btree ("dimension","created_at");--> statement-breakpoint
CREATE INDEX "idx_dimension_events_run" ON "dimension_events" USING btree ("run_id");