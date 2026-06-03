CREATE TABLE "standards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"factor_weights" jsonb NOT NULL,
	"consume_floor" double precision NOT NULL,
	"must_verify_threshold" double precision NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_standards_created" ON "standards" USING btree ("created_at");