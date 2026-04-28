import { expect, test } from "bun:test";
import { CircularFallbackError } from "@domain/errors";
import { validateProviderGraph } from "@domain/services/validateProviderGraph";

test("linear graph valid", () => {
  expect(() =>
    validateProviderGraph({
      a: { fallback: "b" },
      b: { fallback: "c" },
      c: { fallback: null },
    }),
  ).not.toThrow();
});

test("self-cycle throws", () => {
  expect(() =>
    validateProviderGraph({
      a: { fallback: "a" },
    }),
  ).toThrow(CircularFallbackError);
});

test("longer cycle throws with path", () => {
  expect(() =>
    validateProviderGraph({
      a: { fallback: "b" },
      b: { fallback: "c" },
      c: { fallback: "a" },
    }),
  ).toThrow(/Cycle detected: a → b → c → a/);
});

test("fallback to unknown provider throws", () => {
  expect(() =>
    validateProviderGraph({
      a: { fallback: "ghost" },
    }),
  ).toThrow(/unknown provider/);
});

test("empty graph valid", () => {
  expect(() => validateProviderGraph({})).not.toThrow();
});
