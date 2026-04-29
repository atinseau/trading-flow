CREATE TABLE "lesson_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" text NOT NULL,
	"lesson_id" uuid,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"trigger_setup_id" uuid,
	"trigger_close_reason" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"input_hash" text,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" text NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"rationale" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"times_reinforced" integer DEFAULT 0 NOT NULL,
	"times_used_in_prompts" integer DEFAULT 0 NOT NULL,
	"source_feedback_event_id" uuid,
	"supersedes_lesson_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"prompt_version" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_lesson_events_watch_seq" ON "lesson_events" USING btree ("watch_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_lesson_events_watch_seq" ON "lesson_events" USING btree ("watch_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_lesson_events_lesson_time" ON "lesson_events" USING btree ("lesson_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_lesson_events_setup" ON "lesson_events" USING btree ("trigger_setup_id");--> statement-breakpoint
CREATE INDEX "idx_lesson_events_input_hash" ON "lesson_events" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX "idx_lessons_watch_cat_status" ON "lessons" USING btree ("watch_id","category","status");--> statement-breakpoint
CREATE INDEX "idx_lessons_supersedes" ON "lessons" USING btree ("supersedes_lesson_id");