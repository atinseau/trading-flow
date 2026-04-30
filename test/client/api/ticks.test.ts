import { tickSnapshots } from "@adapters/persistence/schema";
import { startTestPostgres } from "@test-helpers/postgres";
import { makeTicksApi } from "@client/api/ticks";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ticks API", () => {
  test("GET /api/ticks?watchId=X returns ordered ticks", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(tickSnapshots).values([
        {
          watchId: "btc-1h",
          tickAt: new Date(Date.now() - 60_000),
          asset: "BTCUSDT",
          timeframe: "1h",
          ohlcvUri: "file:///x",
          chartUri: "file:///x",
          indicators: {} as never,
          preFilterPass: true,
        },
        {
          watchId: "btc-1h",
          tickAt: new Date(),
          asset: "BTCUSDT",
          timeframe: "1h",
          ohlcvUri: "file:///y",
          chartUri: "file:///y",
          indicators: {} as never,
          preFilterPass: false,
        },
      ]);
      const api = makeTicksApi({ db: tp.db });
      const res = await api.list(new Request("http://x/api/ticks?watchId=btc-1h"));
      const items = (await res.json()) as { preFilterPass: boolean }[];
      expect(items.length).toBe(2);
      expect(items[0]!.preFilterPass).toBe(false); // most recent first
    } finally {
      await tp.cleanup();
    }
  });

  test("GET /api/ticks without watchId returns 400", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeTicksApi({ db: tp.db });
      const res = await api.list(new Request("http://x/api/ticks"));
      expect(res.status).toBe(400);
    } finally {
      await tp.cleanup();
    }
  });

  test("GET /api/ticks/:id/chart.png streams the chart PNG", async () => {
    const tp = await startTestPostgres();
    try {
      const dir = mkdtempSync(join(tmpdir(), "tf-tick-png-"));
      process.env.ARTIFACTS_BASE_DIR = dir;
      const png = join(dir, "chart.png");
      writeFileSync(png, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));

      const [tick] = await tp.db
        .insert(tickSnapshots)
        .values({
          watchId: "btc-1h",
          tickAt: new Date(),
          asset: "BTCUSDT",
          timeframe: "1h",
          ohlcvUri: `file://${png}`,
          chartUri: `file://${png}`,
          indicators: {} as never,
          preFilterPass: true,
        })
        .returning();

      const api = makeTicksApi({ db: tp.db });
      const res = await api.chartPng(new Request("http://x"), { id: tick!.id });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    } finally {
      await tp.cleanup();
    }
  });
});
