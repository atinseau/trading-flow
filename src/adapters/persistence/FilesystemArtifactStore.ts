import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactStore, StoredArtifact } from "@domain/ports/ArtifactStore";
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { artifacts } from "./schema";

type DB = ReturnType<typeof drizzle>;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/json": "json",
  "application/gzip": "gz",
  "text/plain": "txt",
};

export class FilesystemArtifactStore implements ArtifactStore {
  constructor(
    private db: DB,
    private baseDir: string,
  ) {}

  async put(args: {
    kind: string;
    content: Buffer;
    mimeType: string;
    eventId?: string;
  }): Promise<StoredArtifact> {
    const sha256 = createHash("sha256").update(args.content).digest("hex");
    const ext = EXT_BY_MIME[args.mimeType] ?? "bin";
    const id = randomUUID();
    const date = new Date();
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const relPath = join(String(yyyy), mm, dd, `${args.kind}_${id}.${ext}`);
    const fullPath = join(this.baseDir, relPath);
    const uri = `file://${fullPath}`;

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, args.content);

    const [row] = await this.db
      .insert(artifacts)
      .values({
        id,
        eventId: args.eventId ?? null,
        kind: args.kind,
        uri,
        mimeType: args.mimeType,
        bytes: args.content.length,
        sha256,
      })
      .returning();

    return { id: row?.id, uri, sha256, bytes: args.content.length, mimeType: args.mimeType };
  }

  async get(uri: string): Promise<Buffer> {
    const path = uri.replace(/^file:\/\//, "");
    return await readFile(path);
  }

  async delete(uri: string): Promise<void> {
    const path = uri.replace(/^file:\/\//, "");
    await unlink(path).catch(() => {});
    await this.db.delete(artifacts).where(eq(artifacts.uri, uri));
  }
}
