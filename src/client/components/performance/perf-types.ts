export type PerfKpis = {
  tradeCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  totalR: number;
  profitFactor: number | null;
  expectancy: number | null;
  avgWin: number;
  avgLoss: number;
  avgPnlPct: number;
  maxDrawdownR: number;
  totalCostUsd: number;
};

export type EquityPoint = { closedAt: string | null; cumulativeR: number };
export type RBucket = { bucket: number; count: number };
export type CalibrationPoint = {
  scoreBucket: number;
  observedWinRate: number;
  count: number;
};
export type PatternRow = {
  pattern: string;
  direction: string;
  trades: number;
  totalR: number;
  winRate: number | null;
  profitFactor: number | null;
};
export type CostStage = { stage: string; costUsd: number };

export type PerfResponse = {
  windowDays: number;
  kpis: PerfKpis;
  equityCurve: EquityPoint[];
  rDistribution: RBucket[];
  calibration: CalibrationPoint[];
  byPattern: PatternRow[];
  costByStage: CostStage[];
};
