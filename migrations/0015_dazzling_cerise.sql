CREATE TABLE "llm_response_cache" (
	"input_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"setup_id" uuid,
	"sequence" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"stage" text NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"score_delta" numeric(5, 2) DEFAULT '0' NOT NULL,
	"score_after" numeric(5, 2),
	"status_before" text,
	"status_after" text,
	"payload" jsonb NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"input_hash" text,
	"latency_ms" integer,
	"cache_hit" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"setup_id" uuid,
	"stage" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_create_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"latency_ms" integer,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" text NOT NULL,
	"name" text,
	"status" text NOT NULL,
	"window_start_at" timestamp with time zone NOT NULL,
	"window_end_at" timestamp with time zone NOT NULL,
	"workflow_id" text NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"lessons_mode" text DEFAULT 'current' NOT NULL,
	"feedback_mode" text DEFAULT 'run' NOT NULL,
	"cost_cap_usd" numeric(10, 4) DEFAULT '5.0' NOT NULL,
	"cost_usd_so_far" numeric(10, 4) DEFAULT '0' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replay_sessions_status_chk" CHECK (status IN ('READY','PAUSED','COMPLETED','COST_CAPPED','FAILED')),
	CONSTRAINT "replay_sessions_window_chk" CHECK (window_end_at > window_start_at),
	CONSTRAINT "replay_sessions_lessons_mode_chk" CHECK (lessons_mode IN ('current','historical','disabled')),
	CONSTRAINT "replay_sessions_feedback_mode_chk" CHECK (feedback_mode IN ('run','skip'))
);
--> statement-breakpoint
ALTER TABLE "replay_events" ADD CONSTRAINT "replay_events_session_id_replay_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."replay_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_llm_calls" ADD CONSTRAINT "replay_llm_calls_session_id_replay_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."replay_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_llm_response_cache_last_used" ON "llm_response_cache" USING btree ("last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_replay_events_session_seq" ON "replay_events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_replay_events_session_setup" ON "replay_events" USING btree ("session_id","setup_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_replay_llm_calls_session" ON "replay_llm_calls" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_replay_sessions_watch_created" ON "replay_sessions" USING btree ("watch_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_replay_sessions_status" ON "replay_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_replay_sessions_workflow" ON "replay_sessions" USING btree ("workflow_id");