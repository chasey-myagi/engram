CREATE TABLE "recall_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid NOT NULL,
	"value" double precision NOT NULL,
	"raw" double precision NOT NULL,
	"factors" jsonb NOT NULL,
	"weights" jsonb NOT NULL,
	"calibration_version" text NOT NULL,
	"by_role" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recall_snapshot" ADD CONSTRAINT "recall_snapshot_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_recall_snapshot_claim" ON "recall_snapshot" USING btree ("claim_id");