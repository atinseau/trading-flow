// DEFERRED — needs TRACKING-phase seeding support in both runners.
//
// Concept : seed a setup already in CONFIRMED/TRACKING with entry,
// stop_loss, and take_profit pre-defined. Tick 1's candle hits TP1
// (high=52_600 against TP1=52_500) → emits TPHit (i=0) + TrailingMoved
// (SL → entry). Tick 2's candle hits the trailed SL (low=51_400
// against trailed SL=51_500) → emits SLHit, closes the setup.
//
// Why deferred :
// 1. Both runners currently seed the setup in REVIEWING state. To
//    support TRACKING-phase scenarios, the live runner needs to (a)
//    bypass the reviewer + finalizer path, (b) inject a tracking-state
//    struct (entry/SL/TP) into the workflow. The setupWorkflow has no
//    public API for this — would need a new workflow constructor or
//    a "seed-tracking" signal handler.
// 2. The replay runner needs the AliveSetup.tracking field populated
//    before processTick is called. The shape is non-trivial (see
//    initialTrackingState in src/workflows/replay/trackingState.ts).
// 3. Intra-candle price ordering matters : TP1 must hit BEFORE the
//    candle's low touches the trailed SL, but the simulateCandleTracking
//    (replay) and trackingLoop (live) consume prices in different
//    orders (replay walks high/low based on direction inference; live
//    consumes the trackingPrice signals in arrival order). Aligning
//    these requires designing prices that produce the same chain
//    regardless of order, which is non-trivial for a TP-then-SL flow.
//
// The TRACKING-phase code paths are covered individually by :
//   - test/workflows/replay/processTick.test.ts (replay)
//   - test/workflows/setup/setupWorkflow.test.ts (live)
//
// Parity coverage of TRACKING would be valuable but is a separate
// substantial effort. Keeping this stub so future work has a landing
// point.
export {};
