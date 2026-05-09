ALTER TABLE "setups" ADD COLUMN "entry_price" numeric;--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "stop_loss" numeric;--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "exit_price" numeric;--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "exit_reason" text;--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "pnl_pct" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "r_multiple" numeric(10, 4);--> statement-breakpoint
CREATE INDEX "idx_setups_closed_at" ON "setups" USING btree ("closed_at");--> statement-breakpoint
ALTER TABLE "setups" ADD CONSTRAINT "setups_exit_reason_chk" CHECK (exit_reason IS NULL OR exit_reason IN ('TP_HIT','SL_HIT','TTL_EXPIRED','INVALIDATED','KILLED'));