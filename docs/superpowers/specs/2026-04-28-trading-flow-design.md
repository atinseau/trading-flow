# Trading Flow — Design Document

**Date** : 2026-04-28
**Status** : Draft (en attente de validation utilisateur)
**Auteur** : brainstorming Arthur + Claude

---

## Table des matières

1. [Vision](#1-vision)
2. [Principes architecturaux](#2-principes-architecturaux)
3. [Tech stack](#3-tech-stack)
4. [Architecture runtime](#4-architecture-runtime)
5. [Data model](#5-data-model)
6. [Workflows en détail](#6-workflows-en-détail)
7. [Adapters](#7-adapters)
8. [Configuration YAML](#8-configuration-yaml)
9. [Runtime ops & docker-compose](#9-runtime-ops--docker-compose)
10. [Testing strategy](#10-testing-strategy)
11. [Reload de config & lifecycle](#11-reload-de-config--lifecycle)
12. [Glossaire](#12-glossaire)
13. [Décisions consciemment écartées](#13-décisions-consciemment-écartées)
14. [Open questions / future work](#14-open-questions--future-work)

---

## 1. Vision

Bot d'analyse de trading **multi-actif, multi-timeframe**, basé sur un pipeline orchestré par Temporal qui fait grandir progressivement un score de confiance sur des "setups" (patterns détectés sur graphe). Quand un setup atteint un seuil élevé, l'utilisateur reçoit une notification Telegram avec recommandation d'entrée + suivi continu de la position théorique (TP/SL, alertes contextuelles).

**Principe métier directeur** : *organique* — un setup naît avec un score faible, grandit avec la confirmation de signaux croisés, peut s'affaiblir ou mourir si le marché contredit, vit jusqu'à confirmation finale ou expiration. Aucun setup n'est rigide ; tous évoluent au fil des ticks d'analyse.

**Pipeline en 3 phases** par setup :

1. **Detector** — détecte librement des patterns sur le graphe à chaque tick scheduler
2. **Reviewer** — refine les setups vivants en croisant fresh data + mémoire accumulée d'analyses précédentes
3. **Finalizer** — décision ultime quand un setup atteint le seuil de confiance ; déclenche notification + bascule vers phase TRACKING qui suit la position

Le système **n'exécute pas d'ordres** au MVP — il notifie. L'utilisateur décide. Architecture adapter prête à brancher un `BrokerExecutor` plus tard sans toucher au métier.

---

## 2. Principes architecturaux

### Hexagonal architecture (Ports & Adapters)

Discipline non-négociable :

- **Domain pur** : entités, schémas Zod, fonctions pures, ports (interfaces). Zéro dépendance externe (pas de Temporal, PG, LLM SDK).
- **Adapters** : implémentations concrètes des ports. Un adapter par "manière de faire" (ex: `BinanceFetcher`, `YahooFetcher` pour `MarketDataFetcher`).
- **Workflows / Activities** : orchestration Temporal. Workflows sans IO ; activities = wrappers fins (5-15 lignes) sur les adapters.
- **Composition root** : `src/workers/*` et `src/cli/*`. Seul endroit où on instancie les adapters concrets et les injecte.

Règles d'import enforcées par Biome :

```
domain/    → domain/ uniquement (zéro libs externes)
adapters/  → domain/ + libs externes (jamais d'autres adapters)
workflows/ → domain/ + sa propre activities (jamais d'adapter directement)
workers/   → tout (composition root)
cli/       → tout (entry point opérateur)
```

### Configuration métier vs détail technique

Test d'admission pour toute clé YAML : *"un trader/utilisateur normal aurait-il une raison rationnelle de toucher cette valeur ?"*. Si non → constante dans l'adapter, pas dans le YAML.

Conséquence : pas de `prompt_template`, pas de `price_monitor.adapter`, pas de `ws_endpoint` exposés à l'utilisateur. Ces décisions sont dérivées automatiquement du contexte (ex: `binance` → `BinanceWsPriceFeed`).

### Validation Zod aux 5 frontières

Tous les payloads externes sont parsés par Zod :

1. YAML config (au boot, fail-fast)
2. LLM responses (structured output validé)
3. Event payloads (un schéma Zod par type d'event, discriminated union)
4. Activity I/O (contrats stricts entre Temporal et adapters)
5. Domain entities (encore Zod-validated en runtime)

Une seule source de vérité par schéma, partagée entre tous les consommateurs.

### Idempotence & event-sourcing

- Toutes les activities LLM sont **idempotentes** via `input_hash` (sha256 des inputs). Retry Temporal = même résultat, zéro double charge LLM.
- Source de vérité = table `events` append-only. Table `setups` = projection matérialisée mise à jour en transaction avec l'append (pas de DB triggers).
- Replay possible : rejouer un setup historique avec un nouveau prompt en re-feeding ses inputs originaux.

---

## 3. Tech stack

| Catégorie         | Choix                                                  |
|-------------------|--------------------------------------------------------|
| Runtime           | Bun                                                     |
| Language          | TypeScript (strict mode)                                |
| Validation        | Zod                                                     |
| ORM               | Drizzle (TS-first, schema-as-code, migrations générées)|
| Lint + format     | Biome (single tool, remplace ESLint + Prettier)         |
| Workflow engine   | Temporal (auto-setup mode, persistance Postgres)        |
| Test              | bun test + testcontainers + Temporal TestWorkflowEnvironment |
| Charting          | Playwright headless (Chromium) + lightweight-charts     |
| Indicateurs TA    | Pure JS (RSI/EMA/ATR maison, ~100 lignes)              |
| LLM SDKs          | `@anthropic-ai/claude-agent-sdk` + OpenRouter HTTP     |
| Notifier          | grammy (Telegram bot)                                   |
| Templates prompts | Handlebars sur fichiers `.md.hbs`                       |
| Container         | Docker + docker-compose à la racine du projet           |

---

## 4. Architecture runtime

### Trois workers, trois task queues

```
┌──────────────────────────────────────────────────────────────────┐
│                          docker-compose                           │
│                                                                   │
│  Postgres ──────────── Temporal (auto-setup) ──── Temporal UI    │
│       │                       │                                   │
│       └───────────────────────┴──────────────────────────────┐    │
│                                                              ▼    │
│  ┌───────────────┐    ┌───────────────┐    ┌──────────────────┐  │
│  │ scheduler-    │    │ analysis-     │    │ notification-    │  │
│  │ worker        │    │ worker        │    │ worker           │  │
│  │               │    │               │    │                  │  │
│  │ - Scheduler   │    │ - Setup       │    │ - Telegram       │  │
│  │   workflows   │    │   workflows   │    │   activities     │  │
│  │ - Detector    │    │ - Reviewer    │    │                  │  │
│  │   activities  │    │   activities  │    │                  │  │
│  │ - PriceMon    │    │ - Finalizer   │    │                  │  │
│  │   workflows   │    │ - Tracking    │    │                  │  │
│  │               │    │   activities  │    │                  │  │
│  │ taskQueue:    │    │ taskQueue:    │    │ taskQueue:       │  │
│  │ scheduler     │    │ analysis      │    │ notifications    │  │
│  └───────────────┘    └───────────────┘    └──────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Pourquoi 3 workers** :
- **Isolation des crashes** : si l'analysis worker plante (OOM gros prompt), le scheduler continue à fetcher.
- **Scaling indépendant** : ajouter des watches → scaler le scheduler. Plus de réactivité d'analyse → scaler l'analysis worker.
- **Hot deploy** : update juste le notification-worker (changement format Telegram) sans toucher au scheduler/analysis qui ont des workflows long-running.

Les 3 workers utilisent le **même code base** ; ils diffèrent uniquement par leur task queue et la liste des workflows/activities qu'ils enregistrent.

### Layout du projet

```
trading-flow/
├─ docker-compose.yml                  # racine
├─ biome.json
├─ drizzle.config.ts
├─ tsconfig.json
├─ package.json (Bun)
├─ config/
│  └─ watches.yaml                     # config runtime, hot-reloadable
├─ src/
│  ├─ domain/                          # cœur — zéro dépendance externe
│  │  ├─ entities/
│  │  ├─ events/
│  │  │  └─ schemas/                   # Zod par type d'event
│  │  ├─ state-machine/
│  │  ├─ scoring/
│  │  ├─ schemas/
│  │  └─ ports/                        # interfaces (les "ports")
│  ├─ adapters/                        # implémentations branchables
│  │  ├─ market-data/
│  │  ├─ chart/
│  │  ├─ indicators/
│  │  ├─ llm/
│  │  ├─ persistence/
│  │  ├─ notify/
│  │  ├─ price-feed/
│  │  └─ time/
│  ├─ workflows/                       # orchestration Temporal
│  │  ├─ scheduler/
│  │  ├─ setup/
│  │  └─ price-monitor/
│  ├─ config/
│  ├─ workers/                         # composition root
│  └─ cli/                             # outils admin
├─ test/
│  ├─ domain/
│  ├─ adapters/
│  ├─ workflows/
│  ├─ e2e/
│  └─ fakes/                           # InMemoryX, FakeY partagés
├─ migrations/                         # générées par drizzle-kit
├─ prompts/
│  ├─ detector.md.hbs
│  ├─ reviewer.md.hbs
│  └─ finalizer.md.hbs
├─ docker/
│  ├─ Dockerfile.worker
│  └─ postgres/init-multiple-dbs.sh
└─ docs/
   ├─ superpowers/specs/                # ce fichier
   └─ adr/                              # Architecture Decision Records
```

---

## 5. Data model

### Cinq tables, une responsabilité chacune

| Table              | Rôle                                            | Croissance              |
|--------------------|-------------------------------------------------|-------------------------|
| `watch_states`     | État opérationnel par watch (compteurs, budget) | borné                   |
| `setups`           | État courant matérialisé d'un setup              | borné (CLOSED purgeables)|
| `events`           | Append-only, source de vérité historique         | linéaire (~30/setup)    |
| `artifacts`        | Pointeurs vers binaires (images, OHLCV, raw LLM) | linéaire (~3/event)     |
| `tick_snapshots`   | Données partagées d'un tick scheduler            | linéaire (~96/jour/watch)|

Les **binaires lourds** (images PNG, OHLCV brut, raw LLM output) ne sont **pas** dans PG — ils vivent sur le filesystem (`/data/artifacts/YYYY/MM/DD/<kind>_<uuid>.<ext>`) avec sha256 pour intégrité et dédup. PG stocke les pointeurs.

### Schéma Drizzle (extraits clés)

```ts
// src/adapters/persistence/schema.ts
export const setups = pgTable("setups", {
  id:                 uuid("id").primaryKey().defaultRandom(),
  watchId:            uuid("watch_id").notNull(),
  asset:              text("asset").notNull(),
  timeframe:          text("timeframe").notNull(),
  status:             text("status").notNull(),
  currentScore:       numeric("current_score", { precision: 5, scale: 2 }).notNull().default("0"),
  patternHint:        text("pattern_hint"),
  invalidationLevel:  numeric("invalidation_level"),
  direction:          text("direction"),
  ttlCandles:         integer("ttl_candles").notNull(),
  ttlExpiresAt:       timestamp("ttl_expires_at", { withTimezone: true }).notNull(),
  workflowId:         text("workflow_id").notNull().unique(),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt:           timestamp("closed_at", { withTimezone: true }),
});

export const events = pgTable("events", {
  id:            uuid("id").primaryKey().defaultRandom(),
  setupId:       uuid("setup_id").notNull().references(() => setups.id, { onDelete: "cascade" }),
  sequence:      integer("sequence").notNull(),
  occurredAt:    timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  stage:         text("stage").notNull(),
  actor:         text("actor").notNull(),
  type:          text("type").notNull(),
  scoreDelta:    numeric("score_delta", { precision: 5, scale: 2 }).notNull().default("0"),
  scoreAfter:    numeric("score_after", { precision: 5, scale: 2 }).notNull(),
  statusBefore:  text("status_before").notNull(),
  statusAfter:   text("status_after").notNull(),
  payload:       jsonb("payload").$type<EventPayload>().notNull(),
  provider:      text("provider"),
  model:         text("model"),
  promptVersion: text("prompt_version"),
  inputHash:     text("input_hash"),
  costUsd:       numeric("cost_usd", { precision: 10, scale: 6 }),
  latencyMs:     integer("latency_ms"),
}, (t) => ({
  setupTimeIdx: index("idx_events_setup_time").on(t.setupId, t.occurredAt),
  uniqueSeq:    uniqueIndex("ux_events_setup_seq").on(t.setupId, t.sequence),
}));

// + artifacts, tick_snapshots, watch_states
```

### Catalogue d'événements

Discriminated union Zod-validée :

```ts
type EventType =
  // Detector
  | "SetupCreated"
  // Reviewer
  | "Strengthened" | "Weakened" | "Neutral" | "Invalidated"
  // Finalizer
  | "Confirmed" | "Rejected"
  // Tracker (post-confirmation)
  | "EntryFilled" | "TPHit" | "SLHit" | "TrailingMoved"
  // Système
  | "Expired" | "PriceInvalidated";
```

Chaque type a son **payload schema** dédié (ex: `StrengthenedPayload` contient `observations[]`, `reasoning`, `freshDataSummary`).

### Idempotence : `input_hash`

Pour chaque appel d'activity LLM :

```ts
const hash = sha256({ setupId, promptVersion, ohlcvSerialized, chartUri, indicators });
const existing = await eventStore.findByInputHash(setupId, hash);
if (existing) return existing;     // retry Temporal → même résultat, 0 LLM call
// sinon on appelle vraiment le LLM
```

### `tick_snapshots` : la donnée partagée d'un tick

Le SchedulerWorkflow fait **un seul fetch** par tick (OHLCV + chart + indicators) et persiste un `tick_snapshot`. Les signals envoyés aux setups ne contiennent qu'un **UUID** (32 bytes), pas la donnée elle-même (qui ferait gonfler l'history Temporal).

Bénéfices : économie IO, cohérence temporelle entre tous les consommateurs du tick, replay déterministe.

---

## 6. Workflows en détail

### Inventaire

| Workflow              | Cardinalité           | Durée         | Task queue   |
|-----------------------|-----------------------|---------------|--------------|
| `SchedulerWorkflow`   | 1 par watch           | ∞             | `scheduler`  |
| `SetupWorkflow`       | 1 par setup vivant    | heures à jours | `analysis`   |
| `PriceMonitorWorkflow`| 1 par watch            | ∞             | `scheduler`  |

### `SchedulerWorkflow` — orchestrateur de tick

Long-running, **un par watch**. Ne contient PAS de boucle `while(true) sleep` (drift). À la place :

- Un **Temporal Schedule** (cron natif) signal `doTick` à chaque cron (cron strict, zéro drift).
- Le SchedulerWorkflow attend les signals indéfiniment et execute `runOneTick()` sur chacun.
- Hot-reload de config via signal `reloadConfig`.

`runOneTick` exécute la pipeline en 3 couches :

1. **Couche 1 — Pre-filter déterministe** (gate cheap)
   - `fetchOHLCV` + `renderChart` (Playwright) + `computeIndicators`
   - Évalue "le marché est-il intéressant ?" via heuristiques larges (ATR ratio, volume spike, RSI extreme, prix proche niveaux pivots, breakout récent)
   - Si non → skip LLM, log "calm tick"
   - Persiste le `tick_snapshot` qui est partagé en aval

2. **Couche 2 — Vision Detector LLM**
   - Input enrichi : chart fresh + indicators + **liste des setups vivants** sur cette watch
   - Verdict structuré (Zod) avec 3 catégories simultanées :
     - `corroborations` (renforce un setup existant)
     - `new_setups` (création de nouveau setup)
     - `ignore_reason` (rien à signaler)

3. **Couche 3 — Dedup déterministe** (filet de sécurité)
   - Si LLM propose un "nouveau" setup proche d'un vivant → forcer en corroboration
   - Garde-fou contre hallucinations / quasi-doublons

Apply :
- `corroborations` → `signal("corroborate")` au SetupWorkflow concerné
- `new_setups` → `startChild(SetupWorkflow, ...)` avec `parentClosePolicy: ABANDON`
- `signal("review")` à tous les setups vivants **non corroborés** (le Reviewer propre vérifie si quelque chose change)

### `SetupWorkflow` — la vie d'un setup

Long-running, **un par setup vivant**. Réactif (signal-driven), pas de polling.

**Machine à états** :

```
                     ┌──────────────────┐
   création  ────►  │   CANDIDATE      │
                    └────────┬─────────┘
                             │ (boot immédiat)
                             ▼
                    ┌──────────────────┐                   timer TTL atteint
                    │   REVIEWING      │ ◄──────────────────────┐
                    └────────┬─────────┘                        │
                             │                                  │
        ┌────────────────────┼──────────────────────┐           │
        │                    │                      │           │
        ▼                    ▼                      ▼           │
   score < dead       score ≥ threshold       INVALIDATE        │
        │                    │                      │           │
        ▼                    ▼                      │           │
  ┌──────────┐         ┌──────────┐                 │           │
  │ EXPIRED  │         │FINALIZING│                 │           │
  └──────────┘         └────┬─────┘                 │           │
                            │                       │           │
                  Finalizer GO?                     │           │
                       /        \                   │           │
                     YES         NO                 │           │
                      ▼           ▼                 ▼           │
                ┌──────────┐  ┌──────────┐    ┌────────────┐    │
                │ TRACKING │  │ REJECTED │    │INVALIDATED │    │
                └────┬─────┘  └──────────┘    └────────────┘    │
                     │                                          │
              TP/SL hit                                         │
                     ▼                                          │
                ┌──────────┐                                    │
                │  CLOSED  │                                    │
                └──────────┘                                    │
                                                                │
  (TTL Temporal natif, peut firer dans REVIEWING/FINALIZING)────┘
```

**Signals** : `review({ tickSnapshotId })`, `corroborate({ delta, evidence })`, `priceCheck({ price })`, `close({ reason })`.

**Activities** : `persistEvent`, `runReviewer`, `runFinalizer`, `notifyTelegram`, `markSetupClosed`.

**Phase TRACKING** : après Confirmation, le workflow continue à vivre. Reçoit des signals `priceCheck` du PriceMonitor. Émet `TPHit` / `SLHit` / `TrailingMoved`. Notifie Telegram à chaque event significatif.

### `PriceMonitorWorkflow` — invalidation sub-tick

Long-running, **un par watch**. Maintient une connexion (WebSocket pour crypto via `BinanceWsPriceFeed`, polling pour stocks via `YahooPollingPriceFeed`). Adapter dérivé automatiquement de `asset.source` — pas de config utilisateur.

À chaque tick prix : pour chaque setup vivant avec `invalidationLevel`, vérifie si le prix franchit. Si oui → `signal("priceCheck")` au SetupWorkflow concerné qui décide selon son `invalidation_policy` (`strict` / `wick_tolerant` / `confirmed_close`).

### Error handling

Retry policies différenciées par type d'activity :

```ts
fetchPolicy: { maxAttempts: 5, backoff: 2x, nonRetryable: [InvalidConfigError, AssetNotFoundError] }
llmPolicy:   { maxAttempts: 3, timeout: 60s, nonRetryable: [LLMSchemaValidationError] }
dbPolicy:    { maxAttempts: 5, nonRetryable: [UniqueConstraintViolation] }
```

Erreurs catégorisées dans `domain/errors.ts` (retryable vs non-retryable). Temporal lit ce flag pour décider retry/fail.

### Versioning des workflows

Pour faire évoluer du code workflow live sans casser les workflows en cours : `patched("patch-name")` Temporal natif. Anciens workflows continuent dans la branche "ancienne", nouveaux prennent la nouvelle. `deprecatePatch()` quand tous les anciens sont CLOSED.

---

## 7. Adapters

### Catalogue des ports + adapters MVP

| Port                  | Implé MVP                                        |
|-----------------------|--------------------------------------------------|
| `MarketDataFetcher`   | `BinanceFetcher`, `YahooFinanceFetcher`           |
| `ChartRenderer`       | `PlaywrightChartRenderer` (Chromium + lightweight-charts) |
| `IndicatorCalculator` | `PureJsIndicatorCalculator`                       |
| `LLMProvider`         | `ClaudeAgentSdkProvider`, `OpenRouterProvider`    |
| `PriceFeed`           | `BinanceWsPriceFeed`, `YahooPollingPriceFeed`     |
| `Notifier`            | `TelegramNotifier` (grammy)                       |
| `SetupRepository`     | `PostgresSetupRepository`                         |
| `EventStore`          | `PostgresEventStore`                              |
| `ArtifactStore`       | `FilesystemArtifactStore`                         |
| `Clock`               | `SystemClock` (FakeClock pour tests)             |

### LLM provider — graphe de fallback

Chaque provider est **autonome** : porte son fallback (par nom, optionnel) et sa logique `isAvailable()` (quotas, rate limits). Le graphe est résolu par un utilitaire `resolveAndCall()` (~20 lignes), pas un adapter.

```ts
interface LLMProvider {
  readonly name: string;
  readonly fallback: string | null;
  isAvailable(): Promise<boolean>;
  complete(input: LLMInput): Promise<LLMOutput>;
}
```

**Détection de cycle au boot** : DFS sur le graphe des fallback. Refus de démarrer si cycle.

**ClaudeAgentSdkProvider** : utilise `@anthropic-ai/claude-agent-sdk`, auth locale Claude Max (workspace_dir configuré). Coût = 0$. Limite : quotas Claude Max (fenêtre 5h glissante, calibrer `daily_call_budget` empiriquement).

**Prompt versioning** : chaque template `prompts/*.md.hbs` déclare sa version dans un commentaire Handlebars en tête de fichier (`{{!-- version: reviewer_v1 --}}`). L'activity extrait cette valeur via regex au load et la stocke dans `events.prompt_version` pour le replay futur. Bumper la version manuellement à chaque changement matériel du prompt.

**À vérifier en implé** : que le SDK fallback bien sur l'auth OAuth locale quand `ANTHROPIC_API_KEY` non défini ; sinon fallback sur subprocess `claude -p --output-format stream-json` (autre adapter, hot-swappable).

**OpenRouterProvider** : HTTP vers `openrouter.ai/api/v1/chat/completions`, compatible API OpenAI, supporte 300+ modèles. Coût tracké via `data.usage.total_cost`.

### MarketDataFetcher

Port unifié, routing par `watch.asset.source` qui mappe vers l'adapter via la factory du worker.

### ChartRenderer — Playwright

Pool de pages Chromium réutilisées (warm pool de 2-3) → rendu en ~150ms steady-state. HTML statique embarqué qui charge `lightweight-charts`. Données injectées via `page.evaluate()`. Screenshot via Playwright API. Sortie PNG sha256-hashée, persistée dans `ArtifactStore`.

### PriceFeed

Port pour invalidation sub-tick. Adapter dérivé automatiquement de `asset.source` (zéro config utilisateur). Activity long-running avec heartbeat Temporal pour maintenir la connexion WS.

---

## 8. Configuration YAML

Fichier `config/watches.yaml` à la racine. Validé par Zod au boot (refus de démarrer si invalide).

### Structure générale

```yaml
version: 1

market_data:
  binance: { base_url, rate_limit_per_minute }
  yahoo: { user_agent }
  ccxt: { enabled_exchanges }

llm_providers:
  claude_max:
    type: claude-agent-sdk
    workspace_dir: /data/claude-workspace
    daily_call_budget: 800
    fallback: openrouter
  openrouter:
    type: openrouter
    api_key: ${OPENROUTER_API_KEY}
    monthly_budget_usd: 50
    fallback: null

artifacts:
  type: filesystem
  base_dir: /data/artifacts
  retention: { keep_days: 30, keep_for_active_setups: true }

notifications:
  telegram: { bot_token, default_chat_id }

database: { url, pool_size, ssl }
temporal: { address, namespace, task_queues }

watches:
  - id: btc-1h
    enabled: true
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [4h] }
    schedule: { detector_cron: "*/15 * * * *", timezone: UTC }
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 }
    setup_lifecycle:
      ttl_candles: 50
      score_initial: 25
      score_threshold_finalizer: 80
      score_threshold_dead: 10
      invalidation_policy: strict        # strict | wick_tolerant | confirmed_close
    history_compaction: { max_raw_events_in_context: 40 }
    deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 }
    pre_filter:
      enabled: true
      mode: lenient
      thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 }
    analyzers:
      detector:  { provider: claude_max, model: claude-sonnet-4-6 }
      reviewer:  { provider: claude_max, model: claude-haiku-4-5 }
      finalizer: { provider: claude_max, model: claude-opus-4-7 }
    optimization: { reviewer_skip_when_detector_corroborated: true }
    notifications:
      telegram_chat_id: ${TELEGRAM_CHAT_ID}
      notify_on: [confirmed, tp_hit, sl_hit, invalidated_after_confirmed]
      include_chart_image: true
      include_reasoning: true
    budget: { max_cost_usd_per_day: 5.00, pause_on_budget_exceeded: true }
```

### Ce qui n'est PAS dans le YAML (intentionnellement)

- `prompt_template` / `prompt_version` → vivent dans `prompts/*.md.hbs` (Handlebars), versionnés via git
- `price_monitor.adapter` / `ws_endpoint` → dérivés automatiquement de `asset.source`
- Détails de connexion réseau (timeout, reconnect) → constantes dans les adapters

### Hot-reload via CLI

```bash
bun run src/cli/reload-config.ts
```

Diff intelligent → applique par catégorie de champ :
- **hot-reload** : signal `reloadConfig` au SchedulerWorkflow vivant
- **schedule-update** : update du Temporal Schedule
- **hard-restart** : kill + restart du workflow (confirmation requise)
- **immutable** : refus, demander delete + add

### Multi-environnements

Argument CLI au boot : `--config=config/watches.dev.yaml`. Pas de framework de config supplémentaire.

---

## 9. Runtime ops & docker-compose

### Services (docker-compose à la racine)

- **postgres** (16-alpine) : héberge DBs `trading_flow` + `temporal` + `temporal_visibility`
- **temporal** (auto-setup 1.27) : Temporal server avec backend PG
- **temporal-ui** (2.34) : UI admin sur `localhost:8080`
- **migrate** (one-shot) : applique les migrations Drizzle
- **bootstrap-schedules** (one-shot) : crée/update les Temporal Schedules à partir du YAML. **Idempotent** : sur boot suivant, vérifie l'existant et applique uniquement les diffs (équivalent à `reload-config` mais limité aux Schedules)
- **scheduler-worker** : long-running
- **analysis-worker** : long-running
- **notification-worker** : long-running

### Volumes

- `postgres_data` : données PG
- `artifacts_data` : `/data/artifacts` (chart PNG, OHLCV, raw LLM output)
- `claude_workspace` : session auth Claude Max persistée

### Bootstrap initial

```bash
bun install
cp .env.example .env && $EDITOR .env
cp config/watches.yaml.example config/watches.yaml && $EDITOR config/watches.yaml
docker compose up -d
docker compose logs -f scheduler-worker
open http://localhost:8080  # UI Temporal
```

### CLI

Tous dans `src/cli/`, scripts Bun standalone réutilisant la composition root :

- `migrate.ts` — applique migrations Drizzle
- `bootstrap-schedules.ts` — crée Temporal Schedules
- `reload-config.ts` — hot-reload avec diff
- `list-setups.ts`, `show-setup.ts`, `kill-setup.ts`
- `pause-all.ts`, `force-tick.ts`
- `replay-setup.ts` — rejoue un setup historique avec un nouveau prompt
- `cost-report.ts` — stats de coût LLM par watch
- `purge-artifacts.ts` — purge des binaires anciens

### Observabilité (3 niveaux)

1. **Telegram** — notifications business
2. **Temporal UI** — workflows actifs, signals, schedules, retries, history replay
3. **Drizzle Studio** (`bunx drizzle-kit studio`) — exploration directe DB

### Backup

- PG : `pg_dumpall` quotidien via cron host
- Artifacts : rsync vers disque externe (ou S3 plus tard via swap d'adapter)

---

## 10. Testing strategy

### Pyramide à 4 niveaux

| Niveau     | Cible          | Vitesse    | Outils                             |
|------------|----------------|------------|------------------------------------|
| Domain     | ~200 tests     | <100ms total| `bun test`, fakes pures             |
| Adapters   | ~50 tests      | <30s       | `bun test` + testcontainers + mocks |
| Workflows  | ~30 tests      | <10s       | `TestWorkflowEnvironment` time-skip |
| E2E        | ~5 tests       | ~2 min     | docker-compose.test.yml             |

### Domain tests — pure TS

Logique métier (transitions d'état, scoring, dedup, cycle detection LLM, parsing Zod, etc.). **Aucune dépendance externe.** Lancés en watch mode pendant le dev.

Coverage cible : 70-80% sur le domain.

### Adapter tests

Tests d'intégration contre **la vraie chose wrappée** quand possible :
- `PostgresEventStore` → testcontainers PG + migrations appliquées
- `BinanceFetcher` → vraie API Binance public (gratuite, pas d'auth)
- LLM providers → mocks HTTP (pas d'appel LLM réel automatisé)

### Workflow tests — TestWorkflowEnvironment

Temporal fournit un serveur en mémoire avec **time-skipping** : on peut "avancer de 4h" sans attendre. Permet de tester :
- Transitions d'état complètes
- TTL → EXPIRED sans attendre
- Score crossing threshold → FINALIZING → TRACKING
- Idempotence sur retry d'activity

Mocks d'activities pour isoler le workflow code. Le workflow code lui-même n'a aucun appel external.

### E2E tests

Quelques smoke tests qui démarrent toute la stack via `docker-compose.test.yml` (avec `MockBinanceServer` servant des données pré-cookées). Valide que le câblage de bout en bout fonctionne. Lancés en CI sur PR uniquement (lent).

### Le helper-pattern : `test/fakes/`

Fakes en mémoire de **tous les ports** (`InMemoryEventStore`, `FakeClock`, `FakeLLMProvider`, etc.). Partagés entre tous les niveaux de tests. Sont la "ground truth" de chaque port — si on change un port, on update son fake, on sait que tous les tests caston.

### CI

```yaml
jobs:
  domain:    # <100ms
  adapters:  # ~30s, services postgres
  workflows: # ~10s
  e2e:       # ~2min, uniquement en PR
  lint:      # <200ms, biome check
```

Lancements ciblés en local : `bun test test/domain/` ou `bun test test/adapters/postgres-event-store.test.ts`.

---

## 11. Reload de config & lifecycle

### Catégorisation des champs

Chaque clé YAML a une **catégorie de réaction** explicite (mappage exhaustif dans `FIELD_CATEGORIES` validé par test) :

- 🟢 **hot-reload** : signal `reloadConfig` au workflow vivant. Aucun setup interrompu.
- 🟡 **schedule-update** : update du Temporal Schedule. Aucun setup interrompu.
- 🔴 **hard-restart** : kill + restart workflow. Confirmation interactive requise.
- ⚪ **immutable** : refus (rename = delete + add).

### Comportement par opération

**Ajout d'une watch** : start `SchedulerWorkflow` + `PriceMonitorWorkflow` + create `Schedule`. Idempotent.

**Modification** : diff field-par-field, action selon catégorie.

**Suppression** :
- Setups en `CANDIDATE`/`REVIEWING`/`FINALIZING` (pas notifiés) → confirmation interactive pour kill
- Setups en `TRACKING` (déjà notifiés à l'utilisateur) → **toujours gardés vivants** jusqu'à TP/SL/expiry naturel
- Stop SchedulerWorkflow + PriceMonitorWorkflow + delete Schedule
- Soft-delete dans `watch_states` pour audit

### Garantie clé

Un setup déjà notifié (TRACKING) n'est **jamais** abandonné par un changement de config. La parole donnée à l'utilisateur via Telegram est tenue jusqu'au bout.

### Mode CI

```bash
bun run src/cli/reload-config.ts --dry-run         # affiche le diff
bun run src/cli/reload-config.ts --auto-confirm    # pour CI/CD
```

---

## 12. Glossaire

- **OHLCV** : format universel de données de marché — Open, High, Low, Close, Volume — les 5 valeurs d'une bougie. Toute API d'exchange retourne ses bougies dans ce format ; les indicateurs (RSI, EMA, ATR, etc.) en sont dérivés.
- **Watch** : déclaration de "je veux suivre cet asset sur ce timeframe avec ces paramètres". Une entrée dans `config/watches.yaml`.
- **Tick** : une exécution du cron du SchedulerWorkflow pour une watch.
- **Tick snapshot** : la donnée capturée à un tick (OHLCV + chart + indicators + pre_filter result), persistée et partagée par tous les consommateurs en aval.
- **Setup** : un pattern détecté par le Detector qui démarre un `SetupWorkflow`. Vit jusqu'à terminaison (CLOSED/INVALIDATED/EXPIRED/REJECTED).
- **Setup score** : confidence de 0 à 100, fait grandir/diminuer par le Reviewer à chaque tick.
- **Setup state machine** : CANDIDATE → REVIEWING → FINALIZING → TRACKING → CLOSED, avec branches INVALIDATED/EXPIRED/REJECTED.
- **Verdict** : sortie structurée du Reviewer (`STRENGTHEN`/`WEAKEN`/`NEUTRAL`/`INVALIDATE`).
- **Corroboration** : action légère du Detector qui renforce un setup existant sans recourir au Reviewer (économie LLM).
- **Invalidation policy** : choix métier sur la sévérité de la vérification de prix (`strict`/`wick_tolerant`/`confirmed_close`).
- **Replay** : capacité à rejouer un setup historique avec un nouveau prompt sur les mêmes inputs originaux.
- **Input hash** : sha256 des inputs d'une activity LLM, sert d'idempotency key pour éviter les doubles charges sur retry.
- **Hot-reload** : reconfiguration sans redémarrage de workflow.
- **Hard-restart** : reconfiguration nécessitant kill + start de workflow (perte de setups CANDIDATE/REVIEWING).

---

## 13. Décisions consciemment écartées

Ces décisions ont été pesées et écartées **explicitement** ; documenter pour qu'on n'y revienne pas par oubli.

- **One-workflow-per-tick** (Option 2/3 de l'archi) : écartée au profit de SetupWorkflow long-running. Raison : durabilité, signals réactifs, phase TRACKING naturelle, replay par setup.
- **DB triggers pour matérialiser `setups` depuis `events`** : écartés au profit de matérialisation applicative en transaction. Raison : logique cachée, intestable, débogage SQL.
- **JSDOM + lightweight-charts** : écarté au profit de Playwright. Raison : qualité visuelle critique pour le LLM vision, friction de dev avec Canvas non-natif.
- **Service externe de chart (chart-img.com)** : écarté. Raison : dépendance externe pour un système 24/7, coût récurrent.
- **`while(true) sleep` boucle dans SchedulerWorkflow** : écarté au profit de Temporal Schedules + signal. Raison : drift cumulé inacceptable pour timestamps de bougies.
- **ACP (Agent Client Protocol) pour Claude Code** : écarté. Raison : conçu pour intégrations éditeur, surface d'API trop large pour un client non-IDE.
- **RoutingAdapter** (LLM) : écarté au profit de providers autonomes + résolveur utilitaire. Raison : couplage plus faible, pas de hiérarchie d'objets inutile.
- **Auto-trade direct via API broker** : écarté au MVP. Raison : périmètre + responsabilité financière. Architecture adapter prête pour ajouter `BrokerExecutor` plus tard.
- **Stratégies de setup pré-définies** (Option A de la détection) : écarté au profit de détection libre par LLM (Option B). Raison : flexibilité, capacité à découvrir des patterns non-anticipés. Les phases 2 et 3 protègent contre les faux positifs.
- **Single-actif MVP (crypto only)** : écarté au profit de multi-actif d'emblée. Raison : architecture adapter le permet sans surcoût significatif, et l'utilisateur veut l'universalité.
- **`prompt_template` dans la config YAML** : écarté. Raison : détail technique, les prompts vivent en tant que `prompts/*.md.hbs` versionnés en git.
- **`price_monitor.adapter` dans la config YAML** : écarté. Raison : détail technique, dérivé automatiquement de `asset.source`.

---

## 14. Open questions / future work

À résoudre en phase d'implémentation ou en post-MVP :

### À vérifier en implé

- **Auth Claude Max via SDK** : le `@anthropic-ai/claude-agent-sdk` utilise-t-il l'OAuth local quand `ANTHROPIC_API_KEY` n'est pas défini ? Si non, fallback sur subprocess `claude -p --output-format stream-json`.
- **Limites exactes de Claude Max** : tester le comportement sur un cycle 24h avec ~30 calls/jour pour calibrer `daily_call_budget`.
- **Qualité visuelle du rendu Playwright** : tester un cycle complet avec un LLM vision réel sur 10-20 setups, vérifier que le Detector identifie correctement les patterns. Si insuffisant, ajouter annotations / multi-pane.

### Post-MVP

- **Compaction LLM** : implémenter le summarize quand `events.length > max_raw_events_in_context`. MVP envoie tout.
- **Multi-timeframe confluence** : le Reviewer fetch déjà optionnellement le HTF, mais la prompt doit être affinée pour tirer parti.
- **Replay tool complet** : CLI `replay-setup.ts` pour comparer prompts v1 vs v2 sur historique réel.
- **Dashboard web** (Bun.serve + React) : visualisation des setups vivants, courbes de cost, performance par stratégie.
- **Auto-trade** : `BrokerExecutor` adapter pour Binance/Bybit, après calibration confiance sur 3+ mois de notifications validées manuellement.
- **Backtesting** : module `backtest/` qui rejoue le pipeline sur données historiques, sans Temporal (en mémoire), pour tuner les paramètres.
- **Multi-utilisateur** : si on veut exposer ça à des amis, ajouter `user_id` partout, isolation des watches, billing (lol).

---

**Fin du design document.**

Pour toute question pendant l'implémentation, ce document fait foi. Les ADRs (`docs/adr/`) capteront les décisions complémentaires prises en cours de route.
