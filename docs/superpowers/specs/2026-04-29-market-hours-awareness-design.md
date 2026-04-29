# Market Hours Awareness — Design Document

**Date** : 2026-04-29
**Status** : Draft (en attente de validation utilisateur)
**Auteur** : brainstorming Arthur + Claude

---

## Table des matières

1. [Vision & contexte](#1-vision--contexte)
2. [Décisions structurantes](#2-décisions-structurantes)
3. [Architecture haut-niveau](#3-architecture-haut-niveau)
4. [Modèle de données](#4-modèle-de-données)
5. [Module domain — `marketSession`](#5-module-domain--marketsession)
6. [Ports & adapters](#6-ports--adapters)
7. [Mécanisme 1 — Market-clock workflow](#7-mécanisme-1--market-clock-workflow)
8. [Mécanisme 2 — Guards dans les workflows long-running](#8-mécanisme-2--guards-dans-les-workflows-long-running)
9. [Mécanisme 3 — Frontend](#9-mécanisme-3--frontend)
10. [Cas limites](#10-cas-limites)
11. [Stratégie de tests](#11-stratégie-de-tests)
12. [Observabilité](#12-observabilité)
13. [Plan de rollout](#13-plan-de-rollout)
14. [Out-of-scope v1](#14-out-of-scope-v1)
15. [Glossaire](#15-glossaire)

---

## 1. Vision & contexte

### Problème constaté

L'audit du codebase a confirmé qu'**aucune logique d'ouverture de marché n'existe** dans Trading Flow :

- Les `Watch` ne stockent que `(symbol, source)`, sans aucune métadonnée d'exchange ou de classe d'actif (`src/domain/schemas/WatchesConfig.ts:55`).
- Les Temporal Schedules (`tick-${watchId}`) tirent leur cron 24/7, peu importe que NYSE/NASDAQ/Euronext soit fermée (`src/config/bootstrapWatch.ts:47-71`).
- Les workflows long-running (`schedulerWorkflow`, `setupWorkflow`, `priceMonitorWorkflow`) ne contiennent aucune garde contre les heures de marché.
- Le frontend n'a aucun indicateur d'état de marché (`watch-card.tsx`).
- Aucune dépendance type `exchange-calendars`, `market-hours` n'est installée.

### Impact concret

Sur un asset US (action, indice, ETF) configuré avec un cron `*/15 * * * *` :
- Heures NASDAQ/NYSE = 9h30–16h ET, 5j/7 ≈ **27% de la semaine**
- Hors marché ≈ **73% des ticks tournent dans le vide** (LLM Detector → tokens brûlés sans valeur)
- Les holidays ajoutent ~10 jours/an de waste

Pour les cryptos (Binance source = `binance`) le problème n'existe pas : marché 24/7. L'enjeu est donc concentré sur les assets Yahoo (stocks, indices, ETF, forex, futures).

### Objectif

Mettre en place un système **transparent et automatique** :
- Aucun nouveau champ utilisateur dans le wizard de création de watch.
- Détection automatique de la session de trading à partir des métadonnées déjà fournies par Yahoo (`quoteType`, `exchange`).
- Pause automatique des workflows pendant les fermetures, reprise automatique à l'ouverture.
- Isolation par session : la fermeture de NYSE n'arrête pas les watches Euronext ou Binance.

---

## 2. Décisions structurantes

| ID | Décision | Choix |
|---|---|---|
| D1 | Approche d'arrêt | **Hybride** : Schedule pause/unpause Temporal-natif pour les ticks scheduler + guards intra-workflow pour les long-running (setup, price monitor) |
| D2 | Granularité | **Une horloge par session de marché**, pas par watch. N watches sur NASDAQ → 1 clock workflow |
| D3 | Crypto Binance | **Exempt total** (always-open par construction) |
| D4 | Discriminateur | `quoteType` Yahoo (`EQUITY`, `ETF`, `INDEX`, `CURRENCY`, `FUTURE`, `CRYPTOCURRENCY`) + `exchange` Yahoo |
| D5 | Holidays | **Différés v2**. ~10 jours/an de waste accepté (vs 73% gagnés sur soirs/weekends) |
| D6 | Setups alive pendant fermeture | **Pause complète** : Reviewer + Finalizer + Tracking attendent la réouverture |
| D7 | Frontend | Badge "Market closed · ouvre dans X" sur watch card / detail / asset detail. Rien quand ouvert ou always-open |
| D8 | Migration des watches existants | **Pas de backfill auto** : watches Yahoo sans `quoteType` sont rejetés à la validation, l'utilisateur les recrée |
| D9 | Futures | Traités comme **always-open** en v1 (calendrier per-contract trop complexe pour le bénéfice) |
| D10 | Forex | Session **24/5** : Dim 17:00 ET → Ven 17:00 ET, DST géré par tz `America/New_York` |

---

## 3. Architecture haut-niveau

Trois mécanismes orthogonaux, **une seule source de vérité** dans le domain :

```
┌──────────────────────────────────────────────────────────────────┐
│  domain layer (pur, portable browser + Node)                     │
│  ─ marketSession.ts : getSession(watch) → Session                │
│                       getSessionState(session, now) → State      │
│  ─ exchangeCalendars.ts : EXCHANGE_DEFS, FOREX_DEF, normalize    │
└─────────────────┬────────────────────────────────────────────────┘
                  │ consommé par les 3 mécanismes
       ┌──────────┼─────────────────────────────────┐
       ▼          ▼                                 ▼
┌──────────────┐ ┌──────────────┐         ┌──────────────────┐
│ Mécanisme 1  │ │ Mécanisme 2  │         │ Mécanisme 3      │
│ Schedule     │ │ Guards in    │         │ Frontend badge   │
│ pause/unpause│ │ long-running │         │                  │
│              │ │ workflows    │         │                  │
│ marketClock  │ │              │         │ useMarketSession │
│ Workflow     │ │ - setupWf    │         │ + Badge          │
│ par session  │ │ - priceMon   │         │                  │
└──────────────┘ └──────────────┘         └──────────────────┘
```

### Principe directeur

Si demain un nouvel exchange ou une nouvelle classe d'actif arrive, on ajoute une entrée dans `EXCHANGE_DEFS` ou un cas dans `getSession`, **rien d'autre** ne change. Les workflows et le frontend consomment l'API stable du domain.

---

## 4. Modèle de données

### Modification du schema Zod

`src/domain/schemas/WatchesConfig.ts:55` — extension du sous-objet `asset` :

```ts
asset: z.object({
  symbol: z.string(),
  source: z.enum(["binance", "yahoo"]),               // était z.string(), resserré
  quoteType: z.enum([
    "EQUITY", "ETF", "INDEX",
    "CURRENCY", "FUTURE", "CRYPTOCURRENCY",
  ]).optional(),
  exchange: z.string().optional(),                     // code Yahoo brut, normalisé en domain
})
```

### Invariants (validés dans `superRefine`)

- `source === "binance"` → `quoteType` et `exchange` ignorés (peuvent être absents).
- `source === "yahoo"` sans `quoteType` → **rejet** (forçage de recréation pour les watches existants).
- `source === "yahoo"` + `quoteType ∈ {EQUITY, ETF, INDEX}` → `exchange` **obligatoire**.
- `source === "yahoo"` + `quoteType === "CURRENCY"` → `exchange` ignoré (forex global).
- `source === "yahoo"` + `quoteType ∈ {FUTURE, CRYPTOCURRENCY}` → `exchange` optionnel.

### Persistance

Le watch est stocké en `jsonb` (table `watchConfigs`, `src/adapters/persistence/schema.ts:120-136`) — **aucune migration DB nécessaire**, seul le shape JSON évolue.

### Validation par-watch (graceful)

La validation Zod est appliquée **watch par watch**, pas sur l'ensemble de la config. Un watch invalide :

- Ne fait pas échouer le reload global.
- Reste en DB tel quel.
- N'apparaît pas dans `WatchRepository.findEnabled()` (filtré au niveau du repo).
- Est surfacé séparément à l'UI via une méthode `findAllWithValidation()` qui retourne `{ watch, error? }` pour chaque row, permettant à la card de rendre "Invalid config — recreate" sans bloquer les autres.

Évite qu'un seul watch cassé après upgrade verrouille le système entier.

### Source des valeurs

Les champs `quoteType` et `exchange` sont **déjà** fetchés par Yahoo dans `src/client/lib/marketData.ts:64-84`. Aujourd'hui ils sont jetés au moment du POST `/watches`. Modification frontend : les inclure dans le payload.

**Aucun champ visible nouveau dans le wizard.**

---

## 5. Module domain — `marketSession`

### Fichier `src/domain/services/marketSession.ts` [NEW]

```ts
import type { WatchConfig } from "@domain/schemas/WatchesConfig"
import { EXCHANGE_DEFS, FOREX_DEF, normalizeYahooExchange } from "./exchangeCalendars"

export type Session =
  | { kind: "always-open" }
  | { kind: "exchange"; id: string }   // id normalisé : NASDAQ | NYSE | PAR | LSE | ...
  | { kind: "forex" }

export type SessionState = {
  isOpen: boolean
  nextOpenAt?: Date    // présent si !isOpen
  nextCloseAt?: Date   // présent si isOpen
}

export function getSession(watch: WatchConfig): Session
export function getSessionState(session: Session, now: Date): SessionState
export function watchesInSession(watches: WatchConfig[], session: Session): WatchConfig[]
```

### Fichier `src/domain/services/exchangeCalendars.ts` [NEW]

Données pures (pas un adapter — c'est de la connaissance métier) :

```ts
type ExchangeDef = {
  tz: string                                            // IANA tz (DST géré par Intl)
  ranges: Array<{ open: string; close: string }>        // HH:mm en heure locale
  days: number[]                                        // 1=Mon..5=Fri
}

export const EXCHANGE_DEFS: Record<string, ExchangeDef> = {
  // US
  NASDAQ: { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1,2,3,4,5] },
  NYSE:   { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1,2,3,4,5] },
  AMEX:   { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1,2,3,4,5] },
  ARCA:   { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1,2,3,4,5] },
  // Europe
  PAR:    { tz: "Europe/Paris",     ranges: [{ open: "09:00", close: "17:30" }], days: [1,2,3,4,5] },
  AMS:    { tz: "Europe/Amsterdam", ranges: [{ open: "09:00", close: "17:30" }], days: [1,2,3,4,5] },
  BRU:    { tz: "Europe/Brussels",  ranges: [{ open: "09:00", close: "17:30" }], days: [1,2,3,4,5] },
  MIL:    { tz: "Europe/Rome",      ranges: [{ open: "09:00", close: "17:30" }], days: [1,2,3,4,5] },
  LSE:    { tz: "Europe/London",    ranges: [{ open: "08:00", close: "16:30" }], days: [1,2,3,4,5] },
  XETRA:  { tz: "Europe/Berlin",    ranges: [{ open: "09:00", close: "17:30" }], days: [1,2,3,4,5] },
  SIX:    { tz: "Europe/Zurich",    ranges: [{ open: "09:00", close: "17:30" }], days: [1,2,3,4,5] },
  // Asie — lunch breaks modélisés
  TSE:    { tz: "Asia/Tokyo",
            ranges: [{ open: "09:00", close: "11:30" }, { open: "12:30", close: "15:00" }],
            days: [1,2,3,4,5] },
  HKEX:   { tz: "Asia/Hong_Kong",
            ranges: [{ open: "09:30", close: "12:00" }, { open: "13:00", close: "16:00" }],
            days: [1,2,3,4,5] },
}

export const FOREX_DEF = {
  tz: "America/New_York",
  open:  { weekday: 0, hhmm: "17:00" },   // Sun 17:00 ET
  close: { weekday: 5, hhmm: "17:00" },   // Fri 17:00 ET
}

const YAHOO_EXCHANGE_MAP: Record<string, keyof typeof EXCHANGE_DEFS> = {
  NMS: "NASDAQ", NCM: "NASDAQ", NGM: "NASDAQ",
  NYQ: "NYSE",
  ASE: "AMEX",
  PCX: "ARCA",
  PAR: "PAR", AMS: "AMS", BRU: "BRU", MIL: "MIL",
  LSE: "LSE",
  GER: "XETRA", FRA: "XETRA",
  EBS: "SIX",
  JPX: "TSE",
  HKG: "HKEX",
}

export function normalizeYahooExchange(code: string | undefined): keyof typeof EXCHANGE_DEFS | null
```

### Logique de `getSession`

```ts
function getSession(watch) {
  if (watch.asset.source === "binance") return { kind: "always-open" }
  switch (watch.asset.quoteType) {
    case "CURRENCY":         return { kind: "forex" }
    case "FUTURE":
    case "CRYPTOCURRENCY":   return { kind: "always-open" }
    case "EQUITY":
    case "ETF":
    case "INDEX": {
      const id = normalizeYahooExchange(watch.asset.exchange)
      if (!id) throw new UnsupportedExchangeError(watch.asset.exchange)
      return { kind: "exchange", id }
    }
  }
}
```

### Logique de `getSessionState` (DST-safe)

1. Convertir `now` UTC vers heure locale de la tz de la session (`Intl.DateTimeFormat({ timeZone })`).
2. Pour `kind: exchange`, vérifier si on est dans une `range` un jour ouvré → `isOpen=true` + `nextCloseAt = fin de la range courante`.
3. Sinon, calculer le prochain `open` en marchant en avant (next valid weekday + first range start).
4. Pour `kind: forex`, vérifier si on est dans la fenêtre Sun 17:00 ET → Fri 17:00 ET.
5. Pour `kind: always-open`, retourner `{ isOpen: true }`.

L'algorithme n'a besoin d'aucune lib externe. `Intl.DateTimeFormat` est ECMAScript standard et résout DST via tzdata système.

---

## 6. Ports & adapters

### Ports (domain interfaces)

#### `src/domain/ports/ScheduleController.ts` [NEW]

```ts
export interface ScheduleController {
  pause(scheduleId: string, reason: string): Promise<void>
  unpause(scheduleId: string): Promise<void>
}
```

#### `src/domain/ports/WatchRepository.ts` [NEW]

```ts
export interface WatchRepository {
  findAll(): Promise<WatchConfig[]>
  findById(id: string): Promise<WatchConfig | null>
  findEnabled(): Promise<WatchConfig[]>
  findAllWithValidation(): Promise<Array<{ id: string; raw: unknown; watch?: WatchConfig; error?: string }>>
}
```

L'introduction de ce port paie une dette technique : aujourd'hui `loadWatchesConfig.ts`, `bootstrap-schedules.ts` et `reload-config.ts` accèdent directement à Drizzle.

### Adapters (concrete impls)

#### `src/adapters/temporal/TemporalScheduleController.ts` [NEW]

```ts
import type { Client } from "@temporalio/client"
import type { ScheduleController } from "@domain/ports/ScheduleController"

export class TemporalScheduleController implements ScheduleController {
  constructor(private client: Client) {}
  async pause(id: string, reason: string) {
    try {
      await this.client.schedule.getHandle(id).pause(reason)
    } catch (e) {
      if (isNotFoundError(e)) return  // schedule supprimée, no-op
      throw e
    }
  }
  async unpause(id: string) {
    try {
      await this.client.schedule.getHandle(id).unpause()
    } catch (e) {
      if (isNotFoundError(e)) return
      throw e
    }
  }
}
```

#### `src/adapters/persistence/PostgresWatchRepository.ts` [NEW]

Implémente `WatchRepository` via Drizzle, utilisant la table `watchConfigs` existante.

### Câblage

Tout est wiré dans `src/workers/buildContainer.ts` comme les autres adapters. La factory `makeMarketClockActivities(deps)` reçoit les ports `Clock`, `WatchRepository`, `ScheduleController`.

---

## 7. Mécanisme 1 — Market-clock workflow

### Fichiers

```
src/workflows/marketClock/
├── marketClockWorkflow.ts      [NEW]   orchestration pure (pas d'I/O direct)
└── activities.ts               [NEW]   bridge ports → infra
```

### Workflow

```ts
import * as workflow from "@temporalio/workflow"
import type { Session } from "@domain/services/marketSession"
import type { makeMarketClockActivities } from "./activities"

const { getNow, listWatchesInSession, applyToSchedules } =
  workflow.proxyActivities<ReturnType<typeof makeMarketClockActivities>>({
    startToCloseTimeout: "1 minute",
  })

export async function marketClockWorkflow(input: { session: Session }): Promise<void> {
  while (true) {
    const now = await getNow()
    const watches = await listWatchesInSession(input.session)
    if (watches.length === 0) return  // dernière watch supprimée → terminate

    const state = getSessionState(input.session, now)
    const action = state.isOpen ? "unpause" : "pause"
    const scheduleIds = watches.map(w => `tick-${w.id}`)
    await applyToSchedules(scheduleIds, action, "market clock transition")

    const wakeAt = state.isOpen ? state.nextCloseAt! : state.nextOpenAt!
    const sleepMs = Math.max(0, wakeAt.getTime() - now.getTime())
    await workflow.sleep(sleepMs)
  }
}
```

`workflow.sleep` n'a aucun coût compute pendant le sleep — Temporal gère le timer côté serveur.

### Activities

```ts
// src/workflows/marketClock/activities.ts
export const makeMarketClockActivities = (deps: {
  clock: Clock
  watches: WatchRepository
  schedules: ScheduleController
}) => ({
  getNow: async () => deps.clock.now(),

  listWatchesInSession: async (session: Session) => {
    const all = await deps.watches.findEnabled()
    return watchesInSession(all, session)
  },

  applyToSchedules: async (
    ids: string[],
    action: "pause" | "unpause",
    reason: string,
  ) => {
    for (const id of ids) {
      action === "pause"
        ? await deps.schedules.pause(id, reason)
        : await deps.schedules.unpause(id)
    }
  },
})
```

### Lifecycle des market-clocks

#### Bootstrap (au démarrage du worker)

`src/workers/scheduler-worker.ts` appelle `bootstrapMarketClocks()` :

```ts
async function bootstrapMarketClocks(deps: { watches: WatchRepository, temporal: Client }) {
  const all = await deps.watches.findEnabled()
  const sessions = uniqBy(
    all.map(getSession).filter(s => s.kind !== "always-open"),
    sessionKey,
  )
  for (const session of sessions) {
    await ensureMarketClock(deps.temporal, session)
  }
}

async function ensureMarketClock(temporal: Client, session: Session) {
  const id = `clock-${session.kind}${session.kind === "exchange" ? "-" + session.id : ""}`
  try {
    await temporal.workflow.getHandle(id).describe()  // déjà running
  } catch {
    await temporal.workflow.start(marketClockWorkflow, {
      taskQueue: "scheduler",
      workflowId: id,
      args: [{ session }],
    })
  }
}
```

#### Création d'un watch

`src/config/bootstrapWatch.ts` ajoute après la création de la Schedule :

```ts
const session = getSession(watch)
if (session.kind !== "always-open") {
  await ensureMarketClock(temporal, session)
  // Si marché actuellement fermé, pause immédiate de la Schedule fraîchement créée
  // pour éviter qu'elle tire un tick avant le prochain réveil du clock.
  const state = getSessionState(session, await clock.now())
  if (!state.isOpen) await scheduleController.pause(`tick-${watch.id}`, "market closed at creation")
}
```

#### Suppression d'un watch

Le clock workflow détecte tout seul (`watches.length === 0` au prochain réveil → `return`). Pas d'action explicite à la suppression.

### IDs Temporal

| Session | Workflow ID |
|---|---|
| Exchange NASDAQ | `clock-exchange-NASDAQ` |
| Exchange Euronext Paris | `clock-exchange-PAR` |
| Forex | `clock-forex` |
| Always-open | (aucun workflow) |

---

## 8. Mécanisme 2 — Guards dans les workflows long-running

### `setupWorkflow.ts` (modification)

Avant chaque itération de la boucle Reviewer/Finalizer/Tracking, garde via `getSessionState` :

```ts
const session = getSession(watch)
while (setup.isAlive) {
  const now = await getNow()
  const state = getSessionState(session, now)
  if (!state.isOpen) {
    const sleepMs = state.nextOpenAt!.getTime() - now.getTime()
    await workflow.sleep(sleepMs)
    continue
  }
  // logique normale : Reviewer / Finalizer / Tracking
}
```

Cohérent avec D6 : pause complète, reprise exacte au prochain open.

### `priceMonitorWorkflow.ts` (modification)

Le workflow est multi-asset. Le filtre se fait **par setup** avant émission :

```ts
for (const setup of aliveSetups) {
  const state = getSessionState(getSession(setup.watch), now)
  if (!state.isOpen) continue  // skip cette émission ; n'arrête pas le workflow
  signalSetup(setup.id, "trackingPrice", price)
}
```

Pas de `workflow.sleep` ici — le price monitor continue de tirer ses prix pour les setups dont le marché est ouvert. C'est le filtre par-setup qui isole.

---

## 9. Mécanisme 3 — Frontend

### Hook `useMarketSession`

```ts
// src/client/hooks/useMarketSession.ts                       [NEW]
import { useEffect, useMemo, useState } from "react"
import { getSession, getSessionState } from "@domain/services/marketSession"
import type { WatchConfig } from "@domain/schemas/WatchesConfig"

export function useMarketSession(watch: WatchConfig) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(tick)
  }, [])
  const session = useMemo(() => getSession(watch), [watch])
  const state = useMemo(() => getSessionState(session, now), [session, now])
  return { session, ...state }
}
```

### Composant `<MarketStateBadge />`

```ts
// src/client/components/market-state-badge.tsx               [NEW]
export function MarketStateBadge({ watch }: { watch: WatchConfig }) {
  const { session, isOpen, nextOpenAt } = useMarketSession(watch)
  if (session.kind === "always-open") return null
  if (isOpen) return null
  return (
    <Badge variant="muted">
      Market closed · ouvre {formatRelativeOpening(nextOpenAt!)}
    </Badge>
  )
}
```

### Format `formatRelativeOpening`

- `< 1h` → `"dans 45 min"`
- `< 24h` → `"dans 8h12"`
- même semaine → `"lundi à 15:30"`
- `> 7j` → `"le 14 mai à 15:30"`

Locale FR (cohérent avec le reste de l'UI).

### Emplacements d'intégration

| Lieu | Fichier | Affichage |
|---|---|---|
| Watch card | `src/client/components/watch-card.tsx` | Badge à côté du badge `enabled` |
| Watch detail | header de la page | Badge plus visible |
| Asset detail | header de la page | Badge informatif |
| Wizard de création | — | Pas de badge (bruit) |
| Live events | — | Pas de badge |

### Comportement watches invalides

Watch Yahoo sans `quoteType` (post-upgrade, D8) :
- Card affiche un badge "Invalid config — recreate" (rouge), `<MarketStateBadge>` n'est pas rendu.
- Le watch est `enabled: false` côté backend (forçage de validation).

### Aucun nouvel endpoint API

Tout est calculé côté browser. Le payload `/watches` retourne déjà la `WatchConfig` complète, donc `quoteType` et `exchange` sont disponibles dès qu'on les persiste (section 4).

---

## 10. Cas limites

| Cas | Comportement attendu |
|---|---|
| **DST transition** (NYSE 14h30 UTC l'hiver, 13h30 UTC l'été) | Géré nativement par `Intl.DateTimeFormat({timeZone})`. Tests dédiés sur les 4 weekends de bascule. |
| **Watch créé pendant marché fermé** | À la création, si `getSessionState(...).isOpen === false`, pause immédiate de la Schedule via `ScheduleController.pause` avant retour à l'utilisateur. |
| **Watch supprimé pendant que le clock dort** | Au prochain réveil, `listWatchesInSession` re-query la DB → le watch n'est plus là → pas d'unpause sur Schedule fantôme. Pause/unpause sur Schedule inexistante = no-op (try/catch sur not-found). |
| **Premier watch d'une session pendant marché fermé** | `ensureMarketClock` démarre le clock ; son premier `getSessionState` détecte `closed` → pause toutes les Schedules de la session. |
| **Dernier watch d'une session supprimé** | Au prochain réveil, `watches.length === 0` → workflow `return` proprement. |
| **Worker crash pendant `applyToSchedules`** | Activity retry automatique par Temporal. Pause/unpause idempotents (pause d'une schedule déjà paused = no-op). |
| **Watch toggle `enabled: false → true` pendant fermeture** | Le re-enable recrée la Schedule via `bootstrapWatch`. Même logique que création hors-heures → pause immédiate. |
| **Yahoo retourne un code exchange inconnu** | `normalizeYahooExchange()` retourne `null` → `UnsupportedExchangeError` → 422 à la création de watch côté API : `"Exchange '<code>' not yet supported"`. Visible dans le wizard. |
| **Index cash vs index future** (`^GSPC` vs `ES=F`) | Discriminés par `quoteType` : `^GSPC` = INDEX → session NYSE, `ES=F` = FUTURE → always-open. |
| **Symbole crypto sur Yahoo** (`BTC-USD`) | `quoteType: CRYPTOCURRENCY` → always-open, pas de clock. Cohérent avec Binance. |
| **Holiday non géré** (NYSE Thanksgiving) | Le clock unpause à 9h30 ET comme un jour normal, le cron tire, les analyses tournent dans le vide. Accepté (D5). |

---

## 11. Stratégie de tests

### Tests domain (TDD strict, `bun test`)

`src/domain/services/marketSession.test.ts` :

- ✓ Crypto Binance → `kind: always-open`, `isOpen: true` toujours
- ✓ Yahoo `EQUITY` NASDAQ ouvert lundi 10h ET, fermé samedi
- ✓ Yahoo `EQUITY` NYSE en transition DST (dim de bascule printemps/automne)
- ✓ Yahoo `EQUITY` Tokyo avec lunch break : 11:45 JST → `closed`, `nextOpenAt = 12:30 JST`
- ✓ Yahoo `INDEX` NYSE → comportement identique à `EQUITY` NYSE
- ✓ Yahoo `CURRENCY` → forex 24/5 : ouvert mardi 10h UTC, fermé samedi 10h UTC, ouvre dim 22h UTC l'hiver / 21h UTC l'été
- ✓ Yahoo `FUTURE` → always-open
- ✓ Yahoo `EQUITY` exchange inconnu → throw `UnsupportedExchangeError`
- ✓ `nextOpenAt` correct pendant un weekend (NASDAQ vendredi 22h ET → ouvre lundi 9h30 ET)
- ✓ `nextCloseAt` correct en pleine séance
- ✓ Multiple ranges (Tokyo) : 13:00 JST = open, transition lunch break correcte

### Tests workflows (`@temporalio/testing`)

- `marketClockWorkflow` : pause/unpause appelés au bon moment, `workflow.sleep` durations correctes
- `setupWorkflow` guard : sleep jusqu'à réouverture, reprise correcte de la boucle Reviewer/Finalizer
- `priceMonitorWorkflow` : skip émission pendant fermeture, autres setups émis normalement

### Tests frontend

Test minimal du hook `useMarketSession` avec un Date mocké, vérifie l'apparition/disparition du badge.

### Tests d'intégration

- Création d'un watch Yahoo NASDAQ pendant marché fermé : Schedule créée + immédiatement paused.
- Bootstrap worker avec 0 watch puis ajout → clock démarre.
- Suppression du dernier watch d'une session → clock se termine au prochain tick.

---

## 12. Observabilité

### Logs structurés (intégrés dans `src/observability/`)

```
market_clock.tick      { sessionKey, isOpen, watchesAffected, nextWakeAt }
market_clock.pause     { sessionKey, scheduleIds, reason }
market_clock.unpause   { sessionKey, scheduleIds }
watch.skipped_closed   { watchId, sessionKey, location: "setupWorkflow" | "priceMonitor" }
```

### Métriques

- `market_clock_paused_total` (counter, label `session_key`)
- `market_clock_unpaused_total` (counter)
- `watch_skipped_market_closed_total` (counter, labels `watch_id`, `location`)
- `setup_paused_duration_seconds` (histogram)

### Frontend

Pas d'instrumentation spécifique. Le rendu correct du badge sert de feedback visuel.

---

## 13. Plan de rollout

Six PRs séquentielles, chacune indépendamment réversible :

### PR 1 — Pure domain (zero behavior change)

- `src/domain/services/marketSession.ts`
- `src/domain/services/exchangeCalendars.ts`
- Tests TDD complets
- Aucun consommateur. Mergeable seul.

### PR 2 — Data model

- Update `WatchSchema` : `quoteType` + `exchange` + invariants `superRefine`
- Update `errors.ts` : `UnsupportedExchangeError`
- Update frontend search → persist `quoteType` + `exchange` au POST `/watches`
- Watches existants Yahoo sans `quoteType` → `enabled: false` forcé au prochain reload, badge UI "Invalid config — recreate"

### PR 3 — Ports & adapters infrastructure

- `src/domain/ports/WatchRepository.ts` + `PostgresWatchRepository`
- `src/domain/ports/ScheduleController.ts` + `TemporalScheduleController`
- Refactor `loadWatchesConfig.ts`, `bootstrap-schedules.ts`, `reload-config.ts` pour utiliser le port `WatchRepository` (paie la dette technique)

### PR 4 — Guards long-running (premiers gains LLM)

- Garde dans `setupWorkflow.ts` (sleep jusqu'à réouverture)
- Garde dans `priceMonitorWorkflow.ts` (skip émission par-setup)
- À ce stade : économies LLM immédiates sur les setups alive.

### PR 5 — Market-clock workflows

- `src/workflows/marketClock/marketClockWorkflow.ts`
- `src/workflows/marketClock/activities.ts`
- `bootstrapMarketClocks()` au démarrage du worker
- `ensureMarketClock(session)` à la création de watch + pause immédiate si fermé
- À ce stade : Temporal Web nettoyé (plus de ticks vides hors séance).

### PR 6 — Frontend badge

- `useMarketSession` hook
- `<MarketStateBadge />` composant
- Intégration dans `watch-card.tsx`, watch detail, asset detail

### Rollback

- Revert PR 5 → les clocks s'arrêtent, Schedules reprennent leur cron 24/7. Le système retourne au comportement actuel sans perte.
- Revert PR 4 → guards disparaissent, workflows tournent à nouveau 24/7.
- Revert PR 2 → schema redevient lax, les nouveaux champs persistés sont juste ignorés.

---

## 14. Out-of-scope v1

Documenté ici pour traçabilité, à reprendre en v2 si besoin :

- **Holidays** (D5) : NYSE Thanksgiving / 4 juillet / etc. ne sont pas reconnus. Waste estimé ~10 jours/an.
- **Calendrier per-contract pour les futures** (D9) : `ES=F`, `GC=F` etc. tournent en always-open.
- **Migration auto des watches existants** (D8) : pas de backfill, l'utilisateur recrée les watches Yahoo.
- **After-hours / pre-market US** : Yahoo ne sert pas ces données de toute façon.
- **Sessions cassées des futures agricoles** (`ZC=F` maïs avec deux sessions/jour) : couvertes par "always-open" en v1, perte ≈ 50% sur ces contrats.
- **Notification utilisateur "Market opens in 5 min"** : pas de v1, peut être ajouté plus tard via le système de notifs existant.

---

## 15. Glossaire

- **Session** : période continue pendant laquelle un asset est négociable. Dans ce design, abstraction `Session` à 3 variantes : `always-open` (crypto, futures), `exchange` (stocks/indices/ETF rattachés à un exchange), `forex` (24/5 anchored to NY time).
- **Market-clock workflow** : workflow Temporal long-running qui dort jusqu'au prochain open/close de sa session, puis pause/unpause les Schedules de tous les watches de cette session.
- **Schedule** : Temporal Schedule existante (`tick-${watchId}`), une par watch, qui tire le cron du tick scheduler.
- **`quoteType`** : champ retourné par Yahoo Finance qui discrimine la classe d'asset (`EQUITY`, `INDEX`, `ETF`, `CURRENCY`, `FUTURE`, `CRYPTOCURRENCY`).
- **Always-open** : kind de session pour les assets négociables 24/7 (cryptos) ou quasi-24/7 traités comme tels (futures en v1).
