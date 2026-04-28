import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities";

const a = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "30s",
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: [
      "InvalidConfigError",
      "AssetNotFoundError",
      "LLMSchemaValidationError",
      "PromptTooLargeError",
      "NoProviderAvailableError",
      "CircularFallbackError",
      "StopRequestedError",
    ],
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
  takeProfit: number[];
  /** Score at the moment of confirmation; preserved across TP/SL/Trailing updates. */
  scoreAtConfirmation: number;
};

export type TrackingResult = "CLOSED";

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
  let nextSequenceNumber = 0;

  // Pending tick queue: signal handlers enqueue, the consumer loop processes
  // them serially so concurrent signals can't read stale `nextTpIndex`.
  const pendingTicks: TrackingPriceTick[] = [];

  // Helper: get and increment sequence
  const nextSeq = async (setupId: string): Promise<number> => {
    if (nextSequenceNumber === 0) {
      nextSequenceNumber = (await a.nextSequence({ setupId })).sequence;
    } else {
      nextSequenceNumber++;
    }
    return nextSequenceNumber;
  };

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

    // Check SL hit
    const slHit =
      (args.direction === "LONG" && tick.currentPrice <= currentSL) ||
      (args.direction === "SHORT" && tick.currentPrice >= currentSL);

    if (slHit) {
      const seq = await nextSeq(args.setupId);
      await a.persistEvent({
        event: {
          setupId: args.setupId,
          sequence: seq,
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
      await a.notifyTelegramSLHit({
        watchId: args.watchId,
        asset: args.asset,
        timeframe: args.timeframe,
        level: currentSL,
      });
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
      const seq = await nextSeq(args.setupId);
      await a.persistEvent({
        event: {
          setupId: args.setupId,
          sequence: seq,
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
      await a.notifyTelegramTPHit({
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
        const trailSeq = await nextSeq(args.setupId);
        await a.persistEvent({
          event: {
            setupId: args.setupId,
            sequence: trailSeq,
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
      closed = true;
    }
  }

  await a.markSetupClosed({ setupId: args.setupId, finalStatus: "CLOSED" });
  return "CLOSED";
}
