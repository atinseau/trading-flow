import { describe, expect, mock, test } from "bun:test";
import { makeWatchesApi } from "@client/api/watches";
import { startTestPostgres } from "@test-helpers/postgres";

const validBody = {
  id: "btc-1h",
  enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: ["4h"] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50,
    score_initial: 25,
    score_threshold_finalizer: 80,
    score_threshold_dead: 10,
    invalidation_policy: "strict",
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6" },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5" },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7" },
    feedback: { provider: "claude_max", model: "claude-opus-4-7" },
  },
  notify_on: ["confirmed"],
};

const hooks = () => ({
  bootstrap: mock(async () => undefined),
  applyReload: mock(async () => undefined),
  tearDown: mock(async () => undefined),
});

const POST = (body: unknown) =>
  new Request("http://x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const PUT = (body: unknown) =>
  new Request("http://x", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("watches API", () => {
  test("GET /api/watches returns empty list initially", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks: hooks() });
      const res = await api.list(new Request("http://x"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await tp.cleanup();
    }
  });

  test("POST /api/watches creates a watch", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks: hooks() });
      const res = await api.create(POST(validBody));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; version: number };
      expect(body.id).toBe("btc-1h");
      expect(body.version).toBe(1);
    } finally {
      await tp.cleanup();
    }
  });

  test("POST /api/watches rejects invalid payload with 400", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks: hooks() });
      const res = await api.create(POST({ id: "BAD!" }));
      expect(res.status).toBe(400);
    } finally {
      await tp.cleanup();
    }
  });

  test("GET /api/watches/:id returns the config or 404", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks: hooks() });
      await api.create(POST(validBody));

      const ok = await api.get(new Request("http://x"), { id: "btc-1h" });
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { version: number };
      expect(okBody.version).toBe(1);

      const miss = await api.get(new Request("http://x"), { id: "nope" });
      expect(miss.status).toBe(404);
    } finally {
      await tp.cleanup();
    }
  });

  test("PUT /api/watches/:id updates and bumps version", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks: hooks() });
      await api.create(POST(validBody));
      const next = { ...validBody, enabled: false };
      const res = await api.update(PUT({ config: next, version: 1 }), { id: "btc-1h" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: number };
      expect(body.version).toBe(2);
    } finally {
      await tp.cleanup();
    }
  });

  test("PUT with stale version returns 409", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks: hooks() });
      await api.create(POST(validBody));
      const res = await api.update(PUT({ config: validBody, version: 99 }), { id: "btc-1h" });
      expect(res.status).toBe(409);
    } finally {
      await tp.cleanup();
    }
  });

  test("DELETE soft-deletes (no longer in list)", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks: hooks() });
      await api.create(POST(validBody));
      const res = await api.del(new Request("http://x", { method: "DELETE" }), { id: "btc-1h" });
      expect(res.status).toBe(204);

      const list = await api.list(new Request("http://x"));
      expect(await list.json()).toEqual([]);
    } finally {
      await tp.cleanup();
    }
  });
});
