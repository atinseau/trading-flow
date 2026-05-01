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
    /**
     * Minimum reward-to-risk ratio the finalizer requires before approving a
     * GO. 2.0 = TP must be ≥ 2× the distance entry → SL. Lower (1.5) = more
     * trades, lower per-trade EV multiplier; higher (3.0) = fewer but
     * higher-quality. Hardcoded was `1:2`; now configurable per watch.
     */
    min_risk_reward_ratio: z.number().min(1).max(10).default(2.0),
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
  "lesson_proposed",
  "lesson_approved",
  "lesson_rejected",
]);
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;

const QuoteTypeSchema = z.enum(["EQUITY", "ETF", "INDEX", "CURRENCY", "FUTURE", "CRYPTOCURRENCY"]);

const AssetSchema = z
  .object({
    symbol: z.string(),
    source: z.enum(KNOWN_ASSET_SOURCES),
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

export const KNOWN_PROVIDER_IDS = [
  "setup-events",
  "tick-snapshots",
  "post-mortem-ohlcv",
  "chart-post-mortem",
] as const;

export type KnownProviderId = (typeof KNOWN_PROVIDER_IDS)[number];

export const FeedbackInjectionSchema = z.object({
  detector: z.boolean().default(true),
  reviewer: z.boolean().default(true),
  finalizer: z.boolean().default(true),
});

export const FeedbackAnalyzerSchema = z.object({
  provider: z.enum(KNOWN_PROVIDERS),
  model: z.string(),
});

export const FeedbackConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_active_lessons_per_category: z.number().int().min(1).max(200).default(30),
  injection: FeedbackInjectionSchema.prefault({}),
  context_providers_disabled: z.array(z.enum(KNOWN_PROVIDER_IDS)).default([]),
  analyzer: FeedbackAnalyzerSchema.optional(),
});

export type FeedbackConfig = z.infer<typeof FeedbackConfigSchema>;
export type FeedbackInjection = z.infer<typeof FeedbackInjectionSchema>;
export type FeedbackAnalyzer = z.infer<typeof FeedbackAnalyzerSchema>;

export const WatchSchema = z
  .object({
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
      feedback: FeedbackAnalyzerSchema.optional(),
    }),
    optimization: z
      .object({
        reviewer_skip_when_detector_corroborated: z.boolean().default(true),
        /**
         * If true, the detector may emit a setup with `initial_score ≥
         * threshold` AND `expected_maturation_ticks = 1`, in which case the
         * setup workflow skips the reviewer entirely and routes the setup
         * directly to the finalizer in the same tick. Saves ~15-60 minutes on
         * clean event patterns (sweep+reclaim, BB squeeze break) at the cost
         * of bypassing one quality gate. Disable for ultra-conservative use.
         */
        allow_same_tick_fast_path: z.boolean().default(true),
      })
      .prefault({}),
    /**
     * Trading-cost calibration for R:R math at the finalizer. Anthropic's
     * generic "0.1%" prompt was wildly off for many venues (Binance perp
     * maker = 0.02%, Yahoo equities w/ spread can be 0.5%+). Calibrate per
     * watch so the finalizer's risk/reward sanity check is accurate after
     * fees & slippage.
     */
    costs: z
      .object({
        /** Total trading fee (entry + exit) as % of notional. Binance perp ≈ 0.04, spot ≈ 0.2. */
        fees_pct: z.number().min(0).max(2).default(0.1),
        /** Expected slippage as % of notional. Liquid crypto perp ≈ 0.02, illiquid alt ≈ 0.3. */
        slippage_pct: z.number().min(0).max(2).default(0.05),
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
    feedback: FeedbackConfigSchema.prefault({}),
  })
  .superRefine((watch, ctx) => {
    if (watch.feedback.enabled && !watch.feedback.analyzer && !watch.analyzers.feedback) {
      ctx.addIssue({
        code: "custom",
        path: ["feedback", "analyzer"],
        message: `watch '${watch.id}' has feedback.enabled: true but no LLM analyzer configured (set either feedback.analyzer or analyzers.feedback)`,
      });
    }
  });

const LLMProviderConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("claude-agent-sdk"),
    daily_call_budget: z.number().int().positive().optional(),
    fallback: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("openrouter"),
    base_url: z.url().default("https://openrouter.ai/api/v1"),
    monthly_budget_usd: z.number().positive().optional(),
    fallback: z.string().nullable().default(null),
  }),
]);

export const WatchesConfigSchema = z
  .object({
    version: z.literal(1),
    market_data: z.array(z.string()),
    notifications: z
      .object({
        telegram: z.boolean().default(false),
      })
      .prefault({}),
    llm_providers: z.record(z.string(), LLMProviderConfigSchema),
    artifacts: z.object({
      type: z.enum(["filesystem", "s3"]),
      retention: z
        .object({
          keep_days: z.number().int().positive().default(30),
          keep_for_active_setups: z.boolean().default(true),
        })
        .prefault({}),
    }),
    watches: z.array(WatchSchema),
  })
  .superRefine((cfg, ctx) => {
    for (const watch of cfg.watches) {
      if (!cfg.market_data.includes(watch.asset.source)) {
        ctx.addIssue({
          code: "custom",
          path: ["watches", watch.id, "asset", "source"],
          message: `Source "${watch.asset.source}" inconnue (not in market_data)`,
        });
      }
      for (const role of ["detector", "reviewer", "finalizer"] as const) {
        const provider = watch.analyzers[role].provider;
        if (!cfg.llm_providers[provider]) {
          ctx.addIssue({
            code: "custom",
            path: ["watches", watch.id, "analyzers", role, "provider"],
            message: `Provider "${provider}" inconnu`,
          });
        }
      }
    }
    for (const startName of Object.keys(cfg.llm_providers)) {
      const visited = new Set<string>();
      let cur: string | null = startName;
      while (cur !== null) {
        if (visited.has(cur)) {
          ctx.addIssue({
            code: "custom",
            path: ["llm_providers"],
            message: `Cycle dans le graphe fallback: ${[...visited, cur].join(" → ")}`,
          });
          break;
        }
        visited.add(cur);
        const node: z.infer<typeof LLMProviderConfigSchema> | undefined = cfg.llm_providers[cur];
        cur = node?.fallback ?? null;
      }
    }
    const ids = new Set<string>();
    for (const w of cfg.watches) {
      if (ids.has(w.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["watches"],
          message: `ID dupliqué: ${w.id}`,
        });
      }
      ids.add(w.id);
    }
  });

export type WatchesConfig = z.infer<typeof WatchesConfigSchema>;
export type WatchConfig = z.infer<typeof WatchSchema>;
