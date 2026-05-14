// DEFERRED — needs `PipelineScenario.setups[]` extension to support
// multi-setup scenarios.
//
// Concept : two alive setups at score=50 share one detector tick.
//   - setup-a : corroborated this tick (+5) → Strengthened (detector_corroboration)
//   - setup-b : NOT corroborated → reviewer fires STRENGTHEN +10
//     (Strengthened, reviewer_full)
//
// The mixed corroborate-vs-review path is exercised at the unit level by
// `test/workflows/scheduler/reviewerGating.test.ts` (the truth-table for
// `shouldSendReviewSignal`) and by `applyCorroboration` unit tests. A
// parity-level scenario requires :
//   1. PipelineScenario.setups[] (array) — runners loop over and seed
//      each into the live workflow + replay alive map.
//   2. Per-tick verdict declarations keyed by setup id.
//   3. runLive that starts N concurrent setupWorkflows on a shared
//      taskQueue and fans signals to the correct handle.
//
// That's a substantial runner-level refactor out of scope for T11.
// Keeping this file as a stub so future work has a landing point.
export {};
