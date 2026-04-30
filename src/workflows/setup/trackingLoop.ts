import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities";

const SHARED_NON_RETRYABLE = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "PromptTooLargeError",
  "NoProviderAvailableError",
  "CircularFallbackError",
  "StopRequestedError",
];

// DB / persistence activities — many fast retries (transient DB blips).
const dbActivities = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "10s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "100ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// Notify (Telegram) — moderate retries, short timeout.
const notifyActivities = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "15s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "500ms",
    maximumInterval: "10s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

export type TrackingPriceTick = { currentPrice: number; observedAt: string };

/** Signal sent by the price monitor (or test) to feed prices into the tracking loop. */
export const trackingPriceSignal = defineSignal<[TrackingPriceTick]>("trackingPrice");

export type TrackingArgs = {
  setupId: string;
  watchId: string;
  asset: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  /**
   * Structural-break level: distinct from the order-level `stopLoss`.
   * If the price crosses this BEFORE the SL it represents a thesis
   * invalidation (different failure mode for the feedback loop).
   */
  invalidationLevel: number;
  takeProfit: number[];
  /** Score at the moment of confirmation; preserved across TP/SL/Trailing updates. */
  scoreAtConfirmation: number;
};

export type TrackingResult = {
  reason: "sl_hit_direct" | "sl_hit_after_tp1" | "price_invalidated" | "all_tps_hit";
};

/**
 * Real position tracking. Receives price ticks via `trackingPrice` signals.
 * Closes the setup when SL hits or all TPs are hit.
 *
 * NOTE: this loop reads `trackingPrice` signals; we use this distinct signal
 * (instead of reusing `priceCheck`) so the TRACKING phase has its own clean
 * channel without conflicting with REVIEWING-phase invalidation logic.
 */
export async function trackingLoop(args: TrackingArgs): Promise<TrackingResult> {
  // Sort TPs by direction so [0] is "first to hit"
  const sortedTPs =
    args.direction === "LONG"
      ? [...args.takeProfit].sort((x, y) => x - y)
      : [...args.takeProfit].sort((x, y) => y - x);

  let nextTpIndex = 0;
  let currentSL = args.stopLoss;
  let closed = false;
  let closeReason: TrackingResult["reason"] | null = null;

  // Pending tick queue: signal handlers enqueue, the consumer loop processes
  // them serially so concurrent signals can't read stale `nextTpIndex`.
  const pendingTicks: TrackingPriceTick[] = [];

  setHandler(trackingPriceSignal, (tick) => {
    if (closed) return;
    pendingTicks.push(tick);
  });

  // Consumer loop: process ticks serially.
  while (!closed) {
    await condition(() => closed || pendingTicks.length > 0);
    if (closed) break;

    const tick = pendingTicks.shift();
    if (!tick) continue;

    // Check price invalidation BEFORE SL — invalidation level is the structural
    // break, distinct from the order-level stop loss. If breached first, it's
    // a different failure mode worth distinguishing for the feedback loop.
    const invalidated =
      (args.direction === "LONG" && tick.currentPrice <= args.invalidationLevel) ||
      (args.direction === "SHORT" && tick.currentPrice >= args.invalidationLevel);

    if (invalidated) {
      await dbActivities.persistEvent({
        event: {
          setupId: args.setupId,
          stage: "tracker",
          actor: "tracker_v1",
          type: "PriceInvalidated",
          scoreDelta: 0,
          scoreAfter: args.scoreAtConfirmation,
          statusBefore: "TRACKING",
          statusAfter: "INVALIDATED",
          payload: {
            type: "PriceInvalidated",
            data: {
              currentPrice: tick.currentPrice,
              invalidationLevel: args.invalidationLevel,
              observedAt: tick.observedAt,
            },
          },
        },
        setupUpdate: { score: args.scoreAtConfirmation, status: "INVALIDATED" },
      });
      await notifyActivities.notifyTelegramInvalidatedAfterConfirmed({
        watchId: args.watchId,
        asset: args.asset,
        timeframe: args.timeframe,
        reason: "price_below_invalidation",
      });
      // Early return — status is INVALIDATED (not CLOSED), so we deliberately
      // skip `markSetupClosed`. The persistEvent above already wrote the
      // INVALIDATED status; calling markSetupClosed would overwrite it.
      return { reason: "price_invalidated" };
    }

    // Check SL hit
    const slHit =
      (args.direction === "LONG" && tick.currentPrice <= currentSL) ||
      (args.direction === "SHORT" && tick.currentPrice >= currentSL);

    if (slHit) {
      await dbActivities.persistEvent({
        event: {
          setupId: args.setupId,
          stage: "tracker",
          actor: "tracker_v1",
          type: "SLHit",
          scoreDelta: 0,
          scoreAfter: args.scoreAtConfirmation,
          statusBefore: "TRACKING",
          statusAfter: "CLOSED",
          payload: {
            type: "SLHit",
            data: { level: currentSL, observedAt: tick.observedAt },
          },
        },
        setupUpdate: { score: args.scoreAtConfirmation, status: "CLOSED" },
      });
      await notifyActivities.notifyTelegramSLHit({
        watchId: args.watchId,
        asset: args.asset,
        timeframe: args.timeframe,
        level: currentSL,
      });
      closeReason = nextTpIndex === 0 ? "sl_hit_direct" : "sl_hit_after_tp1";
      closed = true;
      break;
    }

    // Check TP hits (sequential — only the next TP can hit)
    while (nextTpIndex < sortedTPs.length) {
      const tp = sortedTPs[nextTpIndex];
      if (tp === undefined) break;
      const tpHit =
        (args.direction === "LONG" && tick.currentPrice >= tp) ||
        (args.direction === "SHORT" && tick.currentPrice <= tp);
      if (!tpHit) break;

      const isFinalTp = nextTpIndex === sortedTPs.length - 1;
      await dbActivities.persistEvent({
        event: {
          setupId: args.setupId,
          stage: "tracker",
          actor: "tracker_v1",
          type: "TPHit",
          scoreDelta: 0,
          scoreAfter: args.scoreAtConfirmation,
          statusBefore: "TRACKING",
          statusAfter: isFinalTp ? "CLOSED" : "TRACKING",
          payload: {
            type: "TPHit",
            data: {
              level: tp,
              index: nextTpIndex,
              observedAt: tick.observedAt,
            },
          },
        },
        setupUpdate: {
          score: args.scoreAtConfirmation,
          status: isFinalTp ? "CLOSED" : "TRACKING",
        },
      });
      await notifyActivities.notifyTelegramTPHit({
        watchId: args.watchId,
        asset: args.asset,
        timeframe: args.timeframe,
        level: tp,
        index: nextTpIndex,
        isFinal: isFinalTp,
      });

      // After TP1 hits: move SL to breakeven (entry) — classic risk management
      if (nextTpIndex === 0 && currentSL !== args.entry) {
        const newSL = args.entry;
        await dbActivities.persistEvent({
          event: {
            setupId: args.setupId,
            stage: "tracker",
            actor: "tracker_v1",
            type: "TrailingMoved",
            scoreDelta: 0,
            scoreAfter: args.scoreAtConfirmation,
            statusBefore: "TRACKING",
            statusAfter: "TRACKING",
            payload: {
              type: "TrailingMoved",
              data: { newStopLoss: newSL, reason: "tp1_hit_move_to_breakeven" },
            },
          },
          setupUpdate: { score: args.scoreAtConfirmation, status: "TRACKING" },
        });
        currentSL = newSL;
      }

      nextTpIndex++;
    }

    // All TPs hit?
    if (nextTpIndex >= sortedTPs.length) {
      closeReason = "all_tps_hit";
      closed = true;
    }
  }

  await dbActivities.markSetupClosed({ setupId: args.setupId, finalStatus: "CLOSED" });
  if (closeReason === null) {
    throw new Error("trackingLoop closed without a reason");
  }
  return { reason: closeReason };
}
