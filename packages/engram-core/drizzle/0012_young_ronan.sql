CREATE TABLE "calibration_map" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"knots" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_calibration_map_created" ON "calibration_map" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_calibration_map_version" ON "calibration_map" USING hash ("version");