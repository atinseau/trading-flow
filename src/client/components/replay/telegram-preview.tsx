import { Badge } from "@client/components/ui/badge";

/**
 * Renders the Telegram message that would have been sent in production
 * by the corresponding event. In replay mode the message is formatted
 * inline via `formatTelegramText` and attached as `data.telegramPreview`
 * on the persisted event — never actually sent to Telegram. Displayed
 * with a clearly muted style + (NEUTRALISÉ) badge so it can't be
 * mistaken for a real notification.
 */
export function TelegramPreview(props: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Telegram preview
        </div>
        <Badge
          variant="outline"
          className="text-[10px] text-muted-foreground border-muted-foreground/40"
        >
          NEUTRALISÉ
        </Badge>
      </div>
      <pre className="text-[11px] font-mono whitespace-pre-wrap text-muted-foreground/80">
        {props.text}
      </pre>
    </div>
  );
}
