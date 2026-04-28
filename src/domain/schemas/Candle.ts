import { z } from "zod";

export const CandleSchema = z.object({
  timestamp: z.date(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nonnegative(),
});

export type Candle = z.infer<typeof CandleSchema>;
