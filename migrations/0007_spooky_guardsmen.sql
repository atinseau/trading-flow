CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" text,
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
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_llm_calls_watch_time" ON "llm_calls" USING btree ("watch_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_llm_calls_setup" ON "llm_calls" USING btree ("setup_id");--> statement-breakpoint
CREATE INDEX "idx_llm_calls_provider_time" ON "llm_calls" USING btree ("provider","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_llm_calls_occurred" ON "llm_calls" USING btree ("occurred_at");