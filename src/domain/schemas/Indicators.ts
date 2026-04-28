import { z } from "zod";

export const IndicatorsSchema = z.object({
  rsi: z.number().min(0).max(100),
  ema20: z.number().finite(),
  ema50: z.number().finite(),
  ema200: z.number().finite(),
  atr: z.number().finite().nonnegative(),
  atrMa20: z.number().finite().nonnegative(),
  volumeMa20: z.number().finite().nonnegative(),
  lastVolume: z.number().finite().nonnegative(),
  recentHigh: z.number().finite(),
  recentLow: z.number().finite(),
});

export type Indicators = z.infer<typeof IndicatorsSchema>;
