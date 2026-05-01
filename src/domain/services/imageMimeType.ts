/**
 * Infer an LLM-image MIME type from an artifact URI.
 *
 * The chart renderer emits WebP since cb59a30; older artifacts may still be
 * PNG. Derive from the URI suffix so consumers (LLM activities, feedback
 * context providers) don't need to know the renderer's current format.
 *
 * Defaults to image/png because that's what historical artifacts use; only
 * `.webp` and `.jpg/.jpeg` extensions override.
 */
export function inferImageMimeType(uri: string): "image/png" | "image/jpeg" | "image/webp" {
  const ext = uri.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "image/png";
}
