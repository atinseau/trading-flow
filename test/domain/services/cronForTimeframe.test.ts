import { expect, test } from "bun:test";
import { cronForTimeframe, isValidFiveFieldCron } from "@domain/services/cronForTimeframe";

test("cronForTimeframe maps each timeframe to expected cron", () => {
  expect(cronForTimeframe("1m")).toBe("* * * * *");
  expect(cronForTimeframe("5m")).toBe("*/5 * * * *");
  expect(cronForTimeframe("15m")).toBe("*/15 * * * *");
  expect(cronForTimeframe("30m")).toBe("*/30 * * * *");
  expect(cronForTimeframe("1h")).toBe("0 * * * *");
  expect(cronForTimeframe("2h")).toBe("0 */2 * * *");
  expect(cronForTimeframe("4h")).toBe("0 */4 * * *");
  expect(cronForTimeframe("1d")).toBe("0 0 * * *");
  expect(cronForTimeframe("1w")).toBe("0 0 * * 0");
});

test("cronForTimeframe throws on unknown timeframe", () => {
  expect(() => cronForTimeframe("3m")).toThrow();
  expect(() => cronForTimeframe("8h")).toThrow();
});

test("isValidFiveFieldCron accepts standard 5-field crons", () => {
  expect(isValidFiveFieldCron("* * * * *")).toBe(true);
  expect(isValidFiveFieldCron("*/5 * * * *")).toBe(true);
  expect(isValidFiveFieldCron("0 0 * * *")).toBe(true);
  expect(isValidFiveFieldCron("0,15,30,45 * * * *")).toBe(true);
  expect(isValidFiveFieldCron("0-30/5 * * * *")).toBe(true);
});

test("isValidFiveFieldCron rejects 6-field (with seconds) cron", () => {
  expect(isValidFiveFieldCron("*/30 * * * * *")).toBe(false);
  expect(isValidFiveFieldCron("0 0 * * * 2026")).toBe(false);
});

test("isValidFiveFieldCron rejects malformed cron", () => {
  expect(isValidFiveFieldCron("not a cron")).toBe(false);
  expect(isValidFiveFieldCron("")).toBe(false);
  expect(isValidFiveFieldCron("* * *")).toBe(false);
});
