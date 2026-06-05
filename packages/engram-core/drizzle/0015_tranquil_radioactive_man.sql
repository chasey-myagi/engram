CREATE TABLE "knowledge_grew_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"l5_question_id" text NOT NULL,
	"query" text NOT NULL,
	"release_snapshot" text NOT NULL,
	"recalled_count" integer NOT NULL,
	"confirmed_by" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_grew_events_l5_question_id_unique" UNIQUE("l5_question_id")
);
--> statement-breakpoint
CREATE TABLE "recompete_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"frozen_golden_version" text NOT NULL,
	"release_snapshot" text NOT NULL,
	"dimension" text NOT NULL,
	"value" double precision NOT NULL,
	"delta" double precision,
	"ring" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_knowledge_grew_release" ON "knowledge_grew_events" USING btree ("release_snapshot");--> statement-breakpoint
CREATE INDEX "idx_recompete_events_golden_dim_created" ON "recompete_events" USING btree ("frozen_golden_version","dimension","created_at");--> statement-breakpoint
CREATE INDEX "idx_recompete_events_release" ON "recompete_events" USING btree ("release_snapshot");