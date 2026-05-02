import { describe, expect, test } from "bun:test";
import type { FieldErrors } from "react-hook-form";
import { firstError } from "@client/components/watch-form";

describe("firstError", () => {
  test("returns null on empty errors", () => {
    expect(firstError({})).toBeNull();
  });

  test("flat error", () => {
    expect(firstError({ id: { type: "required", message: "id is required" } })).toEqual({
      path: "id",
      message: "id is required",
    });
  });

  test("nested object error → dot path", () => {
    expect(
      firstError({
        asset: { quoteType: { type: "custom", message: "yahoo asset requires quoteType" } },
      }),
    ).toEqual({ path: "asset.quoteType", message: "yahoo asset requires quoteType" });
  });

  test("array index → bracket notation", () => {
    expect(
      firstError({
        timeframes: { higher: { 0: { type: "invalid_enum", message: "invalid timeframe" } } },
      }),
    ).toEqual({ path: "timeframes.higher[0]", message: "invalid timeframe" });
  });

  test("array-level RHF synthetic 'root' segment is omitted", () => {
    expect(
      firstError({
        notify_on: { root: { type: "too_small", message: "must contain at least 1 element" } },
      }),
    ).toEqual({ path: "notify_on", message: "must contain at least 1 element" });
  });

  test("top-level 'root' (form-level setError) → '(form)' fallback", () => {
    // RHF types `root` as `Record<string, FieldError> & FieldError` — cast to
    // bypass the intersection-with-record requirement in this isolated test.
    const errs = { root: { type: "manual", message: "submission rejected" } } as unknown as FieldErrors;
    expect(firstError(errs)).toEqual({ path: "(form)", message: "submission rejected" });
  });

  test("returns first match in iteration order, not deepest", () => {
    const result = firstError({
      asset: { source: { type: "required", message: "source required" } },
      timeframes: { primary: { type: "required", message: "primary required" } },
    });
    expect(result).toEqual({ path: "asset.source", message: "source required" });
  });

  test("skips entries without a string message and recurses further", () => {
    expect(
      firstError({
        asset: {
          symbol: { type: "required" }, // no message → skip-and-recurse fallback
          quoteType: { type: "custom", message: "missing" },
        },
      }),
    ).toEqual({ path: "asset.quoteType", message: "missing" });
  });
});
