import type { Broadcaster, Topic } from "@client/lib/broadcaster";

const ALL_TOPICS: Topic[] = ["events", "setups", "watches", "ticks"];

export function makeStreamHandler(deps: { broadcaster: Broadcaster; heartbeatMs?: number }) {
  const heartbeat = deps.heartbeatMs ?? 25_000;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const requested = (url.searchParams.get("topics") ?? "events,setups,watches,ticks").split(
      ",",
    ) as Topic[];
    const topics = requested.filter((t): t is Topic => ALL_TOPICS.includes(t));

    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array): void => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        };

        const subscriber = {
          send: (topic: Topic, payload: unknown): void => {
            const id = (payload as { id?: string }).id ?? Date.now().toString();
            const msg = `id: ${id}\nevent: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`;
            safeEnqueue(encoder.encode(msg));
          },
        };

        const unsub = deps.broadcaster.subscribe(topics, subscriber);

        const hbInterval = setInterval(
          () => safeEnqueue(encoder.encode(`: heartbeat\n\n`)),
          heartbeat,
        );

        const close = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(hbInterval);
          unsub();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        req.signal.addEventListener("abort", close);
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
