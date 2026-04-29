// Registers happy-dom globally for React/DOM-based tests.
//
// Used in two ways:
//   1. As a [test].preload in bunfig.toml — runs once at Bun process startup.
//      We auto-detect frontend test runs via process.argv and the
//      TF_HAPPY_DOM=1 env var so happy-dom doesn't replace native fetch/Headers
//      globals during non-frontend test runs (which would break HTTP-server
//      and fetch-mock based tests).
//   2. Imported directly at the top of frontend test files as a defensive
//      fallback (e.g. when running the whole suite via `bun test` without
//      paths, the preload's argv-detection cannot see which tests will run).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function ensureHappyDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
}

const cliArgs = process.argv.slice(1);
const wantsFrontend =
  process.env.TF_HAPPY_DOM === "1" || cliArgs.some((a) => a.includes("test/client/frontend"));

if (wantsFrontend) {
  ensureHappyDom();
}
