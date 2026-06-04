CREATE TYPE "public"."promotion_decision" AS ENUM('promoted', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."l5_candidate_status" ADD VALUE 'promoted';--> statement-breakpoint
ALTER TYPE "public"."l5_candidate_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "golden_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"query" text NOT NULL,
	"poison_claim_id" uuid NOT NULL,
	"promoted_by" text NOT NULL,
	"basis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "golden_questions_candidate_id_unique" UNIQUE("candidate_id")
);
--> statement-breakpoint
CREATE TABLE "promotion_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"decision" "promotion_decision" NOT NULL,
	"decided_by" text NOT NULL,
	"basis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "golden_questions" ADD CONSTRAINT "golden_questions_candidate_id_l5_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."l5_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_questions" ADD CONSTRAINT "golden_questions_poison_claim_id_claim_id_fk" FOREIGN KEY ("poison_claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_audit" ADD CONSTRAINT "promotion_audit_candidate_id_l5_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."l5_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_promotion_audit_candidate" ON "promotion_audit" USING btree ("candidate_id");