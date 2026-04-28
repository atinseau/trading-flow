import { afterAll, beforeAll, expect, test } from "bun:test";
import { rename, stat } from "node:fs/promises";
import { join } from "node:path";

const RUN = process.env.RUN_INTEGRATION_STANDBY === "1";
const repoRoot = new URL("../..", import.meta.url).pathname;
const watchesPath = join(repoRoot, "config", "watches.yaml");
const watchesBackupPath = `${watchesPath}.bak-standby-test`;

beforeAll(async () => {
  if (!RUN) return;
  // Move aside any existing watches.yaml so the stack boots in standby.
  try {
    await stat(watchesPath);
    await rename(watchesPath, watchesBackupPath);
  } catch {
    // file did not exist — nothing to back up
  }
});

afterAll(async () => {
  if (!RUN) return;
  // Restore the backup and tear the stack down.
  try {
    await stat(watchesBackupPath);
    await rename(watchesBackupPath, watchesPath);
  } catch {
    // no backup
  }
  await Bun.$`docker compose -f ${join(repoRoot, "docker-compose.yml")} down`.quiet();
});

test.skipIf(!RUN)(
  "docker compose up boots into standby with no watches.yaml",
  async () => {
    // Bring the stack up detached, waiting for healthchecks.
    const up =
      await Bun.$`docker compose -f ${join(repoRoot, "docker-compose.yml")} up -d --wait --wait-timeout 120`;
    expect(up.exitCode).toBe(0);

    // Each worker exposes /health on its respective port (mapped to localhost via 127.0.0.1).
    const ports = [8081, 8082, 8083]; // scheduler, analysis, notification
    for (const port of ports) {
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("standby");
    }
  },
  150_000,
);
