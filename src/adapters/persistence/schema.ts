import type { EventPayload } from "@domain/events/schemas";
import type { IndicatorScalars } from "@domain/schemas/Indicators";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const watchStates = pgTable("watch_states", {
  watchId: text("watch_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  lastTickStatus: text("last_tick_status"),
  // totalCostUsdMtd and totalCostUsdAllTime were dropped in migration 0008.
  // Cost aggregation is now done on-the-fly from llm_calls (see watches API).
  setupsCreatedMtd: integer("setups_created_mtd").notNull().default(0),
  setupsConfirmedMtd: integer("setups_confirmed_mtd").notNull().default(0),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const setups = pgTable(
  "setups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id").notNull(),
    asset: text("asset").notNull(),
    timeframe: text("timeframe").notNull(),
    status: text("status").notNull(),
    currentScore: numeric("current_score", { precision: 5, scale: 2 }).notNull().default("0"),
    patternHint: text("pattern_hint"),
    /**
     * Detector's classification of the pattern: "event" (single-trigger:
     * breakout, sweep, fvg_retest, BOS-reaction, level_reclaim, gap_fill) or
     * "accumulation" (multi-touch: double_top/bottom, divergence, prolonged
     * compression). Used by the finalizer to apply the correct maturation
     * threshold (1-2 ticks for events, ≥3 for accumulation).
     */
    patternCategory: text("pattern_category"),
    /**
     * Detector's estimated number of reviewer ticks needed to mature this
     * setup to a finalizer-ready conviction. 1 = instantly ready (event with
     * fully formed trigger), 6 = slow accumulation. Replaces the binary
     * event/accumulation maturation rule in the finalizer with a smooth
     * per-setup expectation. Null for legacy rows.
     */
    expectedMaturationTicks: integer("expected_maturation_ticks"),
    invalidationLevel: numeric("invalidation_level"),
    direction: text("direction"),
    ttlCandles: integer("ttl_candles").notNull(),
    ttlExpiresAt: timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
    workflowId: text("workflow_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    outcome: text("outcome"),
    // Performance metrics — denormalized from events at outcome derivation time.
    // entryPrice/stopLoss come from the Confirmed event payload; exitPrice from
    // the terminating TPHit/SLHit/Invalidated/Expired event. Null for setups
    // that never reached EntryFilled (REJECTED, INVALIDATED_PRE_TRADE, etc).
    entryPrice: numeric("entry_price"),
    stopLoss: numeric("stop_loss"),
    exitPrice: numeric("exit_price"),
    exitReason: text("exit_reason"),
    pnlPct: numeric("pnl_pct", { precision: 10, scale: 4 }),
    rMultiple: numeric("r_multiple", { precision: 10, scale: 4 }),
  },
  (t) => [
    index("idx_setups_watch_status").on(t.watchId, t.status),
    index("idx_setups_outcome").on(t.outcome),
    index("idx_setups_closed_at").on(t.closedAt),
    // Lock down the outcome string so a future code path / manual SQL update
    // can't silently corrupt the dashboard with an unknown value (the
    // category= filters and stats query would silently drop those rows).
    check(
      "setups_outcome_chk",
      sql`outcome IS NULL OR outcome IN ('WIN','LOSS','PARTIAL_WIN','TIME_OUT','REJECTED','INVALIDATED_PRE_TRADE','INVALIDATED_POST_TRADE','EXPIRED_NO_FILL','KILLED')`,
    ),
    check(
      "setups_exit_reason_chk",
      sql`exit_reason IS NULL OR exit_reason IN ('TP_HIT','SL_HIT','TTL_EXPIRED','INVALIDATED','KILLED')`,
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setupId: uuid("setup_id")
      .notNull()
      .references(() => setups.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    stage: text("stage").notNull(),
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    scoreDelta: numeric("score_delta", { precision: 5, scale: 2 }).notNull().default("0"),
    scoreAfter: numeric("score_after", { precision: 5, scale: 2 }).notNull(),
    statusBefore: text("status_before").notNull(),
    statusAfter: text("status_after").notNull(),
    payload: jsonb("payload").$type<EventPayload>().notNull(),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    inputHash: text("input_hash"),
    latencyMs: integer("latency_ms"),
  },
  (t) => [
    index("idx_events_setup_time").on(t.setupId, t.occurredAt),
    index("idx_events_type").on(t.type),
    uniqueIndex("ux_events_setup_seq").on(t.setupId, t.sequence),
    index("idx_events_input_hash").on(t.setupId, t.inputHash),
    index("idx_events_provider_time").on(t.provider, t.occurredAt),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    uri: text("uri").notNull(),
    mimeType: text("mime_type"),
    bytes: integer("bytes"),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_artifacts_sha256").on(t.sha256)],
);

export const tickSnapshots = pgTable(
  "tick_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id").notNull(),
    tickAt: timestamp("tick_at", { withTimezone: true }).notNull(),
    asset: text("asset").notNull(),
    timeframe: text("timeframe").notNull(),
    ohlcvUri: text("ohlcv_uri").notNull(),
    chartUri: text("chart_uri").notNull(),
    indicators: jsonb("indicators").$type<IndicatorScalars>().notNull(),
    /** Last candle close at snapshot time. Source of truth for "live price"
        used by HTF positioning and finalizer regime — replaces the buggy
        proxies (recentHigh / invalidationLevel). Nullable for legacy rows. */
    lastClose: numeric("last_close", { precision: 20, scale: 8 }),
    preFilterPass: boolean("pre_filter_pass").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_ticks_watch_time").on(t.watchId, t.tickAt)],
);

export const watchConfigs = pgTable(
  "watch_configs",
  {
    id: text("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<unknown>().notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("idx_watch_configs_enabled").on(t.enabled).where(sql`${t.deletedAt} IS NULL`)],
);

export const watchConfigRevisions = pgTable(
  "watch_config_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id")
      .notNull()
      .references(() => watchConfigs.id, { onDelete: "cascade" }),
    config: jsonb("config").$type<unknown>().notNull(),
    version: integer("version").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    appliedBy: text("applied_by").notNull().default("ui"),
  },
  (t) => [index("idx_watch_revisions_watch").on(t.watchId, t.appliedAt.desc())],
);

export const lessons = pgTable(
  "lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    rationale: text("rationale").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    timesReinforced: integer("times_reinforced").notNull().default(0),
    timesUsedInPrompts: integer("times_used_in_prompts").notNull().default(0),
    sourceFeedbackEventId: uuid("source_feedback_event_id"),
    supersedesLessonId: uuid("supersedes_lesson_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    promptVersion: text("prompt_version").notNull(),
  },
  (t) => [
    index("idx_lessons_watch_cat_status").on(t.watchId, t.category, t.status),
    index("idx_lessons_supersedes").on(t.supersedesLessonId),
  ],
);

export const lessonEvents = pgTable(
  "lesson_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id").notNull(),
    lessonId: uuid("lesson_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    triggerSetupId: uuid("trigger_setup_id"),
    triggerCloseReason: text("trigger_close_reason"),
    payload: jsonb("payload").$type<unknown>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    inputHash: text("input_hash"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
  },
  (t) => [
    index("idx_lesson_events_watch_seq").on(t.watchId, t.sequence),
    uniqueIndex("ux_lesson_events_watch_seq").on(t.watchId, t.sequence),
    index("idx_lesson_events_lesson_time").on(t.lessonId, t.occurredAt),
    index("idx_lesson_events_setup").on(t.triggerSetupId),
    index("idx_lesson_events_input_hash").on(t.inputHash),
  ],
);

// Per-call ledger of every LLM invocation. Independent of `events` (which is
// scoped to setups) so we capture detector ticks that don't produce a setup
// — those costs were previously only summed into watch_states.totalCostUsdMtd
// with no breakdown by provider/model/day.
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id"),
    setupId: uuid("setup_id"),
    stage: text("stage").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreateTokens: integer("cache_create_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
    latencyMs: integer("latency_ms"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_llm_calls_watch_time").on(t.watchId, t.occurredAt),
    index("idx_llm_calls_setup").on(t.setupId),
    index("idx_llm_calls_provider_time").on(t.provider, t.occurredAt),
    index("idx_llm_calls_occurred").on(t.occurredAt),
  ],
);

// ─── Replay Mode tables ────────────────────────────────────────────────────
// Isolated from live tables. Never modified by the live pipeline.
// See docs/superpowers/specs/2026-05-08-replay-mode-design.md §4.

export const replaySessions = pgTable(
  "replay_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id").notNull(),
    name: text("name"),
    status: text("status").notNull(),
    windowStartAt: timestamp("window_start_at", { withTimezone: true }).notNull(),
    windowEndAt: timestamp("window_end_at", { withTimezone: true }).notNull(),
    workflowId: text("workflow_id").notNull(),
    configSnapshot: jsonb("config_snapshot").notNull(),
    lessonsMode: text("lessons_mode").notNull().default("current"),
    feedbackMode: text("feedback_mode").notNull().default("run"),
    costCapUsd: numeric("cost_cap_usd", { precision: 10, scale: 4 }).notNull().default("5.0"),
    costUsdSoFar: numeric("cost_usd_so_far", { precision: 10, scale: 4 }).notNull().default("0"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_replay_sessions_watch_created").on(t.watchId, t.createdAt.desc()),
    index("idx_replay_sessions_status").on(t.status),
    uniqueIndex("ux_replay_sessions_workflow").on(t.workflowId),
    check(
      "replay_sessions_status_chk",
      sql`status IN ('READY','PAUSED','COMPLETED','COST_CAPPED','FAILED')`,
    ),
    check("replay_sessions_window_chk", sql`window_end_at > window_start_at`),
    check(
      "replay_sessions_lessons_mode_chk",
      sql`lessons_mode IN ('current','historical','disabled')`,
    ),
    check("replay_sessions_feedback_mode_chk", sql`feedback_mode IN ('run','skip')`),
  ],
);

export const replayEvents = pgTable(
  "replay_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => replaySessions.id, { onDelete: "cascade" }),
    // Identifies which (workflow-managed) setup this event applies to. No FK
    // since setups in replay live in the Temporal workflow state, not in a
    // table. The UUID is generated by the workflow via the Temporal SDK's
    // uuid4 helper for determinism.
    setupId: uuid("setup_id"),
    sequence: integer("sequence").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    stage: text("stage").notNull(),
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    scoreDelta: numeric("score_delta", { precision: 5, scale: 2 }).notNull().default("0"),
    scoreAfter: numeric("score_after", { precision: 5, scale: 2 }),
    statusBefore: text("status_before"),
    statusAfter: text("status_after"),
    payload: jsonb("payload").$type<EventPayload>().notNull(),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    inputHash: text("input_hash"),
    latencyMs: integer("latency_ms"),
    // Whether the LLM call (if any) was served from the response cache.
    cacheHit: boolean("cache_hit").notNull().default(false),
  },
  (t) => [
    uniqueIndex("ux_replay_events_session_seq").on(t.sessionId, t.sequence),
    index("idx_replay_events_session_setup").on(t.sessionId, t.setupId, t.sequence),
  ],
);

export const replayLlmCalls = pgTable(
  "replay_llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => replaySessions.id, { onDelete: "cascade" }),
    setupId: uuid("setup_id"),
    stage: text("stage").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreateTokens: integer("cache_create_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
    latencyMs: integer("latency_ms"),
    cacheHit: boolean("cache_hit").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_replay_llm_calls_session").on(t.sessionId, t.occurredAt)],
);

// Mutualized LLM response cache: shared across all replay sessions. A hit
// makes the LLM call free for subsequent identical inputs. Key includes
// the chart image SHA so a chart-render change auto-invalidates entries.
export const llmResponseCache = pgTable(
  "llm_response_cache",
  {
    inputHash: text("input_hash").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    responseJson: jsonb("response_json").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    hitCount: integer("hit_count").notNull().default(0),
  },
  (t) => [index("idx_llm_response_cache_last_used").on(t.lastUsedAt)],
);
