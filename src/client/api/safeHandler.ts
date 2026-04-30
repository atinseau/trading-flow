import { childLogger } from "@client/lib/logger";
import { ZodError } from "zod";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export type Handler = (req: Request, params?: Record<string, string>) => Promise<Response>;

export function safeHandler(handler: Handler): Handler {
  return async (req, params) => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const log = childLogger({ requestId, method: req.method, url: req.url });
    try {
      const res = await handler(req, params);
      log.info({ status: res.status }, "request completed");
      return res;
    } catch (err) {
      if (err instanceof ZodError) {
        return Response.json(
          { error: "validation", issues: err.issues },
          { status: 400, headers: { "x-request-id": requestId } },
        );
      }
      if (err instanceof ConflictError) {
        return Response.json(
          { error: err.message },
          { status: 409, headers: { "x-request-id": requestId } },
        );
      }
      if (err instanceof NotFoundError) {
        return Response.json(
          { error: err.message },
          { status: 404, headers: { "x-request-id": requestId } },
        );
      }
      if (err instanceof ValidationError) {
        return Response.json(
          { error: err.message },
          { status: 400, headers: { "x-request-id": requestId } },
        );
      }
      const e = err as Error & { cause?: { message?: string; code?: string }; code?: string };
      log.error(
        {
          err: e.message,
          code: e.code ?? e.cause?.code,
          causeMessage: e.cause?.message,
          stack: e.stack,
        },
        "unhandled error",
      );
      return Response.json(
        {
          error: e.message ?? "internal error",
          ...(e.cause?.message ? { cause: e.cause.message } : {}),
          ...((e.code ?? e.cause?.code) ? { code: e.code ?? e.cause?.code } : {}),
        },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  };
}
