CREATE TABLE "source_metadata_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"field" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"by_role" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_metadata_events_field_check" CHECK ("source_metadata_events"."field" IN ('meta', 'authority_score'))
);
--> statement-breakpoint
ALTER TABLE "source_metadata_events" ADD CONSTRAINT "source_metadata_events_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_source_metadata_events_source_created" ON "source_metadata_events" USING btree ("source_id","created_at");