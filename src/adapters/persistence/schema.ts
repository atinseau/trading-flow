import type { EventPayload } from "@domain/events/schemas";
import type { Indicators } from "@domain/schemas/Indicators";
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
  totalCostUsdMtd: numeric("total_cost_usd_mtd", { precision: 10, scale: 4 })
    .notNull()
    .default("0"),
  totalCostUsdAllTime: numeric("total_cost_usd_all_time", { precision: 12, scale: 4 })
    .notNull()
    .default("0"),
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
    invalidationLevel: numeric("invalidation_level"),
    direction: text("direction"),
    ttlCandles: integer("ttl_candles").notNull(),
    ttlExpiresAt: timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
    workflowId: text("workflow_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    outcome: text("outcome"),
  },
  (t) => [
    index("idx_setups_watch_status").on(t.watchId, t.status),
    index("idx_setups_outcome").on(t.outcome),
    // Lock down the outcome string so a future code path / manual SQL update
    // can't silently corrupt the dashboard with an unknown value (the
    // category= filters and stats query would silently drop those rows).
    check(
      "setups_outcome_chk",
      sql`outcome IS NULL OR outcome IN ('WIN','LOSS','PARTIAL_WIN','TIME_OUT','REJECTED','INVALIDATED_PRE_TRADE','INVALIDATED_POST_TRADE','EXPIRED_NO_FILL')`,
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
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
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
    indicators: jsonb("indicators").$type<Indicators>().notNull(),
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
