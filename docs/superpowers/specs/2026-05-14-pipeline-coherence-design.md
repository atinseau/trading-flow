# Pipeline Coherence (Live ↔ Replay) — Design Document

**Date** : 2026-05-14
**Status** : Designed — awaiting user review before implementation plan
**Auteur** : brainstorming Arthur + Claude

---

## TL;DR

Six mois après le pivot Strategy 1 → Strategy 3 (duplication contrôlée, voir
`2026-05-08-replay-mode-design.md`), l'audit de cohérence du 2026-05-14 a
révélé **11 dérives** entre la pipeline live (`setupWorkflow.ts` +
`schedulerWorkflow.ts`) et la pipeline replay (`processTick.ts`). Trois
sont critiques :

- **Drift A** — `processTick.ts` ne lit JAMAIS `verdict.corroborations[]`.
  Tout le mécanisme de corroboration détecteur (positive + négative depuis
  le fix de mai) est inerte en replay → trajectoires de score divergentes.
- **Drift C** — invalidation prix : event `PriceInvalidated` en live vs
  `Invalidated` en replay pour la même situation logique.
- **Drift E** — `ttlExpiresAt = ... * 3600_000` hardcodé à 1h en live
  (`schedulerWorkflow.ts:189`), correctement calculé en replay. Bug en
  LIVE pour tout watch non-1h.

Sept autres sont moderate/minor : feedback flag ignoré en replay, REVIEWING
price-breach absent en replay, sequence ordering race en live, `persistEvent`
non-idempotent au niveau DB, etc.

**Décision** : extraire les ~6 décisions métier qui drift en pure functions
sous `src/domain/pipeline/`, et bâtir un harness de tests cross-pipeline
qui rejoue la même séquence de stimuli sur les deux runners (live via
`TestWorkflowEnvironment`, replay via `processTick` direct) et compare les
events filtrés event-à-event. Strategy 3 (duplication contrôlée) reste —
on extrait juste les décisions qui ont prouvé qu'elles ont besoin d'être
partagées.

---

## Contexte

### Historique

Le 2026-05-09, Arthur a acté le pivot Strategy 1 → 3 (voir préambule de
`2026-05-08-replay-mode-design.md`). Strategy 1 injectait `replayContext`
dans toutes les activités live ; Strategy 3 duplique les activités sous
`src/workflows/replay/` et accepte le risque de drift comme tradeoff pour
éviter `if (args.replayContext) ...` partout.

Six mois plus tard, **le risque s'est matérialisé**. Le fix de
bidirectional corroboration shipped le 2026-05-14 (`b9615b4`) a été
appliqué dans le handler `corroborateSignal` du `setupWorkflow.ts`, mais
`processTick.ts` continue à ignorer entièrement `verdict.corroborations[]`
— la pipeline replay n'a jamais été instrumentée pour réagir aux
corroborations détecteur.

### Pourquoi maintenant

Le replay est utilisé par Arthur comme oracle pour itérer sur les prompts
sans payer N fois la même analyse. Si replay diverge silencieusement de
live, l'oracle est faussé → les itérations sur prompts produisent des
conclusions invalides. Cela compromet la valeur du replay subsystem
lui-même.

L'audit du 2026-05-14 a aussi révélé un bug réel en **live** : le TTL est
hardcodé à 1h (`schedulerWorkflow.ts:189`) au lieu d'utiliser le timeframe
primaire de la watch. Toute watch non-1h en prod a un TTL incorrect.

---

## Problem statement

Les deux pipelines partagent quelques helpers (`applyVerdict`,
`verdictToEvent`, `formatTelegramText`) mais ont des implémentations
parallèles de :

- Corroboration scoring (corroborateSignal handler vs processTick phase 2)
- Price-breach detection (priceCheckSignal handler vs absent en replay)
- TTL computation (hardcoded 1h en live vs correct en replay)
- Event type naming (PriceInvalidated vs Invalidated pour le tracker)
- Feedback gating (live combine watch + child workflow vs replay seulement
  session mode)
- Reviewer skipping (live utilise `shouldSendReviewSignal`, replay run
  inconditionnellement)
- Same-tick fast-path (live respecte flag, replay implicite-on)

Sans intervention, chaque nouveau feature ré-introduit le risque de drift
sur la nouvelle décision. Discipline-only ne suffit plus.

---

## Goals

1. **Restaurer la cohérence logique** entre live et replay sur les
   décisions métier identifiées par l'audit (drifts A, C, D, E, G, K).
2. **Réduire la surface de drift futur** en extrayant les décisions
   partagées en pure functions consommées par les deux pipelines.
3. **Détecter automatiquement la régression de cohérence** via un harness
   de tests cross-pipeline qui rejoue les mêmes scénarios sur les deux.
4. **Fixer le bug TTL hardcodé en live** comme effet de bord de
   l'extraction de `computeTtlExpiresAt`.

## Non-goals

- **Ne pas revisiter Strategy 1 vs 3.** Le pivot de mai est acquis ;
  l'extraction se fait dans le cadre de Strategy 3.
- **Ne pas refactor les zones qui n'ont pas drifté.** Finalizer, kill flow,
  TTL timer Temporal, notification activities, le `applyVerdict` reviewer
  partagé existant — tout cela reste tel quel.
- **Ne pas adresser les drifts non-cohérence-pipeline** : 3.1
  (persistEvent idempotency au niveau DB), 3.2 (sequence ordering race en
  live), 3.3 (reviewer INVALIDATE silent notification), 3.4 (kill button
  pendant TRACKING), drift Replay-Inv1 (artifacts table). Ces sujets
  méritent leurs propres specs.
- **Ne pas viser parity byte-pour-byte sur tous les events.** Les events
  replay-only (`DetectorTickProcessed`, `ReplayMeta`, `FeedbackLessonProposed`)
  et live-only (`Killed`) sont filtrés du comparateur. La parity vise les
  events business (Strengthened, Weakened, Confirmed, Rejected, …) avec
  même type + même chaîne statusBefore/statusAfter + même signe de
  scoreDelta. Les magnitudes exactes peuvent varier (LLM non-déterministe
  même avec cache, certains payloads contiennent du jitter).

---

## Architecture overview

### Module organization

Nouveau dossier `src/domain/pipeline/` :

```
src/domain/pipeline/
├── applyCorroboration.ts       # Drift A
├── applyPriceCheck.ts          # Drift D
├── computeTtlExpiresAt.ts      # Drift E (+ bug live)
├── priceInvalidationEvent.ts   # Drift C (canonical event builder)
├── shouldRunFeedback.ts        # Drift G
├── timeframeToMs.ts            # utilité partagée si pas déjà existante
└── index.ts                    # barrel
```

Helpers existants gardés en place :
- `src/domain/scoring/applyVerdict.ts` — utilisé par live reviewer +
  replay reviewer. Pas de changement.
- `src/domain/scoring/verdictToEvent.ts` — partagé. Pas de changement.
- `src/workflows/scheduler/reviewerGating.ts` — `shouldSendReviewSignal`
  existe. Le travail est de le **wirer côté replay** (voir Phase 1.6).

### Pattern de consommation

Chaque pure function retourne un résultat discriminé :

```ts
type PureResult =
  | { kind: "noop" | "ignored" | "not_breached" | ... }
  | { kind: "applied"; next: SetupRuntimeState; event: NewEvent };
```

Les callers (live ou replay) :

```ts
const result = applyCorroboration({ state, delta, scoring, ... });
if (result.kind !== "applied") return;
state.score = result.next.score;
state.status = result.next.status;  // MUTATE BEFORE AWAIT
await persistEvent({ event: { ...result.event, ...callerMeta }, setupUpdate: result.next });
```

Les pure functions ne touchent NI à Temporal, NI à la DB, NI au Notifier.
Elles prennent du state, retournent du state + event. Toute la logique
"mutate before await" + persist + retry policy reste dans les workflows.

---

## Pure function specifications

### 1. `applyCorroboration` (fixes Drift A)

```ts
// src/domain/pipeline/applyCorroboration.ts

type CorroborationInput = {
  state: SetupRuntimeState;          // {status, score, invalidationLevel, direction}
  delta: number;                      // signed [-20, 20] per DetectorOutput schema
  scoring: ScoringConfig;             // {scoreMax, scoreThresholdFinalizer, scoreThresholdDead}
  detectorPromptVersion: string;      // actor on the resulting event
};

type CorroborationResult =
  | { kind: "noop" }                  // delta === 0 → skip
  | { kind: "ignored" }               // state.status !== "REVIEWING"
  | {
      kind: "applied";
      next: SetupRuntimeState;
      event: {
        stage: "detector";
        actor: string;                // detectorPromptVersion
        type: "Strengthened" | "Weakened";
        scoreDelta: number;
        scoreAfter: number;
        statusBefore: SetupStatus;
        statusAfter: SetupStatus;
        payload: StrengthenedPayload | WeakenedPayload;
      };
    };

export function applyCorroboration(input: CorroborationInput): CorroborationResult;
```

**Sémantique** :
- Si `delta === 0` → `kind: "noop"` (caller ignore, ne persiste rien).
- Si `state.status !== "REVIEWING"` → `kind: "ignored"`.
- `newScore = Math.max(0, Math.min(scoring.scoreMax, state.score + delta))`.
- `statusAfter` : `FINALIZING` si `newScore >= scoring.scoreThresholdFinalizer`,
  sinon `EXPIRED` si `newScore <= scoring.scoreThresholdDead`, sinon
  `REVIEWING`.
- Si `delta > 0` → event `Strengthened` avec
  `payload.data.source = "detector_corroboration"`,
  `payload.data.reasoning = "Corroborating evidence from detector"`,
  `payload.data.observations = []`.
- Si `delta < 0` → event `Weakened` avec
  `payload.data.source = "detector_decorroboration"`,
  `payload.data.reasoning = "Detector observes pattern weakening or no longer visible on chart"`,
  `payload.data.observations = []`.

**Tests** (truth-table) — fichier `test/domain/pipeline/applyCorroboration.test.ts` :

1. `delta=0, REVIEWING, score=33` → `noop`
2. `delta=+5, REVIEWING, score=33` → `applied`, Strengthened, score=38, status=REVIEWING
3. `delta=+50, REVIEWING, score=33, scoreMax=80` → `applied`, score=80 (clamp)
4. `delta=+50, REVIEWING, score=33, threshold=80` → `applied`, score=83 clamped to 80, statusAfter=FINALIZING
5. `delta=+10, REVIEWING, score=75, threshold=80` → `applied`, score=85, statusAfter=FINALIZING
6. `delta=-5, REVIEWING, score=33` → `applied`, Weakened, score=28, statusAfter=REVIEWING
7. `delta=-50, REVIEWING, score=33` → `applied`, score=0 (floor), statusAfter=EXPIRED (assuming threshold_dead=10)
8. `delta=-5, REVIEWING, score=15, threshold_dead=10` → `applied`, score=10, statusAfter=EXPIRED (boundary inclusive)
9. `delta=+5, FINALIZING, score=85` → `ignored`
10. `delta=-5, TRACKING, score=85` → `ignored`
11. `delta=+5, REJECTED, score=85` → `ignored`
12. `state.invalidationLevel + direction` correctement préservés dans `next`

### 2. `applyPriceCheck` (fixes Drift D — REVIEWING price breach)

```ts
// src/domain/pipeline/applyPriceCheck.ts

type PriceCheckInput = {
  state: SetupRuntimeState;
  currentPrice: number;
  observedAt: string;                 // ISO
};

type PriceCheckResult =
  | { kind: "not_breached" }
  | { kind: "not_active" }            // status not in REVIEWING|FINALIZING (TRACKING handled by trackingLoop)
  | {
      kind: "applied";
      next: SetupRuntimeState;        // status=INVALIDATED
      event: {
        stage: "system";
        actor: "price_monitor";
        type: "PriceInvalidated";
        scoreDelta: 0;
        scoreAfter: number;
        statusBefore: SetupStatus;
        statusAfter: "INVALIDATED";
        payload: PriceInvalidatedPayload;
      };
    };

export function applyPriceCheck(input: PriceCheckInput): PriceCheckResult;
```

**Sémantique** :
- Si `state.status === "TRACKING"` → `not_active` (le trackingLoop gère).
- Si `!isActive(state.status)` (terminal) → `not_active`.
- Breach :
  - LONG : `currentPrice < state.invalidationLevel`
  - SHORT : `currentPrice > state.invalidationLevel`
- Si pas breach → `not_breached`.
- Sinon → `applied` avec `next.status = "INVALIDATED"`, payload
  `{ currentPrice, invalidationLevel, observedAt }`.

**Tests** — `test/domain/pipeline/applyPriceCheck.test.ts` :
- LONG breach, REVIEWING
- LONG breach, FINALIZING
- LONG no breach (price > invalidation)
- SHORT breach
- SHORT no breach
- TRACKING → not_active
- INVALIDATED → not_active
- Equality at invalidationLevel : `not_breached` (strict less/greater than)

### 3. `computeTtlExpiresAt` (fixes Drift E + bug live)

```ts
// src/domain/pipeline/computeTtlExpiresAt.ts

import { type Timeframe, timeframeToMs } from "./timeframeToMs";

type TtlInput = {
  fromTickAt: Date | string;          // base time
  ttlCandles: number;
  primaryTimeframe: Timeframe;
};

export function computeTtlExpiresAt(input: TtlInput): Date;
```

**Sémantique** : `new Date(fromTickAt.getTime() + ttlCandles * timeframeToMs(primaryTimeframe))`.

**Note** : `timeframeToMs` peut déjà exister sous une autre forme
(`timeframeToMinutes` dans `src/client/lib/timeframe.ts` ou
`parseTimeframeToMs` dans `src/domain/ports/Clock.ts`). Phase 1.1 doit
auditer et consolider.

**Tests** — `test/domain/pipeline/computeTtlExpiresAt.test.ts` :
- 1m × 50 candles = 50 min
- 15m × 50 = 12h30
- 1h × 50 = 50h
- 1d × 5 = 5j
- string ISO en input accepté
- Date en input accepté

### 4. `buildPriceInvalidationEvent` (fixes Drift C — canonical type)

```ts
// src/domain/pipeline/priceInvalidationEvent.ts

type PriceInvalidationEventInput = {
  state: SetupRuntimeState;
  currentPrice: number;
  observedAt: string;
  trigger: "price_monitor" | "tracker";  // "price_monitor" pour live REVIEWING, "tracker" pour TRACKING
};

export function buildPriceInvalidationEvent(input: PriceInvalidationEventInput): {
  stage: "system";
  actor: "price_monitor" | "tracker";
  type: "PriceInvalidated";
  scoreDelta: 0;
  scoreAfter: number;
  statusBefore: SetupStatus;
  statusAfter: "INVALIDATED";
  payload: PriceInvalidatedPayload;
};
```

**Décision canonique** : type = `"PriceInvalidated"` (live's name).
Replay's `processTick.ts:610-625` change pour utiliser `buildPriceInvalidationEvent`.

**Note** : `applyPriceCheck` (helper 2) utilise `buildPriceInvalidationEvent`
en interne. Pas de duplication.

**Tests** — `test/domain/pipeline/priceInvalidationEvent.test.ts` :
- `trigger: "price_monitor"` → actor=price_monitor
- `trigger: "tracker"` → actor=tracker
- payload contient currentPrice, invalidationLevel, observedAt
- statusBefore reflète le state au moment du build

### 5. `shouldRunFeedback` (fixes Drift G)

```ts
// src/domain/pipeline/shouldRunFeedback.ts

import { type CloseOutcome, shouldTriggerFeedback } from "@domain/feedback/closeOutcome";

type FeedbackInput = {
  closeOutcome: CloseOutcome;
  watchFeedbackEnabled: boolean;       // watch.feedback.enabled snapshotted in InitialEvidence
  sessionFeedbackMode?: "run" | "skip"; // undefined in live, set in replay
};

export function shouldRunFeedback(input: FeedbackInput): boolean;
```

**Sémantique** :
```ts
return shouldTriggerFeedback(input.closeOutcome)
  && input.watchFeedbackEnabled
  && (input.sessionFeedbackMode ?? "run") !== "skip";
```

**Tests** — `test/domain/pipeline/shouldRunFeedback.test.ts` :
- SL hit, enabled, no session mode → true
- TPs hit (winner), enabled → false (shouldTriggerFeedback false)
- SL hit, disabled → false (watch flag)
- SL hit, enabled, session mode=skip → false
- SL hit, enabled, session mode=run → true

### 6. Reviewer gating en replay (Drift I)

Pas un nouveau helper — `shouldSendReviewSignal` existe déjà.

**Travail** : modifier `processTick.ts` phase 3 (reviewer) pour :
1. Calculer `corroboratedIds` à partir des corroborations appliquées en
   phase 2 (helper 1).
2. Filtrer les setups REVIEWING via `shouldSendReviewSignal` avant chaque
   appel `runReviewerReplay`.

Cela ne change pas le helper — juste son point d'usage.

---

## Test harness cross-pipeline

### Format de scénario

```ts
// test/parity/types.ts

import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { DetectorOutput } from "@domain/schemas/DetectorOutput";
import type { Verdict } from "@domain/schemas/Verdict";
import type { EventTypeName } from "@domain/events/types";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type FinalizerDecision = {
  go: boolean;
  reasoning: string;
  entry?: number;
  stop_loss?: number;
  take_profit?: number[];
};

export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: string;          // ISO, candle close
};

export type PriceTick = {
  price: number;
  observedAt: string;         // ISO, intra-candle
};

export type PipelineScenario = {
  name: string;
  description: string;
  watch: WatchConfig;
  setup: {
    setupId: string;
    direction: "LONG" | "SHORT";
    initialScore: number;
    invalidationLevel: number;
    patternHint: string;
    patternCategory: "event" | "accumulation";
    expectedMaturationTicks: number;
  };
  ticks: Array<{
    tickAt: string;
    detectorVerdict: DetectorOutput;
    reviewerVerdict?: Verdict;          // if reviewer fires this tick
    finalizerDecision?: FinalizerDecision;
    candle: Candle;
    intraCandlePrices?: PriceTick[];    // for TRACKING phase
  }>;
  expectedEventChain: Array<{
    type: EventTypeName;
    statusBefore?: SetupStatus;
    statusAfter?: SetupStatus;
    scoreDeltaSign?: -1 | 0 | 1;
    source?: "reviewer_full" | "detector_corroboration" | "detector_decorroboration";
  }>;
};
```

### Runners

```ts
// test/parity/runners/runLive.ts

export async function runLive(scenario: PipelineScenario): Promise<NewEvent[]>;
// Set up TestWorkflowEnvironment, fake activities (runDetector returns
// scenario.ticks[i].detectorVerdict, runReviewer returns reviewerVerdict,
// runFinalizer returns finalizerDecision). Start setupWorkflow. Signal
// corroborate/review/priceCheck per tick per scenario. Drain. Collect
// events via fake persistEvent that captures the NewEvent objects.

// test/parity/runners/runReplay.ts

export async function runReplay(scenario: PipelineScenario): Promise<NewEvent[]>;
// No TestWorkflowEnvironment. Build replay deps with in-memory stores and
// stub activities (runDetectorReplay etc.). Call processTick() directly N
// times. Collect events via InMemoryReplayEventStore.
```

### Comparateur

```ts
// test/parity/compareEvents.ts

const REPLAY_ONLY_TYPES: ReadonlySet<EventTypeName> = new Set([
  "DetectorTickProcessed",
  "ReplayMeta",
  "FeedbackLessonProposed",
]);
const LIVE_ONLY_TYPES: ReadonlySet<EventTypeName> = new Set([
  "Killed",
]);

export type Drift = {
  index: number;
  field: "type" | "statusBefore" | "statusAfter" | "scoreDeltaSign" | "source" | "length";
  live: unknown;
  replay: unknown;
  message: string;
};

export function compareCanonical(live: NewEvent[], replay: NewEvent[]): Drift[];
```

Compare :
1. Longueur du sequence filtré (live filtré − LIVE_ONLY = replay filtré − REPLAY_ONLY).
2. Pour chaque index, type identique.
3. Chaîne statusBefore[i] === statusAfter[i-1] dans chacun (séparément).
4. statusBefore[i] / statusAfter[i] identiques entre live et replay.
5. Signe de scoreDelta identique (pas la magnitude — les LLM peuvent jitter).
6. `payload.data.source` identique pour Strengthened/Weakened.

### Scénarios canoniques initiaux

`test/parity/scenarios/` :

1. **`corroboration-positive.ts`** — détecteur strengthen ×4 (+8 chacun)
   → score crosses 80 → finalizer GO → tracking → TPs hit. Couvre :
   Drift A positive branch, Drift K (fast-path).
2. **`corroboration-negative.ts`** — corroborate négatif ×3 (-8 chacun)
   → score chute à 1 → EXPIRED. Couvre : Drift A negative branch.
3. **`mixed-corroborate-and-review.ts`** — pour chaque tick, alterner
   un setup corroboré (skip reviewer) et un setup non-corroboré (review
   appelé). Couvre : Drift A + reviewer gating en replay.
4. **`reviewer-invalidate.ts`** — reviewer émet INVALIDATE → INVALIDATED.
5. **`price-breach-during-reviewing.ts`** — au tick T, prix de la candle
   touche `state.invalidationLevel` (low < invalidation pour LONG)
   pendant que le setup est REVIEWING. Couvre : Drift D.
6. **`sl-hit-after-tp1.ts`** — tracking : TP1 hit → SL trail à breakeven
   → candle suivante touche breakeven → SLHit. Couvre : trackingLoop ↔
   simulateCandleTracking parity.
7. **`ttl-expired-15m.ts`** — watch timeframe=15m, ttl_candles=10. Tick
   advance virtuel de 11 candles sans ré-éval. Live + replay calculent
   `ttlExpiresAt` à partir du même `fromTickAt` ; comparer la valeur. (Ce
   scenario teste `computeTtlExpiresAt`, pas une exécution complète.)
8. **`feedback-disabled.ts`** — watch.feedback.enabled=false, SL hit
   classique. Ni live ni replay ne fire feedback. Couvre : Drift G.

### Test format

```ts
// test/parity/scenarios/corroboration-positive.test.ts

import { test, expect } from "bun:test";
import { runLive, runReplay } from "../runners";
import { compareCanonical } from "../compareEvents";
import { scenario } from "./corroboration-positive.scenario";
import { expectEventChain } from "../expectEventChain";

test("parity: corroboration positive drives FINALIZING then TRACKING", async () => {
  const liveEvents = await runLive(scenario);
  const replayEvents = await runReplay(scenario);
  const drifts = compareCanonical(liveEvents, replayEvents);
  expect(drifts).toEqual([]);
  expectEventChain(liveEvents, scenario.expectedEventChain);
  expectEventChain(replayEvents, scenario.expectedEventChain);
});
```

### Script package.json

```json
"test:parity": "bun test test/parity"
```

---

## Migration phases

### Phase 1 — Extraction des pure functions (incrémentale)

Ordre du plus simple au plus invasif :

1. **`computeTtlExpiresAt`** (1.1)
   - Créer `src/domain/pipeline/timeframeToMs.ts` si pas existant (audit `src/client/lib/timeframe.ts` + `src/domain/ports/Clock.ts`).
   - Créer `src/domain/pipeline/computeTtlExpiresAt.ts` + tests.
   - Remplacer `schedulerWorkflow.ts:189-192` (fix bug live).
   - Remplacer `processTick.ts:253-256` (alignement).
   - Commit.

2. **`buildPriceInvalidationEvent`** (1.2)
   - Créer le helper + tests.
   - Remplacer en live `trackingLoop.ts:108-122` (utilise le builder à la place de l'inline).
   - Remplacer en live `setupWorkflow.priceCheckSignal:297-321`.
   - Remplacer en replay `processTick.ts:610-625` (change le type Invalidated → PriceInvalidated, casse intentionnellement les exports/dashboards qui filtraient sur Invalidated tracker).
   - Commit.

3. **`shouldRunFeedback`** (1.3)
   - Helper + tests.
   - Remplacer `setupWorkflow.ts:693-714` (déjà gating sur `feedbackEnabled` + `shouldTriggerFeedback`, juste extraire).
   - Remplacer `processTick.ts:480-491` + `activities.ts:839-851` (ajouter le check `watch.feedback.enabled`).
   - Commit.

4. **`applyCorroboration`** (1.4 — LA grosse)
   - Helper + tests (12 cas).
   - Remplacer `setupWorkflow.corroborateSignal:244-324` par appel au helper + persist.
   - Modifier `processTick.ts:181-330` pour :
     - Phase 2 : destructurer `corroborations` du verdict.
     - Pour chaque corroboration, trouver l'alive setup, appeler
       `applyCorroboration`, persister via `appendReplayEvent`.
     - Mettre à jour `setup.runtime` dans `alive: Map`.
   - Tests existants `setupWorkflow.test.ts` corroborate doivent
     toujours passer (refactor sans changement de comportement).
   - Commit.

5. **`applyPriceCheck`** (1.5)
   - Helper + tests.
   - Remplacer `setupWorkflow.priceCheckSignal:283-391` par appel helper.
   - Ajouter à `processTick.ts` une **phase 0.5** (avant détecteur) qui :
     - Pour chaque alive setup, fetch la candle courante via
       `fetchRangeCandles`.
     - Si LONG : `currentPrice = candle.low` ; SHORT : `currentPrice = candle.high`.
     - Appeler `applyPriceCheck` ; si applied → persister + retirer du
       `alive` Map.
   - Commit.

6. **Wirer `shouldSendReviewSignal` en replay** (1.6)
   - Phase 3 (reviewer) de `processTick.ts`.
   - Calculer `corroboratedIds` à partir de la phase 2 (depuis les events
     `Strengthened`/`Weakened` `source: detector_*`).
   - Appliquer `shouldSendReviewSignal` avant chaque `runReviewerReplay`.
   - Commit.

### Phase 2 — Test harness

1. Créer `test/parity/types.ts`, `test/parity/runners/{runLive,runReplay}.ts`,
   `test/parity/compareEvents.ts`, `test/parity/expectEventChain.ts`.
2. Écrire les 4 premiers scénarios (corroboration positive/negative, mixed,
   reviewer invalidate). Vérifier qu'ils passent.
3. Ajouter `bun run test:parity` dans `package.json`.
4. Écrire les 4 scénarios restants (price-breach, sl-hit-after-tp1,
   ttl-expired-15m, feedback-disabled).
5. Commit après chaque scénario en ligne avec ses fixes Phase 1.

### Phase 3 — Documentation

1. Ajouter à `CLAUDE.md` une section "Pipeline coherence" :
   - Pointer vers `src/domain/pipeline/`
   - Expliquer le pattern "extract pour live ↔ replay parity"
   - Pointer vers `test:parity` et les scénarios
2. Ajouter à `README.md` :
   - Une ligne dans le tableau des tests pour `test:parity`
   - Dans Replay Mode section, ajouter une mention "harnessé pour
     parity event-à-event vs live"
3. Le présent design devient `2026-05-14-pipeline-coherence-design.md`
   committé et epoch-frozen.

---

## Risks + mitigations

| Risque | Mitigation |
|---|---|
| Refactor de `processTick.ts` (Phase 1.4) introduit une régression dans le replay subsystem | Tests existants `processTick.test.ts` garantissent pas de régression. Ne pas modifier le contrat externe — juste internaliser l'appel au helper |
| `applyCorroboration` extrait casse les tests setupWorkflow existants | Helper conçu pour être 1-pour-1 équivalent au code inline. Tests inchangés doivent passer |
| Drift entre `applyPriceCheck` et `trackingLoop`'s logic intra-candle | `applyPriceCheck` couvre uniquement REVIEWING/FINALIZING. `trackingLoop` reste la source pour TRACKING (sortie de scope) |
| `shouldSendReviewSignal` en replay nécessite tracking de `corroboratedIds` qui n'existait pas | Phase 1.6 doit construire ce set à partir des events appliqués phase 1.4 |
| Test harness `runLive` lent (TestWorkflowEnvironment download) | Pas un nouveau souci, suit le pattern existant. Marquer ces tests comme `test:parity` séparé de `test:domain` (qui reste rapide) |
| `Invalidated` (replay) → `PriceInvalidated` change la sémantique des consommateurs | Les exports / UI / dashboards qui filtraient sur `type === "Invalidated"` pour les tracker-time invalidations vont voir un changement. Audit phase 1.2 avant le commit |
| Les 8 scénarios initiaux ne couvrent pas tous les chemins | C'est un filet, pas une preuve formelle. Ajouts au fil des dérives suspectées. La couverture grandit naturellement |

---

## Out of scope (à traiter dans d'autres specs)

Les drifts suivants identifiés à l'audit du 2026-05-14 ne sont **pas**
adressés ici :

- **3.1 — `persistEvent` non-idempotent au niveau DB**. Nécessite ajouter
  une key idempotente à chaque event persisté + dédup `inputHash` dans
  `PostgresEventStore.append`. Spec séparée.
- **3.2 — Event sequence ordering race en live** (corroborate flip à
  FINALIZING qui race avec le finalizer persist). Nécessite un mutex
  workflow-side. Spec séparée.
- **3.3 — Reviewer INVALIDATE silent (pas de Telegram)**. Décision UX —
  ajouter un notify_on event ? Spec UX séparée.
- **3.4 — Kill button pendant TRACKING ne fait rien**. Soit cacher le
  bouton post-Confirmed, soit propager `killRequested` dans trackingLoop.
  Spec UX séparée.
- **Drift F — `EntryFilled` event en replay mais pas en live**. Décision
  archi : live devrait-il émettre ? Spec séparée.
- **Drift Replay-Inv1 — replay écrit dans la table `artifacts` live**.
  Nécessite un `ReplayArtifactStore` séparé. Spec séparée.

---

## Success criteria

1. Les 6 helpers existent dans `src/domain/pipeline/` avec leurs tests
   unitaires passants.
2. Live et replay consomment les mêmes helpers — pas de logique de
   décision dupliquée pour les 6 cas adressés.
3. Le harness `test:parity` existe avec au moins 8 scénarios canoniques
   tous verts.
4. Le bug TTL live est fixé (test : créer un setup sur watch 15m, vérifier
   `ttlExpiresAt - createdAt = 50 × 15min = 12h30`, pas 50h).
5. Le replay produit le même type d'event `PriceInvalidated` que live pour
   les tracker-time invalidations.
6. Drift A est résolu : un détecteur retournant
   `corroborations: [{setup_id, confidence_delta_suggested: +X}]` produit
   le même `Strengthened` event en live et en replay.
7. `docs/superpowers/specs/2026-05-14-pipeline-coherence-design.md` existe,
   committé, epoch-frozen.

## Open questions

- Le helper `timeframeToMs` doit-il être unifié avec
  `parseTimeframeToMs` existant dans `src/domain/ports/Clock.ts` ? À auditer
  en phase 1.1.
- Le harness doit-il aussi vérifier que les events sont
  **séquentiellement valides** (ex : chaque `statusAfter[i]` matche
  `statusBefore[i+1]`) ? Probable yes — bug catcher gratuit.
- Faut-il un script CI qui run `test:parity` à chaque PR ? Probable yes
  mais pas dans le scope de cette spec.
