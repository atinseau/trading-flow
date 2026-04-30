export type CallbackAction = "approve" | "reject";

export function encodeCallbackData(args: { action: CallbackAction; lessonId: string }): string {
  const a = args.action === "approve" ? "a" : "r";
  return `v1|${a}|${args.lessonId}`;
}

export function parseCallbackData(
  data: string,
): { action: CallbackAction; lessonId: string } | null {
  const parts = data.split("|");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, a, lessonId] = parts;
  if (a !== "a" && a !== "r") return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lessonId ?? "")) {
    return null;
  }
  return { action: a === "a" ? "approve" : "reject", lessonId: lessonId as string };
}

export type LessonProposalMessageInput = {
  kind: "CREATE" | "REFINE";
  watchId: string;
  category: "detecting" | "reviewing" | "finalizing";
  title: string;
  body: string;
  rationale: string;
  triggerSetupId: string;
  triggerCloseReason: string;
  before?: { title: string; body: string };
};

export function formatLessonProposalMessage(input: LessonProposalMessageInput): string {
  const setupShort = input.triggerSetupId.slice(0, 8);
  const lines: string[] = [];
  lines.push(
    `🧠 *${input.kind === "CREATE" ? "New lesson proposed" : "Refined lesson proposed"}* — watch \`${input.watchId}\``,
  );
  lines.push("");
  lines.push(`Category: \`${input.category}\``);
  lines.push(`Triggered by: setup \`${setupShort}\` — \`${input.triggerCloseReason}\``);
  lines.push("");
  lines.push(`*Title*: ${input.title}`);
  lines.push("");
  lines.push("*Body*:");
  lines.push(input.body);
  lines.push("");
  if (input.before) {
    lines.push("*Before*:");
    lines.push(`  ${input.before.title}`);
    lines.push(`  ${input.before.body}`);
    lines.push("");
  }
  lines.push("*Rationale (LLM)*:");
  lines.push(input.rationale);
  return lines.join("\n");
}
