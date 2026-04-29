# Feedback Loop — Design Document

**Date** : 2026-04-29
**Status** : Draft (en attente de validation utilisateur)
**Auteur** : brainstorming Arthur + Claude

---

## Table des matières

1. [Vision & contexte](#1-vision--contexte)
2. [Décisions structurantes](#2-décisions-structurantes)
3. [Architecture haut-niveau](#3-architecture-haut-niveau)
4. [Schéma de données](#4-schéma-de-données)
5. [Workflow & activities Temporal](#5-workflow--activities-temporal)
6. [Plugin de contexte (`FeedbackContextProvider`)](#6-plugin-de-contexte-feedbackcontextprovider)
7. [Prompt feedback + schéma de sortie LLM](#7-prompt-feedback--schéma-de-sortie-llm)
8. [Injection des guidelines dans les prompts existants](#8-injection-des-guidelines-dans-les-prompts-existants)
9. [Notification Telegram & callback handling](#9-notification-telegram--callback-handling)
10. [CLI](#10-cli)
11. [Configuration](#11-configuration)
12. [Stratégie de tests](#12-stratégie-de-tests)
13. [Plan de déploiement & migration](#13-plan-de-déploiement--migration)
14. [Extensibilité](#14-extensibilité)
15. [Décisions consciemment écartées (out-of-scope v1)](#15-décisions-consciemment-écartées-out-of-scope-v1)
16. [Glossaire](#16-glossaire)

---

## 1. Vision & contexte

### Problème

La pipeline existante de Trading Flow s'arrête à la fermeture d'un setup en `CLOSED` (TP final atteint), `INVALIDATED` (prix casse l'invalidation level pendant tracking), `EXPIRED` (TTL atteint), ou `REJECTED` (NO_GO du Finalizer). Quand un trade confirmé échoue, l'information de l'échec est persistée comme event mais **n'a aucun effet rétroactif** sur le système : les prochains setups bénéficient de zéro apprentissage tiré de ce qui s'est passé.

### Vision de la feedback loop

Ajouter une **étape rétroactive** déclenchée à la fermeture défavorable d'un setup confirmé. Cette étape :

- Analyse en profondeur le trade : décisions, raisonnements, indicateurs au moment des décisions, trajectoire post-confirmation, charts.
- Produit des **enseignements génériques** (jamais d'actif, jamais de timeframe spécifique) — des principes de trading abstraits réutilisables.
- Maintient un pool de leçons **par watch**, géré par le LLM lui-même via les actions `CREATE / REINFORCE / REFINE / DEPRECATE`.
- Injecte les leçons actives dans les prompts des phases `Detector`, `Reviewer`, `Finalizer` selon une catégorisation (`detecting / reviewing / finalizing`).
- Tend à **découvrir des règles non humainement compréhensibles** : on encourage le LLM à proposer des principes précis et observables que la littérature classique ne formalise pas nécessairement.

### Cycle de vie d'une leçon

```
                 trade fail
                     │
                     ▼
            FeedbackLoopWorkflow
                     │
                     ▼
              LLM analyse
                     │
        ┌────────────┴────────────┐
        │                         │
   CREATE/REFINE              DEPRECATE/REINFORCE
        │                         │
        ▼                         ▼
   PENDING ─── 🔔 Telegram      ACTIVE/DEPRECATED
        │       (validation)    (auto, no human)
        │
   ┌────┴────┐
   │         │
   ▼         ▼
 ACTIVE   REJECTED
   │
   ▼
 (injectée dans prompts)
   │
   ▼
 (potentiellement REFINED ou DEPRECATED par cycles futurs)
   │
   ▼
 ARCHIVED
```

### Principes guides

1. **Hexagonal strict** — domain pur, ports, adapters, workflows. Aucune dérogation.
2. **Event-sourcé** — `lesson_events` est la source de vérité ; `lessons` est une projection.
3. **Validation humaine pour les changements de contenu sémantique** (`CREATE`, `REFINE`) ; auto-flow pour les changements neutres (`REINFORCE`, `DEPRECATE`).
4. **Architecture extensible** — l'ajout d'un succès comme trigger, d'un nouveau context provider, d'un corpus statique, ou d'un worker dédié sont des évolutions linéaires sans refacto.
5. **Idempotence stricte** — child workflowId déterministe + `inputHash` côté LLM = pas de double facturation, pas de double persist.

---

## 2. Décisions structurantes

| # | Dimension | Décision |
|---|---|---|
| 1 | Triggers | A (`SLHit` direct) + B (`SLHit` après TP1 trailé) + C (`PriceInvalidated` post-confirmation). D (succès net `all_tps_hit`) explicitement OUT-OF-SCOPE v1 mais l'archi le supporte par modification d'une fonction pure `shouldTriggerFeedback`. |
| 2 | Périmètre | Pool isolé **par `watch_id`**. Migration vers hybride (global + watch) prévue par ajout d'une colonne `scope`. |
| 3 | Catégories de leçons | `detecting / reviewing / finalizing`, extensibles. Routage automatique : chaque prompt charge les `ACTIVE` de sa catégorie pour son watch. |
| 4 | Lifecycle des leçons | Upsert dirigé par le LLM : `CREATE / REINFORCE / REFINE / DEPRECATE`. Toutes les actions persistées en events versionnés (audit/replay/rollback). Cap dur par catégorie+watch (default 30). Pin/archive manuel via CLI. |
| 5 | Littérature trading | v1 = connaissance interne du LLM. v2 = corpus statique extensible (`prompts/trading-knowledge/*.md`) via un nouveau provider de contexte. |
| 6 | Orchestration | Child workflow `FeedbackLoopWorkflow` séparé, démarré par `SetupWorkflow` à la fermeture éligible avec `parentClosePolicy: ABANDON`. |
| 7 | Validation humaine | `CREATE` + `REFINE` → status `PENDING` → notification Telegram avec inline buttons → status `ACTIVE` ou `REJECTED`. `DEPRECATE` + `REINFORCE` automatiques. Pas de timeout : une leçon `PENDING` reste `PENDING` jusqu'à action humaine. |
| 8 | Modèle LLM | `claude-opus-4-7` par défaut, configurable par watch via `analyzers.feedback`. Passe par `resolveAndCall` (budgets/fallbacks/retries gratuits). |
| 9 | Contexte d'analyse | Architecture plugin : port `FeedbackContextProvider`, composé par un `FeedbackContextBuilder`. 4 providers v1 : `setup-events`, `tick-snapshots`, `post-mortem-ohlcv`, `chart-post-mortem`. Ordre figé dans le code, config = liste de désactivés. |
| 10 | Statut épistémique des leçons | **Override** la connaissance prior du LLM en cas de conflit. Le LLM apprend en pretraining ; les leçons reflètent ce que ce watch précis a démontré. |
| 11 | Worker host | Sur `analysis-worker` existant (Chromium déjà disponible pour le chart post-mortem, adapters LLM déjà branchés). Extraction vers un worker dédié possible plus tard sans refacto. |

---

## 3. Architecture haut-niveau

### Vue d'ensemble

```
SetupWorkflow                FeedbackLoopWorkflow            Notification
─────────────                ───────────────────             ─────────────

  TRACKING
    ├─ SLHit / PriceInval
    ├─ shouldTriggerFeedback?
    │    (domain pure)
    └─ if yes:
        startChild ────────► gatherFeedbackContext (activity)
        markSetupClosed             │
        return                      ▼
                            runFeedbackAnalysis (activity)
                                    │
                                    ▼
                            applyLessonChanges (activity)
                                    │
                                    ├─ persist lesson_events
                                    ├─ for CREATE/REFINE ───► notifyLessonPending (activity, cross-task-queue)
                                    │                                │
                                    │                                ▼
                                    │                       TelegramNotifier.sendLessonProposal
                                    │                                │
                                    │                                ▼
                                    │                       (Telegram inline keyboard rendered)
                                    └─ return

                            ◄──── callback ───── user taps ✅/❌
                                    │             (handled directly in
                                    │              notification-worker, hors Temporal)
                                    ▼
                            lessonApprovalUseCase.handle
                                    │
                                    ├─ UPDATE lesson status
                                    ├─ INSERT lesson_event (HumanApproved/HumanRejected)
                                    └─ TelegramNotifier.editLessonMessage
```

### Nouveaux ports (domain-pure interfaces)

- `LessonStore` — read/upsert/list lessons par watch+catégorie+status, increment usage atomique.
- `LessonEventStore` — append-only log des actions LLM et humaines (CREATE / REINFORCE / REFINE / DEPRECATE / HumanApproved / HumanRejected / AutoRejected / NotificationSent).
- `FeedbackContextProvider` — interface plugin pour les providers de contexte.

### Nouveaux adapters

- `PostgresLessonStore` (Drizzle, table `lessons`).
- `PostgresLessonEventStore` (Drizzle, table `lesson_events`).
- 4 providers de contexte : `SetupEventsContextProvider`, `TickSnapshotsContextProvider`, `PostMortemOhlcvContextProvider`, `ChartPostMortemContextProvider`.

### Nouvelles activities (`src/workflows/feedback/activities.ts`)

- `gatherFeedbackContext` — invoque les providers configurés via le `FeedbackContextBuilder`.
- `runFeedbackAnalysis` — appel LLM via `resolveAndCall`, validation Zod du payload de retour.
- `applyLessonChanges` — validation cross-état + persist transactionnel + notify Telegram pour les actions PENDING.
- `notifyLessonPending` — wrapper sur `TelegramNotifier.sendLessonProposal` (cross-task-queue vers `notification-tasks`).

### Modifications minimales aux fichiers existants

- `src/workflows/setup/setupWorkflow.ts` — ajout de `startChild(feedbackLoopWorkflow, ...)` aux points de fermeture éligibles, juste avant `markSetupClosed`.
- `src/workflows/setup/activities.ts` — `runDetector`, `runReviewer`, `runFinalizer` ajoutent `activeLessons` aux variables du prompt + appel à `LessonStore.incrementUsage`.
- `src/adapters/notify/TelegramNotifier.ts` — ajout `sendLessonProposal(...)`, `editLessonMessage(...)`.
- `src/workers/notification-worker.ts` — branchement de `bot.on('callback_query:data')` sur le `lessonApprovalUseCase`.
- `prompts/detector.md.hbs`, `prompts/reviewer.md.hbs`, `prompts/finalizer.md.hbs` — ajout du bloc `{{#if activeLessons.length}}## Active guidelines …{{/if}}` en tête + bump version `_v3` → `_v4`.
- `src/config/loadConfig.ts` (et la chaîne `loadWatchesConfig` / `loadWatchesFromDb`) — Zod schema étendu avec le bloc `feedback`.

### Nouveau prompt

`prompts/feedback.md.hbs` + `prompts/feedback.system.md`, versionnés `feedback_v1`.

### Domaine isolé

- `src/domain/feedback/closeOutcome.ts` — types `CloseOutcome`, `deriveCloseOutcome(...)`, `shouldTriggerFeedback(outcome): boolean`.
- `src/domain/feedback/lessonTransitions.ts` — state machine `PENDING → ACTIVE | REJECTED`, `ACTIVE → ARCHIVED | DEPRECATED`, règle `pinned` interdit `REFINE`/`DEPRECATE` auto.
- `src/domain/feedback/lessonAction.ts` — types `LessonAction = CREATE | REINFORCE | REFINE | DEPRECATE`.
- `src/domain/feedback/validateActions.ts` — fonction pure de cross-validation des actions LLM contre l'état du pool + filtre anti-actif.
- `src/domain/schemas/FeedbackOutput.ts` — Zod discriminated union pour le payload de retour LLM.

---

## 4. Schéma de données

### Table `lessons` (état courant — projection des events)

```ts
export const lessons = pgTable(
  "lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id").notNull(),
    category: text("category").notNull(),                    // 'detecting' | 'reviewing' | 'finalizing'
    status: text("status").notNull(),                        // 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DEPRECATED' | 'ARCHIVED'
    title: text("title").notNull(),                          // ≤120 chars
    body: text("body").notNull(),                            // 40-800 chars
    rationale: text("rationale").notNull(),                  // pourquoi cette leçon
    pinned: boolean("pinned").notNull().default(false),
    timesReinforced: integer("times_reinforced").notNull().default(0),
    timesUsedInPrompts: integer("times_used_in_prompts").notNull().default(0),
    sourceFeedbackEventId: uuid("source_feedback_event_id"),
    supersedesLessonId: uuid("supersedes_lesson_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    promptVersion: text("prompt_version").notNull(),
  },
  (t) => [
    index("idx_lessons_watch_cat_status").on(t.watchId, t.category, t.status),
    index("idx_lessons_supersedes").on(t.supersedesLessonId),
  ],
);
```

**Charge active** : `SELECT … FROM lessons WHERE watch_id = ? AND category = ? AND status = 'ACTIVE' ORDER BY times_reinforced DESC, created_at DESC LIMIT cap`.

### Table `lesson_events` (event log — audit/replay)

```ts
export const lessonEvents = pgTable(
  "lesson_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id").notNull(),
    lessonId: uuid("lesson_id"),                             // null pour CREATE avant insert
    sequence: integer("sequence").notNull(),                 // par watchId, atomique MAX+1
    type: text("type").notNull(),
    actor: text("actor").notNull(),                          // 'feedback_v1' | 'human:telegram' | 'human:cli' | 'system'
    triggerSetupId: uuid("trigger_setup_id"),
    triggerCloseReason: text("trigger_close_reason"),        // 'sl_hit_direct' | 'sl_hit_after_tp1' | 'price_invalidated'
    payload: jsonb("payload").$type<LessonEventPayload>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    inputHash: text("input_hash"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
  },
  (t) => [
    index("idx_lesson_events_watch_seq").on(t.watchId, t.sequence),
    uniqueIndex("ux_lesson_events_watch_seq").on(t.watchId, t.sequence),
    index("idx_lesson_events_lesson_time").on(t.lessonId, t.occurredAt),
    index("idx_lesson_events_setup").on(t.triggerSetupId),
    index("idx_lesson_events_input_hash").on(t.inputHash),
  ],
);
```

### Discriminated union `LessonEventPayload` (Zod)

| `type` | Payload | Émetteur |
|---|---|---|
| `CREATE` | `{ category, title, body, rationale }` | LLM (feedback_v1) |
| `REINFORCE` | `{ reason }` | LLM (feedback_v1) |
| `REFINE` | `{ supersedesLessonId, before: { title, body }, after: { title, body }, rationale }` | LLM (feedback_v1) |
| `DEPRECATE` | `{ reason }` | LLM (feedback_v1) |
| `AutoRejected` | `{ proposedAction, reason: 'cap_exceeded' \| 'pinned_lesson' \| 'asset_mention' \| 'timeframe_mention' \| 'lesson_not_found' \| 'lesson_not_active' }` | system (validation domain) |
| `NotificationSent` | `{ channel: 'telegram', msgId: number }` | system |
| `HumanApproved` | `{ via: 'telegram' \| 'cli', byUser?: string }` | human |
| `HumanRejected` | `{ via: 'telegram' \| 'cli', reason?: string }` | human |
| `HumanPinned` / `HumanUnpinned` / `HumanArchived` | `{ via: 'cli', reason?: string }` | human |

### Cap dur

Default `max_active_lessons_per_category: 30`, configurable par watch. Au moment d'un `CREATE` qui ferait dépasser le cap, l'action est rejetée et persistée comme `AutoRejected` avec `reason: 'cap_exceeded'`. Le LLM voit le pool dans son contexte → c'est à lui d'anticiper en émettant un `DEPRECATE` avant un nouveau `CREATE`.

### Justifications

- **`lesson_events` est la source de vérité** ; `lessons` est une projection. Cohérent avec le reste du système event-sourcé.
- **`sequence` atomique par `watchId`** (pas global) — un échec d'append sur watch A ne bloque pas watch B. `UNIQUE(watch_id, sequence)` comme filet de sécurité.
- **`supersedesLessonId`** permet de retrouver la généalogie d'une leçon (utile pour replay/débogage et pour l'affichage CLI).
- **Pas de FK dure de `lesson_events.lessonId` → `lessons.id`** car CREATE log vient avant l'INSERT lesson (FK nullable, vérifiée applicativement après).
- **`triggerSetupId`** garde la traçabilité bidirectionnelle setup ↔ leçon. Permet à un futur `show-setup` étendu d'afficher "ce setup a généré la leçon X".

### Migration

Fichier `migrations/000X_feedback_loop.sql` généré via `bun drizzle-kit generate`. Additif : aucune modification aux 5 tables existantes (`watch_states`, `setups`, `events`, `artifacts`, `tick_snapshots`, `watch_configs`, `watch_config_revisions`). Le service `migrate` du docker-compose existant exécute la migration au boot.

---

## 5. Workflow & activities Temporal

### Déclenchement depuis `SetupWorkflow`

Modification dans `setupWorkflow.ts` ET `trackingLoop.ts`. Le trackingLoop actuel retourne `'CLOSED'` sans préciser **comment** la position s'est fermée — pour distinguer A/B/C/D, on enrichit son retour.

#### Modification de `trackingLoop.ts` (changement breaking interne)

```ts
export type TrackingResult = {
  reason: 'sl_hit_direct' | 'sl_hit_after_tp1' | 'price_invalidated' | 'all_tps_hit';
};

export async function trackingLoop(args: TrackingArgs): Promise<TrackingResult> { ... }
```

Le trackingLoop check trois conditions par tick (dans cet ordre) :
1. **`price_invalidated`** : prix franchit `args.invalidationLevel` (nouveau paramètre, distinct du SL). Pour LONG : `tick.currentPrice <= args.invalidationLevel`. Persist `PriceInvalidated` event + close.
2. **SL hit** : SL touché → `sl_hit_direct` si `nextTpIndex === 0`, `sl_hit_after_tp1` sinon (et `currentSL === args.entry` indique trailing breakeven).
3. **TP final hit** : `all_tps_hit`.

`TrackingArgs` gagne `invalidationLevel: number` qui était déjà disponible dans `SetupWorkflowState.invalidationLevel`.

#### Dans `setupWorkflow.ts`, post-trackingLoop

```ts
const trackingResult = await trackingLoop({
  setupId: initial.setupId, /* ... */,
  invalidationLevel: state.invalidationLevel,
  scoreAtConfirmation: state.score,
});

const closeOutcome: CloseOutcome = deriveCloseOutcome({
  finalStatus: 'CLOSED',
  trackingResult,
  everConfirmed: true,
});

if (shouldTriggerFeedback(closeOutcome)) {
  await startChild(feedbackLoopWorkflow, {
    workflowId: feedbackWorkflowId(initial.setupId),
    args: [{
      setupId: initial.setupId,
      watchId: initial.watchId,
      closeOutcome,
      scoreAtClose: state.score,
    }],
    parentClosePolicy: 'ABANDON',
    cancellationType: 'ABANDON',
  });
}

state.status = 'CLOSED';
```

#### Domain `CloseOutcome`

```ts
export type CloseOutcome = {
  reason: 'sl_hit_direct' | 'sl_hit_after_tp1' | 'price_invalidated' | 'all_tps_hit'
        | 'expired' | 'rejected' | 'never_confirmed';
  everConfirmed: boolean;
};

export function deriveCloseOutcome(input: {
  finalStatus: SetupStatus;
  trackingResult?: TrackingResult;
  everConfirmed: boolean;
}): CloseOutcome { ... }

export function shouldTriggerFeedback(o: CloseOutcome): boolean {
  return o.everConfirmed && (
    o.reason === 'sl_hit_direct'
    || o.reason === 'sl_hit_after_tp1'
    || o.reason === 'price_invalidated'
  );
}
```

**Pourquoi `parentClosePolicy: ABANDON`** : la feedback loop dure plus longtemps que le SetupWorkflow (analyse + attente humaine). Le SetupWorkflow doit pouvoir se terminer immédiatement.

**Pourquoi child workflow et pas signal-only** : workflowId déterministe (`feedback-${setupId}`), retry/replay independent, visible dans Temporal UI, et `startChild` est plus idiomatique.

**Note sur le case C (`price_invalidated`)** : dans le code actuel, `priceCheckSignal` early-returns en phase TRACKING (cf. `setupWorkflow.ts:269-320`), donc l'event `PriceInvalidated` post-confirmation n'est pas détecté aujourd'hui. La détection est déplacée **dans le trackingLoop** où elle a sa place naturelle (le tick de prix arrive de toute façon par `trackingPriceSignal`). Le handler `priceCheckSignal` du SetupWorkflow garde son comportement actuel (gérer REVIEWING/FINALIZING uniquement).

### `FeedbackLoopWorkflow`

```ts
export type FeedbackLoopArgs = {
  setupId: string;
  watchId: string;
  closeOutcome: CloseOutcome;
  scoreAtClose: number;
};

export type FeedbackLoopResult = {
  changesApplied: number;
  pendingApprovalsCreated: number;
  costUsd: number;
};

export async function feedbackLoopWorkflow(args: FeedbackLoopArgs): Promise<FeedbackLoopResult> {
  // 1. Gather context (plugin pipeline, sequential)
  const context = await contextActivity.gatherFeedbackContext({
    setupId: args.setupId,
    watchId: args.watchId,
    closeOutcome: args.closeOutcome,
  });

  // 2. Run LLM analysis (one-shot, structured output)
  const analysis = await llmActivities.runFeedbackAnalysis({
    setupId: args.setupId,
    watchId: args.watchId,
    contextRef: context.contextRef,
  });

  // 3. Apply lesson changes (events + DB updates) and notify
  const result = await dbActivities.applyLessonChanges({
    setupId: args.setupId,
    watchId: args.watchId,
    closeReason: args.closeOutcome.reason,
    proposedActions: analysis.actions,
    feedbackPromptVersion: analysis.promptVersion,
    provider: analysis.provider,
    model: analysis.model,
    inputHash: analysis.inputHash,
    costUsd: analysis.costUsd,
    latencyMs: analysis.latencyMs,
  });

  return result;
}

export const feedbackWorkflowId = (setupId: string) => `feedback-${setupId}`;
```

### Retry policies

```ts
// Context gathering — DB reads + chart render. Mid-cost retries.
const contextActivity = proxyActivities<...>({
  startToCloseTimeout: '60s',
  retry: { maximumAttempts: 3, initialInterval: '500ms', maximumInterval: '10s', backoffCoefficient: 2 },
});

// LLM analysis — slow, expensive. Sparse retries.
const llmActivities = proxyActivities<...>({
  startToCloseTimeout: '180s',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5s',
    maximumInterval: '60s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// DB persistence + Telegram notify — many fast retries.
const dbActivities = proxyActivities<...>({
  startToCloseTimeout: '15s',
  retry: { maximumAttempts: 5, initialInterval: '100ms', maximumInterval: '5s', backoffCoefficient: 2 },
});
```

### Idempotence

- `runFeedbackAnalysis` calcule `inputHash = sha256(stringify({ contextChunkHashes, existingLessonIds, promptVersion }))`. Avant l'appel LLM, on consulte `lesson_events WHERE input_hash = ?` AVANT la transaction. Si match, on retourne le résultat persisté → zéro double facturation.
- `applyLessonChanges` opère en transaction Postgres avec `(watch_id, sequence)` unique. Replay → INSERT échoue → on lit ce qui a été persisté la première fois.
- Le child workflowId déterministe (`feedback-${setupId}`) garantit qu'on ne lance JAMAIS deux feedback loops pour le même setup.

### Worker host

Sur `analysis-worker` existant. Justifications :
- Volume faible (qq feedback loops par jour par watch).
- Le chart post-mortem nécessite Chromium → `analysis-worker` l'a déjà.
- L'extraction vers un worker dédié plus tard est une refacto mécanique (changer la task queue dans la config et le compose).

La task queue existante `analysis-tasks` héberge le `FeedbackLoopWorkflow` et toutes ses activities.

`notifyLessonPending` est routée vers la task queue `notification-tasks` (worker existant) — comme les autres notifications.

---

## 6. Plugin de contexte (`FeedbackContextProvider`)

### Port

`src/domain/ports/FeedbackContextProvider.ts` :

```ts
export type FeedbackContextScope = {
  setupId: string;
  watchId: string;
  asset: string;
  timeframe: string;
  closeOutcome: CloseOutcome;
  setupCreatedAt: Date;
  setupClosedAt: Date;
  confirmedAt: Date | null;
};

export type FeedbackContextChunk = {
  /** Stable id used in prompt section headers and for idempotence hashing. */
  providerId: string;
  /** Human title for the section in the prompt. */
  title: string;
  content:
    | { kind: 'markdown'; value: string }
    | { kind: 'image'; artifactUri: string; mimeType: string };
  budget?: { estTokens: number };
};

export interface FeedbackContextProvider {
  readonly id: string;
  isApplicable(scope: FeedbackContextScope): boolean;
  gather(scope: FeedbackContextScope): Promise<FeedbackContextChunk[]>;
}
```

### Composer

`src/workflows/feedback/buildContext.ts` :

```ts
export async function buildFeedbackContext(
  scope: FeedbackContextScope,
  providers: FeedbackContextProvider[],
): Promise<FeedbackContextChunk[]> {
  const chunks: FeedbackContextChunk[] = [];
  for (const p of providers) {
    if (!p.isApplicable(scope)) continue;
    const result = await p.gather(scope);
    for (const c of result) chunks.push(c);
  }
  return chunks;
}
```

Composition explicite, ordre stable (l'ordre dans la liste = ordre dans le prompt), pas de logique conditionnelle cachée.

### Adapters initiaux (4 providers v1)

Tous dans `src/adapters/feedback-context/` :

| ID | Classe | Source | Sortie |
|---|---|---|---|
| `setup-events` | `SetupEventsContextProvider` | `EventStore` | markdown — timeline complète SetupCreated → CLOSED, avec reasoning et observations |
| `tick-snapshots` | `TickSnapshotsContextProvider` | `TickSnapshotStore` | markdown — RSI/EMA/ATR à chaque tick LLM |
| `post-mortem-ohlcv` | `PostMortemOhlcvContextProvider` | `MarketDataFetcher` | markdown table — OHLCV `[confirmedAt, closedAt+marge]` |
| `chart-post-mortem` | `ChartPostMortemContextProvider` | `ChartRenderer` (généré à la volée) | image — couvre `[setupCreatedAt, closedAt+marge]`, marqueurs entry/SL/TP/close |

`existing-lessons` n'est **pas** un provider. C'est un input obligatoire passé directement à `runFeedbackAnalysis` (le LLM doit voir le pool pour décider entre `CREATE / REINFORCE / REFINE / DEPRECATE`). Le sortir du système plugin évite qu'une mauvaise config le désactive.

### Ordre figé (dans le composer, pas dans la config)

```
setup-events → tick-snapshots → post-mortem-ohlcv → chart-post-mortem
```

La config est binaire (enable/disable) ; pas de reordering YAML. Un changement d'ordre = changement de code = code review.

### Composition root

Dans `src/workers/analysis-worker.ts` :

```ts
const registry = new FeedbackContextProviderRegistry({
  'setup-events': new SetupEventsContextProvider({ eventStore }),
  'tick-snapshots': new TickSnapshotsContextProvider({ tickStore }),
  'post-mortem-ohlcv': new PostMortemOhlcvContextProvider({ marketDataFetcher }),
  'chart-post-mortem': new ChartPostMortemContextProvider({ chartRenderer, marketDataFetcher }),
});

buildFeedbackActivities({
  registry,
  lessonStore,
  lessonEventStore,
  /* ... */
});
```

L'activity `gatherFeedbackContext` lit `feedback.context_providers_disabled` depuis la config du watch, instancie la liste finale dans l'ordre canonique, ignore les IDs inconnus avec un log warning. Ajout d'un nouveau provider = 1 classe + 1 ligne dans la registry + ajout dans la liste canonique du composer.

### Justifications

- **Pas de chaîne de pré-/post-traitement** : si un provider doit dépendre d'un autre, il le compose explicitement, pas via un middleware caché.
- **`content.kind: markdown | image`** discriminé : permet à l'adapter LLM (Claude SDK) de mapper proprement texte vs image vers les blocks de l'API. `text` et `markdown` sont équivalents pour un LLM, on garde un seul kind textuel.
- **`isApplicable`** plutôt que retour vide : décision explicite, observable dans les logs, facilement testable.
- **`budget.estTokens`** optionnel : permettra plus tard d'implémenter un context-budgeter par priorisation. Pas implémenté en v1.

---

## 7. Prompt feedback + schéma de sortie LLM

### Fichiers prompt

`prompts/feedback.system.md` et `prompts/feedback.md.hbs`, versionnés `feedback_v1`.

### `feedback.system.md` (extraits clés)

```
You are the Feedback Analyzer for Trading Flow. A confirmed setup has just
closed unfavourably. Your job is retrospective analysis: produce GENERIC
trading lessons that, if applied earlier, might have avoided the failure or
caught it sooner.

ABSOLUTE CONSTRAINTS ON LESSON CONTENT
- NEVER cite a specific asset (no "BTC", no "EURUSD", no "AAPL").
- NEVER cite a specific timeframe (no "1h", no "daily", no "4h chart").
- NEVER cite specific price levels, dates, or session windows.
- NEVER mention this trade or the setup that triggered the analysis.
- A lesson must read as a UNIVERSAL trading principle applicable across any
  asset/timeframe within this watch's pool.

QUALITY BAR
- Concrete and observable: cite measurable signals (indicator regimes,
  structure conditions, candle behaviours) — not vague intuitions.
- Falsifiable: a lesson should specify when it applies AND when it does not.
- Non-redundant: if an existing ACTIVE lesson already captures the insight,
  REINFORCE it rather than CREATE.
- Creative encouraged: principles humans may not have catalogued are welcome,
  provided they are precise and observable.

YOUR DEFAULT STANCE
Bias for REINFORCE over CREATE. Bias for REFINE over DEPRECATE.
Only DEPRECATE a lesson when this trade clearly contradicts it under
conditions that overlap the lesson's scope.

ZERO ACTIONS IS A VALID OUTPUT
If this trade does not produce any new insight, return an empty `actions` array.
```

### `feedback.md.hbs` (template Handlebars, anglais)

```handlebars
{{!-- version: feedback_v1 --}}

# Retrospective trade analysis

## Trade outcome

- **Close reason**: `{{closeOutcome.reason}}`
- **Score at close**: {{scoreAtClose}}/100
- **Watch pool — active lessons by category**:
  - detecting: {{poolStats.detecting}}
  - reviewing: {{poolStats.reviewing}}
  - finalizing: {{poolStats.finalizing}}
- **Cap per category**: {{maxActivePerCategory}}

## Active lessons in this watch's pool (do not duplicate)

{{#each existingLessons}}
### Lesson `{{this.id}}` — category `{{this.category}}` — reinforced {{this.timesReinforced}}×

**{{this.title}}**

{{this.body}}

---
{{/each}}

{{#if (eq existingLessons.length 0)}}
_No active lessons yet — first cycle for this watch._
{{/if}}

## Context for analysis

{{#each contextChunks}}
## {{this.title}}

{{#if (eq this.content.kind "markdown")}}
{{{this.content.value}}}
{{/if}}
{{#if (eq this.content.kind "image")}}
_Image attached: {{this.title}}_
{{/if}}

{{/each}}

## Decision rules for `actions`

You may return between 0 and 5 actions. Each action is one of:

| Type | When to use | Required fields |
|---|---|---|
| `CREATE` | A new generic principle this trade reveals | `category`, `title`, `body`, `rationale` |
| `REINFORCE` | An existing lesson cleanly applies; this trade is more evidence | `lessonId`, `reason` |
| `REFINE` | Existing lesson right but incomplete; rewrite it | `lessonId`, `newTitle`, `newBody`, `rationale` |
| `DEPRECATE` | Existing lesson contradicted by this trade in its own scope | `lessonId`, `reason` |

## Output format

```json
{
  "summary": "1-2 sentence retrospective, free-form, not stored as a lesson",
  "actions": [...]
}
```
```

### Schéma de sortie (Zod, `src/domain/schemas/FeedbackOutput.ts`)

```ts
const LessonCategory = z.enum(['detecting', 'reviewing', 'finalizing']);

const CreateAction = z.object({
  type: z.literal('CREATE'),
  category: LessonCategory,
  title: z.string().min(10).max(120),
  body: z.string().min(40).max(800),
  rationale: z.string().min(20).max(500),
});

const ReinforceAction = z.object({
  type: z.literal('REINFORCE'),
  lessonId: z.string().uuid(),
  reason: z.string().min(10).max(500),
});

const RefineAction = z.object({
  type: z.literal('REFINE'),
  lessonId: z.string().uuid(),
  newTitle: z.string().min(10).max(120),
  newBody: z.string().min(40).max(800),
  rationale: z.string().min(20).max(500),
});

const DeprecateAction = z.object({
  type: z.literal('DEPRECATE'),
  lessonId: z.string().uuid(),
  reason: z.string().min(10).max(500),
});

export const FeedbackActionSchema = z.discriminatedUnion('type', [
  CreateAction, ReinforceAction, RefineAction, DeprecateAction,
]);

export const FeedbackOutputSchema = z.object({
  summary: z.string().min(20).max(2000),
  actions: z.array(FeedbackActionSchema).max(5),
});
```

### Validation domain post-LLM (`src/domain/feedback/validateActions.ts`)

Fonction pure qui :

1. **Validation Zod** : `FeedbackOutputSchema.parse(...)` → `LLMSchemaValidationError` non-retryable si KO.
2. **Cross-validation contre l'état du pool** :
   - `REINFORCE/REFINE/DEPRECATE.lessonId` doit pointer vers une leçon `ACTIVE` du même watch → sinon `AutoRejected{ reason: 'lesson_not_found' | 'lesson_not_active' }`.
   - Une leçon `pinned: true` rejette `REFINE` et `DEPRECATE` automatiques → `AutoRejected{ reason: 'pinned_lesson' }`.
   - `CREATE` qui ferait dépasser le cap après application → `AutoRejected{ reason: 'cap_exceeded' }`.
3. **Filtre anti-actif** :
   - Whitelist de symboles/classes connus déduite du watch (`watchConfig.asset.symbol` + classe inférée). Regex de mention rejette les actions dont `title` ou `body` matche → `AutoRejected{ reason: 'asset_mention' }`.
   - Idem pour timeframe explicite (`1m|5m|15m|30m|1h|2h|4h|1d|1w|hourly|daily|weekly|...`) → `AutoRejected{ reason: 'timeframe_mention' }`.

Sortie : `ValidatedActions { applied: LessonAction[], rejected: { action, reason }[] }`. Les `rejected` sont persistés en `lesson_events.type = 'AutoRejected'` pour audit.

### Idempotence

`inputHash = sha256(JSON.stringify({ contextChunkHashes, existingLessonIds, promptVersion }))`. Lookup `lesson_events WHERE input_hash = ? AND type IN ('CREATE','REINFORCE','REFINE','DEPRECATE')` avant l'appel LLM ; si match, on rejoue les actions persistées sans rappeler le LLM.

---

## 8. Injection des guidelines dans les prompts existants

### Pattern d'injection (identique pour les 3 prompts)

Ajouté en **tête** de chaque prompt utilisateur (Detector, Reviewer, Finalizer), juste après les métadonnées du setup et avant les données fraîches. Position en tête car les guidelines doivent biaiser le raisonnement qui suit (primacy effect).

```handlebars
{{#if activeLessons.length}}
## Active guidelines (learned from previous trades)

These principles emerged from retrospective analysis of past failed trades on
this watch. Apply them whenever they apply to the current decision. They take
precedence over generic best practice when there is a conflict.

{{#each activeLessons}}
### {{this.title}}

{{this.body}}

---
{{/each}}

{{/if}}
```

Quand `activeLessons` est vide, **toute la section disparaît** — pas de placeholder.

### Statut épistémique : override

Les leçons **prennent précédence** sur la connaissance prior du LLM en cas de conflit. Justification : ces leçons sont l'évidence empirique propre au watch, validée humainement. Sans override, les leçons "non humainement compréhensibles" auraient peu d'impact face à la connaissance pretraining.

### Bumping des prompt versions

- `prompts/detector.md.hbs` → `detector_v4`
- `prompts/reviewer.md.hbs` → `reviewer_v4`
- `prompts/finalizer.md.hbs` → `finalizer_v4`

Les events anciens conservent leur version d'origine (`_v3`). Audit/replay montrent explicitement "v3 → v4 : nouvelles guidelines actives".

### Chargement des leçons (où, comment)

Modification au niveau des activities `runDetector`, `runReviewer`, `runFinalizer` (zéro modif au workflow).

```ts
const activeLessons = await lessonStore.listActive({
  watchId: setup.watchId,
  category: 'reviewing',                              // ou 'detecting' / 'finalizing' selon l'activity
  limit: feedbackConfig.maxActiveLessonsPerCategory,
  orderBy: 'timesReinforced DESC, createdAt DESC',
});

await lessonStore.incrementUsage(activeLessons.map(l => l.id));   // batch UPDATE

const prompt = await loadPrompt('reviewer', { setup, history, fresh, activeLessons });
```

### Désactivation par catégorie

Le bloc `feedback.injection: { detector: bool, reviewer: bool, finalizer: bool }` (default tous true) permet de désactiver l'injection par phase. Si `false`, l'activity skip le `listActive` et passe `activeLessons: []` au prompt → la section disparaît.

### Pas de cache applicatif

`listActive` est appelé à chaque tick LLM. Coût négligeable (lecture indexée). On veut le hot-reload natif : une leçon validée par l'utilisateur sur Telegram doit prendre effet **au tick suivant**.

### Compteur d'usage

`times_used_in_prompts` incrémenté en batch à chaque appel. Valeur principalement observative en v1 (CLI affiche les leçons les plus utilisées vs jamais sollicitées). Logique automatique branchée dessus : OUT-OF-SCOPE v1.

---

## 9. Notification Telegram & callback handling

### Flux complet

```
applyLessonChanges (activity, in analysis-worker)
    ├─ INSERT lesson (status=PENDING) for CREATE
    ├─ INSERT lesson (status=PENDING) for REFINE (new row, supersedesLessonId=oldId)
    ├─ INSERT lesson_event (CREATE / REFINE)
    └─ enqueue notifyLessonPending (cross-task-queue → notification-tasks)
              │
              ▼
    notification-worker
              ├─ TelegramNotifier.sendLessonProposal(lesson) → returns msgId
              │     ↳ inline keyboard: [✅ Approve] [❌ Reject]
              │     ↳ callback_data = "v1|<a|r>|<lessonId>"
              └─ INSERT lesson_event (NotificationSent, payload={msgId})

--- Plus tard, l'humain tape un bouton ---

grammy bot loop (long-running dans notification-worker)
    ├─ on('callback_query:data')
    │     ├─ verify chatId is allow-listed
    │     ├─ parse callback_data
    │     └─ lessonApprovalUseCase.handle({ lessonId, action })
    │           ├─ load lesson, verify status=PENDING
    │           ├─ if approve:
    │           │     ├─ UPDATE lessons SET status='ACTIVE', activated_at=now WHERE id=? AND status='PENDING'
    │           │     ├─ if was REFINE: UPDATE old supersedes lesson SET status='ARCHIVED'
    │           │     └─ INSERT lesson_event (HumanApproved)
    │           ├─ if reject:
    │           │     ├─ UPDATE lessons SET status='REJECTED' WHERE id=? AND status='PENDING'
    │           │     └─ INSERT lesson_event (HumanRejected)
    │           └─ TelegramNotifier.editLessonMessage(msgId, finalState)
    │
    └─ ctx.answerCallbackQuery()                                    // ack le tap (Telegram demande ≤15s)
```

### Pourquoi un use-case direct (et pas un workflow Temporal)

Le callback est synchrone, idempotent au niveau DB, doit répondre dans 15s, n'a pas besoin de la durabilité Temporal — la **DB elle-même** est durable. Démarrer un workflow ultra-court à chaque tap serait surdimensionné.

```ts
bot.on('callback_query:data', async (ctx) => {
  if (!isAllowlistedChat(ctx.chat?.id)) return;
  const parsed = parseCallbackData(ctx.callbackQuery.data);
  if (!parsed) return;
  await lessonApprovalUseCase.handle(parsed);
  await ctx.answerCallbackQuery();
});
```

### Idempotence

`UPDATE lessons SET status=? WHERE id=? AND status='PENDING'` — si la leçon n'est plus PENDING (double-tap, rejet via CLI entre-temps), l'UPDATE est no-op.

### Format du message Telegram

```
🧠 New lesson proposed — watch <btc-1h>

Category: reviewing
Triggered by: setup <id-court> — sl_hit_after_tp1

Title: <title>

Body:
<body>

Rationale (LLM):
<rationale>

[✅ Approve]   [❌ Reject]
```

Pour `REFINE`, ajout d'un bloc `Before:` / `After:` avec les diffs title/body.

### Callback data

```
v1|<action>|<lessonId>
```

- `action` ∈ `a` (approve), `r` (reject)
- `lessonId` UUID 36c

Total ~45 octets, sous la limite Telegram (64).

### Sécurité (allowlist chat ID)

Réutilise `TELEGRAM_CHAT_ID` du `.env`. Tout autre chat → callback silently ignored, log debug only.

### Failure modes

| Scénario | Comportement |
|---|---|
| Notification Telegram fail (network) | `notifyLessonPending` retry (5x). Si tout échoue : leçon reste `PENDING`, accessible via `bun run src/cli/list-lessons.ts --status=PENDING`. |
| Tap Approve, notification-worker down | Telegram timeout → bouton reste cliquable. Worker repart, tap suivant fonctionne. |
| Tap Approve, edit-message fail | Leçon est `ACTIVE` (DB committee), seule l'édition a échoué. Bouton restant cliquable mais re-clic no-op (status != PENDING). |
| Double-tap Approve avant ack | `WHERE status='PENDING'` ne match qu'une fois. Idempotent. |

### Modifications aux fichiers existants

- `src/adapters/notify/TelegramNotifier.ts` : ajout `sendLessonProposal`, `editLessonMessage`.
- `src/workers/notification-worker.ts` : construction `lessonApprovalUseCase`, branchement `bot.on('callback_query:data')`.
- Nouveau `src/domain/feedback/lessonApprovalUseCase.ts` (ports purs).
- Nouveau `src/adapters/notify/lessonProposalFormat.ts` (formatting Markdown).

---

## 10. CLI

Cohérent avec les CLI existantes (`list-setups`, `show-setup`, etc.). Fichiers dans `src/cli/`. Sortie human-readable + flag `--json` pour piping.

### Nouveaux fichiers CLI

```
src/cli/
├── list-lessons.ts          # liste filtrable
├── show-lesson.ts           # détail + historique d'events
├── approve-lesson.ts        # fallback à Telegram
├── reject-lesson.ts         # fallback à Telegram
├── pin-lesson.ts            # protège contre REFINE/DEPRECATE auto
├── unpin-lesson.ts
├── archive-lesson.ts        # retire du pool actif
└── replay-feedback.ts       # rejoue la feedback loop sur un setup donné
```

### Signatures

```bash
# Lister
bun run src/cli/list-lessons.ts                                    # tout
bun run src/cli/list-lessons.ts --watch=btc-1h
bun run src/cli/list-lessons.ts --status=PENDING                   # ce qui attend ta validation
bun run src/cli/list-lessons.ts --category=reviewing
bun run src/cli/list-lessons.ts --watch=btc-1h --status=ACTIVE --json

# Détail + historique
bun run src/cli/show-lesson.ts <lesson-id>

# Approuver/Rejeter (fallback Telegram)
bun run src/cli/approve-lesson.ts <lesson-id>
bun run src/cli/reject-lesson.ts <lesson-id> --reason="too vague"

# Pin/Unpin
bun run src/cli/pin-lesson.ts <lesson-id>
bun run src/cli/unpin-lesson.ts <lesson-id>

# Archive
bun run src/cli/archive-lesson.ts <lesson-id> --reason="manual_curation"

# Replay (debug)
bun run src/cli/replay-feedback.ts <setup-id>                      # dry-run par défaut
bun run src/cli/replay-feedback.ts <setup-id> --apply
bun run src/cli/replay-feedback.ts <setup-id> --providers=setup-events,existing-lessons
```

### Composition root

`src/cli/_lesson-adapters.ts` factorise l'instanciation des adapters (cohérent avec le pattern existant des autres CLI).

### `replay-feedback` — comportement détaillé

Appelle directement les **mêmes activities** (`gatherFeedbackContext`, `runFeedbackAnalysis`, `applyLessonChanges`) qu'utilise le `FeedbackLoopWorkflow`. Pas de duplication de logique.

Sans `--apply`, on appelle `gatherFeedbackContext` + `runFeedbackAnalysis` mais on saute `applyLessonChanges`. Affiche les `actions`, le `summary`, le `costUsd` simulé.

### Pas de modif des CLI existantes

`show-setup.ts` peut être étendu plus tard pour montrer le statut feedback loop. OUT-OF-SCOPE v1.

### Pas de `delete-lesson`

On ne supprime jamais — `archive` est suffisant et préserve l'audit. Purge des leçons archivées vieilles de N jours = OUT-OF-SCOPE v1 (à intégrer dans `purge-artifacts.ts` plus tard si besoin).

---

## 11. Configuration

### Schéma config par watch

```yaml
watches:
  - id: btc-1h
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [4h] }
    schedule: { timezone: UTC }
    setup_lifecycle: { ... }
    analyzers:
      detector:  { provider: claude_max, model: claude-sonnet-4-6 }
      reviewer:  { provider: claude_max, model: claude-haiku-4-5 }
      finalizer: { provider: claude_max, model: claude-opus-4-7 }
      feedback:  { provider: claude_max, model: claude-opus-4-7 }   # ← NEW
    notifications:
      telegram_chat_id: ${TELEGRAM_CHAT_ID}
      notify_on:
        [confirmed, tp_hit, sl_hit, invalidated_after_confirmed, expired,
         lesson_proposed, lesson_approved, lesson_rejected]          # ← +3 events
    budget: { max_cost_usd_per_day: 5.00 }

    feedback:                                                         # ← NEW BLOCK
      enabled: true
      max_active_lessons_per_category: 30
      injection:
        detector: true
        reviewer: true
        finalizer: true
      context_providers_disabled: []
      # available providers: setup-events, tick-snapshots,
      #                      post-mortem-ohlcv, chart-post-mortem
```

### Defaults Zod

```ts
const DEFAULT_FEEDBACK_CONFIG = {
  enabled: true,
  maxActiveLessonsPerCategory: 30,
  injection: { detector: true, reviewer: true, finalizer: true },
  contextProvidersDisabled: [],
  analyzer: { provider: 'claude_max', model: 'claude-opus-4-7' },
};
```

Si bloc `feedback:` absent → defaults appliqués. Si `feedback.enabled: false` → toute la pipeline d'apprentissage est désactivée pour ce watch (pas de child workflow démarré, pas d'injection).

### Validation Zod (extraits clés)

```ts
const FeedbackInjectionSchema = z.object({
  detector: z.boolean().default(true),
  reviewer: z.boolean().default(true),
  finalizer: z.boolean().default(true),
});

const KNOWN_PROVIDER_IDS = ['setup-events', 'tick-snapshots', 'post-mortem-ohlcv', 'chart-post-mortem'] as const;

const FeedbackConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxActiveLessonsPerCategory: z.number().int().min(1).max(200).default(30),
  injection: FeedbackInjectionSchema.default({ detector: true, reviewer: true, finalizer: true }),
  contextProvidersDisabled: z.array(z.enum(KNOWN_PROVIDER_IDS)).default([]),
  analyzer: FeedbackAnalyzerSchema.optional(),
});
```

Si `feedback.enabled: true` ET ni `feedback.analyzer` ni `analyzers.feedback` n'est fourni → erreur explicite : `watch 'btc-1h' has feedback.enabled: true but no LLM analyzer configured (set either feedback.analyzer or analyzers.feedback)`.

### Hot-reload

| Champ | Hot-reload OK ? |
|---|---|
| `feedback.enabled` (true → false) | OK : prochain setup éligible ne déclenchera pas de child workflow |
| `feedback.enabled` (false → true) | OK : prochain setup éligible déclenchera. Setups déjà clos pendant l'off **ne sont pas rejoués automatiquement** (faire `replay-feedback.ts <id>` manuellement) |
| `feedback.maxActiveLessonsPerCategory` | OK : prochain `listActive` filtre |
| `feedback.injection.*` | OK : prochain tick LLM applique le flag |
| `feedback.contextProvidersDisabled` | OK : prochain `gatherFeedbackContext` |
| `feedback.analyzer` | OK : prochain run |

Tout hot-reload sans restart, contrairement à `cron` ou `temporal.address` qui sont restart-only.

### Variables d'environnement

Aucune nouvelle env. Le système réutilise `DATABASE_URL`, `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

### Migration de configs existantes

`config/watches.yaml.example` est mis à jour avec le bloc `feedback` documenté + commentaires. Les configs existantes n'ont rien à faire : les defaults Zod activent la feature avec des valeurs raisonnables.

---

## 12. Stratégie de tests

### `test/domain/feedback/` — pure logic, ~ms

| Fichier | Couvre |
|---|---|
| `closeOutcome.test.ts` | `deriveCloseOutcome`, `shouldTriggerFeedback` — table-driven (sl_hit_direct, sl_hit_after_tp1, price_invalidated, all_tps_hit, never_confirmed) |
| `lessonTransitions.test.ts` | State machine `PENDING → ACTIVE | REJECTED`, `ACTIVE → ARCHIVED | DEPRECATED`, `pinned` interdit `REFINE`/`DEPRECATE` auto |
| `validateActions.test.ts` | Cross-validation des actions LLM contre l'état du pool : `lessonId` doit pointer vers ACTIVE, cap dépassé, leçon pinned, regex anti-actif |
| `lessonAction.test.ts` | Discriminated union types, propriétés requises par variant |
| `feedbackOutputSchema.test.ts` | Zod parsing valides + invalides |

### `test/adapters/feedback-context/` — chaque provider, ~secondes

| Fichier | Couvre |
|---|---|
| `SetupEventsContextProvider.test.ts` | Avec fake `EventStore`, timeline complète |
| `TickSnapshotsContextProvider.test.ts` | Avec fake `TickSnapshotStore`, indicateurs |
| `PostMortemOhlcvContextProvider.test.ts` | Avec fake `MarketDataFetcher`, fenêtre temporelle |
| `ChartPostMortemContextProvider.test.ts` | Avec fake `ChartRenderer`, image bytes |

### `test/adapters/persistence/lessons.test.ts`

Avec `testcontainers` Postgres :
- `PostgresLessonStore` : insert/upsert/listActive avec filtres, increment usage atomique sous concurrence
- `PostgresLessonEventStore` : sequence atomique `MAX(seq)+1` par watchId, `UNIQUE(watchId, sequence)`, idempotence sur `inputHash`

### `test/adapters/notify/lessonProposal.test.ts`

Fake bot grammy : format markdown, inline buttons, `callback_data` ≤64 octets, retour `msgId`.

### `test/workflows/feedback/` — TestWorkflowEnvironment

| Fichier | Couvre |
|---|---|
| `feedbackLoopWorkflow.test.ts` | Bonheur path : context → LLM → applyLessonChanges → Telegram notified |
| `feedbackLoopWorkflow.failures.test.ts` | LLM échoue 3× → workflow fail. DB transient blip → succès via retries |
| `feedbackLoopWorkflow.idempotence.test.ts` | Replay même `inputHash` → pas de double LLM call, pas de double persist |
| `setupWorkflow.feedback.test.ts` | `SLHit` → child workflow démarré avec `parentClosePolicy: ABANDON`. Setup peut se fermer indépendamment du child. |
| `trackingLoop.feedback.test.ts` | Le trackingLoop retourne le bon `TrackingResult.reason` pour les 4 cas (sl_hit_direct, sl_hit_after_tp1, price_invalidated, all_tps_hit). Vérifie que `price_invalidated` est détecté **avant** `sl_hit_direct` quand l'invalidation level est touché en premier. |

### `test/integration/feedback-loop.integration.test.ts`

Postgres réel + InMemoryTelegram + InMemoryLLM. Setup factice avec trajectoire `Confirmed → SLHit`, déclenche `FeedbackLoopWorkflow`, vérifie :
- 1 lesson `PENDING`
- 1 `lesson_event` `CREATE` avec sequence=1
- Telegram message reçu avec inline keyboard
- Simule `callback_query` Approve → leçon `ACTIVE`
- Au prochain `runReviewer`, leçon active apparaît dans le prompt

### `test/integration/feedback-loop.lifecycle.integration.test.ts`

Scénarios multi-actions : REINFORCE, REFINE (chain ARCHIVED), DEPRECATE auto, pinned bloque REFINE/DEPRECATE.

### `test/e2e/feedback-loop.e2e.test.ts` — gated `RUN_E2E=1`

Sur stack docker-compose réelle : déclencher manuellement (CLI) une feedback loop sur un setup factice persisté, vérifier child workflow Temporal UI + leçon `PENDING` en DB + approbation CLI fonctionne.

### `test/llm/feedback.smoke.test.ts` — gated `RUN_LLM_CLAUDE=1`

Smoke test : 1 fixture de setup, appel réel claude-opus-4-7, vérifier que sortie passe `FeedbackOutputSchema` Zod et respecte les contraintes (pas de mention "BTC", pas de timeframe). Coût ~$0.30, opt-in.

### Fakes nouveaux dans `test/fakes/`

- `InMemoryLessonStore.ts`
- `InMemoryLessonEventStore.ts`
- `FakeFeedbackContextProvider.ts` (chunks prédéfinis)
- `FakeFeedbackLLM.ts` (actions pré-programmées par `inputHash`)

### Couverture cible (checklist)

- ✅ Tous les types d'actions (CREATE/REINFORCE/REFINE/DEPRECATE) — au moins un test à chaque niveau
- ✅ Tous les states de leçon (PENDING/ACTIVE/REJECTED/ARCHIVED/DEPRECATED) — au moins un test de transition
- ✅ Tous les triggers (sl_hit_direct/sl_hit_after_tp1/price_invalidated) — un test d'activation
- ✅ Hot-reload de `feedback.enabled` — test ad hoc dans `test/config/`

---

## 13. Plan de déploiement & migration

### Séquence de déploiement (premier rollout)

1. **Migration Drizzle** (one-shot, service `migrate` du docker-compose) : ajout des 2 nouvelles tables `lessons` et `lesson_events`.
2. **Bump des prompts existants** : `detector_v3 → v4`, `reviewer_v3 → v4`, `finalizer_v3 → v4`. Nouveaux events portent `actor: detector_v4` etc. ; anciens events conservent leur version d'origine.
3. **Nouveau prompt** : `feedback_v1`.
4. **Watches existants** : zéro modification YAML obligatoire. Defaults Zod activent la feature.
5. **Pool initial vide** : premier setup éligible → premières leçons proposées en Telegram → après approbation, premières injections au tick suivant.

### Rollback

Flag `feedback.enabled: false` sur tous les watches via `reload-config`. Aucun child workflow ne se déclenche, aucune injection. Tables existent mais inertes.

### Compatibilité avec les workflows en cours

`SetupWorkflow` en cours au moment du déploiement : Temporal versioning policy. Le déploiement remplace le code worker ; les workflows existants reprennent au prochain decision task. Le bump v3→v4 des prompts s'applique **aux ticks LLM postérieurs au déploiement**, pas aux events déjà persistés.

### Cohérence event-sourced

Les events `lesson_events` portent `promptVersion: feedback_v1`. Si on re-bumps plus tard (`feedback_v2`), les événements anciens conservent `feedback_v1` — replay reste correct.

---

## 14. Extensibilité

### 14.1 Ajouter le succès comme trigger

Le code domain isole la décision dans `shouldTriggerFeedback(closeOutcome): boolean`. Aujourd'hui :

```ts
export function shouldTriggerFeedback(o: CloseOutcome): boolean {
  return o.reason === 'sl_hit_direct'
      || o.reason === 'sl_hit_after_tp1'
      || o.reason === 'price_invalidated';
}
```

Demain, ajouter le succès net = ajouter `'all_tps_hit'`. Tout le reste suit (typesafe via `CloseOutcome.reason` union, `triggerCloseReason` colonne text libre, prompt feedback a déjà le placeholder, system prompt à enrichir). Estimation : ~1h de code + tests.

### 14.2 Pool hybride (global + par watch)

Ajouter colonne `scope: 'watch' | 'global'` à `lessons` (default `'watch'`). `LessonStore.listActive` retourne actives **du watch** + **du global**. Le system prompt apprend à émettre `scope: 'global'` quand la leçon est suffisamment universelle. Migration `ALTER TABLE … ADD COLUMN scope text NOT NULL DEFAULT 'watch'`. Estimation : ~half-day.

### 14.3 Corpus statique de littérature trading (v2)

Créer `prompts/trading-knowledge/*.md`. Charger via un nouveau provider de contexte `trading-literature` :

```ts
class TradingLiteratureContextProvider implements FeedbackContextProvider {
  readonly id = 'trading-literature';
  isApplicable() { return true; }
  async gather() {
    return [{ providerId: this.id, title: 'Reference literature', content: { kind: 'markdown', value: ... } }];
  }
}
```

Ajout dans la registry du worker + ajout dans la liste canonique du composer. Zéro modif à l'archi. Estimation : ~2h pour le provider + curation continue du corpus en parallèle.

### 14.4 Nouvelle catégorie de leçon (ex. `tracking`)

Catégories stockées en `text` (pas en enum Postgres) précisément pour permettre l'ajout sans migration. Ajouter `'tracking'` à l'union TS `LessonCategory`, étendre Zod `LessonCategory.enum`, ajouter le bloc d'injection dans le prompt cible si LLM-driven, enrichir `feedback.system.md`. Estimation : ~1h.

### 14.5 Worker dédié `feedback-worker`

Extraire en nouveau service docker-compose avec sa propre task queue `feedback-tasks`. Modifier `workflowOptions.taskQueue` au start child workflow + configurer le worker. Aucun changement de code applicatif. Estimation : ~3h.

### 14.6 Versioning du prompt feedback

Bump `feedback_v1 → v2` = nouveau fichier `feedback_v2.md.hbs` + handlebars header `version: feedback_v2`. Nouveaux `lesson_events` portent `feedback_v2` ; anciennes leçons gardent leur `promptVersion: feedback_v1`. Cohérent avec le pattern existant.

---

## 15. Décisions consciemment écartées (out-of-scope v1)

| Item | OUT-OF-SCOPE v1 | Justification |
|---|---|---|
| Trigger sur succès net (`all_tps_hit`) | ✅ | Demande explicite : démarrer sur les échecs uniquement. Architecture extensible. |
| Pool hybride (global + watch) | ✅ | Demande explicite : par watch. Simplification v1. |
| Corpus statique de littérature trading | ✅ | LLM connaît déjà beaucoup. Démarrer light, ajouter si besoin. |
| Catégorie `tracking` LLM-driven | ✅ | Tracking actuel est mécanique (pas de LLM). À envisager si on ajoute un tracker LLM. |
| Worker dédié `feedback-worker` | ✅ | Volume faible, `analysis-worker` suffit. Extraction triviale plus tard. |
| Web search live | ✅ | Casse le determinism du replay. À éviter sauf besoin avéré. |
| Auto-deprecate sur signal de performance | ✅ | Nécessite instrumentation perf des leçons. À traiter avec des données. |
| Cross-trade reflection (batch) | ✅ | Mode complémentaire au cycle par-trade. Plus tard. |
| UI web pour gérer les leçons | ✅ | Telegram + CLI suffisent. Frontend séparé déjà en cours pour les watches. |
| Auto-approve / timeout sur `PENDING` | ✅ | Demande explicite : `PENDING` indéfiniment. |
| Notification de rappel sur `PENDING` ancien | ✅ | Demande explicite : pas plus compliqué. |
| Validation humaine sur `DEPRECATE` / `REINFORCE` | ✅ | Ces actions ne peuvent pas injecter de mauvais contenu. |
| Cache applicatif sur `listActive` | ✅ | Hot-reload prévaut. Cache à introduire seulement si volume devient un problème. |
| Suppression dure de leçons | ✅ | `archive` suffit, audit préservé. |

### Dette technique délibérée

- **Idempotence à `inputHash` un peu fragile** : si l'OHLCV post-mortem est régénéré et change d'une fraction (rounding), `inputHash` diffère et on rappelle le LLM. Acceptable pour la v1 (rare). Mitigation v2 : freeze le contexte en artifact et hash l'artifact.
- **Pas de dépréciation automatique des leçons inactives** : si une leçon est créée puis jamais utilisée pendant 6 mois, elle reste. À traiter quand on aura des données.
- **Pas de cap soft + reorder** : à 30 leçons actives, on rejette les nouveaux `CREATE` (`AutoRejected`). Plus tard on pourra DEPRECATE automatiquement la moins utile.

---

## 16. Glossaire

| Terme | Définition |
|---|---|
| **Feedback loop** | Phase rétroactive déclenchée à la fermeture défavorable d'un setup confirmé. Analyse + production de leçons + persist + notification. |
| **Leçon (Lesson)** | Principe de trading générique, stocké dans `lessons`, avec un cycle de vie `PENDING → ACTIVE → ARCHIVED/DEPRECATED/REJECTED`. |
| **Catégorie** | Phase de la pipeline à laquelle la leçon s'applique : `detecting`, `reviewing`, `finalizing`. |
| **Action LLM** | Une des 4 décisions du LLM feedback : `CREATE`, `REINFORCE`, `REFINE`, `DEPRECATE`. |
| **Pool** | Ensemble des leçons `ACTIVE` pour un `(watchId, category)` donné, plafonné par `maxActiveLessonsPerCategory`. |
| **Override (statut épistémique)** | Les leçons `ACTIVE` prennent précédence sur la connaissance prior du LLM en cas de conflit. |
| **CloseOutcome** | Type domain qui décrit comment un setup s'est fermé : `sl_hit_direct`, `sl_hit_after_tp1`, `price_invalidated`, `all_tps_hit`, `expired`, `rejected`, `never_confirmed`. |
| **Trigger éligible** | `CloseOutcome.reason` qui déclenche la feedback loop (v1 : 3 cas). |
| **Validation humaine** | Approbation/rejet manuel via Telegram (callback) ou CLI sur les actions `CREATE` / `REFINE`. |
| **Pinned** | Leçon protégée contre `REFINE` et `DEPRECATE` automatiques (le LLM voit le tag et ne propose pas ; le filtre domain rejette en `AutoRejected` si proposé). |
| **inputHash** | Hash sha256 du contexte normalisé pour idempotence : `(contextChunkHashes, existingLessonIds, promptVersion)`. |
| **Provider de contexte** | Implémentation du port `FeedbackContextProvider`. v1 : 4 providers (`setup-events`, `tick-snapshots`, `post-mortem-ohlcv`, `chart-post-mortem`). |
| **`existing-lessons`** | Input obligatoire passé directement à `runFeedbackAnalysis`, hors système plugin (le LLM doit voir le pool pour décider). |
| **AutoRejected** | Type de `lesson_event` émis quand une action LLM viole une règle domain (cap dépassé, leçon pinned, mention d'actif/timeframe, lessonId invalide). |

---

## Fin du document
