import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@client/components/ui/accordion";
import { Badge } from "@client/components/ui/badge";
import { cn } from "@client/lib/utils";
import { FeedbackAnalysisCard } from "./feedback-analysis-card";
import type { ReplayEventRow } from "./replay-types";
import { TelegramPreview } from "./telegram-preview";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function extractReasoning(event: ReplayEventRow): string | null {
  const payload = event.payload as { data?: unknown };
  const data = payload.data as { reasoning?: string; rationale?: string } | undefined;
  return data?.reasoning ?? data?.rationale ?? null;
}

function extractTelegramText(event: ReplayEventRow): string | null {
  // The replay workflow attaches the formatted Telegram preview to
  // `data.telegramPreview` whenever it persists an event that would
  // have triggered a notification in live. Events copied from the live
  // baseline (Jalon 1 path) have no preview attached → returns null.
  const payload = event.payload as { data?: { telegramPreview?: string } };
  return payload.data?.telegramPreview ?? null;
}

export function CurrentPhaseCard({
  event,
  sessionId,
}: {
  event: ReplayEventRow | null;
  sessionId: string;
}) {
  if (!event) {
    return (
      <div className="rounded-md border bg-card p-3 text-xs text-muted-foreground italic">
        Aucun event sélectionné. Clique une ligne du log pour voir le détail.
      </div>
    );
  }

  const reasoning = extractReasoning(event);
  const telegram = extractTelegramText(event);
  const delta = event.scoreDelta;
  const deltaCls =
    delta > 0 ? "text-emerald-400" : delta < 0 ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="rounded-md border bg-card p-3 space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Phase courante
          </div>
          <div className="font-semibold">
            {event.stage} · {event.type}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {delta !== 0 && (
            <Badge variant="outline" className={cn("text-[10px]", deltaCls)}>
              Δ {delta > 0 ? "+" : ""}
              {delta}
            </Badge>
          )}
          {event.scoreAfter !== null && (
            <Badge variant="outline" className="text-[10px]">
              score {event.scoreAfter}
            </Badge>
          )}
          {event.cacheHit && (
            <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-400">
              cache hit
            </Badge>
          )}
        </div>
      </div>

      <div className="text-xs text-muted-foreground font-mono">
        {fmtTime(event.occurredAt)} · seq #{event.sequence}
        {event.setupId && <> · setup {event.setupId.slice(0, 8)}</>}
        {event.provider && (
          <>
            {" "}
            · {event.provider}/{event.model}
          </>
        )}
        {event.latencyMs !== null && <> · {event.latencyMs}ms</>}
      </div>

      {event.type === "FeedbackLessonProposed" ? (
        <FeedbackAnalysisCard event={event} sessionId={sessionId} />
      ) : (
        <>
          {reasoning && (
            <div className="text-xs leading-relaxed whitespace-pre-wrap border-l-2 border-primary/30 pl-3">
              {reasoning}
            </div>
          )}
          {telegram && <TelegramPreview text={telegram} />}
        </>
      )}

      <Accordion type="single" collapsible>
        <AccordionItem value="raw">
          <AccordionTrigger className="text-xs">
            Voir input snapshot / payload brut
          </AccordionTrigger>
          <AccordionContent>
            <pre className="text-[10px] font-mono whitespace-pre-wrap bg-muted/30 p-2 rounded overflow-x-auto">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
            {event.inputHash && (
              <div className="text-[10px] text-muted-foreground mt-2 font-mono">
                inputHash: {event.inputHash}
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
