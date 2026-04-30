import { describe, expect, test } from "bun:test";
import { makeAdminApi } from "@client/api/admin";

const POST = (body?: unknown) =>
  new Request("http://x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("admin API", () => {
  test("forceTick calls forceTick helper", async () => {
    const calls: string[] = [];
    const api = makeAdminApi({
      ops: {
        forceTick: async ({ watchId }) => {
          calls.push(`tick:${watchId}`);
        },
        pauseWatch: async () => undefined,
        resumeWatch: async () => undefined,
        killSetup: async () => undefined,
      },
    });
    const res = await api.forceTick(POST(), { id: "btc-1h" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["tick:btc-1h"]);
  });

  test("pause + resume call helpers", async () => {
    const calls: string[] = [];
    const api = makeAdminApi({
      ops: {
        forceTick: async () => undefined,
        pauseWatch: async ({ watchId }) => {
          calls.push(`pause:${watchId}`);
        },
        resumeWatch: async ({ watchId }) => {
          calls.push(`resume:${watchId}`);
        },
        killSetup: async () => undefined,
      },
    });
    await api.pause(POST(), { id: "btc-1h" });
    await api.resume(POST(), { id: "btc-1h" });
    expect(calls).toEqual(["pause:btc-1h", "resume:btc-1h"]);
  });

  test("killSetup uses default reason when body empty", async () => {
    const calls: string[] = [];
    const api = makeAdminApi({
      ops: {
        forceTick: async () => undefined,
        pauseWatch: async () => undefined,
        resumeWatch: async () => undefined,
        killSetup: async ({ setupId, reason }) => {
          calls.push(`${setupId}:${reason}`);
        },
      },
    });
    const res = await api.killSetup(POST({}), { id: "abc" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["abc:manual_close"]);
  });

  test("killSetup uses provided reason", async () => {
    const calls: string[] = [];
    const api = makeAdminApi({
      ops: {
        forceTick: async () => undefined,
        pauseWatch: async () => undefined,
        resumeWatch: async () => undefined,
        killSetup: async ({ setupId, reason }) => {
          calls.push(`${setupId}:${reason}`);
        },
      },
    });
    await api.killSetup(POST({ reason: "stale" }), { id: "abc" });
    expect(calls).toEqual(["abc:stale"]);
  });
});
