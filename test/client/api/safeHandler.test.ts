import {
  ConflictError,
  NotFoundError,
  ValidationError,
  safeHandler,
} from "@client/api/safeHandler";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

describe("safeHandler", () => {
  test("passes through successful responses", async () => {
    const h = safeHandler(async () => Response.json({ ok: true }));
    const res = await h(new Request("http://x/y"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("returns 500 on uncaught exceptions", async () => {
    const h = safeHandler(async () => {
      throw new Error("boom");
    });
    const res = await h(new Request("http://x/y"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("boom");
  });

  test("returns 400 on ZodError", async () => {
    const h = safeHandler(async () => {
      z.object({ a: z.string() }).parse({ a: 123 });
      return Response.json({});
    });
    const res = await h(new Request("http://x/y"));
    expect(res.status).toBe(400);
  });

  test("returns 409 on ConflictError", async () => {
    const h = safeHandler(async () => {
      throw new ConflictError("version mismatch");
    });
    const res = await h(new Request("http://x/y"));
    expect(res.status).toBe(409);
  });

  test("returns 404 on NotFoundError", async () => {
    const h = safeHandler(async () => {
      throw new NotFoundError("missing");
    });
    const res = await h(new Request("http://x/y"));
    expect(res.status).toBe(404);
  });

  test("returns 400 on ValidationError", async () => {
    const h = safeHandler(async () => {
      throw new ValidationError("bad input");
    });
    const res = await h(new Request("http://x/y"));
    expect(res.status).toBe(400);
  });
});
