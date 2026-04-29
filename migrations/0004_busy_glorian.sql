ALTER TABLE "setups" ADD COLUMN "outcome" text;--> statement-breakpoint
CREATE INDEX "idx_setups_outcome" ON "setups" USING btree ("outcome");