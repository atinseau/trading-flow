import { expect, test } from "bun:test";
import { getLogger, rootLogger } from "../../src/observability/logger";

test("getLogger returns a pino child logger with bound context", () => {
  const log = getLogger({ component: "test", watchId: "btc-1h" });
  expect(log).toBeDefined();
  expect(typeof log.info).toBe("function");
  expect(typeof log.error).toBe("function");
});

test("rootLogger exists and respects level", () => {
  expect(rootLogger).toBeDefined();
  expect(typeof rootLogger.level).toBe("string");
});
