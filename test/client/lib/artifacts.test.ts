import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { streamArtifact } from "@client/lib/artifacts";

describe("streamArtifact", () => {
  test("returns 200 with content-type for PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-art-"));
    const path = join(dir, "chart.png");
    writeFileSync(path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await streamArtifact({ uri: `file://${path}`, baseDir: dir });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("returns 404 if file missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-art-"));
    const res = await streamArtifact({ uri: `file://${dir}${sep}missing.png`, baseDir: dir });
    expect(res.status).toBe(404);
  });

  test("rejects path traversal outside baseDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-art-"));
    const res = await streamArtifact({ uri: "file:///etc/passwd", baseDir: dir });
    expect(res.status).toBe(403);
  });
});
