import { NotFoundError, safeHandler, ValidationError } from "@client/api/safeHandler";
import { lookupYahooMetadata } from "@client/lib/yahooMetadata";

export const yahooLookup = safeHandler(async (req) => {
  const symbol = new URL(req.url).searchParams.get("symbol");
  if (!symbol) throw new ValidationError("missing query param: symbol");
  const meta = await lookupYahooMetadata(symbol);
  if (!meta) throw new NotFoundError(`yahoo asset not found: ${symbol}`);
  return Response.json(meta);
});
