/**
 * Parity-harness types.
 *
 * The harness runs a single `PipelineScenario` through BOTH the live and
 * replay pipelines and compares the resulting event chains. A scenario
 * is a deterministic recipe : a watch config + an initial setup +
 * per-tick LLM verdicts (detector / reviewer / finalizer) + candles.
 *
 * The two pipelines run different machinery (Temporal workflows vs
 * in-process processTick orchestrator) but must produce the same
 * canonical event sequence — that's the invariant the harness asserts.
 */

import type { DetectorOutput } from "@domain/schemas/DetectorOutput";
import type { Verdict } from "@domain/schemas/Verdict";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

/**
 * Finalizer decision payload mirroring the relevant subset of
 * `FinalizerOutput`. We don't import the schema here so scenarios can
 * stay terse — the runners coerce into the runtime shape.
 */
export type FinalizerDecision = {
  go: boolean;
  reasoning: string;
  entry?: number;
  stop_loss?: number;
  take_profit?: number[];
};

export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: string;
};

export type PriceTick = {
  price: number;
  observedAt: string;
};

/**
 * Normalized capture of one persisted event from either pipeline. The
 * runners extract these fields from `persistEvent` (live) or
 * `appendReplayEvent` (replay) call sites. `payloadSource` flattens
 * the discriminant `payload.data.source` used by Strengthened /
 * Weakened events — the helper that fixes Drift A relies on this
 * discriminant being identical across pipelines.
 */
export type CapturedEvent = {
  setupId: string;
  type: string;
  stage: string;
  actor: string;
  scoreDelta: number;
  scoreAfter: number;
  statusBefore?: SetupStatus | null;
  statusAfter?: SetupStatus | null;
  payloadType: string;
  payloadSource?: string;
  occurredAt: string;
};

/**
 * A loose assertion on a canonical event — fields omitted are treated
 * as "don't care". Used by `expectEventChain` to declare the expected
 * shape of a scenario's emitted chain without overspecifying.
 */
export type ExpectedEvent = {
  type: string;
  statusBefore?: SetupStatus;
  statusAfter?: SetupStatus;
  /** Sign of `scoreDelta` to expect : -1 negative, 0 zero, 1 positive. */
  scoreDeltaSign?: -1 | 0 | 1;
  /** Match `payload.data.source` if present. */
  source?: "reviewer_full" | "detector_corroboration" | "detector_decorroboration";
};

export type PipelineScenario = {
  name: string;
  description: string;
  watch: WatchConfig;
  setup: {
    setupId: string;
    direction: "LONG" | "SHORT";
    initialScore: number;
    invalidationLevel: number;
    patternHint: string;
    patternCategory: "event" | "accumulation";
    expectedMaturationTicks: number;
  };
  ticks: Array<{
    tickAt: string;
    detectorVerdict: DetectorOutput;
    reviewerVerdict?: Verdict;
    finalizerDecision?: FinalizerDecision;
    candle: Candle;
    /** Optional intra-candle price ticks for the live price-monitor channel. */
    intraCandlePrices?: PriceTick[];
  }>;
  expectedEventChain: ExpectedEvent[];
};
