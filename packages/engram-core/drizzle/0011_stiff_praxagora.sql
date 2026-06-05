CREATE TABLE "governance_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promotion_gate_level" double precision NOT NULL,
	"patrol_frequency" double precision NOT NULL,
	"ingestion_throttle" double precision NOT NULL,
	"arbiter_priority" double precision NOT NULL,
	"metrics" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_governance_state_created" ON "governance_state" USING btree ("created_at");