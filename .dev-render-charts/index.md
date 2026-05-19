# Backend chart-render smoke (yahoo / EURUSD=X / 1h, 200 candles)

Rendered 20 combinations via PlaywrightChartRenderer (same code path as production).

## 00_naked
Indicators : _naked_
![00_naked](00_naked.webp)

## 01_ema_stack
Indicators : ema_stack
![01_ema_stack](01_ema_stack.webp)

## 02_rsi
Indicators : rsi
![02_rsi](02_rsi.webp)

## 03_bollinger
Indicators : bollinger
![03_bollinger](03_bollinger.webp)

## 04_macd
Indicators : macd
![04_macd](04_macd.webp)

## 05_atr
Indicators : atr
![05_atr](05_atr.webp)

## 06_vwap
Indicators : vwap
![06_vwap](06_vwap.webp)

## 07_volume
Indicators : volume
![07_volume](07_volume.webp)

## 08_swings_bos
Indicators : swings_bos
![08_swings_bos](08_swings_bos.webp)

## 09_structure_levels
Indicators : structure_levels
![09_structure_levels](09_structure_levels.webp)

## 10_liquidity_pools
Indicators : liquidity_pools
![10_liquidity_pools](10_liquidity_pools.webp)

## 11_fibonacci
Indicators : fibonacci
![11_fibonacci](11_fibonacci.webp)

## 12_ema_rsi
Indicators : ema_stack, rsi
![12_ema_rsi](12_ema_rsi.webp)

## 13_bollinger_macd
Indicators : bollinger, macd
![13_bollinger_macd](13_bollinger_macd.webp)

## 14_swings_structure_fib
Indicators : swings_bos, structure_levels, fibonacci
![14_swings_structure_fib](14_swings_structure_fib.webp)

## 15_trio_classic
Indicators : ema_stack, rsi, volume
![15_trio_classic](15_trio_classic.webp)

## 16_quad_momentum
Indicators : ema_stack, rsi, macd, atr
![16_quad_momentum](16_quad_momentum.webp)

## 17_all_overlays
Indicators : ema_stack, vwap, bollinger, swings_bos, structure_levels, liquidity_pools, fibonacci
![17_all_overlays](17_all_overlays.webp)

## 18_all_secondaries
Indicators : rsi, macd, atr, volume
![18_all_secondaries](18_all_secondaries.webp)

## 19_full_stack
Indicators : ema_stack, vwap, bollinger, rsi, macd, atr, volume, swings_bos, structure_levels, liquidity_pools, fibonacci
![19_full_stack](19_full_stack.webp)
