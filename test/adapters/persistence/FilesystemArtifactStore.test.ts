import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { startTestPostgres, type TestPostgres } from "../../helpers/postgres";

let pg: TestPostgres;
let store: FilesystemArtifactStore;
let baseDir: string;

beforeAll(async () => {
  pg = await startTestPostgres();
  baseDir = await mkdtemp(join(tmpdir(), "tf-artifacts-"));
  store = new FilesystemArtifactStore(pg.db, baseDir);
}, 60_000);

afterAll(async () => {
  await pg.cleanup();
  await rm(baseDir, { recursive: true, force: true });
});

describe("FilesystemArtifactStore", () => {
  test("put writes file + DB row, sha256 stable", async () => {
    const content = Buffer.from("hello world");
    const a = await store.put({ kind: "test", content, mimeType: "text/plain" });
    expect(a.bytes).toBe(11);
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);

    const fetched = await store.get(a.uri);
    expect(fetched.toString()).toBe("hello world");
  });

  test("delete removes file + DB row", async () => {
    const content = Buffer.from("delete-me");
    const a = await store.put({ kind: "test", content, mimeType: "text/plain" });
    await store.delete(a.uri);
    await expect(store.get(a.uri)).rejects.toThrow();
  });
});
