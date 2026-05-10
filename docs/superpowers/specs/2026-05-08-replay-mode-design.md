# Replay Mode — Design Document

**Date** : 2026-05-08
**Status** : Draft (en attente de validation utilisateur)
**Auteur** : brainstorming Arthur + Claude

---

## Préambule métier

### Le besoin

Trading Flow est un bot LLM-driven : ses décisions de trading sont produites par un raisonnement opaque (Detector → Reviewer → Finalizer). Quand un setup se ferme, on a aujourd'hui :

- la liste textuelle des events sur `/setups/:id`
- les chart artifacts persistés
- les agrégats statistiques sur `/performance`

Mais on **ne voit pas ce que le bot voyait au moment où il a décidé**. On ne peut pas savoir s'il a halluciné un pattern, sur-pondéré un indicateur, ou réagi correctement à des données partielles. Et quand on veut **améliorer le bot** (modifier un prompt, ajuster un seuil, changer un modèle), on n'a aucun moyen de tester ce changement sans le déployer en prod et attendre que des trades surviennent.

### Ce que ce projet fournit

Une **rétro-exécution contrôlée**, déclenchée à la demande par l'utilisateur, sur **une fenêtre temporelle passée d'une watch précise**.

Concrètement, sur la page `/replay` :

1. L'utilisateur **choisit une watch** (ex: `btc-1h`) et **une fenêtre de bougies passées** (ex: du 12 avril 14h au 13 avril 14h, soit 24 bougies).
2. Une **session de replay** est créée. Toutes les bougies de la fenêtre sont chargées : celles ≤ playhead sont visibles au bot, celles > playhead sont masquées au bot mais affichées en transparence à l'utilisateur (qui, lui, connaît le futur).
3. **Bougie par bougie**, l'utilisateur clique "Step" et observe le bot raisonner exactement comme il l'aurait fait à ce moment-là :
   - Le **Detector** reçoit le chart **dans l'état exact** où il était à cette bougie.
   - S'il propose un setup, l'utilisateur voit le verdict, le reasoning textuel, et le score initial.
   - Bougie suivante : le **Reviewer** réévalue, le score évolue.
   - Si le seuil est atteint : **Finalizer** → décision GO/NO_GO.
   - Si GO : tracking simulé bougie par bougie pour TP/SL.

L'utilisateur peut **comparer en temps réel les décisions du bot à ce qui s'est réellement passé** (visible en transparence sur le chart) et identifier où le bot s'est trompé, où il a eu raison, ou où un changement de prompt aurait fait la différence.

### Pourquoi c'est utile (cas d'usage métier)

| Cas d'usage | Comment le replay aide |
|---|---|
| **Comprendre une perte** | Prendre un trade qui a perdu en prod, lancer un replay sur sa fenêtre, voir bougie par bougie où le bot a fait un faux pas (mauvaise lecture du Detector ? sur-confiance du Reviewer ? Finalizer trop permissif ?). |
| **Tester un changement de prompt** | Modifier `detector_v3` → `v4` localement, lancer un replay sur une fenêtre passée intéressante, voir si v4 décide mieux — sans toucher aux watches actives. |
| **Apprendre à connaître le bot** | Observer son raisonnement dans des contextes variés (bull, bear, range, news), calibrer son intuition sur ses forces et faiblesses. |
| **Itérer rapidement** | Chaque replay coûte quelques cents (cache LLM mutualisé, fenêtre courte), pas des heures et des centaines de dollars comme un batch agrégé. |

### Ce qui distingue cette approche

- **Manuel et on-demand** : l'utilisateur déclenche, regarde, comprend. Aucun cron, aucune analyse statistique en arrière-plan, aucun scoring automatique.
- **Une watch à la fois** : la session est attachée à une watch et **utilise sa config réelle** (prompts versionnés, indicateurs activés, seuils, modèles).
- **Une fenêtre courte** (24-100 bougies typiquement) : on étudie un cas précis à fond, pas une moyenne sur 12 mois.
- **Observation, pas optimisation** : la session ne produit pas de Sharpe ni de profit factor. Elle produit une **trace** — la séquence d'events que le bot aurait émis, avec tout son raisonnement.
- **Aucun impact sur la prod** : zéro Telegram envoyé, zéro écriture sur les tables live (`setups`, `events`, `lessons`, `llm_calls`...), zéro workflow Temporal démarré. La prod continue à tourner pendant qu'on fait des replays.

### Ancrage architectural

L'implémentation respecte strictement l'**architecture hexagonale** déjà en place :

- La pipeline domain (Detector, Reviewer, Finalizer, scoring, state machine) est invoquée **sans modification**.
- Seuls les **adapters sont substitués** via dependency injection : `CachedLLMProvider` (cache mutualisé), `NoopTelegramNotifier` (capture sans envoi), `Replay*Store` (écriture sur tables `replay_*` isolées), `FixedClock` (horloge simulée à la bougie courante).
- Aucun nouveau workflow Temporal : l'orchestrateur `ReplayStepper` est synchrone, in-process, testable sans infra.
- Aucune modification du schéma live ; uniquement de nouvelles tables `replay_*` et un cache `llm_response_cache`.

C'est cette discipline qui garantit que **le bot replayé est rigoureusement le même que le bot live** — modulo les side-effects neutralisés.

---

## Table des matières

1. [Vision & contexte](#1-vision--contexte)
2. [Décisions structurantes](#2-décisions-structurantes)
3. [Architecture haut-niveau](#3-architecture-haut-niveau)
4. [Schéma de données](#4-schéma-de-données)
5. [Domain & adapters de neutralisation](#5-domain--adapters-de-neutralisation)
6. [Mécanisme de stepping](#6-mécanisme-de-stepping)
7. [Endpoints API](#7-endpoints-api)
8. [Frontend](#8-frontend)
9. [Coût LLM, cache, garde-fous](#9-coût-llm-cache-garde-fous)
10. [Isolation & invariants de sécurité](#10-isolation--invariants-de-sécurité)
11. [Stratégie de tests](#11-stratégie-de-tests)
12. [Plan de phases & déploiement](#12-plan-de-phases--déploiement)
13. [Extensibilité](#13-extensibilité)
14. [Décisions consciemment écartées (out-of-scope v1)](#14-décisions-consciemment-écartées-out-of-scope-v1)
15. [Glossaire](#15-glossaire)

---

## 1. Vision & contexte

### Forme du système

Une **rétro-exécution contrôlée** de la pipeline du bot sur une fenêtre temporelle passée. La session est manuelle, on-demand, attachée à une watch précise. L'utilisateur navigue **bougie par bougie** et voit :

- l'**input** envoyé au LLM (chart figé à la bougie courante, scalars d'indicateurs)
- la **réponse** du LLM (verdict, score, reasoning textuel)
- les **events** émis (SetupCreated, Strengthened, Confirmed, TPHit, ...)
- le **message Telegram** qui aurait été envoyé en prod, capturé sans envoi

Le tout est persisté dans des tables `replay_*` isolées, reprenable, supprimable.

### Cas d'usage primaires

1. **Post-mortem d'une perte** — replay sur la fenêtre du trade pour voir où le bot s'est planté.
2. **Validation d'un changement de prompt / config** — tester localement sans toucher la prod.
3. **Compréhension qualitative** — apprendre comment le bot réagit dans tel régime, sur tel pattern.

### Périmètre explicite

- **Une fenêtre courte** : 24 à 100 bougies typiquement. Pas un backtest 12 mois.
- **Une watch à la fois** : la session utilise la config de cette watch (prompts versionnés, indicateurs, seuils, modèles).
- **Manuel** : l'utilisateur clique Step (ou active Auto-step à intervalle). Pas de cron, pas de trigger automatique.
- **Observation** : la session produit une trace, pas une métrique d'optimisation.

### Principes guides

1. **Hexagonal strict** — la pipeline (Detector / Reviewer / Finalizer) est invoquée **inchangée**. Seuls les adapters changent (LLM cache, Notifier no-op, stores replay-scoped, Clock simulé).
2. **Side-effects neutralisés** — zéro Telegram, zéro écriture sur `setups`/`events`/`tick_snapshots`/`llm_calls` live, zéro Temporal Schedule créé, zéro tracking workflow démarré.
3. **Event-sourcé** — `replay_events` est la source de vérité d'une session. On peut rejouer la lecture d'une session à zéro coût en relisant ses events.
4. **Reprenable** — une session pausée peut être reprise. Le state du replay est entièrement dans `replay_sessions.current_playhead_at` + les `replay_events` accumulés.
5. **Page dédiée** — `/replay` est une zone à part entière, pas un onglet d'une watch. Une session référence une watch (pour la config), mais les sessions vivent leur propre vie et survivent à la suppression d'une watch.

---

## 2. Décisions structurantes

| # | Dimension | Décision |
|---|---|---|
| 1 | Périmètre v1 | Le produit cible est la rétro-exécution interactive complète (step → invoke pipeline → afficher trace). Livré en deux jalons (cf. §12) : un squelette navigable d'abord, puis le step interactif qui déclenche les vrais LLM calls. |
| 2 | Localisation UI | Page dédiée `/replay` (liste de sessions + bouton nouvelle) et `/replay/:sessionId` (la session). **Pas** d'onglet sous `/watches/:id`. Une session référence une watch via `watch_id` mais peut survivre à la suppression de la watch. |
| 3 | Granularité du step | 1 step = 1 bougie sur le `timeframe.primary` de la watch. Step `count > 1` autorisé pour avancer rapidement. Auto-step à intervalle paramétrable (1s / 2s / 5s entre bougies). |
| 4 | Source des bougies | `MarketDataFetcher` existant (Binance / Yahoo) avec borne haute = `current_playhead_at`. Pas de stockage local des OHLCV — on les re-fetch à chaque step (rapide, déjà cached côté Bun). |
| 5 | Side-effects neutralisés | (a) `NoopTelegramNotifier` capture les messages dans `replay_events.payload.telegram_preview` mais n'envoie rien. (b) `ReplayEventStore` écrit dans `replay_events` au lieu de `events`. (c) `ReplayLLMCallStore` écrit dans `replay_llm_calls`. (d) `ReplaySetupRepository` écrit dans `replay_setups`. (e) Tracking simulé dans le step lui-même, pas via Temporal child workflow. |
| 6 | Clock | À chaque step on injecte un `FixedClock` qui retourne `current_playhead_at`. Le `inputHash` reste reproductible. |
| 7 | Cache LLM | Table `llm_response_cache` indexée par `(provider, model, prompt_version, input_hash)`. Hit = $0. Miss = appel réel + insert dans le cache. Cache mutualisé entre toutes les sessions. |
| 8 | Cost cap | Cap obligatoire à la création (default $5 / session). Si le coût cumulé d'une session atteint le cap, le step suivant retourne 402, la session passe en `COST_CAPPED`. Reprenable après augmentation du cap. |
| 9 | Persistence config snapshot | À la création, on snapshot la config de la watch (prompts versions, modèles, indicateurs, seuils) dans `replay_sessions.config_snapshot`. Si la watch est éditée plus tard, le replay reste reproductible. |
| 10 | Override de config | Hors scope v1. La session utilise toujours la config snapshotée de la watch. Une évolution post-v1 pourrait permettre de surcharger ponctuellement (autre prompt, autre modèle) ; v1 reste sur "config réelle de la watch". |
| 11 | Comparaison de sessions | Hors scope v1. Évolution possible post-v1 si l'usage le demande. |
| 12 | Auto-trigger | Out-of-scope. Aucun cron, aucun déclenchement automatique. 100% on-demand par l'utilisateur. |
| 13 | Suppression | Une session peut être supprimée par l'utilisateur (cascade sur `replay_events`, `replay_setups`, `replay_llm_calls`). Le `llm_response_cache` survit (utilisé par d'autres sessions). |
| 14 | Échec en cours de step | Si un LLM call échoue (timeout, rate limit, erreur provider), la session passe en `FAILED` avec le message d'erreur. Reprenable après résolution (retry idempotent grâce au cache). |
| 15 | Telegram preview | Capture la string formatée *qu'aurait* émise le notifier, sans appeler l'API Telegram. Affichée dans l'UI à côté du verdict, en grisé `(NEUTRALISÉ)`. |

---

## 3. Architecture haut-niveau

### Diagramme : composants et dépendances

```
┌────────────────────────────────────────────────────────────────────────┐
│                            tf-web (Bun.serve)                          │
│                                                                        │
│  Routes /api/replay/*  ──────►  ReplaySessionService (domain)          │
│                                       │                                │
│                                       ▼                                │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  ReplayStepper (orchestrateur in-process, pas Temporal)         │ │
│  │                                                                  │ │
│  │   1. Charge session + currentPlayhead                            │ │
│  │   2. Pour chaque bougie [playhead .. playhead+count] :           │ │
│  │      a. Fetch OHLCV [windowStart..tick] via MarketDataFetcher    │ │
│  │      b. Compute scalars (IndicatorCalculator)                    │ │
│  │      c. Render chart PNG (PlaywrightChartRenderer)               │ │
│  │      d. Build Detector prompt (PromptBuilder)                    │ │
│  │      e. Call Detector via CachedLLMProvider                      │ │
│  │      f. Pour chaque alive replay_setup :                         │ │
│  │         - Build Reviewer prompt                                  │ │
│  │         - Call Reviewer via cache                                │ │
│  │         - applyVerdict                                           │ │
│  │      g. Si score >= threshold : Finalizer                        │ │
│  │      h. Si GO : créer EntryFilled                                │ │
│  │      i. Pour chaque setup avec EntryFilled : simuler TP/SL       │ │
│  │         sur la bougie courante                                   │ │
│  │      j. Persister tous les events dans replay_events             │ │
│  │   3. Avance currentPlayhead                                      │ │
│  │   4. Renvoie tous les nouveaux events au frontend                │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                       │                                │
│                                       ▼                                │
│         ┌─────────────────────────────────────────────────┐            │
│         │  Adapters (injection au step time)              │            │
│         │  ─────────────────────────────────────          │            │
│         │  CachedLLMProvider   wrapping ClaudeAgentSdk    │            │
│         │  NoopTelegramNotifier                           │            │
│         │  ReplayEventStore  → replay_events              │            │
│         │  ReplaySetupRepository → replay_setups          │            │
│         │  ReplayLLMCallStore → replay_llm_calls          │            │
│         │  FixedClock(currentPlayheadAt)                  │            │
│         └─────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────┘
```

### Pourquoi pas de Temporal workflow ?

Le replay est **synchrone et interactif** : le user clique Step, on attend la réponse (5-15s pour 1 step avec LLM call). Temporal apporterait du surcoût (worker, schedule, queue) sans bénéfice — on n'a pas besoin de durabilité long-running, ni de retry automatique transparent. Si le step crashe, on retourne 500 au frontend et le user ré-essaie ; le cache LLM garantit qu'on ne paie pas deux fois.

**Ce qui justifierait un workflow Temporal** : un mode "Auto-run jusqu'à la fin de la fenêtre" (ex: 200 bougies d'un coup). On reportera cette décision à une éventuelle évolution post-v1.

### Diagramme : flux d'une session

```
[user] clique "Nouvelle session"
   │
   ▼
POST /api/replay/sessions
   │  (snapshot config watch, valide cost_cap, allocate sessionId)
   ▼
INSERT replay_sessions (status=READY, current_playhead_at=window_start)
   │
   ▼
[user] redirect → /replay/:sessionId

[user] clique "Step" (count=1)
   │
   ▼
POST /api/replay/sessions/:id/step?count=1
   │
   ▼
ReplayStepper.advance(session, 1)
   │
   ├─► fetchOHLCV(symbol, window_start..playhead+1)
   ├─► compute scalars on this slice
   ├─► render chart
   ├─► call Detector via cache
   ├─► persist 0..N replay_events (DetectorTickProcessed, SetupCreated, …)
   ├─► for each alive replay_setup → Reviewer/Finalizer
   ├─► simulate TP/SL on current candle for confirmed setups
   ├─► UPDATE replay_sessions.current_playhead_at, cost_usd_so_far
   ▼
RETURN { newEvents: [...], playheadAt, costUsdSoFar }

[frontend] append events to log + markers on chart
```

---

## 4. Schéma de données

Toutes les tables sont préfixées `replay_*`. Aucune modification des tables live.

### `replay_sessions`

```sql
CREATE TABLE replay_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id               text NOT NULL,                 -- referenced (loose, no FK; survives watch deletion)
  name                   text,                          -- user-given label, optional
  status                 text NOT NULL,                 -- READY | RUNNING | PAUSED | COMPLETED | COST_CAPPED | FAILED
  window_start_at        timestamptz NOT NULL,
  window_end_at          timestamptz NOT NULL,
  current_playhead_at    timestamptz NOT NULL,          -- starts = window_start_at; advances per step
  config_snapshot        jsonb NOT NULL,                -- full WatchConfig at creation; immutable
  cost_cap_usd           numeric(10, 4) NOT NULL DEFAULT 5.0,
  cost_usd_so_far        numeric(10, 4) NOT NULL DEFAULT 0,
  failure_reason         text,                          -- non-null if status=FAILED
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replay_sessions_status_chk CHECK (
    status IN ('READY','RUNNING','PAUSED','COMPLETED','COST_CAPPED','FAILED')
  ),
  CONSTRAINT replay_sessions_window_chk CHECK (window_end_at > window_start_at),
  CONSTRAINT replay_sessions_playhead_chk CHECK (
    current_playhead_at >= window_start_at AND current_playhead_at <= window_end_at
  )
);

CREATE INDEX idx_replay_sessions_watch_created ON replay_sessions (watch_id, created_at DESC);
CREATE INDEX idx_replay_sessions_status ON replay_sessions (status);
```

### `replay_setups`

Miroir de `setups` scopé par session. Champs identiques sémantiquement, plus `session_id`.

```sql
CREATE TABLE replay_setups (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                  uuid NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  watch_id                    text NOT NULL,
  asset                       text NOT NULL,
  timeframe                   text NOT NULL,
  status                      text NOT NULL,
  current_score               numeric(5, 2) NOT NULL DEFAULT 0,
  pattern_hint                text,
  pattern_category            text,
  expected_maturation_ticks   integer,
  invalidation_level          numeric,
  direction                   text,
  ttl_candles                 integer NOT NULL,
  ttl_expires_at              timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  closed_at                   timestamptz,
  outcome                     text,
  entry_price                 numeric,
  stop_loss                   numeric,
  exit_price                  numeric,
  exit_reason                 text,
  pnl_pct                     numeric(10, 4),
  r_multiple                  numeric(10, 4)
);

CREATE INDEX idx_replay_setups_session_status ON replay_setups (session_id, status);
```

### `replay_events`

Event-sourcé miroir de `events`. Inclut les events Telegram-preview neutralisés.

```sql
CREATE TABLE replay_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  setup_id          uuid REFERENCES replay_setups(id) ON DELETE CASCADE, -- null for tick-level events without setup
  sequence          integer NOT NULL,                                     -- monotonic per session
  occurred_at       timestamptz NOT NULL,                                 -- simulated time = playhead at moment of emission
  stage             text NOT NULL,                                        -- detector | reviewer | finalizer | tracker | replay-meta
  actor             text NOT NULL,
  type              text NOT NULL,                                        -- existing event types + replay-specific
  score_delta       numeric(5, 2) NOT NULL DEFAULT 0,
  score_after       numeric(5, 2),
  status_before     text,
  status_after      text,
  payload           jsonb NOT NULL,
  provider          text,
  model             text,
  prompt_version    text,
  input_hash        text,
  latency_ms        integer,
  cache_hit         boolean NOT NULL DEFAULT false                       -- was the LLM call served from cache?
);

CREATE UNIQUE INDEX ux_replay_events_session_seq ON replay_events (session_id, sequence);
CREATE INDEX idx_replay_events_session_setup ON replay_events (session_id, setup_id, sequence);
```

**Types d'events spécifiques au replay** (en plus des types existants `SetupCreated`, `Strengthened`, `Confirmed`, `TPHit`, etc.) :

- `DetectorTickProcessed` : émis à chaque step même si le Detector retourne `ignore_reason`. Contient le reasoning, le ignore_reason, le coût.
- `ReplayMeta` : événements méta (session pausée, reprise, cost-capped). Stage = `replay-meta`.

### `replay_llm_calls`

Miroir de `llm_calls`. Permet l'audit fin du coût d'une session par stage / modèle.

```sql
CREATE TABLE replay_llm_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  setup_id            uuid REFERENCES replay_setups(id) ON DELETE SET NULL,
  stage               text NOT NULL,                  -- detector | reviewer | finalizer
  provider            text NOT NULL,
  model               text NOT NULL,
  prompt_tokens       integer NOT NULL DEFAULT 0,
  completion_tokens   integer NOT NULL DEFAULT 0,
  cache_read_tokens   integer NOT NULL DEFAULT 0,
  cache_create_tokens integer NOT NULL DEFAULT 0,
  cost_usd            numeric(10, 6) NOT NULL,
  latency_ms          integer,
  cache_hit           boolean NOT NULL DEFAULT false,  -- was this call served from llm_response_cache?
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_replay_llm_calls_session ON replay_llm_calls (session_id, occurred_at);
```

### `llm_response_cache`

**Table mutualisée** entre toutes les sessions de replay. Une session qui rejoue un input identique à une autre paie zéro.

```sql
CREATE TABLE llm_response_cache (
  input_hash          text PRIMARY KEY,                -- SHA-256 of (provider, model, prompt, image_sha256)
  provider            text NOT NULL,
  model               text NOT NULL,
  prompt_version      text NOT NULL,
  response_json       jsonb NOT NULL,                  -- raw LLM output, validated against schema at hit time
  prompt_tokens       integer NOT NULL,
  completion_tokens   integer NOT NULL,
  cost_usd            numeric(10, 6) NOT NULL,         -- cost of the original (cache-miss) call
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  hit_count           integer NOT NULL DEFAULT 0
);

CREATE INDEX idx_llm_response_cache_last_used ON llm_response_cache (last_used_at);
```

**Politique d'invalidation** : aucune invalidation automatique v1. Le `prompt_version` fait partie du `input_hash` indirectement (changement de prompt = nouveau hash). Si on doit invalider manuellement (ex: bug dans le calcul d'un scalar), on peut purger via CLI.

### Migration

Une seule migration ajoutée (n° 0015) qui crée les 5 tables. Aucune modification des tables live.

---

## 5. Domain & adapters de neutralisation

### Vue d'ensemble

La pipeline domain reste **strictement inchangée**. L'orchestrateur `ReplayStepper` instancie une variante des adapters et les passe aux mêmes fonctions de domain.

### Adapters à créer

#### `CachedLLMProvider` (wrapping)

```ts
// src/adapters/llm/CachedLLMProvider.ts
export class CachedLLMProvider implements LLMProvider {
  constructor(
    private inner: LLMProvider,
    private cache: LLMResponseCacheStore,
  ) {}

  async call(input: LLMInput): Promise<LLMOutput> {
    const hash = computeInputHash(input);
    const cached = await this.cache.get(hash);
    if (cached) {
      await this.cache.touchHit(hash);
      return { ...cached.response, fromCache: true, costUsd: 0 };
    }
    const out = await this.inner.call(input);
    await this.cache.set(hash, { response: out, ...meta });
    return { ...out, fromCache: false };
  }
}
```

**Important** : le `cache` est partagé. Le `CachedLLMProvider` est mountable sur n'importe quel `LLMProvider` (Anthropic SDK, OpenRouter). Le `inputHash` inclut le sha256 de l'image (le chart PNG) pour invalider le cache si la donnée change.

Note : un mode "no-cache" est supporté via flag `bypass_cache` au step level (utile pour tester un changement de prompt qui n'incrémente pas la version).

#### `NoopTelegramNotifier`

```ts
// src/adapters/notify/NoopTelegramNotifier.ts
export class NoopTelegramNotifier implements Notifier {
  constructor(private capture: (message: TelegramPreview) => Promise<void>) {}

  async notifyTelegramSetupCreated(args): Promise<void> {
    await this.capture({ kind: "setup_created", text: this.format(args), args });
    // No real API call.
  }
  // ... idem for all 7 notify methods
}
```

Le `capture` callback persiste les previews dans `replay_events.payload.telegram_preview` pour qu'elles soient affichées dans l'UI. **Aucun appel à l'API Telegram.**

#### `ReplayEventStore`, `ReplaySetupRepository`, `ReplayLLMCallStore`

Reproduisent les interfaces des stores live mais écrivent dans les tables `replay_*` avec un `session_id` injecté. Leurs implémentations sont des wrappers minces autour de Drizzle.

#### `FixedClock`

```ts
// src/adapters/time/FixedClock.ts
export class FixedClock implements Clock {
  constructor(private fixedAt: Date) {}
  now(): Date { return this.fixedAt; }
  advance(to: Date): void { this.fixedAt = to; }
}
```

Garantit que `now()` dans la pipeline retourne le timestamp de la bougie courante, pas l'heure réelle. Crucial pour la reproductibilité (si on rappelle le LLM avec le même prompt, il doit donner la même réponse → cache hit).

### Domain : `ReplaySessionService`

Petit service domain (pure) qui encapsule la logique de cycle de vie d'une session :

```ts
export class ReplaySessionService {
  create(args: { watchConfig, windowStart, windowEnd, name, costCap }): ReplaySession
  canStep(session: ReplaySession, requestedCount: number): { ok: boolean; reason?: string }
  applyStep(session: ReplaySession, advanceBy: number, costIncurred: number): ReplaySession
  isCompleted(session: ReplaySession): boolean
}
```

Pas de side-effects, juste des fonctions pures qui valident/transitionnent l'état.

### Domain : `ReplayStepper`

L'orchestrateur. Pas un workflow Temporal, juste une classe qui assemble les pièces. Ses dépendances sont injectées (testable).

```ts
export class ReplayStepper {
  constructor(private deps: {
    sessionRepo: ReplaySessionRepository,
    eventStore: ReplayEventStore,
    setupRepo: ReplaySetupRepository,
    llmCallStore: ReplayLLMCallStore,
    cachedLLM: LLMProvider,
    notifier: Notifier,            // NoopTelegramNotifier
    clock: FixedClock,
    marketData: MarketDataFetcher,
    indicatorCalc: IndicatorCalculator,
    chartRenderer: ChartRenderer,
    promptBuilder: PromptBuilder,
  }) {}

  async step(sessionId: string, count: number): Promise<StepResult>
}
```

`step()` retourne tous les nouveaux events produits par la fenêtre [oldPlayhead, newPlayhead], le coût LLM cumulé, et le nouveau status.

---

## 6. Mécanisme de stepping

### Une bougie à la fois

À chaque step (count=1) :

1. **Compute scalars** sur la fenêtre `[windowStart, currentPlayhead+1]` via `IndicatorCalculator`.
2. **Render chart PNG** sur cette même fenêtre. Stocké dans `/tmp/replay-charts/{sessionId}/{playheadIso}.png` (purgé à la suppression de la session).
3. **Detector call** (toujours appelé, même si plus tôt il y a eu un setup).
   - Si `new_setup` proposé → INSERT replay_setups, INSERT replay_event(SetupCreated).
   - Si `corroborations[]` sur des setups vivants → applyVerdict, INSERT replay_event(Strengthened).
   - Si `ignore_reason` → INSERT replay_event(DetectorTickProcessed) avec le reason.
4. **Reviewer call** pour chaque replay_setup en status `REVIEWING` (NB : on appelle le Reviewer **uniquement si le Detector n'a pas déjà émis une corroboration sur ce setup au même tick** — sinon double-comptage).
5. **Finalizer call** pour chaque replay_setup dont le score atteint `score_threshold_finalizer`. Si GO → INSERT EntryFilled à `entry_price = close de la bougie courante`. Si NO_GO → INSERT Rejected, status REJECTED.
6. **Tracking simulation** pour chaque replay_setup en status `TRACKING` :
   - `LONG` : si `bougie.high >= TP[i]` → TPHit ; si `bougie.low <= currentSL` → SLHit.
   - `SHORT` : symétrique.
   - Si TP1 hit pour la première fois → TrailingMoved (SL → entry_price).
   - Si SLHit ou TP_final_hit → close (status CLOSED).
7. **Advance playhead** d'1 bougie de timeframe.
8. **Update session** : current_playhead_at, cost_usd_so_far.
9. **If playhead == window_end** : status → COMPLETED.

### Step multiple (count > 1)

Boucle interne qui répète les étapes 1-8 pour chaque bougie. Streamé en SSE pour les counts > 5.

### Auto-step

Mode où le frontend appelle `step?count=1` à intervalle régulier (1s/2s/5s configurable). L'utilisateur peut pause à tout moment. Pas de cron côté backend — c'est le frontend qui drive.

### Cas d'erreur

- LLM rate-limited / timeout → l'event courant n'est pas persisté, le step retourne 503, le user re-clique. Le cache LLM garantit qu'on ne paie pas la portion déjà accomplie.
- Cost cap atteint avant la fin du `count` → on persiste tout ce qui a été fait jusqu'au cap, status → COST_CAPPED, retour 402 avec les events partiels.
- Crash inattendu (ex: prompt build error) → status → FAILED, failure_reason rempli.

Tous ces cas sont **reprenables** : le user augmente le cap / fixe le bug, et un nouveau step continue depuis `current_playhead_at`.

---

## 7. Endpoints API

Tous sous `/api/replay/*`. Auth/role inchangés (le projet n'a pas d'auth utilisateur multi-tenant, single user trusted).

| Méthode | Path | Description |
|---|---|---|
| GET | `/api/replay/sessions` | Liste des sessions, sortées par `created_at DESC`. Filtres optionnels : `?watchId=`, `?status=`. |
| POST | `/api/replay/sessions` | Crée une session. Body : `{ watchId, name?, windowStartAt, windowEndAt, costCapUsd?, configOverrides? }`. Snapshot la config watch. Retourne `{ id, ... }`. |
| GET | `/api/replay/sessions/:id` | Détail session : metadata + window + status + costSoFar. |
| GET | `/api/replay/sessions/:id/events` | Tous les replay_events de la session, sortés par sequence. Inclut le payload complet pour rendu (LLM reasoning, telegram_preview). |
| GET | `/api/replay/sessions/:id/setups` | Tous les replay_setups de la session. |
| GET | `/api/replay/sessions/:id/llm-calls` | Audit des LLM calls (pour le breakdown coût). |
| GET | `/api/replay/sessions/:id/ohlcv` | OHLCV de la fenêtre. Frontend utilise ça pour render le chart. |
| POST | `/api/replay/sessions/:id/step` | Body : `{ count: 1 }`. Avance la pipeline. Retourne `{ newEvents: [...], playheadAt, costUsdSoFar, status }`. |
| POST | `/api/replay/sessions/:id/pause` | status RUNNING → PAUSED. Idempotent. |
| POST | `/api/replay/sessions/:id/resume` | status PAUSED → RUNNING. |
| DELETE | `/api/replay/sessions/:id` | Cascade delete. |

**Pas d'endpoint pour modifier le `config_snapshot` après création** : une session est immutable côté config. Si tu veux tester une autre config, tu crées une nouvelle session.

---

## 8. Frontend

### Routes

```
/replay                  → liste de sessions + bouton "Nouvelle session"
/replay/:sessionId       → la session (chart + step controls + decisions log)
```

Lazy-loaded via `react-router-dom` à la sauce du projet (`src/client/frontend.tsx:18-29`).

### Page `/replay` (liste)

- Header `Replay sessions` + bouton `[+ Nouvelle session]`.
- Liste de sessions sous forme de cards avec : nom, watch, période, status (badge couleur), coût, # events, date.
- Filtres : par watch (Select), par status (pills).
- Click sur card → `/replay/:id`.
- Action contextuelle : `[Reprendre]` si paused/cost_capped, `[Supprimer]` (avec confirm).

### Modal "Nouvelle session"

Champs :
- `watchId` (Select des watches enabled).
- `name` (Input, optionnel).
- `windowStartAt`, `windowEndAt` (date pickers, default = 7 derniers jours).
- `costCapUsd` (Input number, default 5).
- (Hors scope v1, prévu comme évolution future) : section "Avancé" pour overrider prompts/modèles/seuils/indicateurs.

À la validation : POST `/api/replay/sessions`, redirect → `/replay/:id`.

### Page `/replay/:sessionId`

Layout 3 zones :

**Zone 1 — Header** : nom session, watch, status, playhead position, coût.

**Zone 2 — Chart (gauche, 2/3)** :
- `lightweight-charts` v5.
- Bougies `[windowStart, currentPlayhead]` opaques (ce que le bot voit).
- Bougies `]currentPlayhead, windowEnd]` semi-transparentes (le futur, visible à l'humain seulement).
- Markers via `createSeriesMarkers` :
  - Detector tick (cercle gris si ignore, cercle coloré si setup created).
  - Reviewer event (carré : vert STRENGTHEN, rouge WEAKEN, gris NEUTRAL).
  - Confirmed (arrowUp vert si LONG, arrowDown rouge si SHORT).
  - TP hits (✓ vert).
  - SL hit (✕ rouge).
  - Invalidated (∅ orange).
- `createPriceLine` pour entry/SL/TP des setups vivants.
- Multi-pane (`addPane`) pour RSI / MACD sous les bougies.
- Click sur un marker → focus l'event correspondant dans la zone 3.

**Zone 3 — Decisions panel (droite, 1/3)** :
- **Phase courante** (en haut) : pour le dernier event ajouté, affiche :
  - Le stage (Detector/Reviewer/Finalizer/Tracker).
  - Le verdict / type d'event.
  - Le reasoning textuel du LLM.
  - L'input snapshot (collapsible : prompt complet, scalars, image SHA).
  - Le telegram preview (`(NEUTRALISÉ)` en grisé).
  - Le coût + cache hit/miss.
- **Decisions log** (en bas, scrollable) : tous les events de la session par ordre chronologique. Click sur un event → remonte dans la phase courante.

**Zone 4 — Step controls (sous le chart)** :
- `[⏮]` reset à window_start (avec confirm).
- `[Step 1]` step count=1.
- `[Step 5]`, `[Step 10]` pour avancer rapidement.
- `[▶ Auto]` toggle auto-step à intervalle (slider 1s/2s/5s).
- `[⏸ Pause]` pendant auto-step.
- Progress bar : `currentPlayhead / windowEnd`.
- Coût cumulé : `$X.XX / $cap`.

### Composants à créer

```
src/client/routes/
├── replay.tsx              # /replay (liste)
└── replay-session.tsx      # /replay/:id

src/client/components/replay/
├── replay-session-card.tsx
├── new-session-modal.tsx
├── replay-chart.tsx        # wrapper TVChart with markers + transparency
├── replay-controls.tsx     # step buttons + auto-step
├── decisions-panel.tsx     # current phase + log
├── current-phase-card.tsx  # detail of latest event
├── decisions-log.tsx       # chronological list
├── telegram-preview.tsx    # neutralized telegram message rendering
└── replay-marker-config.ts # mapping event type → marker shape/color
```

### State management

- React Query pour les fetches REST (`/api/replay/*`).
- `useReplayStepper(sessionId)` hook custom qui encapsule :
  - `step(count)` → POST step + invalidate queries.
  - `auto-step` interval.
  - `pause/resume`.
- SSE optionnel pour streamer les events pendant un step long (count >= 5).

---

## 9. Coût LLM, cache, garde-fous

### Estimation pré-création

À l'ouverture du modal "Nouvelle session", on calcule une estimation basée sur :
- Nb bougies dans la fenêtre (`(windowEnd − windowStart) / timeframe.primary`).
- Coût moyen par stage (calibré sur `llm_calls` historiques de la watch).
- Hypothèse : 1 setup par 10 ticks Detector, 5 Reviewer ticks par setup, 0.3 Finalizer call par setup.

Affiché dans le modal : `Estimation : ~$0.42 (avec cache: $0.05 si déjà joué)`.

### Cache LLM mutualisé

Le `llm_response_cache` est partagé entre toutes les sessions. Donc :
- Première session sur une fenêtre : paie tout.
- Deuxième session avec **mêmes prompts** sur la même fenêtre : 100% cache hit, $0.
- Deuxième session avec **un prompt modifié** : seul l'étage modifié recompute, les autres sont en cache.

Le `inputHash` doit donc inclure :
- `provider`
- `model`
- `prompt_version` + sha256 du système prompt
- `prompt_user_text` (le résultat du Handlebars render)
- `image_sha256` (du chart PNG)

Comme le chart PNG dépend de `lightweight-charts` config, on doit fixer la version de chart rendering (un changement futur de chart aurait un nouveau hash → invalide le cache automatiquement).

### Cost cap obligatoire

- Default $5 par session (adjustable au create-time).
- Vérifié AVANT chaque LLM call (anticipation : si `cost_so_far + max_cost_call > cap`, on n'appelle pas).
- Si atteint mid-step : status → COST_CAPPED, retour 402, events partiels persistés.

### Telemetry

Page `/replay/:id` affiche en permanence :
- `cost_usd_so_far / cost_cap_usd`.
- Breakdown par stage (Detector / Reviewer / Finalizer).
- Cache hit rate (% des calls servis par cache).

---

## 10. Isolation & invariants de sécurité

Ces invariants sont **vérifiés par tests d'intégration** (voir §11).

### Invariant 1 : aucune écriture sur tables live

Les tables suivantes sont **interdites en écriture** depuis le code Replay :
- `setups`, `events`, `tick_snapshots`, `llm_calls`, `lessons`, `lesson_events`, `watch_states`, `watch_configs`, `watch_config_revisions`, `artifacts`.

**Mécanisme** : les adapters `ReplayEventStore`, etc. utilisent une instance `db` injectée. Le service `ReplaySessionService` n'a accès qu'à un `db` filtré (en pratique : on injecte la même `db` mais on relie les ports aux adapters Replay). La séparation est par **type** (les ports `LiveEventStore` vs `ReplayEventStore` sont distincts), pas par config DB.

### Invariant 2 : aucun appel Telegram

Le `ReplayStepper` reçoit un `Notifier` qui est forcément un `NoopTelegramNotifier`. Il n'a **pas accès** au constructeur de `TelegramNotifier` (DI pure).

### Invariant 3 : aucun workflow Temporal démarré

Le `ReplayStepper` n'a pas accès au `TemporalClient`. Donc impossible de démarrer un `SetupWorkflow`, un `TrackingLoop`, ou un `PriceMonitor`. Le tracking est simulé in-process dans le step.

### Invariant 4 : `current_playhead_at <= window_end_at`

Contrainte SQL CHECK + validation domain dans `ReplaySessionService.applyStep`.

### Invariant 5 : `cost_usd_so_far <= cost_cap_usd` à tout moment où status ≠ COST_CAPPED

Vérifié avant chaque LLM call. La transition `RUNNING → COST_CAPPED` se fait dans la même transaction que l'INSERT du dernier event qui dépasse le cap.

### Invariant 6 : suppression d'une watch ne casse pas les sessions

`replay_sessions.watch_id` est un `text` sans FK. Les sessions héritent du `config_snapshot` au create-time, donc elles peuvent revivre une watch supprimée. La page `/replay/:id` affiche un badge "Watch supprimée" si la watch n'existe plus.

---

## 11. Stratégie de tests

### Domain pure (`test/domain/replay/`)

- `ReplaySessionService` :
  - Création avec window valide.
  - Refus si `window_end <= window_start`.
  - Transition RUNNING → COST_CAPPED.
  - `canStep` retourne false si COMPLETED / FAILED.
  - `applyStep` advance correctement.

- Tests d'isolation logique (sans DB) sur le `inputHash` du `CachedLLMProvider` :
  - Hash stable si mêmes inputs.
  - Hash change si image change.
  - Hash change si prompt_version change.

### Adapters (`test/adapters/replay/`)

- `ReplayEventStore` (testcontainers Postgres) :
  - Insert event scopé par `session_id`.
  - Sequence monotonique.
  - Cascade delete fonctionne.

- `NoopTelegramNotifier` :
  - Capture le message.
  - Ne fait pas d'appel HTTP (vérifié via `nock` ou injection de fake fetch).

- `CachedLLMProvider` :
  - Cache miss → appelle `inner.call`.
  - Cache hit → retourne sans appeler.
  - Met à jour `last_used_at` et `hit_count`.
  - Coût = 0 sur hit.

- `FixedClock` :
  - `now()` retourne la valeur fixée.
  - `advance` fonctionne.

### Intégration (`test/integration/replay/`)

- Création de session → première step → vérifier qu'aucun row n'apparaît dans `setups`/`events`/`llm_calls` live.
- Step entier sur fenêtre 5 bougies avec un fake LLM provider qui retourne des verdicts contrôlés. Vérifier la séquence d'events produite.
- Cost cap : configurer cap = $0.10, mock LLM à $0.05 par call, vérifier que la 3e call passe en COST_CAPPED.
- Reprise après pause : pause à T+3, resume, step jusqu'à T+5, vérifier sequence continue.

### Frontend (`test/client/frontend/components/replay/`)

- `ReplayChart` : transparence appliquée correctement aux bougies post-playhead.
- `DecisionsLog` : événements ordonnés par sequence, click → focus.
- `NewSessionModal` : validation window, cost estimation affichée.
- `useReplayStepper` hook : auto-step pause/resume.

### E2E (`test/e2e/replay/` — RUN_E2E=1)

- Crée une watch, force un setup en live, ouvre `/replay`, crée une session sur la fenêtre du setup, step jusqu'à la fin, vérifie que les events live n'ont pas été modifiés.

### Smoke LLM (`test/llm/replay-smoke.test.ts` — RUN_LLM_CLAUDE=1)

- Une session minimale (3 bougies) avec vraie API Claude. Vérifie le pipeline complet + le cache (re-run = $0).

---

## 12. Plan de phases & déploiement

Le produit cible est **la rétro-exécution interactive** décrite au préambule. On la livre en deux jalons pour réduire le risque et profiter de la valeur d'une UI fonctionnelle dès le premier jalon.

### Jalon 1 — Squelette navigable (3-4 jours, gratuit)

Objectif : la page `/replay` est en ligne, on peut créer une session sur une fenêtre passée et **naviguer dans les events des setups qui ont déjà tourné en prod** sur cette fenêtre. Le bouton "Step" est encore désactivé (pas de re-exécution LLM), mais toute la mécanique UI est là : chart, scrubber, decisions log, transparence des bougies futures.

Livrables :

- Migration 0015 : 5 tables `replay_*` + `llm_response_cache`.
- Domain : `ReplaySession` entity + `ReplaySessionService` (creation, validation).
- Endpoints `/api/replay/sessions` (list/create/get/delete) + `/api/replay/sessions/:id/events|setups|ohlcv`.
- À la création d'une session, on **copie une fois** dans `replay_events` les events live de la fenêtre demandée (lecture sur `events`, écriture sur `replay_events`). Cette copie sert de baseline avant que le Jalon 2 ajoute le step.
- Pages `/replay` (liste + bouton créer) et `/replay/:id` (chart + scrubber + log).
- Tests : domain, adapters (testcontainers), frontend (composants).

Ce qui n'est pas encore là : step interactif, LLM calls, telegram preview, cost cap.

### Jalon 2 — Rétro-exécution interactive (1-2 semaines, payant cheap)

Objectif : la session devient **active**. Le bouton "Step" appelle réellement Detector / Reviewer / Finalizer sur la bougie courante via les adapters neutralisés, et écrit les events produits dans `replay_events`.

Livrables :

- Adapters : `CachedLLMProvider`, `NoopTelegramNotifier`, `ReplayEventStore`, `ReplaySetupRepository`, `ReplayLLMCallStore`, `FixedClock`.
- Domain : `ReplayStepper` (orchestrateur in-process, voir §3 et §6).
- Endpoint `/api/replay/sessions/:id/step`.
- Cache LLM `llm_response_cache` + lookup par `inputHash`.
- Cost cap (vérifié avant chaque LLM call) + estimation pré-création.
- UI : step controls, current-phase card, telegram preview, breakdown coût.
- Tests : intégration cost cap, isolation tables live, smoke LLM (RUN_LLM_CLAUDE=1).

À l'issue du Jalon 2, le produit cible est livré.

### Évolutions post-v1 (optionnelles, déclenchées par usage réel)

- **Override de config dans le modal** : choisir un prompt alternatif (v3 vs v4), un autre modèle, un seuil différent, désactiver un indicateur. Permet de tester une variation sans modifier le repo.
- **Comparaison de sessions** : page `/replay/compare?a=...&b=...` superposant deux sessions sur la même fenêtre (mêmes bougies, configs différentes).

Aucun engagement de planning sur ces évolutions — on les considère seulement si l'usage réel des Jalons 1+2 fait apparaître le besoin.

### Migration / déploiement

- Aucune modification des tables live.
- Aucune modification des workflows existants.
- Aucune env var nouvelle pour la prod (les variables Replay sont locales à tf-web).
- La migration 0015 est idempotente (CREATE TABLE IF NOT EXISTS).
- Rollback : `DROP TABLE replay_*; DROP TABLE llm_response_cache;` — aucun impact sur la prod.

---

## 13. Extensibilité

Points d'extension prévus (architecture le permet, code v1 ne les implémente pas) :

1. **Nouvelles brique pipeline** : si demain on ajoute un `RiskFilter` après le Finalizer, le Replay l'invoque automatiquement (DI). Aucun code Replay à modifier.

2. **Sources de données alternatives** : si on ajoute un futur `OnChainDataFetcher` au `MarketDataFetcher`, le replay l'utilise via injection. Aucun changement de schéma.

3. **Replay multi-watch** : aujourd'hui une session = une watch. Pour comparer deux watches sur la même période → deux sessions. v2 pourrait introduire un mode "groupé".

4. **Replay continu** : un cron qui lance des replays automatiques sur les 7 derniers jours quotidiennement pour détecter des régressions de prompts. Reposerait sur la même API.

5. **Export d'une session** : JSON/CSV pour analyse externe. Endpoint `/api/replay/sessions/:id/export`.

---

## 14. Décisions consciemment écartées (out-of-scope v1)

- **Multi-tenant / permissions** : single user trusted, comme le reste du projet.
- **Auto-trigger sur événement** (e.g. après une perte en prod, déclencher automatiquement un replay) : pas v1. C'est un outil R&D manuel, pas un monitoring.
- **Cron / planification** : aucun replay automatique récurrent.
- **Walk-forward optimization** : pas notre but. Le replay observe, il n'optimise pas.
- **Comparaison automatique de sessions** : possible évolution post-v1, pas v1.
- **Override de prompt / config dans l'UI** : possible évolution post-v1. v1 utilise la config réelle de la watch (snapshot au create-time). Tester un autre prompt = créer un nouveau prompt versionné dans le repo et lancer une nouvelle session.
- **Editeur de prompt inline** dans l'UI replay : non. Les prompts vivent dans `prompts/*.hbs`, versionnés par git.
- **Streaming SSE des events pendant un step** : v1 = HTTP simple synchrone. SSE possible plus tard si latence devient gênante sur des steps multiples.
- **Replay sur un setup live actif** : interdit. Une session ne peut pas être créée sur une fenêtre incluant `now()`. Validation au create-time.
- **Cross-watch session** : une session = une watch. Pour comparer deux watches → deux sessions.
- **Modification du `config_snapshot` post-création** : interdit. Une session est immutable côté config. Changement = nouvelle session.
- **Notification de fin de session** : pas v1. Les sessions sont courtes (typiquement 24-100 bougies, soit 2-15 min de step actif), l'utilisateur est devant l'écran.
- **Métriques agrégées sur la session** (Sharpe, profit factor, etc.) : pas v1. Le replay produit une trace observable, pas un chiffre d'optimisation. Si le besoin émerge, l'API `/performance` existante peut être étendue pour lire `replay_*`.

---

## 15. Glossaire

| Terme | Définition |
|---|---|
| **Session de replay** | Une instance de rétro-exécution sur une fenêtre temporelle, persistée dans `replay_sessions`. |
| **Playhead** | Le timestamp courant de simulation. Toutes les bougies `<= playhead` sont visibles au bot ; les autres sont cachées. |
| **Step** | Une avance du playhead d'une bougie (ou plus), exécutant la pipeline pour cette/ces bougies. |
| **Window** | La période `[window_start_at, window_end_at]` sur laquelle se déroule le replay. |
| **Side-effects neutralisés** | Tous les effets externes (Telegram, écriture sur tables live, démarrage de workflows) sont désactivés en mode replay. |
| **Telegram preview** | Le message qui *aurait* été envoyé par le notifier en prod, capturé pour affichage dans l'UI. |
| **Cost cap** | Plafond de coût LLM par session. Atteint = session passe en COST_CAPPED. |
| **`inputHash`** | SHA-256 de (provider, model, prompt_version, prompt rendu, image SHA). Clé du cache LLM. |
| **Jalon 1 / Jalon 2** | Découpage de la livraison v1. Jalon 1 = squelette navigable (UI + lecture des events live d'une fenêtre passée). Jalon 2 = step interactif qui appelle réellement la pipeline LLM. |
| **Rétro-exécution contrôlée** | Synonyme du Replay Mode. Désigne la nature step-by-step, manuelle, contrôlée par l'utilisateur, de l'exécution de la pipeline sur des bougies passées. |
| **Side-effect neutralisé** | Un effet externe normalement présent en prod (Telegram, écriture sur tables live, démarrage de workflows Temporal) qui est explicitement désactivé en replay via injection d'un adapter substitué. |
