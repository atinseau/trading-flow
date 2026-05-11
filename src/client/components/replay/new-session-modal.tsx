import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { useWatches } from "@client/hooks/useWatches";
import { ApiError, api } from "@client/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  CreateSessionBody,
  FeedbackMode,
  LessonsMode,
  ReplaySessionRow,
} from "./replay-types";

const TIMEFRAME_MINUTES: Record<string, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "1d": 1440,
  "1w": 10080,
};

const MAX_WINDOW_CANDLES = 300;

function toLocalInput(d: Date): string {
  // datetime-local needs "YYYY-MM-DDTHH:mm" in local tz
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(s: string): Date {
  return new Date(s);
}

export function NewSessionModal(props: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const watches = useWatches();
  const enabled = (watches.data ?? []).filter((w) => w.enabled);

  const [watchId, setWatchId] = useState<string>("");
  const [name, setName] = useState("");
  const [startStr, setStartStr] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 60 * 60_000)),
  );
  const [endStr, setEndStr] = useState(() => toLocalInput(new Date()));
  const [costCap, setCostCap] = useState<string>("5");
  const [lessonsMode, setLessonsMode] = useState<LessonsMode>("current");
  const [feedbackMode, setFeedbackMode] = useState<FeedbackMode>("run");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWatch = useMemo(() => enabled.find((w) => w.id === watchId), [enabled, watchId]);

  const validation = useMemo(() => {
    if (!watchId) return { ok: false as const, reason: "Choisis une watch." };
    if (!selectedWatch) return { ok: false as const, reason: "Watch introuvable." };
    const start = fromLocalInput(startStr);
    const end = fromLocalInput(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { ok: false as const, reason: "Dates invalides." };
    }
    if (end <= start) return { ok: false as const, reason: "Fin doit être > début." };
    if (end > new Date()) return { ok: false as const, reason: "Fenêtre dans le futur." };
    const tf = selectedWatch.config.timeframes.primary;
    const minutesPerCandle = TIMEFRAME_MINUTES[tf];
    if (!minutesPerCandle) {
      return { ok: false as const, reason: `Timeframe non supporté: ${tf}` };
    }
    const candles = Math.ceil((end.getTime() - start.getTime()) / 60_000 / minutesPerCandle);
    if (candles > MAX_WINDOW_CANDLES) {
      return {
        ok: false as const,
        reason: `Fenêtre trop large: ${candles} bougies (max ${MAX_WINDOW_CANDLES})`,
      };
    }
    const cap = Number.parseFloat(costCap);
    if (!Number.isFinite(cap) || cap < 0.5) {
      return { ok: false as const, reason: "Cost cap minimum $0.50" };
    }
    return { ok: true as const, candles, cap };
  }, [watchId, selectedWatch, startStr, endStr, costCap]);

  async function submit() {
    if (!validation.ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: CreateSessionBody = {
        watchId,
        name: name.trim() ? name.trim() : null,
        windowStartAt: fromLocalInput(startStr).toISOString(),
        windowEndAt: fromLocalInput(endStr).toISOString(),
        costCapUsd: validation.cap,
        lessonsMode,
        feedbackMode,
      };
      const result = await api<{ session: ReplaySessionRow }>("/api/replay/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await queryClient.invalidateQueries({ queryKey: ["replay", "list"] });
      props.onClose();
      navigate(`/replay/${result.session.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string } | null;
        setError(body?.error ?? e.message);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Nouvelle session de replay</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="space-y-1">
            <Label>Watch</Label>
            <Select value={watchId} onValueChange={setWatchId}>
              <SelectTrigger>
                <SelectValue placeholder="Choisis une watch…" />
              </SelectTrigger>
              <SelectContent>
                {enabled.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.id} ({w.config.timeframes.primary})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="name">Nom (optionnel)</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='ex: "Comprendre la perte du 12 avril"'
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="start">Début</Label>
              <Input
                id="start"
                type="datetime-local"
                value={startStr}
                onChange={(e) => setStartStr(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="end">Fin</Label>
              <Input
                id="end"
                type="datetime-local"
                value={endStr}
                onChange={(e) => setEndStr(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Lessons mode</Label>
            <Select value={lessonsMode} onValueChange={(v) => setLessonsMode(v as LessonsMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">
                  Current — lessons actives aujourd'hui (replay "as if today")
                </SelectItem>
                <SelectItem value="historical">
                  Historical — lessons d'époque (fidèle au bot d'avant)
                </SelectItem>
                <SelectItem value="disabled">
                  Disabled — aucune lesson (mesure leur impact)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>Feedback loop</Label>
            <Select value={feedbackMode} onValueChange={(v) => setFeedbackMode(v as FeedbackMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="run">
                  Run — analyse rétroactive activée à chaque fermeture
                </SelectItem>
                <SelectItem value="skip">Skip — pas d'analyse feedback</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="cap">Cost cap LLM ($)</Label>
            <Input
              id="cap"
              type="number"
              step="0.1"
              min="0.5"
              value={costCap}
              onChange={(e) => setCostCap(e.target.value)}
            />
          </div>

          {validation.ok && (
            <div className="text-xs text-muted-foreground">
              {validation.candles} bougies · cap ${validation.cap.toFixed(2)}
            </div>
          )}
          {!validation.ok && watchId && (
            <div className="text-xs text-amber-400">{validation.reason}</div>
          )}
          {error && <div className="text-xs text-red-400">Erreur : {error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={submitting}>
            Annuler
          </Button>
          <Button onClick={submit} disabled={!validation.ok || submitting}>
            {submitting ? "Création…" : "Créer la session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
