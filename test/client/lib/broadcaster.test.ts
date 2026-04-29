import { Broadcaster, type Topic } from "@client/lib/broadcaster";
import { describe, expect, test } from "bun:test";

const fakeSub = () => {
  const received: { topic: Topic; payload: unknown }[] = [];
  return {
    send: (topic: Topic, payload: unknown) => received.push({ topic, payload }),
    received,
  };
};

describe("Broadcaster", () => {
  test("emit fans out only to subscribed topics", () => {
    const b = new Broadcaster();
    const a = fakeSub();
    const z = fakeSub();
    b.subscribe(["events"], a);
    b.subscribe(["watches"], z);

    b.emit("events", { id: 1 });
    b.emit("watches", { id: 2 });
    b.emit("ticks", { id: 3 });

    expect(a.received).toEqual([{ topic: "events", payload: { id: 1 } }]);
    expect(z.received).toEqual([{ topic: "watches", payload: { id: 2 } }]);
  });

  test("unsubscribe removes the subscriber", () => {
    const b = new Broadcaster();
    const sub = fakeSub();
    const unsub = b.subscribe(["events"], sub);

    b.emit("events", { id: 1 });
    unsub();
    b.emit("events", { id: 2 });

    expect(sub.received).toEqual([{ topic: "events", payload: { id: 1 } }]);
  });

  test("multiple subscribers on same topic all receive", () => {
    const b = new Broadcaster();
    const a = fakeSub();
    const c = fakeSub();
    b.subscribe(["events"], a);
    b.subscribe(["events"], c);
    b.emit("events", { id: 1 });
    expect(a.received.length).toBe(1);
    expect(c.received.length).toBe(1);
  });
});
