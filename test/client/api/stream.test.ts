import { describe, expect, test } from "bun:test";
import { makeStreamHandler } from "@client/api/stream";
import { Broadcaster } from "@client/lib/broadcaster";

const decode = (chunk: Uint8Array) => new TextDecoder().decode(chunk);

describe("SSE stream", () => {
  test("subscribes to topics from query string and pushes payloads", async () => {
    const b = new Broadcaster();
    const handler = makeStreamHandler({ broadcaster: b, heartbeatMs: 10_000 });
    const res = await handler(new Request("http://x/api/stream?topics=events"));

    expect(res.headers.get("content-type")).toBe("text/event-stream");

    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    setTimeout(() => b.emit("events", { id: "abc", type: "Strengthened" }), 30);

    let buf = "";
    const start = Date.now();
    while (!buf.includes("Strengthened") && Date.now() - start < 1000) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += decode(value);
    }
    expect(buf).toContain("event: events");
    expect(buf).toContain("Strengthened");
    await reader.cancel();
  });

  test("emits heartbeat lines", async () => {
    const b = new Broadcaster();
    const handler = makeStreamHandler({ broadcaster: b, heartbeatMs: 50 });
    const res = await handler(new Request("http://x/api/stream"));
    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();

    let buf = "";
    const start = Date.now();
    while (!buf.includes("heartbeat") && Date.now() - start < 1000) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += decode(value);
    }
    expect(buf).toContain("heartbeat");
    await reader.cancel();
  });

  test("filters out invalid topic names", async () => {
    const b = new Broadcaster();
    const handler = makeStreamHandler({ broadcaster: b, heartbeatMs: 10_000 });
    const res = await handler(new Request("http://x/api/stream?topics=events,garbage"));
    expect(res.status).toBe(200);
    // Only "events" is a real topic; "garbage" should be silently dropped.
    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    setTimeout(() => {
      b.emit("events", { id: "1" });
      // Emitting on "garbage" wouldn't typecheck; we just confirm the stream stays open.
    }, 30);
    let buf = "";
    const start = Date.now();
    while (!buf.includes('"id":"1"') && Date.now() - start < 1000) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += decode(value);
    }
    expect(buf).toContain("event: events");
    await reader.cancel();
  });
});
