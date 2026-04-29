export type Topic = "events" | "setups" | "watches" | "ticks";

export type Subscriber = {
  send: (topic: Topic, payload: unknown) => void;
};

export class Broadcaster {
  private subscribers = new Map<Topic, Set<Subscriber>>();

  subscribe(topics: Topic[], sub: Subscriber): () => void {
    for (const t of topics) {
      if (!this.subscribers.has(t)) this.subscribers.set(t, new Set());
      this.subscribers.get(t)!.add(sub);
    }
    return () => topics.forEach((t) => this.subscribers.get(t)?.delete(sub));
  }

  emit(topic: Topic, payload: unknown): void {
    const subs = this.subscribers.get(topic);
    if (!subs) return;
    for (const s of subs) s.send(topic, payload);
  }

  size(topic: Topic): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }
}

export const broadcaster = new Broadcaster();
