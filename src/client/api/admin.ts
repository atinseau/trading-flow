import { requireParam, safeHandler } from "@client/api/safeHandler";

export type AdminOps = {
  forceTick: (input: { watchId: string }) => Promise<void>;
  pauseWatch: (input: { watchId: string }) => Promise<void>;
  resumeWatch: (input: { watchId: string }) => Promise<void>;
  killSetup: (input: { setupId: string; reason: string }) => Promise<void>;
};

export function makeAdminApi(deps: { ops: AdminOps }) {
  return {
    forceTick: safeHandler(async (_req, params) => {
      await deps.ops.forceTick({ watchId: requireParam(params, "id") });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
    pause: safeHandler(async (_req, params) => {
      await deps.ops.pauseWatch({ watchId: requireParam(params, "id") });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
    resume: safeHandler(async (_req, params) => {
      await deps.ops.resumeWatch({ watchId: requireParam(params, "id") });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
    killSetup: safeHandler(async (req, params) => {
      const body = (await req.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason ?? "manual_close";
      await deps.ops.killSetup({ setupId: requireParam(params, "id"), reason });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
  };
}
