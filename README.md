# Trading Flow

Bot d'analyse de trading multi-actif / multi-timeframe orchestré par Temporal, avec
pipeline en 3 phases (Detector → Reviewer → Finalizer), score de confiance organique
qui croît au fil des analyses, et notifications Telegram avec suivi de position TP/SL.

---

## Vue d'ensemble

À chaque tick (cron configurable par watch), le système :

1. **Detector** — analyse libre du graphe via vision LLM. Identifie de nouveaux setups
   ou renforce des setups existants.
2. **Reviewer** — refine les setups vivants en croisant fresh data + mémoire
   accumulée des analyses précédentes. Le score peut monter, baisser, ou
   l'analyse peut invalider le setup.
3. **Finalizer** — quand un setup atteint le seuil de confiance, prend la
   décision finale GO / NO_GO. Si GO, notifie l'utilisateur via Telegram avec
   entry / SL / TP.

Après confirmation, le setup entre en phase **TRACKING** : suivi en temps réel
des prix via WebSocket, événements TP/SL hits persistés, trailing-to-breakeven
après TP1, notifications Telegram à chaque transition.

Tout est event-sourced en Postgres. Les prompts sont versionnés (Handlebars).
Les budgets LLM sont durables. Les workflows sont déterministes (replay-able).

---

## Architecture

Hexagonale (Ports & Adapters), orchestration via Temporal, persistence event-sourcée.

```
┌──────────────────────────────────────────────────────────────────┐
│                          docker-compose                           │
│                                                                   │
│   Postgres ────── Temporal ────── Temporal UI                    │
│       │              │                                            │
│       └──────────────┼──────────────────────────────────┐         │
│                                                          ▼         │
│   ┌───────────────┐  ┌───────────────┐  ┌──────────────────┐     │
│   │ scheduler     │  │ analysis      │  │ notification     │     │
│   │ worker        │  │ worker        │  │ worker           │     │
│   │ :8081 /health │  │ :8082 /health │  │ :8083 /health    │     │
│   │               │  │               │  │                  │     │
│   │ Scheduler wf  │  │ Setup wf      │  │ Telegram         │     │
│   │ Detector LLM  │  │ Reviewer LLM  │  │                  │     │
│   │ PriceMonitor  │  │ Finalizer LLM │  │                  │     │
│   │ + Chromium    │  │ Tracking loop │  │                  │     │
│   └───────────────┘  └───────────────┘  └──────────────────┘     │
└──────────────────────────────────────────────────────────────────┘

  Domain (pure)  ◄──  Adapters (Postgres, LLM, Telegram, Playwright)
                ◄──  Workflows (Temporal — orchestration only)
                ◄──  Activities (thin wrappers around adapters)
```

Détails complets :
[`docs/superpowers/specs/2026-04-28-trading-flow-design.md`](docs/superpowers/specs/2026-04-28-trading-flow-design.md)

---

## Tech Stack

- **Runtime** : Bun
- **Language** : TypeScript strict + Zod (validation aux frontières)
- **ORM** : Drizzle (schema-as-code, migrations générées)
- **Lint + Format** : Biome (single tool avec règles d'import hexagonal)
- **Workflow engine** : Temporal
- **Charting** : Playwright headless (Chromium) + lightweight-charts
- **LLM** : `@anthropic-ai/claude-agent-sdk` (Claude Max) + OpenRouter (300+ modèles)
- **Notifier** : grammy (Telegram bot)
- **Logging** : pino (JSON structuré + correlation IDs)
- **DB** : Postgres 16

---

## Prerequisites

| Outil          | Version min     | Comment vérifier                     |
|----------------|-----------------|--------------------------------------|
| Bun            | 1.3             | `bun --version`                      |
| Docker         | 20.10           | `docker --version`                   |
| Docker Compose | v2              | `docker compose version`             |
| Bot Telegram   | —               | Créé via [@BotFather](https://t.me/BotFather) |
| Clé LLM        | —               | Anthropic API key OU OpenRouter key |

Ports utilisés (tous bindés sur `127.0.0.1`) :
- `5432` — Postgres
- `7233` — Temporal gRPC
- `8080` — Temporal UI (browser)
- `8081` — scheduler-worker `/health`
- `8082` — analysis-worker `/health`
- `8083` — notification-worker `/health`

---

## Getting Started

### 1. Récupérer le projet et installer les dépendances

```bash
git clone <ton-fork-ou-ce-repo>
cd trading-flow
bun install
```

`bun install` télécharge les dépendances + le binaire Chromium pour Playwright
(~250 MB la première fois).

### 2. Configurer les secrets (`.env`)

```bash
cp .env.example .env
$EDITOR .env
```

Variables minimales à remplir :

```bash
# Postgres — choisir un mot de passe local
POSTGRES_USER=trading_flow
POSTGRES_PASSWORD=<ton-mot-de-passe>
DATABASE_URL=postgres://trading_flow:<ton-mot-de-passe>@localhost:5432/trading_flow

# Temporal (laisser tel quel pour le dev local)
TEMPORAL_ADDRESS=localhost:7233

# LLM — au moins un des deux
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-v1-...

# Telegram (voir étape 5 ci-dessous pour créer le bot)
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_CHAT_ID=123456789
```

> Le fichier `.env` est dans `.gitignore` et ne sera jamais commité.

### 3. Définir ta watchlist (`config/watches.yaml`)

```bash
cp config/watches.yaml.example config/watches.yaml
$EDITOR config/watches.yaml
```

Le fichier `watches.yaml.example` fournit un exemple complet pour BTCUSDT 1h via
Binance. Adapte selon tes besoins :

```yaml
watches:
  - id: btc-1h                    # identifiant unique (slug, pas UUID)
    enabled: true
    asset:
      symbol: BTCUSDT
      source: binance              # binance | yahoo
    timeframes:
      primary: 1h                  # 1m | 5m | 15m | 30m | 1h | 2h | 4h | 1d | 1w
      higher: [4h]                 # multi-timeframe pour confluence
    schedule:
      # detector_cron: "*/15 * * * *"  # optionnel — par défaut dérivé du timeframe primary
      timezone: UTC
    setup_lifecycle:
      ttl_candles: 50              # un setup vit max 50 bougies
      score_initial: 25            # score à la création
      score_threshold_finalizer: 80  # déclenche le Finalizer
      score_threshold_dead: 10     # mort prématurée
      invalidation_policy: strict  # strict | wick_tolerant | confirmed_close
    analyzers:
      detector:  { provider: claude_max, model: claude-sonnet-4-6 }
      reviewer:  { provider: claude_max, model: claude-haiku-4-5 }
      finalizer: { provider: claude_max, model: claude-opus-4-7 }
    notifications:
      telegram_chat_id: ${TELEGRAM_CHAT_ID}
      notify_on: [confirmed, tp_hit, sl_hit, invalidated_after_confirmed, expired]
    budget:
      max_cost_usd_per_day: 5.00
```

Tu peux multiplier les watches (BTC 1h + ETH 4h + AAPL 1d, etc.). Chaque watch
tourne indépendamment.

> **`detector_cron` est optionnel.** Si omis, dérivé automatiquement du
> `timeframes.primary` pour aligner sur la fermeture des bougies :
>
> | Timeframe | Cron auto                |
> |-----------|--------------------------|
> | 1m        | `* * * * *`              |
> | 5m        | `*/5 * * * *`            |
> | 15m       | `*/15 * * * *`           |
> | 1h        | `0 * * * *`              |
> | 4h        | `0 */4 * * *`            |
> | 1d        | `0 0 * * *`              |
>
> **Override possible** pour les cas avancés (multi-timeframe, news reactivity).
> Min 1 minute (cron 5-field standard) — les expressions à 6 fields (avec
> secondes) sont refusées au boot pour éviter les coûts LLM accidentels.

### 4. Lancer toute la stack

```bash
docker compose up -d
```

Cette commande démarre dans l'ordre :

1. **postgres** (~5s) — Postgres 16 avec les bases `trading_flow`, `temporal`,
   `temporal_visibility` créées automatiquement
2. **temporal** (~30s) — serveur Temporal avec son schéma appliqué automatiquement
3. **temporal-ui** (~5s) — UI admin sur http://localhost:8080
4. **migrate** (one-shot, ~5s) — applique les migrations Drizzle (5 tables + indices)
5. **bootstrap-schedules** (one-shot, ~5s) — crée les Temporal Schedules (cron)
   pour chaque watch et démarre les SchedulerWorkflow + PriceMonitorWorkflow
6. **scheduler-worker / analysis-worker / notification-worker** — long-running

Vérifier que tous les services sont healthy :

```bash
docker compose ps
```

Tu devrais voir tous les services en `running` ou `healthy`. Si un service
échoue, voir la section [Troubleshooting](#troubleshooting).

### 5. Créer le bot Telegram (si pas déjà fait)

1. Sur Telegram, message à [@BotFather](https://t.me/BotFather) :
   - `/newbot` → suis les instructions → récupère le token
   - Mets-le dans `.env` comme `TELEGRAM_BOT_TOKEN`
2. Récupérer ton `chat_id` :
   - Démarrer une conversation avec ton bot (envoyer `/start`)
   - Visiter `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Chercher `"chat":{"id":123456789,...` — c'est ton `TELEGRAM_CHAT_ID`
3. Restart les workers pour prendre en compte `.env` :
   ```bash
   docker compose restart scheduler-worker analysis-worker notification-worker
   ```

### 6. Vérifier que le pipeline tourne

#### Logs en live

```bash
docker compose logs -f scheduler-worker
```

Tu devrais voir des logs JSON structurés pour chaque tick cron.

#### UI Temporal

Ouvrir http://localhost:8080 — tu vois :
- Les Schedules actifs (1 par watch enabled)
- Les SchedulerWorkflow en cours
- Les SetupWorkflow vivants (un par setup détecté)

#### Health endpoints

```bash
curl http://localhost:8081/health  # scheduler
curl http://localhost:8082/health  # analysis
curl http://localhost:8083/health  # notification
```

Réponse attendue :

```json
{
  "component": "scheduler-worker",
  "status": "ok",
  "startedAt": "2026-04-28T14:00:00.000Z",
  "uptimeMs": 123456,
  "lastActivityAt": "2026-04-28T14:02:00.000Z",
  "metadata": { "workerStatus": "RUNNING" }
}
```

#### Forcer un tick immédiat (pour tester sans attendre le cron)

```bash
bun run src/cli/force-tick.ts btc-1h
```

Quelques secondes plus tard, vérifier le résultat :

```bash
bun run src/cli/list-setups.ts
```

S'il y a un setup intéressant détecté, il apparaîtra avec son score initial.

---

## Configuration

### Hot-reload

Modifie `config/watches.yaml` puis :

```bash
bun run src/cli/reload-config.ts
```

Recharge à chaud les watches existantes (seuils de score, fréquence d'analyse,
templates de notification, etc.). **Limites** :

- Changements de cron → nécessite `docker compose restart bootstrap-schedules`
- Ajout / suppression de watch → nécessite redémarrage des workers
- `temporal.address`, IDs de watch → idem

### Pause / reprise d'une watch

```bash
bun run src/cli/pause-watch.ts btc-1h pause     # met en pause
bun run src/cli/pause-watch.ts btc-1h resume    # reprend
```

---

## CLI Reference

Toutes les commandes utilisent `DATABASE_URL` et `TEMPORAL_ADDRESS` depuis `.env`.

### Lecture (read-only)

```bash
# Lister les setups vivants
bun run src/cli/list-setups.ts
bun run src/cli/list-setups.ts --status=REVIEWING
bun run src/cli/list-setups.ts --watch=btc-1h

# Détail d'un setup + son historique d'events
bun run src/cli/show-setup.ts <setup-id>

# Rapport de coût LLM
bun run src/cli/cost-report.ts                              # all-time par provider
bun run src/cli/cost-report.ts --by=model --since=2026-04-01
bun run src/cli/cost-report.ts --watch=btc-1h --by=day

# Replay setup avec prompts actuels (rapporte ce qui changerait)
bun run src/cli/replay-setup.ts <setup-id>
bun run src/cli/replay-setup.ts <setup-id> --prompt=reviewer
```

### Contrôle (mutate)

```bash
# Forcer un tick immédiat
bun run src/cli/force-tick.ts btc-1h

# Pause / resume d'une watch
bun run src/cli/pause-watch.ts btc-1h pause
bun run src/cli/pause-watch.ts btc-1h resume

# Tuer un setup zombie
bun run src/cli/kill-setup.ts <setup-id> --reason="manual_close"

# Hot-reload de la config
bun run src/cli/reload-config.ts
bun run src/cli/reload-config.ts --dry-run                  # voir le diff sans appliquer
```

### Maintenance

```bash
# Appliquer les migrations Drizzle (au démarrage automatiquement)
bun run src/cli/migrate.ts

# Bootstrap des Temporal Schedules (au démarrage automatiquement)
bun run src/cli/bootstrap-schedules.ts

# Purger les artifacts anciens (charts, OHLCV) — respecte les setups vivants
bun run src/cli/purge-artifacts.ts --older-than-days=30 --dry-run
bun run src/cli/purge-artifacts.ts --older-than-days=30
```

---

## Observabilité

### 1. Logs structurés

Tous les workers et activities émettent du JSON structuré (pino) avec
correlation IDs (`workflowId`, `setupId`, `watchId`, `tickSnapshotId`).

```bash
docker compose logs -f scheduler-worker
docker compose logs -f analysis-worker --tail=100
LOG_LEVEL=debug docker compose up -d                # logs verbeux
```

En dev, formatés avec `pino-pretty` (couleurs). En prod, JSON pur pour ingest
Loki / Datadog / CloudWatch.

### 2. Health endpoints

```bash
curl http://localhost:8081/health   # scheduler
curl http://localhost:8082/health   # analysis
curl http://localhost:8083/health   # notification
```

Reflètent le `worker.getState()` Temporal réel (RUNNING / DRAINING / STOPPED / FAILED).
Les Docker healthchecks utilisent ces endpoints.

### 3. Temporal UI

http://localhost:8080 — interface complète :
- Workflows actifs avec leur state
- Histoire complète de chaque workflow (replay possible)
- Schedules (cron) avec next execution
- Activities en cours, retries, échecs
- Task queues et leur charge

### 4. Drizzle Studio (DB explorer)

```bash
bunx drizzle-kit studio
```

Ouvre une UI web pour explorer Postgres directement. Pratique pour debugger un
setup ou voir les events.

---

## Testing

```bash
# Domain pur (zéro dep, ultra-rapide)
bun test test/domain                          # ~100ms

# Adapters (testcontainers Postgres + mocks HTTP)
bun test test/adapters                        # ~30s

# Workflows (TestWorkflowEnvironment time-skipping)
bun test test/workflows                       # ~10s

# Intégration (Postgres réel + activities + workflow lifecycle)
bun test test/integration                    # ~10s

# E2E (full stack docker-compose)
RUN_E2E=1 bun test test/e2e                  # ~2 min

# Tout
bun test                                      # ~15s sans E2E
```

---

## Project Structure

```
src/
├── domain/                          # cœur, zéro dépendance externe
│   ├── entities/                    # Setup, Watch, TickSnapshot
│   ├── events/schemas/              # 13 event payloads (Zod discriminated union)
│   ├── ports/                       # 11 interfaces (les contrats hexagonaux)
│   ├── schemas/                     # Config, Verdict, Candle, Indicators
│   ├── scoring/applyVerdict.ts      # fonction pure
│   ├── services/                    # inputHash, validateProviderGraph
│   ├── state-machine/               # SetupStatus + transitions
│   └── errors.ts
├── adapters/                        # implémentations branchables
│   ├── chart/                       # Playwright + lightweight-charts
│   ├── indicators/                  # PureJsIndicatorCalculator (RSI/EMA/ATR)
│   ├── llm/                         # Claude SDK + OpenRouter + resolveAndCall
│   ├── market-data/                 # Binance + Yahoo
│   ├── notify/                      # Telegram (grammy)
│   ├── persistence/                 # Drizzle Postgres (5 tables)
│   ├── price-feed/                  # Binance WS + Yahoo polling
│   ├── prompts/                     # loadPrompt (Handlebars)
│   └── time/                        # SystemClock
├── workflows/                       # Temporal orchestration (deterministic)
│   ├── scheduler/                   # SchedulerWorkflow + activities
│   ├── setup/                       # SetupWorkflow + trackingLoop + activities
│   ├── price-monitor/               # PriceMonitorWorkflow
│   └── notification/                # activities only (separate task queue)
├── observability/                   # logger (pino) + healthServer
├── config/loadConfig.ts             # YAML + env expansion + Zod
├── workers/                         # composition root (3 entry points)
└── cli/                             # 11 admin tools

test/
├── domain/                          # tests pures TS
├── adapters/                        # tests d'intégration
├── workflows/                       # TestWorkflowEnvironment
├── integration/                     # full stack avec testcontainers
├── e2e/                             # docker-compose smoke tests
├── fakes/                           # 11 InMemory* / Fake*
└── helpers/postgres.ts              # shared testcontainers helper

prompts/                             # Handlebars templates versionnés
├── detector.md.hbs                  # version: detector_v1
├── reviewer.md.hbs                  # version: reviewer_v1
└── finalizer.md.hbs                 # version: finalizer_v1

config/
├── watches.yaml                     # ta config (gitignored)
└── watches.yaml.example             # template

migrations/                          # générées par drizzle-kit
docker/                              # Dockerfile.worker + init scripts
docker-compose.yml                   # stack complète
```

---

## Troubleshooting

### Postgres "port already allocated"

Un autre Postgres tourne déjà sur 5432. Soit l'arrêter, soit changer le port
dans `docker-compose.yml` (`"127.0.0.1:5433:5432"`) et adapter `DATABASE_URL`.

### `tf-temporal` reste `unhealthy`

Le healthcheck Temporal échoue souvent au premier démarrage. Attendre 60s puis
`docker compose restart temporal`. Si persistant, vérifier les logs :

```bash
docker compose logs temporal | tail -50
```

Souvent c'est un problème d'auth Postgres — vérifier que `POSTGRES_PASSWORD`
dans `.env` correspond à celui utilisé par le volume `postgres_data` (si tu as
changé le password APRÈS le premier `up -d`, fais `docker compose down -v` puis
`docker compose up -d` pour reset le volume).

### Worker ne démarre pas

```bash
docker compose logs scheduler-worker --tail=50
```

Causes fréquentes :
- `DATABASE_URL` mal formé → vérifier le format et l'host
- `TEMPORAL_ADDRESS` injoignable → vérifier que `tf-temporal` est `healthy`
- `TELEGRAM_BOT_TOKEN` absent → mettre une valeur (même fake) pour les workers
  qui ne l'utilisent pas

### LLM coûte trop cher

```bash
bun run src/cli/cost-report.ts --by=day --since=2026-04-01
```

Voir si c'est un setup particulier qui boucle. Les budgets durables sont
configurés par provider :

```yaml
llm_providers:
  claude_max:
    daily_call_budget: 800            # cap journalier
    fallback: openrouter
  openrouter:
    monthly_budget_usd: 50            # cap mensuel en $
    fallback: null
```

Quand le budget est franchi, `isAvailable()` returns false → fallback ou
`NoProviderAvailableError`.

### Setup vivant qui semble bloqué

```bash
bun run src/cli/show-setup.ts <setup-id>          # voir l'historique d'events
bun run src/cli/kill-setup.ts <setup-id>          # le tuer manuellement
```

Le workflow Temporal correspondant peut aussi être inspecté dans la UI
(http://localhost:8080) — voir ses signals reçus, ses queries possibles.

### Charts (PNG) corrompus

Le PlaywrightChartRenderer télécharge `lightweight-charts` depuis unpkg.com.
Vérifier la connexion réseau du container scheduler-worker. Forcer un tick
pour générer un nouveau chart :

```bash
bun run src/cli/force-tick.ts btc-1h
```

---

## Avertissement

**Ce bot n'est PAS un conseiller financier.** Il génère des analyses à but
informatif et envoie des notifications Telegram. **Toi seul** prends la
décision de placer ou non un ordre, en utilisant ton propre courtier.

Le trading comporte des risques. Tu peux perdre tout ou partie de ton capital.
Les performances passées ne préjugent pas des performances futures. Les LLMs
hallucinent. Les niveaux d'invalidation peuvent être franchis violemment
sans signal.

Utilise ce système à tes propres risques. Démarre toujours en
**paper trading / testnet** avant tout engagement réel.

---

## Documents

- **Spec** : [`docs/superpowers/specs/2026-04-28-trading-flow-design.md`](docs/superpowers/specs/2026-04-28-trading-flow-design.md)
- **Plan d'implémentation** : [`docs/superpowers/plans/2026-04-28-trading-flow-implementation.md`](docs/superpowers/plans/2026-04-28-trading-flow-implementation.md)

---

## License

Privé / personnel. Pas de license open-source pour le moment.
