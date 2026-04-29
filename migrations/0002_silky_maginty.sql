CREATE TABLE "watch_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watch_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"version" integer NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_by" text DEFAULT 'ui' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "watch_config_revisions" ADD CONSTRAINT "watch_config_revisions_watch_id_watch_configs_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watch_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_watch_revisions_watch" ON "watch_config_revisions" USING btree ("watch_id","applied_at");--> statement-breakpoint
CREATE INDEX "idx_watch_configs_enabled" ON "watch_configs" USING btree ("enabled");