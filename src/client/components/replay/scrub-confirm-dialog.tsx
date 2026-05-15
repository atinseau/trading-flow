import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@client/components/ui/alert-dialog";
import { fmtParisShort } from "@client/lib/format";

/**
 * Controlled confirmation dialog opened when the user releases the scrubber
 * forward of the bot's last processed tick. The scrubber's design is
 * "drag = preview", so the modal is what turns the visual gesture into
 * an actual LLM-spending tick dispatch.
 *
 * Pure / dumb component : the parent owns the batch computation, the
 * cost estimate, and the dispatch. We just present the numbers.
 *
 * Cancel resets the parent's `scrubMs` back to the bot's position (the
 * preview disappears). Confirm dispatches via the parent's onConfirm.
 */
export function ScrubConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  botAt: Date;
  targetAt: Date;
  tickCount: number;
  estimatedCostUsd: number;
  /** Set when the requested distance exceeded the 50-tick batch cap. */
  truncatedToMax: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Avancer le bot de {props.tickCount} tick{props.tickCount > 1 ? "s" : ""} ?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <div className="font-mono text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <span className="text-muted-foreground">Bot actuellement</span>
                <span>{fmtParisShort(props.botAt)}</span>
                <span className="text-muted-foreground">Position cible</span>
                <span>{fmtParisShort(props.targetAt)}</span>
                <span className="text-muted-foreground">Coût estimé</span>
                <span>≈ ${props.estimatedCostUsd.toFixed(2)}</span>
              </div>
              {props.truncatedToMax && (
                <div className="text-[11px] text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded px-2 py-1.5">
                  Distance plafonnée à 50 ticks (limite du signal Temporal). Relance un autre Step
                  après pour aller plus loin.
                </div>
              )}
              <div className="text-[11px] text-muted-foreground">
                Le workflow va consommer du budget LLM réel. Annuler ramène la vue sur la position
                du bot.
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuler</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>Confirmer</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
