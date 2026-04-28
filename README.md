# Trading Flow

Bot d'analyse de trading multi-actif/multi-timeframe orchestré par Temporal.

## Quickstart

```bash
# 1. Install
bun install

# 2. Configure
cp .env.example .env
$EDITOR .env
cp config/watches.yaml.example config/watches.yaml
$EDITOR config/watches.yaml

# 3. Lancer toute la stack
docker compose up -d

# 4. Voir les logs
docker compose logs -f scheduler-worker

# 5. Ouvrir l'UI Temporal
open http://localhost:8080
```

## Composition

- **Postgres 16** (port 5432) — stocke `trading_flow` + `temporal` + `temporal_visibility`
- **Temporal 1.27** (port 7233) — workflow engine
- **Temporal UI** (port 8080) — admin
- **3 workers Bun** — scheduler / analysis / notification

## CLI

```bash
bun run src/cli/list-setups.ts --status=REVIEWING
bun run src/cli/show-setup.ts <setup-id>
bun run src/cli/kill-setup.ts <setup-id>
bun run src/cli/force-tick.ts btc-1h
bun run src/cli/pause-watch.ts btc-1h pause
bun run src/cli/reload-config.ts
bun run src/cli/replay-setup.ts <setup-id>           # report which events would re-run with current prompts
bun run src/cli/replay-setup.ts <setup-id> --prompt=reviewer  # filter to specific stage
bun run src/cli/cost-report.ts                              # all-time cost by provider
bun run src/cli/cost-report.ts --by=model --since=2026-04-01
bun run src/cli/cost-report.ts --watch=btc-1h --by=day
bun run src/cli/purge-artifacts.ts --older-than-days=30 --dry-run
bun run src/cli/purge-artifacts.ts --older-than-days=30
```

## Architecture

Voir `docs/superpowers/specs/2026-04-28-trading-flow-design.md` pour le design complet.
Voir `docs/superpowers/plans/2026-04-28-trading-flow-implementation.md` pour le plan d'implémentation.

## Tests

```bash
bun test test/domain        # ultra-rapide, pure TS
bun test test/adapters      # ~30s, testcontainers
bun test test/workflows     # ~10s, TestWorkflowEnvironment
RUN_E2E=1 bun test test/e2e # ~2min, full stack
```

## Tech Stack

Bun + TypeScript strict + Zod + Drizzle + Biome + Temporal + Playwright (Chromium) + Handlebars + grammy + Postgres 16.
