import type {
  FeedbackContextChunk,
  FeedbackContextProvider,
  FeedbackContextScope,
} from "@domain/ports/FeedbackContextProvider";
import type { TickSnapshotStore } from "@domain/ports/TickSnapshotStore";

export class TickSnapshotsContextProvider implements FeedbackContextProvider {
  readonly id = "tick-snapshots";
  constructor(private readonly deps: { tickStore: TickSnapshotStore }) {}

  isApplicable(_scope: FeedbackContextScope): boolean {
    return true;
  }

  async gather(scope: FeedbackContextScope): Promise<FeedbackContextChunk[]> {
    const ticks = await this.deps.tickStore.listInWindow({
      watchId: scope.watchId,
      from: scope.setupCreatedAt,
      to: scope.setupClosedAt,
    });
    const lines: string[] = [];
    lines.push(`### Indicator snapshots (${ticks.length} ticks)\n`);
    lines.push("| tickAt | rsi | emaShort | emaMid | emaLong | atr |");
    lines.push("|---|---|---|---|---|---|");
    for (const t of ticks) {
      const i = t.indicators;
      lines.push(
        `| ${t.tickAt.toISOString()} | ${i.rsi} | ${i.emaShort} | ${i.emaMid} | ${i.emaLong} | ${i.atr} |`,
      );
    }
    return [
      {
        providerId: this.id,
        title: "Indicator snapshots (per tick)",
        content: { kind: "markdown", value: lines.join("\n") },
      },
    ];
  }
}
