import { z } from "zod";

export const CandleSchema = z.object({
  timestamp: z.date(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
});

export type Candle = z.infer<typeof CandleSchema>;
