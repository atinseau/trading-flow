import type { FeedbackContextProvider } from "@domain/ports/FeedbackContextProvider";
import { getLogger } from "@observability/logger";

const log = getLogger({ component: "feedback-context-registry" });

export const PROVIDER_CANONICAL_ORDER = [
  "setup-events",
  "tick-snapshots",
  "post-mortem-ohlcv",
  "chart-post-mortem",
] as const;

export type KnownProviderId = (typeof PROVIDER_CANONICAL_ORDER)[number];

export class FeedbackContextProviderRegistry {
  constructor(private readonly providers: Record<string, FeedbackContextProvider>) {}

  /**
   * Returns the canonical-ordered list of providers minus the disabled ones.
   * Unknown disabled IDs are logged at warn but do not throw.
   */
  resolveForWatch(disabled: string[]): FeedbackContextProvider[] {
    const disabledSet = new Set(disabled);
    for (const d of disabledSet) {
      if (!(d in this.providers)) {
        log.warn({ id: d }, "feedback context: unknown disabled provider id");
      }
    }
    const out: FeedbackContextProvider[] = [];
    for (const id of PROVIDER_CANONICAL_ORDER) {
      if (disabledSet.has(id)) continue;
      const p = this.providers[id];
      if (p) out.push(p);
    }
    return out;
  }
}
