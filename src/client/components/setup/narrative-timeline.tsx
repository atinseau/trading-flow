import type { SetupEvent } from "./events-timeline";
import { Badge } from "../ui/badge";
import { ScoreChart } from "./score-chart";
import { fmtCost } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useMemo, useState } from "react";

type Phase =
  | { kind: "birth"; event: SetupEvent }
  | { kind: "refinement"; events: SetupEvent[]; scoreStart: number; scoreEnd: number }
  | { kind: "decision"; event: SetupEvent } // Confirmed or Rejected
  | { kind: "trade"; events: SetupEvent[] } // EntryFilled, TPHit, SLHit, TrailingMoved
  | { kind: "death"; event: SetupEvent } // Invalidated / Expired / PriceInvalidated (pre-trade only)
  | { kind: "lessons"; peakScore: number; confirmationScore: number | null; totalCost: number };

const REFINEMENT_TYPES = new Set(["Strengthened", "Weakened", "Neutral"]);
const TRADE_TYPES = new Set(["EntryFilled", "TPHit", "SLHit", "TrailingMoved"]);
const DEATH_TYPES = new Set(["Invalidated", "PriceInvalidated", "Expired"]);

function groupIntoPhases(events: SetupEvent[]): Phase[] {
  const phases: Phase[] = [];
  let i = 0;

  // 1. Birth — must be first event
  if (events[0]?.type === "SetupCreated") {
    phases.push({ kind: "birth", event: events[0] });
    i = 1;
  }

  // 2. Refinement — collect contiguous Strengthened/Weakened/Neutral until decision
  const refinement: SetupEvent[] = [];
  while (i < events.length && REFINEMENT_TYPES.has(events[i]!.type)) {
    refinement.push(events[i]!);
    i++;
  }
  if (refinement.length > 0) {
    phases.push({
      kind: "refinement",
      events: refinement,
      scoreStart: Number(refinement[0]!.scoreAfter) - Number(refinement[0]!.scoreDelta || 0),
      scoreEnd: Number(refinement[refinement.length - 1]!.scoreAfter),
    });
  }

  // 3. Decision — Confirmed or Rejected
  if (i < events.length && (events[i]!.type === "Confirmed" || events[i]!.type === "Rejected")) {
    phases.push({ kind: "decision", event: events[i]! });
    i++;
  }

  // 4. Trade lifecycle — EntryFilled, TPHit, SLHit, TrailingMoved
  const tradeEvents: SetupEvent[] = [];
  while (i < events.length && TRADE_TYPES.has(events[i]!.type)) {
    tradeEvents.push(events[i]!);
    i++;
  }
  if (tradeEvents.length > 0) {
    phases.push({ kind: "trade", events: tradeEvents });
  }

  // 5. Death — terminal pre/post-trade event (Invalidated/Expired/PriceInvalidated)
  while (i < events.length && DEATH_TYPES.has(events[i]!.type)) {
    phases.push({ kind: "death", event: events[i]! });
    i++;
  }

  // Anything left — unclassified, append as raw refinement-style group
  if (i < events.length) {
    phases.push({ kind: "refinement", events: events.slice(i), scoreStart: 0, scoreEnd: 0 });
  }

  return phases;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PhaseHeader({
  icon,
  title,
  subtitle,
}: {
  icon: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-base">{icon}</span>
      <span className="text-sm font-semibold uppercase tracking-wide">{title}</span>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
    </div>
  );
}

function ReasoningBlock({ event }: { event: SetupEvent }) {
  const data = event.payload?.data as
    | { reasoning?: string; observations?: string[] }
    | undefined;
  if (!data?.reasoning && (!data?.observations || data.observations.length === 0)) {
    return null;
  }
  return (
    <div className="space-y-2 mt-2">
      {data.reasoning && (
        <div className="text-xs leading-relaxed text-foreground/85 border-l-2 border-primary/40 pl-3">
          {data.reasoning}
        </div>
      )}
      {data.observations && data.observations.length > 0 && (
        <ul className="space-y-1 ml-3">
          {data.observations.map((o, idx) => (
            <li key={idx} className="text-[11px] text-muted-foreground">
              <span className="text-primary mr-1">·</span>
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SmallEventLine({ e }: { e: SetupEvent }) {
  const delta = Number(e.scoreDelta);
  const sign = delta > 0 ? "+" : "";
  return (
    <div className="flex items-center gap-2 text-[11px] py-1">
      <span className="text-muted-foreground font-mono w-20 shrink-0">{fmtTime(e.occurredAt)}</span>
      <Badge variant="outline" className="text-[9px] uppercase">{e.type}</Badge>
      <span className="font-mono ml-auto">
        {delta !== 0 && `${sign}${delta.toFixed(0)} → `}
        {Number(e.scoreAfter).toFixed(0)}
      </span>
    </div>
  );
}

export function NarrativeTimeline({ events }: { events: SetupEvent[] }) {
  const [showNeutral, setShowNeutral] = useState(false);
  const filtered = useMemo(
    () => (showNeutral ? events : events.filter((e) => e.type !== "Neutral")),
    [events, showNeutral],
  );
  const phases = useMemo(() => groupIntoPhases(filtered), [filtered]);
  const neutralCount = events.filter((e) => e.type === "Neutral").length;

  // Lessons block — always last
  const peakScore = events.reduce((max, e) => Math.max(max, Number(e.scoreAfter)), 0);
  const confirmationScore = (() => {
    const c = events.find((e) => e.type === "Confirmed");
    return c ? Number(c.scoreAfter) : null;
  })();
  const totalCost = events.reduce((sum, e) => sum + Number(e.costUsd ?? 0), 0);

  return (
    <div className="space-y-6">
      {neutralCount > 0 && (
        <button
          type="button"
          onClick={() => setShowNeutral((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {showNeutral ? "Masquer" : "Afficher"} les {neutralCount} events neutres
        </button>
      )}

      {phases.map((phase, pidx) => {
        if (phase.kind === "birth") {
          const data = phase.event.payload?.data as
            | { pattern?: string; direction?: string; rawObservation?: string; initialScore?: number }
            | undefined;
          return (
            <section key={pidx} className="rounded-lg border bg-card p-4 space-y-2">
              <PhaseHeader
                icon="📍"
                title="Naissance"
                subtitle={`${fmtTime(phase.event.occurredAt)} · score initial ${data?.initialScore ?? Number(phase.event.scoreAfter).toFixed(0)}`}
              />
              <div className="text-sm">
                Pattern <span className="font-mono">{data?.pattern ?? "?"}</span>
                {data?.direction && (
                  <Badge
                    variant={data.direction === "LONG" ? "default" : "destructive"}
                    className="ml-2 text-[10px]"
                  >
                    {data.direction}
                  </Badge>
                )}
              </div>
              {data?.rawObservation && (
                <div className="text-xs text-muted-foreground italic border-l-2 border-primary/30 pl-3">
                  « {data.rawObservation} »
                </div>
              )}
              <div className="text-[10px] text-muted-foreground font-mono">
                {phase.event.provider} · {phase.event.model} · {fmtCost(phase.event.costUsd)} ·{" "}
                {phase.event.latencyMs}ms
              </div>
            </section>
          );
        }

        if (phase.kind === "refinement") {
          const points = phase.events.map((e) => ({
            occurredAt: e.occurredAt,
            scoreAfter: Number(e.scoreAfter),
          }));
          return (
            <section key={pidx} className="rounded-lg border bg-card p-4 space-y-3">
              <PhaseHeader
                icon="📈"
                title="Raffinement"
                subtitle={`${phase.events.length} events · score ${phase.scoreStart.toFixed(0)} → ${phase.scoreEnd.toFixed(0)}`}
              />
              {points.length >= 2 && <ScoreChart points={points} />}
              <div className="space-y-0">
                {phase.events.map((e) => (
                  <div key={e.id} className="border-t border-border first:border-t-0 py-1">
                    <SmallEventLine e={e} />
                    <ReasoningBlock event={e} />
                  </div>
                ))}
              </div>
            </section>
          );
        }

        if (phase.kind === "decision") {
          const isGo = phase.event.type === "Confirmed";
          const data = phase.event.payload?.data as
            | { entry?: number; stopLoss?: number; takeProfit?: number[]; reasoning?: string }
            | undefined;
          return (
            <section
              key={pidx}
              className={cn(
                "rounded-lg border-2 p-4 space-y-2",
                isGo
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-zinc-500/40 bg-zinc-500/5",
              )}
            >
              <PhaseHeader
                icon={isGo ? "✅" : "✋"}
                title={isGo ? "Confirmation GO" : "Rejet NO_GO"}
                subtitle={`${fmtTime(phase.event.occurredAt)} · score ${Number(phase.event.scoreAfter).toFixed(0)}`}
              />
              {isGo && data && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                  {data.entry !== undefined && (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase">Entry</div>
                      {data.entry}
                    </div>
                  )}
                  {data.stopLoss !== undefined && (
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase">SL</div>
                      {data.stopLoss}
                    </div>
                  )}
                  {data.takeProfit?.map((tp, i) => (
                    <div key={i}>
                      <div className="text-[10px] text-muted-foreground uppercase">TP{i + 1}</div>
                      {tp}
                    </div>
                  ))}
                </div>
              )}
              {data?.reasoning && (
                <div className="text-xs leading-relaxed text-foreground/85 border-l-2 border-primary/40 pl-3 mt-2">
                  {data.reasoning}
                </div>
              )}
              <div className="text-[10px] text-muted-foreground font-mono">
                {phase.event.provider} · {phase.event.model} · {fmtCost(phase.event.costUsd)}
              </div>
            </section>
          );
        }

        if (phase.kind === "trade") {
          return (
            <section key={pidx} className="rounded-lg border bg-card p-4 space-y-3">
              <PhaseHeader icon="🎯" title="En trade" subtitle={`${phase.events.length} events`} />
              <div className="space-y-1">
                {phase.events.map((e) => {
                  const data = e.payload?.data as
                    | { fillPrice?: number; level?: number; reason?: string; newStopLoss?: number; index?: number }
                    | undefined;
                  let detail = "";
                  if (e.type === "EntryFilled" && data?.fillPrice) detail = `@ ${data.fillPrice}`;
                  else if (e.type === "TPHit" && data?.level)
                    detail = `TP${(data.index ?? 0) + 1} @ ${data.level}`;
                  else if (e.type === "SLHit" && data?.level) detail = `@ ${data.level}`;
                  else if (e.type === "TrailingMoved" && data?.newStopLoss)
                    detail = `SL → ${data.newStopLoss} (${data.reason ?? ""})`;
                  return (
                    <div
                      key={e.id}
                      className="flex items-center gap-2 text-xs py-1 border-t border-border first:border-t-0"
                    >
                      <span className="text-muted-foreground font-mono w-24 shrink-0">
                        {fmtTime(e.occurredAt)}
                      </span>
                      <Badge variant="outline" className="text-[9px] uppercase">
                        {e.type}
                      </Badge>
                      <span className="font-mono">{detail}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        }

        if (phase.kind === "death") {
          const data = phase.event.payload?.data as
            | { reason?: string; trigger?: string; priceAtInvalidation?: number; invalidationLevel?: number }
            | undefined;
          return (
            <section
              key={pidx}
              className="rounded-lg border-2 border-zinc-500/40 bg-zinc-500/5 p-4 space-y-2"
            >
              <PhaseHeader
                icon="🪦"
                title={phase.event.type}
                subtitle={fmtTime(phase.event.occurredAt)}
              />
              {data?.reason && (
                <div className="text-xs italic text-muted-foreground">{data.reason}</div>
              )}
              {data?.trigger && (
                <div className="text-[11px] text-muted-foreground">
                  Trigger : <span className="font-mono">{data.trigger}</span>
                </div>
              )}
              {data?.priceAtInvalidation !== undefined && data?.invalidationLevel !== undefined && (
                <div className="text-[11px] text-muted-foreground font-mono">
                  Prix {data.priceAtInvalidation} a touché niveau {data.invalidationLevel}
                </div>
              )}
            </section>
          );
        }

        return null;
      })}

      <section className="rounded-lg border bg-muted/30 p-4 space-y-2">
        <PhaseHeader icon="📊" title="Bilan" />
        <div className="grid grid-cols-3 gap-3 text-xs font-mono">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase">Score peak</div>
            <div className="text-base">{peakScore.toFixed(0)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase">Score à conf.</div>
            <div className="text-base">
              {confirmationScore !== null ? confirmationScore.toFixed(0) : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase">Coût LLM</div>
            <div className="text-base">{fmtCost(totalCost)}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
