import { createHash } from "node:crypto";
import type { ArtifactStore, StoredArtifact } from "@domain/ports/ArtifactStore";

export class InMemoryArtifactStore implements ArtifactStore {
  blobs = new Map<string, { content: Buffer; sha256: string; mimeType: string }>();

  async put(args: {
    kind: string;
    content: Buffer;
    mimeType: string;
    eventId?: string;
  }): Promise<StoredArtifact> {
    // Content-addressable: identical bytes produce identical URI. Mirrors
    // the assumption CachedLLMProvider relies on (its cache key includes
    // the image sourceUri, which must be stable across repeats for hits).
    const sha256 = createHash("sha256").update(args.content).digest("hex");
    const uri = `mem://${sha256}`;
    this.blobs.set(uri, { content: args.content, sha256, mimeType: args.mimeType });
    return { id: sha256, uri, sha256, bytes: args.content.length, mimeType: args.mimeType };
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
