/**
 * Side-effect import. Re-exports the whole `lightweight-charts` module
 * onto `globalThis.LightweightCharts` so the unified `chartBootstrap` and
 * `contributionRenderer` adapters can resolve constants (`LineSeries`,
 * `HistogramSeries`, `CandlestickSeries`, `createSeriesMarkers`) without
 * a compile-time `import` of `lightweight-charts` — which is what allows
 * the same TS source to also run inside the Playwright headless page,
 * where lightweight-charts is loaded as a `<script>` standalone bundle.
 *
 * Import this module ONCE at frontend boot (already done from
 * `src/client/frontend.tsx`). The module has no exports.
 */
import * as LC from "lightweight-charts";

(globalThis as { LightweightCharts?: typeof LC }).LightweightCharts = LC;
