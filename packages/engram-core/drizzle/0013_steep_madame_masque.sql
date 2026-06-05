CREATE TABLE "redteam_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"items" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redteam_generations_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "redteam_immunity_scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"generation_version" text NOT NULL,
	"redteam_class" text NOT NULL,
	"injected" integer NOT NULL,
	"detected" integer NOT NULL,
	"detection_rate" double precision NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "redteam_immunity_scores" ADD CONSTRAINT "redteam_immunity_scores_generation_version_redteam_generations_version_fk" FOREIGN KEY ("generation_version") REFERENCES "public"."redteam_generations"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_redteam_generations_created" ON "redteam_generations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_redteam_generations_version" ON "redteam_generations" USING hash ("version");--> statement-breakpoint
CREATE INDEX "idx_redteam_scores_gen_class" ON "redteam_immunity_scores" USING btree ("generation_version","redteam_class");