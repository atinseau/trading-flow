import type { EventStore } from "@domain/ports/EventStore";
import type {
  FeedbackContextChunk,
  FeedbackContextProvider,
  FeedbackContextScope,
} from "@domain/ports/FeedbackContextProvider";

export class SetupEventsContextProvider implements FeedbackContextProvider {
  readonly id = "setup-events";
  constructor(private readonly deps: { eventStore: EventStore }) {}

  isApplicable(_scope: FeedbackContextScope): boolean {
    return true;
  }

  async gather(scope: FeedbackContextScope): Promise<FeedbackContextChunk[]> {
    const events = await this.deps.eventStore.listForSetup(scope.setupId);
    const lines: string[] = [];
    lines.push(`### Setup timeline (${events.length} events)\n`);
    for (const e of events) {
      const scoreBefore = e.scoreAfter - e.scoreDelta;
      lines.push(`#### Tick ${e.sequence} — ${e.type} (${e.occurredAt.toISOString()})`);
      lines.push(`- score: ${scoreBefore} → ${e.scoreAfter}`);
      lines.push(`- status: ${e.statusBefore} → ${e.statusAfter}`);
      const payload = e.payload as { data?: Record<string, unknown> };
      const data = payload.data ?? {};
      const dataRecord = data as Record<string, unknown>;
      if (typeof dataRecord.pattern === "string") {
        lines.push(`- pattern: ${dataRecord.pattern as string}`);
      }
      if (typeof dataRecord.reasoning === "string") {
        lines.push(`- reasoning: ${dataRecord.reasoning as string}`);
      }
      if (Array.isArray(dataRecord.observations)) {
        const obs = dataRecord.observations as { kind?: string; text?: string }[];
        for (const o of obs) {
          lines.push(`  - **${o.kind ?? "obs"}**: ${o.text ?? ""}`);
        }
      }
      lines.push("");
    }
    return [
      {
        providerId: this.id,
        title: "Setup timeline (events)",
        content: { kind: "markdown", value: lines.join("\n") },
      },
    ];
  }
}
