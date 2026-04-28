// Mirror of one watch entry in YAML — runtime DTO after Zod parsing
export type Watch = {
  id: string;
  enabled: boolean;
  asset: { symbol: string; source: string };
  timeframes: { primary: string; higher: string[] };
  schedule: { detectorCron: string; timezone: string };
  candles: { detectorLookback: number; reviewerLookback: number; reviewerChartWindow: number };
  setupLifecycle: {
    ttlCandles: number;
    scoreInitial: number;
    scoreThresholdFinalizer: number;
    scoreThresholdDead: number;
    scoreMax: number;
    invalidationPolicy: "strict" | "wick_tolerant" | "confirmed_close";
  };
  historyCompaction: { maxRawEventsInContext: number; summarizeAfterAgeHours: number };
  deduplication: { similarSetupWindowCandles: number; similarPriceTolerancePct: number };
  preFilter: {
    enabled: boolean;
    mode: "lenient" | "strict" | "off";
    thresholds: { atrRatioMin: number; volumeSpikeMin: number; rsiExtremeDistance: number };
  };
  analyzers: {
    detector: { provider: string; model: string };
    reviewer: { provider: string; model: string };
    finalizer: { provider: string; model: string };
  };
  optimization: { reviewerSkipWhenDetectorCorroborated: boolean };
  notifications: {
    telegramChatId: string;
    notifyOn: string[];
    includeChartImage: boolean;
    includeReasoning: boolean;
  };
  budget: { maxCostUsdPerDay?: number; pauseOnBudgetExceeded: boolean };
};
