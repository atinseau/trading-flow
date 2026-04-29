import { resolve } from "node:path";

const MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  json: "application/json",
  svg: "image/svg+xml",
};

export async function streamArtifact(input: { uri: string; baseDir: string }): Promise<Response> {
  const { uri, baseDir } = input;
  const path = uri.replace(/^file:\/\//, "");
  const resolved = resolve(path);
  const baseResolved = resolve(baseDir);

  if (!resolved.startsWith(baseResolved)) {
    return new Response("forbidden", { status: 403 });
  }

  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }

  const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIMES[ext] ?? "application/octet-stream";

  return new Response(file.stream(), {
    status: 200,
    headers: {
      "content-type": mime,
      "cache-control": "private, max-age=300",
    },
  });
}
