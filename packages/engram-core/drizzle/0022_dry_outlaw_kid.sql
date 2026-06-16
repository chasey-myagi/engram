CREATE TABLE "round_cohort" (
	"id" uuid PRIMARY KEY NOT NULL,
	"generation_version" text NOT NULL,
	"item_id" text NOT NULL,
	"redteam_class" text NOT NULL,
	"admitted" boolean NOT NULL,
	"golden_id" uuid,
	"poison_claim_id" uuid,
	"basis" jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "round_cohort_generation_item_unique" UNIQUE("generation_version","item_id"),
	CONSTRAINT "round_cohort_redteam_class_check" CHECK ("round_cohort"."redteam_class" IN ('false', 'contradiction', 'stale', 'near_dup_poison'))
);
--> statement-breakpoint
ALTER TABLE "round_cohort" ADD CONSTRAINT "round_cohort_generation_version_redteam_generations_version_fk" FOREIGN KEY ("generation_version") REFERENCES "public"."redteam_generations"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_round_cohort_generation" ON "round_cohort" USING btree ("generation_version");