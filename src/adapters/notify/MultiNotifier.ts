import type { Notifier } from "@domain/ports/Notifier";

export class MultiNotifier implements Notifier {
  constructor(private readonly delegates: Notifier[]) {}

  async send(args: Parameters<Notifier["send"]>[0]): Promise<{ messageId: number }> {
    let firstResult: { messageId: number } | null = null;
    for (const d of this.delegates) {
      const r = await d.send(args);
      if (firstResult === null) firstResult = r;
    }
    return firstResult ?? { messageId: 0 };
  }
}
