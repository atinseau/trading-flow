import { safeHandler, ValidationError } from "./safeHandler";
import { searchAssets, type AssetType } from "../lib/marketData";

const VALID_TYPES: AssetType[] = ["crypto", "stock", "index", "etf", "currency", "future", "other"];

export const search = safeHandler(async (req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 1) {
    throw new ValidationError("query parameter 'q' is required");
  }
  const types = url.searchParams.get("types");
  const parsedTypes = types
    ? (types.split(",").filter((t): t is AssetType => VALID_TYPES.includes(t as AssetType)))
    : undefined;

  const results = await searchAssets({ query: q, types: parsedTypes });
  return Response.json(results);
});
