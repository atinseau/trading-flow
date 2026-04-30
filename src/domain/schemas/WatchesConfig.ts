import { isValidFiveFieldCron } from "@domain/services/cronForTimeframe";
import { z } from "zod";

const TimeframeSchema = z.enum(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"]);

const PreFilterSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["lenient", "strict", "off"]).default("lenient"),
    thresholds: z
      .object({
        atr_ratio_min: z.number().positive().default(1.3),
        volume_spike_min: z.number().positive().default(1.5),
        rsi_extreme_distance: z.number().min(0).max(50).default(25),
      })
      .prefault({}),
  })
  .prefault({});

// Names that can appear in a watch must match what the runtime exposes:
// - providers: PROVIDER_DEFAULTS in src/adapters/llm/buildProviderRegistry.ts
// - sources: BinanceFetcher / YahooFinanceFetcher in src/adapters/market-data/
// Adding a new provider or source requires touching this schema, the
// registry/fetcher wiring, and the tf-web wizard pickers — by design.
export const KNOWN_PROVIDERS = ["claude_max", "openrouter"] as const;
export const KNOWN_ASSET_SOURCES = ["binance", "yahoo"] as const;

const AnalyzerSchema = z.object({
  provider: z.enum(KNOWN_PROVIDERS),
  model: z.string(),
  max_tokens: z.number().int().positive().default(2000),
  fetch_higher_timeframe: z.boolean().optional(),
});

const SetupLifecycleSchema = z
  .object({
    ttl_candles: z.number().int().positive(),
    score_initial: z.number().min(0).max(100),
    score_threshold_finalizer: z.number().min(0).max(100),
    score_threshold_dead: z.number().min(0).max(100),
    score_max: z.number().min(0).max(100).default(100),
    invalidation_policy: z.enum(["strict", "wick_tolerant", "confirmed_close"]).default("strict"),
  })
  .refine(
    (s) =>
      s.score_threshold_dead < s.score_initial && s.score_initial < s.score_threshold_finalizer,
    { message: "Doit avoir score_threshold_dead < score_initial < score_threshold_finalizer" },
  );

export const NotifyEventSchema = z.enum([
  "confirmed",
  "rejected",
  "tp_hit",
  "sl_hit",
  "invalidated",
  "invalidated_after_confirmed",
  "expired",
]);
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;

const QuoteTypeSchema = z.enum(["EQUITY", "ETF", "INDEX", "CURRENCY", "FUTURE", "CRYPTOCURRENCY"]);
const SourceSchema = z.enum(["binance", "yahoo"]);

const AssetSchema = z
  .object({
    symbol: z.string(),
    source: SourceSchema,
    quoteType: QuoteTypeSchema.optional(),
    exchange: z.string().optional(),
  })
  .superRefine((asset, ctx) => {
    if (asset.source === "binance") return;
    // source === "yahoo"
    if (!asset.quoteType) {
      ctx.addIssue({
        code: "custom",
        path: ["quoteType"],
        message: "yahoo asset requires quoteType (recreate watch)",
      });
      return;
    }
    if (
      (asset.quoteType === "EQUITY" || asset.quoteType === "ETF" || asset.quoteType === "INDEX") &&
      !asset.exchange
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["exchange"],
        message: `${asset.quoteType} requires exchange`,
      });
    }
  });

export const WatchSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  enabled: z.boolean().default(true),
  asset: AssetSchema,
  timeframes: z.object({
    primary: TimeframeSchema,
    higher: z.array(TimeframeSchema).default([]),
  }),
  schedule: z.object({
    detector_cron: z
      .string()
      .optional()
      .refine((cron) => cron === undefined || isValidFiveFieldCron(cron), {
        message:
          "detector_cron must be a 5-field cron (no seconds field — minimum 1-minute interval enforced)",
      }),
    reviewer_cron: z
      .string()
      .optional()
      .refine((cron) => cron === undefined || isValidFiveFieldCron(cron), {
        message: "reviewer_cron must be a 5-field cron",
      }),
    timezone: z.string().default("UTC"),
  }),
  candles: z.object({
    detector_lookback: z.number().int().positive(),
    reviewer_lookback: z.number().int().positive(),
    reviewer_chart_window: z.number().int().positive(),
  }),
  setup_lifecycle: SetupLifecycleSchema,
  history_compaction: z
    .object({
      max_raw_events_in_context: z.number().int().positive().default(40),
      summarize_after_age_hours: z.number().int().positive().default(48),
    })
    .prefault({}),
  deduplication: z
    .object({
      similar_setup_window_candles: z.number().int().positive().default(5),
      similar_price_tolerance_pct: z.number().positive().default(0.5),
    })
    .prefault({}),
  pre_filter: PreFilterSchema,
  analyzers: z.object({
    detector: AnalyzerSchema,
    reviewer: AnalyzerSchema,
    finalizer: AnalyzerSchema,
  }),
  optimization: z
    .object({
      reviewer_skip_when_detector_corroborated: z.boolean().default(true),
    })
    .prefault({}),
  notify_on: z.array(NotifyEventSchema).default([]),
  include_chart_image: z.boolean().default(true),
  include_reasoning: z.boolean().default(true),
  budget: z
    .object({
      max_cost_usd_per_day: z.number().positive().optional(),
      pause_on_budget_exceeded: z.boolean().default(true),
    })
    .prefault({}),
});

export type WatchConfig = z.infer<typeof WatchSchema>;
