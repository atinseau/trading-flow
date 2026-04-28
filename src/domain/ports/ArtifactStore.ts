export type StoredArtifact = {
  id: string;
  uri: string;
  sha256: string;
  bytes: number;
  mimeType: string;
};

export interface ArtifactStore {
  put(args: {
    kind: string;
    content: Buffer;
    mimeType: string;
    eventId?: string;
  }): Promise<StoredArtifact>;
  get(uri: string): Promise<Buffer>;
  delete(uri: string): Promise<void>;
}
