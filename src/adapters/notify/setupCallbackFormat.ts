/**
 * Telegram callback_data format for setup-lifecycle inline buttons.
 *
 * The notification worker also handles legacy lesson approve/reject buttons
 * (see lessonProposalFormat.ts — `v1|<a|r>|<lessonId>`). To avoid colliding
 * with that scheme AND to keep already-sent lesson messages working, we
 * reserve a separate version+namespace prefix for setup callbacks:
 *
 *   v2|setup|<action>|<setupId>
 *
 * The notification worker tries `parseSetupCallback` first; on null it falls
 * back to the legacy `parseCallbackData` (lesson). New setup actions can be
 * added by extending SetupCallbackAction without breaking either format.
 *
 * Telegram caps callback_data at 64 bytes; the longest possible payload here
 * is `v2|setup|kill|<36-char-uuid>` = 51 bytes — well under the limit.
 */

export type SetupCallbackAction = "kill";

export function encodeSetupCallback(args: {
  action: SetupCallbackAction;
  setupId: string;
}): string {
  return `v2|setup|${args.action}|${args.setupId}`;
}

export function parseSetupCallback(
  data: string,
): { action: SetupCallbackAction; setupId: string } | null {
  const parts = data.split("|");
  if (parts.length !== 4 || parts[0] !== "v2" || parts[1] !== "setup") return null;
  const [, , action, setupId] = parts;
  if (action !== "kill") return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupId ?? "")) {
    return null;
  }
  return { action: "kill", setupId: setupId as string };
}
