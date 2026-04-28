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

const AnalyzerSchema = z.object({
  provider: z.string(),
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

const NotifyEventSchema = z.enum([
  "confirmed",
  "rejected",
  "tp_hit",
  "sl_hit",
  "invalidated",
  "invalidated_after_confirmed",
  "expired",
]);

const WatchSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  enabled: z.boolean().default(true),
  asset: z.object({ symbol: z.string(), source: z.string() }),
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
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;
