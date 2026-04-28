import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore, StoredArtifact } from "@domain/ports/ArtifactStore";

export class InMemoryArtifactStore implements ArtifactStore {
  blobs = new Map<string, { content: Buffer; sha256: string; mimeType: string }>();

  async put(args: {
    kind: string;
    content: Buffer;
    mimeType: string;
    eventId?: string;
  }): Promise<StoredArtifact> {
    const id = randomUUID();
    const sha256 = createHash("sha256").update(args.content).digest("hex");
    const uri = `mem://${id}`;
    this.blobs.set(uri, { content: args.content, sha256, mimeType: args.mimeType });
    return { id, uri, sha256, bytes: args.content.length, mimeType: args.mimeType };
  }

  async get(uri: string): Promise<Buffer> {
    const b = this.blobs.get(uri);
    if (!b) throw new Error(`Not found: ${uri}`);
    return b.content;
  }

  async delete(uri: string): Promise<void> {
    this.blobs.delete(uri);
  }

  reset(): void {
    this.blobs.clear();
  }
}
