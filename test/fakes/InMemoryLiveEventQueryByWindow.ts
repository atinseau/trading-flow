import type {
  LiveEventInWindow,
  LiveEventQueryByWindow,
} from "@domain/ports/LiveEventQueryByWindow";

export class InMemoryLiveEventQueryByWindow implements LiveEventQueryByWindow {
  events: LiveEventInWindow[] = [];

  async listEventsInWindow(args: {
    watchId: string;
    windowStartAt: Date;
    windowEndAt: Date;
  }): Promise<LiveEventInWindow[]> {
    return this.events
      .filter(
        (e) =>
          e.watchId === args.watchId &&
          e.occurredAt >= args.windowStartAt &&
          e.occurredAt <= args.windowEndAt,
      )
      .sort((a, b) => {
        const dt = a.occurredAt.getTime() - b.occurredAt.getTime();
        return dt !== 0 ? dt : a.sequence - b.sequence;
      });
  }

  reset(): void {
    this.events = [];
  }
}
