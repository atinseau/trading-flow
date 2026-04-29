import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWatchesConfig, WatchesConfigError } from "@config/loadWatchesConfig";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tf-wc-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const minimal = `
version: 1
market_data: [binance]
llm_providers:
  claude_max: { type: claude-agent-sdk, fallback: null }
artifacts: { type: filesystem }
watches:
  - id: btc-1h
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [] }
    schedule: { detector_cron: "*/15 * * * *" }
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 }
    setup_lifecycle:
      ttl_candles: 50
      score_initial: 25
      score_threshold_finalizer: 80
      score_threshold_dead: 10
      invalidation_policy: strict
    analyzers:
      detector:  { provider: claude_max, model: x }
      reviewer:  { provider: claude_max, model: x }
      finalizer: { provider: claude_max, model: x }
      feedback:  { provider: claude_max, model: x }
    notify_on: [confirmed]
`;

test("returns null when file does not exist", async () => {
  const cfg = await loadWatchesConfig(join(dir, "absent.yaml"));
  expect(cfg).toBeNull();
});

test("returns parsed WatchesConfig when file is valid", async () => {
  const path = join(dir, "ok.yaml");
  await writeFile(path, minimal);
  const cfg = await loadWatchesConfig(path);
  expect(cfg).not.toBeNull();
  expect(cfg?.watches[0]?.id).toBe("btc-1h");
  expect(cfg?.market_data).toEqual(["binance"]);
});

test("throws WatchesConfigError when YAML is malformed", async () => {
  const path = join(dir, "bad-yaml.yaml");
  await writeFile(path, "this: is: not: valid: yaml: [");
  await expect(loadWatchesConfig(path)).rejects.toThrow(WatchesConfigError);
});

test("throws WatchesConfigError when schema fails", async () => {
  const path = join(dir, "bad-schema.yaml");
  await writeFile(path, "version: 1\nmarket_data: [binance]\nwatches: []\n"); // missing llm_providers/artifacts
  await expect(loadWatchesConfig(path)).rejects.toThrow(WatchesConfigError);
});
