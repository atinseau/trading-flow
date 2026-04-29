DROP INDEX "idx_watch_revisions_watch";--> statement-breakpoint
DROP INDEX "idx_watch_configs_enabled";--> statement-breakpoint
CREATE INDEX "idx_watch_revisions_watch" ON "watch_config_revisions" USING btree ("watch_id","applied_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_watch_configs_enabled" ON "watch_configs" USING btree ("enabled") WHERE "watch_configs"."deleted_at" IS NULL;