CREATE TYPE "public"."claim_status" AS ENUM('draft', 'active', 'flagged', 'quarantined', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."prov_relevance" AS ENUM('exact', 'supporting', 'tangential', 'irrelevant');--> statement-breakpoint
CREATE TYPE "public"."relation_type" AS ENUM('supports', 'contradicts', 'refines', 'derived_from', 'supersedes');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('formal_document', 'structured_spec', 'human_qa', 'conversation_log', 'historical_artifact', 'agent_synthesis', 'external_feed');--> statement-breakpoint
CREATE TYPE "public"."verification_kind" AS ENUM('patrol', 'usage_truth', 'reembed_marker');--> statement-breakpoint
CREATE TABLE "claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_text" text NOT NULL,
	"subject" text,
	"predicate" text,
	"object" text,
	"status" "claim_status" DEFAULT 'draft' NOT NULL,
	"confidence" double precision NOT NULL,
	"confidence_raw" double precision NOT NULL,
	"confidence_factors" jsonb NOT NULL,
	"lineage_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"locator" text NOT NULL,
	"excerpt" text,
	"relevance" "prov_relevance" DEFAULT 'supporting' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"kind" "verification_kind" NOT NULL,
	"verdict" jsonb NOT NULL,
	"by_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_claims" (
	"page_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"ord" integer,
	CONSTRAINT "page_claims_page_id_claim_id_pk" PRIMARY KEY("page_id","claim_id")
);
--> statement-breakpoint
CREATE TABLE "relation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_claim" uuid NOT NULL,
	"to_claim" uuid,
	"type" "relation_type" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"authority_score" double precision DEFAULT 0.5 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_content_hash_unique" UNIQUE("content_hash")
);
--> statement-breakpoint
ALTER TABLE "claim_provenance" ADD CONSTRAINT "claim_provenance_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance" ADD CONSTRAINT "claim_provenance_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_verification" ADD CONSTRAINT "claim_verification_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation" ADD CONSTRAINT "relation_from_claim_claim_id_fk" FOREIGN KEY ("from_claim") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation" ADD CONSTRAINT "relation_to_claim_claim_id_fk" FOREIGN KEY ("to_claim") REFERENCES "public"."claim"("id") ON DELETE no action ON UPDATE no action;