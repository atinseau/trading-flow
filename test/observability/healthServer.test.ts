import { afterEach, expect, test } from "bun:test";
import { HealthServer } from "../../src/observability/healthServer";

let server: HealthServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

test("HealthServer responds 200 with status payload on /health", async () => {
  server = new HealthServer("test-component", 0);
  server.start();
  const port = server.actualPort;
  const res = await fetch(`http://localhost:${port}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    component: string;
    status: string;
    startedAt: string;
    uptimeMs: number;
    lastActivityAt: string | null;
  };
  expect(body.component).toBe("test-component");
  expect(body.status).toBe("ok");
  expect(typeof body.uptimeMs).toBe("number");
  expect(body.startedAt).toBeDefined();
  expect(body.lastActivityAt).toBeNull();
});

test("HealthServer responds 503 when status set to down", async () => {
  server = new HealthServer("test-component", 0);
  server.start();
  server.setStatus("down", { reason: "dependency-unavailable" });
  const res = await fetch(`http://localhost:${server.actualPort}/health`);
  expect(res.status).toBe(503);
  const body = (await res.json()) as {
    status: string;
    metadata?: Record<string, unknown>;
  };
  expect(body.status).toBe("down");
  expect(body.metadata).toEqual({ reason: "dependency-unavailable" });
});

test("HealthServer responds 404 on unknown paths", async () => {
  server = new HealthServer("test-component", 0);
  server.start();
  const res = await fetch(`http://localhost:${server.actualPort}/unknown`);
  expect(res.status).toBe(404);
});

test("setActivity updates lastActivityAt timestamp", async () => {
  server = new HealthServer("test-component", 0);
  server.start();
  const before = (await fetch(`http://localhost:${server.actualPort}/health`).then((r) =>
    r.json(),
  )) as { lastActivityAt: string | null };
  expect(before.lastActivityAt).toBeNull();
  server.setActivity();
  const after = (await fetch(`http://localhost:${server.actualPort}/health`).then((r) =>
    r.json(),
  )) as { lastActivityAt: string | null };
  expect(after.lastActivityAt).not.toBeNull();
});

test("HealthServer responds 200 with standby status and reason", async () => {
  server = new HealthServer("test-component", 0);
  server.start();
  server.setStatus("standby", { reason: "no watches.yaml" });
  const res = await fetch(`http://localhost:${server.actualPort}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; metadata?: Record<string, unknown> };
  expect(body.status).toBe("standby");
  expect(body.metadata).toEqual({ reason: "no watches.yaml" });
});
