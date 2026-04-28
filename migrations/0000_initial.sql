CREATE TABLE IF NOT EXISTS "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"kind" text NOT NULL,
	"uri" text NOT NULL,
	"mime_type" text,
	"bytes" integer,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setup_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage" text NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"score_delta" numeric(5, 2) DEFAULT '0' NOT NULL,
	"score_after" numeric(5, 2) NOT NULL,
	"status_before" text NOT NULL,
	"status_after" text NOT NULL,
	"payload" jsonb NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"input_hash" text,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"timeframe" text NOT NULL,
	"status" text NOT NULL,
	"current_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"pattern_hint" text,
	"invalidation_level" numeric,
	"direction" text,
	"ttl_candles" integer NOT NULL,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"workflow_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "setups_workflow_id_unique" UNIQUE("workflow_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tick_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" uuid NOT NULL,
	"tick_at" timestamp with time zone NOT NULL,
	"asset" text NOT NULL,
	"timeframe" text NOT NULL,
	"ohlcv_uri" text NOT NULL,
	"chart_uri" text NOT NULL,
	"indicators" jsonb NOT NULL,
	"pre_filter_pass" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watch_states" (
	"watch_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_tick_at" timestamp with time zone,
	"last_tick_status" text,
	"total_cost_usd_mtd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"total_cost_usd_all_time" numeric(12, 4) DEFAULT '0' NOT NULL,
	"setups_created_mtd" integer DEFAULT 0 NOT NULL,
	"setups_confirmed_mtd" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_setup_id_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."setups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_artifacts_sha256" ON "artifacts" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_setup_time" ON "events" USING btree ("setup_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_type" ON "events" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_events_setup_seq" ON "events" USING btree ("setup_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_input_hash" ON "events" USING btree ("setup_id","input_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_setups_watch_status" ON "setups" USING btree ("watch_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticks_watch_time" ON "tick_snapshots" USING btree ("watch_id","tick_at");