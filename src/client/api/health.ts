import { safeHandler } from "@client/api/safeHandler";

const startedAt = new Date();

export const health = safeHandler(async () =>
  Response.json({
    component: "tf-web",
    status: "ok",
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
  }),
);
