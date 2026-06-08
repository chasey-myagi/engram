CREATE TABLE "agent_run_trace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"worker_name" text NOT NULL,
	"by_role" text NOT NULL,
	"reason" text NOT NULL,
	"turns" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"tool_errors" integer DEFAULT 0 NOT NULL,
	"tool_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_eval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_label" text NOT NULL,
	"variant" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"ci_low" double precision,
	"ci_high" double precision,
	"sample_n" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agent_run_trace_run" ON "agent_run_trace" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_agent_run_trace_worker_created" ON "agent_run_trace" USING btree ("worker_name","created_at");--> statement-breakpoint
CREATE INDEX "idx_decision_eval_run" ON "decision_eval" USING btree ("run_label","metric");