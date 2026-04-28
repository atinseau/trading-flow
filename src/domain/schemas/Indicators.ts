import { z } from "zod";

export const IndicatorsSchema = z.object({
  rsi: z.number().min(0).max(100),
  ema20: z.number(),
  ema50: z.number(),
  ema200: z.number(),
  atr: z.number().nonnegative(),
  atrMa20: z.number().nonnegative(),
  volumeMa20: z.number().nonnegative(),
  lastVolume: z.number().nonnegative(),
  recentHigh: z.number(),
  recentLow: z.number(),
});

export type Indicators = z.infer<typeof IndicatorsSchema>;
