import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandEnvVars, loadConfig } from "@config/loadConfig";
import { InvalidConfigError } from "@domain/errors";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tf-cfg-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("expandEnvVars replaces ${VAR}", () => {
  process.env.TF_TEST_VAR = "hello";
  expect(expandEnvVars("greeting: ${TF_TEST_VAR}")).toBe("greeting: hello");
});

test("expandEnvVars throws if VAR missing", () => {
  expect(() => expandEnvVars("x: ${MISSING_VAR_XYZ}")).toThrow(InvalidConfigError);
});

test("loadConfig parses minimal valid file", async () => {
  process.env.TF_TEST_PASS = "secret";
  const path = join(dir, "watches.yaml");
  await writeFile(
    path,
    `
version: 1
market_data:
  binance: { base_url: "https://api.binance.com" }
llm_providers:
  claude_max:
    type: claude-agent-sdk
    workspace_dir: /tmp
    fallback: null
artifacts:
  type: filesystem
  base_dir: /data
notifications:
  telegram: { bot_token: \${TF_TEST_PASS}, default_chat_id: "1" }
database: { url: postgres://x }
temporal: { address: localhost:7233 }
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
    notifications: { telegram_chat_id: "1", notify_on: [confirmed] }
`,
  );
  const cfg = await loadConfig(path);
  expect(cfg.watches[0]?.id).toBe("btc-1h");
  expect(cfg.notifications.telegram.bot_token).toBe("secret");
});

test("loadConfig accepts watch without detector_cron (will be derived)", async () => {
  process.env.TF_TEST_PASS = "secret";
  const path = join(dir, "watches-no-cron.yaml");
  await writeFile(
    path,
    `
version: 1
market_data:
  binance: { base_url: "https://api.binance.com" }
llm_providers:
  claude_max:
    type: claude-agent-sdk
    workspace_dir: /tmp
    fallback: null
artifacts:
  type: filesystem
  base_dir: /data
notifications:
  telegram: { bot_token: \${TF_TEST_PASS}, default_chat_id: "1" }
database: { url: postgres://x }
temporal: { address: localhost:7233 }
watches:
  - id: btc-1h
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [] }
    schedule: { timezone: UTC }
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
    notifications: { telegram_chat_id: "1", notify_on: [confirmed] }
`,
  );
  const cfg = await loadConfig(path);
  expect(cfg.watches[0]?.schedule.detector_cron).toBeUndefined();
});

test("loadConfig rejects 6-field cron (sub-minute)", async () => {
  process.env.TF_TEST_PASS = "secret";
  const path = join(dir, "watches-sub-minute.yaml");
  await writeFile(
    path,
    `
version: 1
market_data:
  binance: { base_url: "https://api.binance.com" }
llm_providers:
  claude_max:
    type: claude-agent-sdk
    workspace_dir: /tmp
    fallback: null
artifacts:
  type: filesystem
  base_dir: /data
notifications:
  telegram: { bot_token: \${TF_TEST_PASS}, default_chat_id: "1" }
database: { url: postgres://x }
temporal: { address: localhost:7233 }
watches:
  - id: btc-1h
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [] }
    schedule: { detector_cron: "*/30 * * * * *" }
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
    notifications: { telegram_chat_id: "1", notify_on: [confirmed] }
`,
  );
  await expect(loadConfig(path)).rejects.toThrow(InvalidConfigError);
});
