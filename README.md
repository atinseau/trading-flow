# Trading Flow

Bot d'analyse de trading multi-actif / multi-timeframe orchestré par Temporal, avec
pipeline LLM en 3 phases (Detector → Reviewer → Finalizer), scoring bidirectionnel,
feedback loop qui apprend des trades perdants, et **replay mode** offline pour
itérer sur les prompts sans payer Claude deux fois la même analyse.

---

## Vue d'ensemble

À chaque tick (cron aligné sur la fermeture de bougie, configurable par watch) :

1. **Detector** (vision LLM, opus/sonnet-class) — observe le chart + indicateurs et
   produit un verdict structuré contenant : `new_setups[]` (patterns frais) +
   `corroborations[]` pour les setups vivants. Chaque corroboration porte un
   `confidence_delta_suggested ∈ [-20, 20]` **signé** : positif renforce le setup
   (event `Strengthened`), négatif l'affaiblit (event `Weakened`, source
   `detector_decorroboration`). Le détecteur peut aussi rester silencieux sur un
   setup — c'est le signal "rien de neuf".

2. **Reviewer** (haiku/sonnet-class) — pour chaque setup vivant non corroboré
   par le détecteur ce tick (configurable via `optimization.reviewer_skip_when_detector_corroborated`,
   `false` par défaut), refait une évaluation indépendante : `STRENGTHEN |
   WEAKEN | NEUTRAL | INVALIDATE`. Le reviewer peut moduler le score dans les
   deux sens, mettre à jour le niveau d'invalidation, ou clore le setup.

3. **Finalizer** (opus-class) — déclenché quand le score franchit
   `score_threshold_finalizer`. Émet `Confirmed` (GO, avec entry/SL/TP) ou
   `Rejected` (NO_GO). Une option `allow_same_tick_fast_path` (par défaut `true`)
   permet au détecteur de court-circuiter le reviewer si
   `expected_maturation_ticks === 1` ET `initial_score ≥ threshold`.

4. **Tracking** (post-GO) — un `priceMonitorWorkflow` mutualisé par symbole
   pousse des signaux `priceCheck` vers le setup workflow. Le `trackingLoop`
   détecte TP/SL hits, déplace le SL au break-even après TP1, et invalide
   en cas de breach post-trade.

Tout est event-sourcé en Postgres (table `events` pour live, `replay_events`
pour replay). Le score d'un setup est la **somme cumulée** des `score_delta`
de tous ses events. Les workflows Temporal sont déterministes (replayable).
Les prompts sont versionnés (Handlebars) — bumper la version invalide le cache
LLM.

### Feedback loop (apprentissage rétroactif)

Quand un trade confirmé se ferme défavorablement (SL hit direct, SL après TP1
trailé, ou prix qui casse l'invalidation), le `feedbackLoopWorkflow` se
déclenche automatiquement comme **child workflow** (avec
`ParentClosePolicy.ABANDON` — le setup workflow peut terminer pendant que la
feedback analysis tourne) :

1. **Context gathering** — 4 providers canoniques (`setup-events`,
   `tick-snapshots`, `post-mortem-ohlcv`, `chart-post-mortem`). Désactivables
   par watch via `feedback.context_providers_disabled`.
2. **LLM analysis** — opus-class. Idempotent : `inputHash` court-circuite si
   déjà calculé. Produit des `LessonAction[]` : `CREATE`, `REINFORCE`, `REFINE`
   (supersedes l'ancienne), `DEPRECATE`.
3. **Apply** — `validateActions` enforce le cap par catégorie
   (`max_active_lessons_per_category`, défaut 30), refuse de déprécier une
   leçon `pinned`, etc. Les `CREATE`/`REFINE` arrivent en statut `PENDING` et
   sont notifiées via Telegram avec boutons inline ✅/❌. `REINFORCE` et
   `DEPRECATE` s'appliquent immédiatement (audit dans `lesson_events`).

Le pool de leçons est **scopé par watch**. Catégories : `detecting`,
`reviewing`, `finalizing` — chacune injectée dans le prompt correspondant via
les flags `feedback.injection.{detector,reviewer,finalizer}` (tous `true`
par défaut).

Voir [`docs/superpowers/specs/2026-04-29-feedback-loop-design.md`](docs/superpowers/specs/2026-04-29-feedback-loop-design.md).

### Replay mode (itération offline)

Le `/replay` permet de réexécuter le pipeline complet sur une fenêtre
temporelle passée, à un rythme contrôlé par l'utilisateur (Step / Pause /
Resume / Auto), avec un cache LLM mutualisé entre sessions. Cas d'usage :

- Itérer sur un prompt sans payer N fois la même analyse.
- Diagnostiquer un setup mort en SL : voir tick-par-tick ce que chaque LLM
  a "vu".
- Comparer "current prompts" vs "historical prompts" sur le même setup.

La première analyse d'un tick paie Claude (~$0.20-0.30) ; les replays suivants
hit le `llm_response_cache` (clé : `input_hash` + `provider` + `model` +
`promptVersion`) et coûtent **$0**. Voir [§ Replay mode](#replay-mode).

---

## Cycle de vie d'un setup

```
                   detector
                      │
                      ▼
                  CANDIDATE
                      │
                      ▼ SetupCreated
                  REVIEWING ◀────────────────────────────────┐
                      │                                       │
       ┌──────────────┼──────────────────────┐                │
       │              │                      │                │
       │ score ≥ 80   │ priceCheck           │ TTL expired   │ corroborate /
       ▼              │ (breach)             ▼                │ review
   FINALIZING         │                  EXPIRED              │
       │              ▼                                       │
       │          INVALIDATED                                 │
       │                                                      │
       ▼ finalizer GO / NO_GO                                 │
       │                                                      │
   ┌───┴───┐                                                  │
   │       │                                                  │
   GO     NO_GO                                               │
   │       │                                                  │
   ▼       ▼                                                  │
TRACKING  REJECTED                                            │
   │
   │ trackingLoop : priceCheck signals
   │
   ├─ TP1 hit → SL → entry (breakeven), trail to TPn
   ├─ SL hit → CLOSED
   ├─ invalidation breach → INVALIDATED
   └─ all TPs hit → CLOSED

kill button (Telegram or UI) at any active state → KILLED
```

États (`src/domain/state-machine/setupTransitions.ts`) :

- **Actifs** : `CANDIDATE`, `REVIEWING`, `FINALIZING`, `TRACKING`
- **Terminaux** : `CLOSED`, `INVALIDATED`, `EXPIRED`, `REJECTED`, `KILLED`

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│   ┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌────────────┐   │
│   │  scheduler  │   │  analysis    │   │ notification │   │  tf-web    │   │
│   │  worker     │   │  worker      │   │  worker      │   │  :8084     │   │
│   │  :8081      │   │  :8082       │   │  :8083       │   │            │   │
│   │             │   │              │   │              │   │  React SPA │   │
│   │  scheduler  │   │  TWO workers │   │  Outbound    │   │  +         │   │
│   │  workflow   │   │  in 1 proc : │   │  Telegram +  │   │  REST API  │   │
│   │             │   │              │   │  grammy bot  │   │  +         │   │
│   │  price-     │   │  • analysis  │   │  (inline btn │   │  SSE       │   │
│   │  monitor    │   │    queue     │   │   callbacks) │   │  stream    │   │
│   │             │   │  • replay    │   │              │   │            │   │
│   │  market-    │   │    queue     │   │              │   │            │   │
│   │  clock      │   │              │   │              │   │            │   │
│   │             │   │  setup +     │   │              │   │            │   │
│   │  Detector   │   │  feedback +  │   │              │   │            │   │
│   │  LLM        │   │  replay LLM  │   │              │   │            │   │
│   │             │   │  (reviewer,  │   │              │   │            │   │
│   │             │   │   finalizer) │   │              │   │            │   │
│   └─────┬───────┘   └──────┬───────┘   └──────┬───────┘   └─────┬──────┘   │
│         │                  │                  │                 │          │
│         └──────────────────┴──────────────────┴─────────────────┘          │
│                                     │                                       │
│         ┌───────────────────────────┴─────────────────────┐                 │
│         ▼                                                 ▼                 │
│   ┌───────────┐                                     ┌───────────┐           │
│   │ Temporal  │                                     │ Postgres  │           │
│   │  :7233    │                                     │  :5432    │           │
│   │           │                                     │           │           │
│   │ 4 task    │                                     │ 14 tables │           │
│   │ queues    │                                     │ Drizzle   │           │
│   └───────────┘                                     └───────────┘           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

| Service | Container | Rôle | Task queue(s) | Health |
|---|---|---|---|---|
| **scheduler-worker** | `tf-scheduler-worker` | Héberge `schedulerWorkflow` (un par watch), `priceMonitorWorkflow` (un par symbole), `marketClockWorkflow` (un par session de marché). Exécute l'activité `runDetector`. Lance Chromium pour le chart rendering. | `scheduler` | `:8081/health` |
| **analysis-worker** | `tf-analysis-worker` | **2 `Worker.create()` dans un seul process** : (a) queue `analysis` bundle `setupWorkflow.ts` + activités setup/feedback ; (b) queue `replay` bundle `replaySessionWorkflow.ts` + activités replay-scopées. | `analysis` + `replay` | `:8082/health` |
| **notification-worker** | `tf-notification-worker` | Polle `notifications` pour les envois Telegram outbound. Héberge **aussi** un long-poll grammy `Bot` pour les inline-button callbacks (kill setup, approve/reject leçon). | `notifications` | `:8083/health` |
| **tf-web** | `tf-web` | Bun.serve : React SPA + REST API + SSE stream. Source de vérité pour les configs watches (table `watch_configs`). Polle Postgres et broadcast les changements via `/api/stream`. | — | `:8084/health` |
| **migrate** | `tf-migrate` (one-shot) | `bun run src/cli/migrate.ts` au boot. Idempotent. | — | — |
| **bootstrap-schedules** | `tf-bootstrap-schedules` (one-shot) | Crée les Temporal Schedules + `schedulerWorkflow` + `marketClockWorkflow` pour chaque watch DB activée. | — | — |

Plus : `tf-postgres` (Postgres 16-alpine), `tf-temporal` (Temporal 1.27 autosetup), `tf-temporal-ui`.

---

## Stack technique

- **Runtime** : Bun ≥ 1.3 (TypeScript strict, ESM natif, `Bun.serve` en backend)
- **Orchestration** : Temporal (4 task queues : `scheduler`, `analysis`, `notifications`, `replay`)
- **DB** : Postgres 16 + Drizzle ORM (14 tables, 16 migrations, schema dans
  `src/adapters/persistence/schema.ts`)
- **LLM** : `claude_max` (via `@anthropic-ai/claude-agent-sdk`, OAuth token long-lived)
  avec fallback automatique vers `openrouter` (clé API). Graph de fallback validé
  au boot par `validateProviderGraph`.
- **Prompts** : Handlebars (`prompts/*.md.hbs` + `*.system.md`), versionnés
  par rôle. Versions actuelles : `detector_v6`, `reviewer_v6`, `finalizer_v4`,
  `feedback_v1`.
- **Indicators** : 10 plugins modulaires
  (`src/adapters/indicators/plugins/{ema_stack,vwap,bollinger,rsi,macd,atr,volume,swings_bos,structure_levels,liquidity_pools}`).
  Calculs en pur JS via `PureJsIndicatorCalculator`. Chaque plugin contribue à
  la prompt + au chart rendering.
- **Charting** : `lightweight-charts` (TradingView) côté UI + Playwright
  headless Chromium côté worker pour le rendering inclus dans les prompts.
- **Market data** : `BinanceFetcher` (REST kline + WS price feed) /
  `YahooFinanceFetcher` (REST chart API + polling price feed).
- **Notifications** : `grammy` pour Telegram (envois sortants + handler de
  callback_query pour les inline buttons).
- **Frontend** : React 19 + React-Router + Tanstack Query + Radix UI + Tailwind 4
  + `lightweight-charts`. ~16 routes (`src/client/frontend.tsx`).
- **Tests** : `bun test` natif. 4 niveaux : `test/domain` (pur), `test/adapters`
  (testcontainers Postgres), `test/workflows` (`@temporalio/testing`),
  `test/e2e` (docker compose réel, `RUN_E2E=1`).
- **CI / quality** : Biome (formatter + linter + import restrictions).

---

## Prérequis

- **Bun ≥ 1.3** (`curl -fsSL https://bun.sh/install | bash`)
- **Docker** ≥ 24 + Docker Compose v2
- **Telegram bot** (`@BotFather`) + ton `chat_id` (envoie un message au bot,
  visite `https://api.telegram.org/bot<TOKEN>/getUpdates`)
- **Une clé d'accès LLM** au choix :
  - `CLAUDE_CODE_OAUTH_TOKEN` (recommandé) — généré automatiquement par
    `scripts/dev/bootstrap-claude-token.sh` au premier `bun run compose:dev`.
    Tourne dans un container interactif qui lance `claude setup-token`. **NE
    PAS** confondre avec `ANTHROPIC_API_KEY` (qui n'est utilisé QUE par
    `test/llm/claudeSmoke.test.ts`, jamais en runtime).
  - `OPENROUTER_API_KEY` (optionnel — pris en fallback si `claude_max` rate-limit).

---

## Démarrage — dev

```sh
git clone <repo> trading-flow
cd trading-flow
bun install

# Configurer .env
cp .env.example .env
# Édite : POSTGRES_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# Laisse CLAUDE_CODE_OAUTH_TOKEN vide — il sera bootstrappé.

# Démarre tout (postgres + temporal + 4 workers + tf-web)
bun run compose:dev
```

⚠️ **`bun run compose:dev`** (PAS `docker compose up -d`) : le fichier
`docker-compose.yml` de base est volontairement Coolify-friendly et n'expose
AUCUN port à l'hôte. C'est l'overlay `docker-compose-dev.yaml` qui publie
5432 / 7233 / 8080 / 8081-8084 sur `127.0.0.1`, et `compose:dev` qui le
charge. Le script lance aussi `scripts/dev/bootstrap-claude-token.sh` en
hook `precompose:dev` pour générer le token Claude si nécessaire.

Une fois la stack up (~30s) :

1. **Crée ta première watch** : `http://localhost:8084/watches/new`. Wizard
   en 7 étapes (asset / indicators / schedule / lifecycle / analyzers /
   notifs+budget / advanced). Le submit insère la row `watch_configs` ; le
   prochain reload de la stack (ou un hot-reload via `applyReload` signal)
   crée le Schedule Temporal.

2. **Force un premier tick** (sans attendre le cron) :
   - Via UI : `/watches/:id` → bouton "Force tick"
   - Via CLI : `bun run src/cli/force-tick.ts <watch-id>`

3. **Observe** :
   - Setups : `http://localhost:8084/setups`
   - Events live : `http://localhost:8084/live-events`
   - Performance : `http://localhost:8084/performance`
   - Temporal UI : `http://localhost:8080`

### Commandes Docker utiles

```sh
bun run compose:dev        # Up avec overlay dev (binds ports + bind-mount src pour tf-web)
bun run compose:sync       # Restart tf-web seul (utile après édition .env)
bun run compose:down       # Down sans toucher aux volumes
bun run compose:nuke       # Down -v : wipe Postgres + Temporal state (reset complet)

bun run logs:workers       # Tail scheduler + analysis + notification
bun run logs:web           # Tail tf-web
```

### Hot-reload — qui rebuild quoi

| Service | Trigger code change → effet |
|---|---|
| `tf-web` | Bind-mount `./src` + `bun --watch` → restart auto en quelques secondes |
| Workers | Image bakée → rebuild via `compose:dev` (ou `compose up -d --build <worker>`) |

---

## L'UI

16 routes (`src/client/frontend.tsx`) :

| Route | Page |
|---|---|
| `/` | Dashboard (watches actives, perf rapide) |
| `/watches`, `/watches/new`, `/watches/:id` | CRUD watches |
| `/setups`, `/setups/:id` | Liste + détail d'un setup (events, LLM calls, OHLCV) |
| `/lessons` | Pool de leçons (approve/reject/pin/archive) |
| `/live-events` | Stream SSE des events temps réel |
| `/performance` | Equity curve, R distribution, calibration, ROI bars |
| `/costs` | Aggregations LLM par provider/model/jour |
| `/replay`, `/replay/:id` | Replay mode (voir ci-dessous) |
| `/assets/:source/:symbol` | Recherche / création de watch depuis un asset |
| `/search` | Recherche globale |

---

## Replay mode

UI : `http://localhost:8084/replay`.

### Modèle

Un **replay session** = une fenêtre temporelle `[windowStartAt, windowEndAt]`
sur une watch existante, avec une cost cap durable. Création via
`POST /api/replay/sessions` ou via le bouton "Nouvelle session" de l'UI.
Une fois créée, la session est en statut `READY` mais aucun workflow n'a
encore tourné — c'est l'utilisateur qui drive le rythme.

Boutons UI :

- **Step 1** / **Step 5** — avance d'un (ou 5) candle. Envoie un signal
  `replayTick` au workflow.
- **Auto** — boucle Step toutes les ~800ms jusqu'à fin de fenêtre / cost cap / pause.
- **Pause** / **Reprendre** — gate le traitement workflow-side.
- **Scrubber** — déplace le playhead pour inspecter un moment précis.

Le chart est divisé en 3 séries :

1. **Lookback** (gris-bleu désaturé) — bougies avant `windowStartAt` (le
   contexte que la LLM voit mais qui n'est PAS dans la fenêtre choisie).
2. **Revealed** (couleurs pleines) — bougies entre `windowStartAt` et
   `playheadAt`. Ce que le bot a déjà scoré.
3. **Future** (transparent à 25%) — bougies entre `playheadAt` et
   `windowEndAt`. Visibles pour toi, invisibles pour le bot.

Un badge **« Raisonnement en cours… »** s'affiche pendant qu'une activité LLM
tourne (polling de `/api/replay/sessions/:id/workflow-state` sur la query
Temporal `getReplayState`). Les boutons Step se grisent tant que le workflow
n'a pas drainé.

### Isolation stricte

Le code replay (`src/workflows/replay/**`, `src/adapters/persistence/PostgresReplay*`)
**ne touche jamais** les tables live. Tables dédiées :

- `replay_sessions` — config + état + cost
- `replay_events` — event log scopé par session (FK CASCADE)
- `replay_llm_calls` — audit LLM scopé par session
- `llm_response_cache` — **partagé** entre toutes les sessions, content-addressable
  par `input_hash`. Le premier replay paie Claude, les suivants sont free.

Voir [`docs/superpowers/specs/2026-05-08-replay-mode-design.md`](docs/superpowers/specs/2026-05-08-replay-mode-design.md)
pour les 10 invariants d'isolation.

### Promote a lesson from replay

Quand le replay déclenche une feedback analysis et produit une proposition de
leçon (`FeedbackLessonProposed`), tu peux la promouvoir dans le pool live avec
le bouton "Promouvoir en prod" de la `FeedbackAnalysisCard`. Idempotent via
`inputHash = "replay-promote:{eventId}"`.

---

## API REST

Endpoints sous `/api/` (voir `src/client/server.ts:170-242` pour le mapping
complet). Quelques highlights :

| Domaine | Endpoints |
|---|---|
| **Watches** | `GET/POST /api/watches`, `GET/PUT/DELETE /api/watches/:id`, `GET /api/watches/:id/revisions` |
| **Setups** | `GET /api/setups` (filtrable), `GET /api/setups/:id`, `GET /api/setups/:id/{events,llm-calls,ohlcv}` |
| **Admin / Ops** | `POST /api/watches/:id/force-tick`, `POST /api/watches/:id/{pause,resume}`, `POST /api/setups/:id/kill` |
| **Lessons** | `GET /api/lessons`, `GET /api/watches/:id/lessons`, `POST /api/lessons/:id/{approve,reject,pin,unpin,archive}` |
| **Replay** | `GET/POST /api/replay/sessions`, `POST /api/replay/sessions/:id/{step,pause,resume,terminate}`, `GET /api/replay/sessions/:id/{events,setups,ohlcv,cost-breakdown,llm-calls,workflow-state}`, `POST /api/replay/sessions/:id/events/:eventId/promote` |
| **Stream / divers** | `GET /api/stream` (SSE), `GET /api/perf`, `GET /api/costs`, `GET /api/assets/:source/:symbol/ohlcv`, `GET /api/yahoo/lookup` |

Health : `GET /health`. Catch-all : SPA shell.

---

## CLI

Tous via `bun run src/cli/<file>.ts [args]`. Lit `DATABASE_URL` / `TEMPORAL_ADDRESS`
depuis `.env`.

| Catégorie | Commandes |
|---|---|
| **Setup ops** | `force-tick <watchId>`, `list-setups [--status …]`, `show-setup <id>`, `kill-setup <id> [reason]`, `pause-watch <watchId>` |
| **Lessons** | `list-lessons`, `show-lesson <id>`, `approve-lesson <id>`, `reject-lesson <id>`, `pin-lesson <id>`, `unpin-lesson <id>`, `archive-lesson <id>` |
| **Replay debug** | `replay-setup <id>` (rejoue le pipeline sur un setup stocké), `replay-feedback <id>` (relance la feedback analysis avec contexte frais) |
| **Maintenance** | `migrate`, `bootstrap-schedules`, `purge-artifacts`, `cost-report` |

---

## Configuration d'une watch

Schéma complet : `src/domain/schemas/WatchesConfig.ts`. Création via le wizard
UI ou directement par insertion DB (`watch_configs` row). Les champs clés :

| Section | Champs notables |
|---|---|
| **asset** | `symbol` (e.g. `BTCUSDT`, `AAPL`), `source` (`binance` ou `yahoo`), `quoteType` + `exchange` pour les équities Yahoo |
| **timeframes** | `primary` (1m..1w), `higher[]` (timeframes plus larges pour HTF context) |
| **schedule** | `detector_cron` (laisse vide pour dérivation automatique depuis le primary), `timezone` |
| **candles** | `detector_lookback`, `reviewer_lookback`, `reviewer_chart_window` (en candles) |
| **setup_lifecycle** | `ttl_candles`, `score_initial`, `score_threshold_finalizer` (80 par défaut), `score_threshold_dead`, `score_max` (100), `invalidation_policy`, `min_risk_reward_ratio` (2.0) |
| **analyzers** | Par rôle : `{provider, model, max_tokens}` pour `detector`, `reviewer`, `finalizer`, `feedback` |
| **optimization** | `reviewer_skip_when_detector_corroborated` (**`false` par défaut** depuis le fix mai 2026), `allow_same_tick_fast_path` (`true`) |
| **costs** | `fees_pct`, `slippage_pct` — pour la math R:R du finalizer (calibre selon le venue) |
| **feedback** | `enabled` (`true`), `max_active_lessons_per_category` (30), `injection.{detector,reviewer,finalizer}` (tous `true`), `context_providers_disabled[]` |
| **pre_filter** | `enabled`, `mode` (lenient/strict/off), thresholds ATR / volume / RSI / pivots — gate cheap avant l'appel détecteur |
| **indicators** | 10 plugins on/off avec params custom (RSI period, EMA periods, etc.) |
| **notify_on** | Événements qui notifient via Telegram (`setup_created`, `setup_strengthened`, `confirmed`, `tp_hit`, `sl_hit`, ...) |
| **include_chart_image** / **include_reasoning** | Snapshotted au setup creation — Telegram payloads |

Pour comprendre l'impact d'un champ : grep `WatchesConfig.ts` puis suis l'usage
dans `src/workflows/`.

---

## Variables d'environnement

Validé au boot par `loadInfraConfig()` (`src/config/InfraConfig.ts`). Voir
`.env.example` pour le détail.

**Requis** :

```sh
DATABASE_URL=postgres://trading_flow:<password>@localhost:5432/trading_flow
TEMPORAL_ADDRESS=localhost:7233
TELEGRAM_BOT_TOKEN=<...>
TELEGRAM_CHAT_ID=<...>
```

**Optionnels / défauts** :

```sh
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE_SCHEDULER=scheduler
TEMPORAL_TASK_QUEUE_ANALYSIS=analysis
TEMPORAL_TASK_QUEUE_NOTIFICATIONS=notifications
TEMPORAL_TASK_QUEUE_REPLAY=replay
DATABASE_POOL_SIZE=10
DATABASE_SSL=false
OPENROUTER_API_KEY=                 # vide → fallback Claude→OpenRouter désactivé
ARTIFACTS_BASE_DIR=/data/artifacts
CLAUDE_WORKSPACE_DIR=/data/claude-workspace
CLAUDE_CODE_OAUTH_TOKEN=<auto-bootstrapped en dev>
ANTHROPIC_API_KEY=                  # UNIQUEMENT pour test/llm/claudeSmoke.test.ts
```

**Gates de tests live** (opt-in, coûtent réels) :

```sh
RUN_LLM_OPENROUTER=1   # test/llm/promptSmoke.test.ts
RUN_LLM_CLAUDE=1       # test/llm/claudeSmoke.test.ts
RUN_LIVE_TELEGRAM=1    # test/adapters/notify/TelegramNotifier.test.ts
RUN_E2E=1              # test/e2e/*.test.ts (requires docker stack up)
E2E_WATCH_ID=btc-1h    # override default watchId for force-tick e2e
```

---

## Observabilité

- **Logs** : pino JSON dans les containers, pretty-print en dev. Un logger
  par composant (`getLogger({ component: "..." })`). Tail via
  `bun run logs:workers` ou `docker logs tf-<service>`.
- **Health** : `GET /health` sur chaque worker (8081/8082/8083 + 8084). Renvoie
  `{status: "ok"|"degraded"|"down", uptimeMs, ...}`.
- **Temporal UI** : `http://localhost:8080` — visualisation des workflows
  running, history, search par WorkflowId.
- **SSE stream** : `GET /api/stream` côté tf-web pousse chaque nouvel event
  Postgres aux clients. Polling Postgres interne toutes les
  `TF_WEB_POLL_INTERVAL_MS=1500` ms.
- **Métriques perf** : `/performance` (UI) ou `GET /api/perf` — equity curve,
  R-multiple histogram, calibration plot (score vs taux de win), ROI bars
  par catégorie.
- **Costs** : `/costs` ou `bun run src/cli/cost-report.ts` — agrégation des
  rows `llm_calls` par jour / stage / provider.

---

## Tests

| Niveau | Commande | Speed | Deps |
|---|---|---|---|
| Domain | `bun test test/domain` | < 1s | aucun (pur) |
| Adapters | `bun test test/adapters` | 5-30s | testcontainers Postgres (auto) |
| Workflows | `bun test test/workflows` | 5-60s | `@temporalio/testing` (download Temporal CLI au 1er run) |
| Client | `bun test test/client` | 1-5s | aucun |
| E2E | `RUN_E2E=1 bun run test:e2e[:replay|:web|:feedback]` | 30s-3min | stack `compose:dev` up + Claude OAuth token |
| LLM smoke | `RUN_LLM_CLAUDE=1 bun run test:llm:claude` | variable | clé Claude + $ |
| Telegram | `RUN_LIVE_TELEGRAM=1 bun run test:llm` | < 5s | bot + chat + token |

E2E suites :

- `test/e2e/full-pipeline.test.ts` — health, force-tick, schedule registration
- `test/e2e/feedback-loop.e2e.test.ts` — promotion d'une leçon PENDING → ACTIVE
- `test/e2e/replay-pipeline.e2e.test.ts` — création session → step → events → UI (avec Playwright)
- `test/e2e/web-smoke.test.ts` — création watch via UI

---

## Project structure

```
trading-flow/
├── src/
│   ├── client/              # tf-web : Bun.serve + React SPA
│   │   ├── api/             # Handlers REST (par domaine)
│   │   ├── components/      # React components (replay/, performance/, ...)
│   │   ├── routes/          # Routes React-Router (16 pages)
│   │   ├── frontend.tsx     # Routeur SPA
│   │   ├── server.ts        # Bun.serve point d'entrée + routes mapping
│   │   └── hooks/, lib/
│   ├── workers/             # Process Temporal worker (4 fichiers)
│   ├── workflows/           # Workflows Temporal (orchestration)
│   │   ├── setup/           # setupWorkflow + activities + trackingLoop
│   │   ├── scheduler/       # schedulerWorkflow + dedup + preFilter + reviewerGating
│   │   ├── replay/          # replaySessionWorkflow + activities + processTick
│   │   ├── feedback/        # feedbackLoopWorkflow + activities + buildContext
│   │   ├── price-monitor/   # priceMonitorWorkflow + WS/polling activities
│   │   ├── marketClock/     # marketClockWorkflow (market hours awareness)
│   │   └── notification/    # Notification activities (Telegram outbound)
│   ├── adapters/            # Adaptateurs hexagonaux (sortie I/O)
│   │   ├── persistence/     # Drizzle stores + schema.ts (14 tables)
│   │   ├── llm/             # claude-agent-sdk / openrouter + provider registry
│   │   ├── notify/          # Telegram (grammy) + Console + Multi
│   │   ├── market-data/     # Binance / Yahoo fetchers
│   │   ├── price-feed/      # Binance WS / Yahoo polling
│   │   ├── chart/           # Playwright headless rendering
│   │   ├── indicators/      # IndicatorRegistry + 10 plugins
│   │   ├── prompts/         # loadPrompt + Handlebars + cache
│   │   └── feedback-context/, funding/, temporal/, time/
│   ├── domain/              # Logique pure (zéro I/O, zéro framework)
│   │   ├── schemas/         # Zod (WatchesConfig, DetectorOutput, ReviewerOutput, …)
│   │   ├── state-machine/   # setupTransitions.ts (états + transitions)
│   │   ├── scoring/         # applyVerdict + verdictToEvent
│   │   ├── events/          # 17 event payloads (Zod discriminated union)
│   │   ├── feedback/        # closeOutcome + lessonAction + validateActions
│   │   ├── replay/          # ReplaySession + simulateTracking + projectSetups
│   │   ├── services/        # PromptBuilder + FewShotEngine + IndicatorPlugin + inputHash
│   │   ├── notify/          # formatTelegramText (shared live ↔ replay)
│   │   └── ports/           # 24 interfaces hexagonales (contrats)
│   ├── config/              # InfraConfig (Zod-validated env) + loadWatchesFromDb
│   ├── cli/                 # 20 scripts opérationnels
│   └── observability/       # Logger + health server
├── test/
│   ├── domain/, adapters/, workflows/, client/, e2e/, llm/, integration/
│   ├── fakes/               # 20+ InMemory* / Fake* (test doubles)
│   └── helpers/
├── prompts/                 # detector|reviewer|finalizer|feedback × {.md.hbs, .system.md}
├── migrations/              # 16 SQL files générés par Drizzle
├── docker/                  # Dockerfile.worker
├── docs/superpowers/        # Specs + plans + runbooks (epoch-frozen, voir CLAUDE.md)
├── scripts/dev/             # bootstrap-claude-token.sh (precompose:dev hook)
├── docker-compose.yml       # Base (Coolify-friendly, expose only)
├── docker-compose-dev.yaml  # Dev overlay (publish ports + bind-mount src)
├── biome.json               # Lint + import restrictions
├── drizzle.config.ts        # Drizzle config
├── package.json             # Scripts: compose:* / logs:* / test:* / db:* / worker:*
└── README.md / CLAUDE.md
```

---

## Troubleshooting

### Stack ne démarre pas

```sh
# Logs détaillés au boot
docker compose -f docker-compose.yml -f docker-compose-dev.yaml logs --tail=200

# Healthchecks
curl http://localhost:8081/health   # scheduler
curl http://localhost:8082/health   # analysis
curl http://localhost:8083/health   # notification
curl http://localhost:8084/health   # web
```

### `bootstrap-claude-token.sh` interactif

Le script lance `claude setup-token` dans un container. Suivre l'URL OAuth,
coller le code. Le token est écrit dans `.env`. Si déjà présent, no-op.

### Postgres password reset

Si tu changes `POSTGRES_PASSWORD` après un premier `compose:up`, Postgres ne
le honore PAS (init script uniquement au volume vide). Tu dois soit :

```sh
bun run compose:nuke   # wipe volume + restart
```

soit l'updater à la main :

```sh
docker exec -it tf-postgres psql -U trading_flow -d trading_flow \
  -c "ALTER USER trading_flow PASSWORD '<new-password>';"
```

### "Failed to signal Workflow (workflow may be closed)"

Un priceMonitor essaie de signaler un setup workflow déjà terminé. Bénin
tant que c'est ponctuel (cache 60s du price-monitor). Si récurrent : un setup
en `INVALIDATED` / `EXPIRED` en DB dont le workflow Temporal est resté
"Running" — terminer via :

```sh
docker exec tf-temporal tctl --address temporal:7233 wf terminate \
  -w setup-<setupId> --reason "stuck workflow"
```

### Chart vide dans Telegram / `/replay`

Vérifier que Playwright a accès à Chromium : `docker exec tf-scheduler-worker
ls /ms-playwright/`. Si vide, le Dockerfile.worker a un souci de build.

### gRPC payload exceeds 4MB

Symptôme : warning `grpc: received message larger than max` dans
`tf-temporal` logs. Cause : un workflow accumule trop d'history events (>10K
typiquement). Indique un signal storm (race condition non-idempotente). Voir
`CLAUDE.md` § "Mutate workflow state BEFORE await" pour la cause classique.

### Webpack errors sur `test/workflows/replay/replaySessionWorkflow.integration.test.ts`

Connu, non-bloquant. Les tests requièrent un workflow bundle webpack qui
peut échouer si le filtre webpack plugin du workflow sandbox rejette un import
domain. Solution : utiliser `test/e2e/replay-pipeline.e2e.test.ts` à la place
(stack réelle) ou les unit tests purs.

---

## Design docs

Frozen specs + implementation plans dans `docs/superpowers/{specs,plans}/`.
Datés ; ne pas éditer post-hoc (écrire une nouvelle spec si une décision
change).

| Doc | Sujet |
|---|---|
| `specs/2026-04-28-trading-flow-design.md` | Architecture overall |
| `specs/2026-04-28-frontend-watches-config-design.md` | Wizard de création de watch |
| `specs/2026-04-28-standby-mode-config-split-design.md` | Split config standby vs runtime |
| `specs/2026-04-29-delete-yaml-config-design.md` | Migration YAML → DB pour les watches |
| `specs/2026-04-29-feedback-loop-design.md` | Lessons / feedback loop |
| `specs/2026-04-29-market-hours-awareness-design.md` | Market clock workflow (Yahoo equities) |
| `specs/2026-04-29-price-monitor-shared-by-symbol-design.md` | Mutualisation price monitor par symbol |
| `specs/2026-04-30-indicators-modularization-design.md` | Indicator plugins |
| `specs/2026-05-01-naked-vs-equipped-validation.md` | Schéma detector naked vs equipped |
| `specs/2026-05-08-replay-mode-design.md` | Replay mode + invariants d'isolation |
| `plans/*.md` | Plans d'implémentation jalon-par-jalon des specs ci-dessus |

---

## Disclaimer

Trading is risky. Le bot **propose** des setups et **track** des positions,
mais aucune exécution réelle n'est câblée à un exchange. Les notifs Telegram
servent à l'évaluation humaine. Toute décision de trading est sous ta
responsabilité.

Le code est fourni tel quel, sans garantie.
