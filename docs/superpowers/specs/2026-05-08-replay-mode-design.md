# Replay Mode — Design Document

**Date** : 2026-05-08
**Status** : Implémenté (J2) — pivot d'archi acté ci-dessous
**Auteur** : brainstorming Arthur + Claude

---

## ⚠️ Note d'implémentation (post-spec, 2026-05-11)

Cette spec décrit la **Stratégie 1** envisagée à l'époque du brainstorm : un seul code path métier, deux comportements via un paramètre `replayContext` injecté à toutes les activités live. Au moment d'implémenter §5 ("Branchement DI"), on a constaté que :

- Le couplage des activités live à `tickSnapshotStore`, `setupRepo`, `lessonStore` (mutations) et `eventStore` est plus profond que ce que la spec laissait entendre — chaque activité aurait demandé un bloc `if (args.replayContext) ...` non trivial sur 5-10 sites.
- Le risque de drift live/replay sur une zone aussi critique (Detector → Reviewer → Finalizer → tracking) justifiait une isolation plus stricte.

**Décision Arthur (2026-05-09)** : pivoter vers la **Stratégie 3** — duplication contrôlée. Les activités live restent **strictement inchangées** ; un nouveau module `src/workflows/replay/activities.ts` fournit les variantes replay-scopées (`runDetectorReplay`, `runReviewerReplay`, `runFinalizerReplay`, `runFeedbackAnalysisReplay`). Le workflow Temporal `src/workflows/replay/replaySessionWorkflow.ts` les orchestre.

Ce que la spec dit toujours juste :
- Les **4 tables** (`replay_sessions`, `replay_events`, `replay_llm_calls`, `llm_response_cache`) — implémentées telles quelles.
- Les **10 invariants d'isolation** (§10) — respectés.
- Les **3 modes lessons** + **2 modes feedback** — implémentés.
- L'**API endpoints** (§7) — implémentée + endpoints `step`/`pause`/`resume`/`terminate` ajoutés.
- Le **hard cap 300 bougies** (§19) + **règle d'or** (§1) — respectés.

Ce que la spec décrit mais qui n'existe pas comme tel dans le code :
- Pas de paramètre `replayContext` sur les activités live. Lire `src/workflows/replay/activities.ts` à la place de §5.
- `FixedClock` est instancié **dans** chaque activité replay (`new FixedClock(input.tickAt)`) plutôt que injecté via DI — pour notre Stratégie 3 sans deps partagés.
- `NoopTelegramNotifier` n'est pas injecté comme adapter ; le workflow attache directement un champ `telegramPreview?: string` aux payloads pertinents via `domain/notify/formatReplayTelegramPreview.ts`.

Les sections §3, §5, §6 ci-dessous décrivent la Stratégie 1 originelle — gardées pour archéologie. Pour comprendre ce qui tourne en prod, lire le code source + cette note.

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

### Multi-setup par session

Une session peut contenir plusieurs setups simultanés, exactement comme la prod. Le Detector peut détecter un setup A à T+4, puis un setup B à T+9. Tant qu'aucun ne ferme, ils coexistent et reçoivent chacun leur Reviewer/Finalizer. La session est scopée à une **watch + window**, pas à un setup. L'UI affiche tous les setups d'une session avec un système de tabs pour focus l'analyse sur l'un ou l'autre.

### Lookback vs Window

Deux notions à distinguer :

- **Lookback** = combien de bougies d'historique le Detector a besoin pour calculer ses indicateurs et rendre son chart. **Fixé par la config de la watch** (`candles.detector_lookback`, typiquement 200). L'utilisateur n'y touche pas.
- **Window** = la plage de bougies que **l'utilisateur** choisit à la création de la session. C'est le nombre de fois où il pourra cliquer Step. Typiquement 24-100 bougies.

À chaque tick au playhead `T`, le Detector reçoit les bougies `[T - lookback, T]` ; les premières font partie de la window jouée, les autres sont du contexte hors-window pour les calculs.

### Ancrage architectural

L'implémentation respecte strictement l'**architecture hexagonale** déjà en place :

- La pipeline domain (scoring, state machine, `applyVerdict`, `inputHash`) est invoquée **sans modification**.
- Les **activités existantes** (`runDetector`, `runReviewer`, `runFinalizer`, `runFeedbackAnalysis`, `persistEvent`, `markSetupClosed`, `notifyTelegram*`) sont **les mêmes** en live et en replay. Un bloc DI au début de chaque activité bascule vers les adapters replay-scopés quand `args.replayContext` est présent.
- Adapters substitués : `CachedLLMProvider` (cache mutualisé), `NoopTelegramNotifier` (capture sans envoi), `Replay*Store` (écriture sur tables `replay_*` isolées), `FixedClock` (horloge simulée à la bougie courante).
- **Un seul nouveau workflow Temporal** : `replaySessionWorkflow`, thin (~150 lignes), enregistré sur le worker `analysis-worker` existant. Il porte l'état durable (alive setups, score, coût) et n'utilise ni timer ni child workflow ni polling — il attend uniquement les signaux de l'API.
- Aucune modification du schéma live ; uniquement 4 nouvelles tables (`replay_sessions`, `replay_events`, `replay_llm_calls`, `llm_response_cache`).

C'est cette discipline qui garantit que **le bot replayé est rigoureusement le même que le bot live** — modulo les side-effects neutralisés.

### La règle d'or : RIEN d'automatique

Le `replaySessionWorkflow` est **silencieux à sa création**. Il existe en mémoire Temporal, attend des signaux, exécute la pipeline pour le signal reçu, retourne en idle. Aucune activité ne tourne entre les ticks demandés par l'utilisateur. Aucune Temporal Schedule, aucun `priceMonitorWorkflow`, aucun timer, aucun child workflow, aucun polling. **L'utilisateur clique → l'API signale → le workflow exécute → idle**. Si l'utilisateur ferme l'onglet, plus aucun coût LLM n'est dépensé. L'état est durable, on peut revenir demain et reprendre exactement où on était.

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
| 5 | Side-effects neutralisés | (a) `NoopTelegramNotifier` capture les messages dans `replay_events.payload.telegram_preview` mais n'envoie rien. (b) `ReplayEventStore` écrit dans `replay_events` au lieu de `events`. (c) `ReplayLLMCallStore` écrit dans `replay_llm_calls`. (d) Aucun child workflow `setupWorkflow` démarré ; l'état des setups vit dans le workflow `replaySessionWorkflow`. (e) Tracking simulé déterministiquement au tick du workflow, pas via `priceMonitor` / `trackingLoop`. |
| 6 | Clock | À chaque step on injecte un `FixedClock` qui retourne `current_playhead_at`. Le `inputHash` reste reproductible. |
| 7 | Cache LLM | Table `llm_response_cache` indexée par `(provider, model, prompt_version, input_hash)`. Hit = $0. Miss = appel réel + insert dans le cache. Cache mutualisé entre toutes les sessions. |
| 8 | Cost cap | Cap obligatoire à la création (default $5 / session). Si le coût cumulé d'une session atteint le cap, le step suivant retourne 402, la session passe en `COST_CAPPED`. Reprenable après augmentation du cap. |
| 9 | Persistence config snapshot | À la création, on snapshot la config de la watch (prompts versions, modèles, indicateurs, seuils) dans `replay_sessions.config_snapshot`. Si la watch est éditée plus tard, le replay reste reproductible. |
| 10 | Override de config | Hors scope v1. La session utilise toujours la config snapshotée de la watch. Une évolution post-v1 pourrait permettre de surcharger ponctuellement (autre prompt, autre modèle) ; v1 reste sur "config réelle de la watch". |
| 11 | Comparaison de sessions | Hors scope v1. Évolution possible post-v1 si l'usage le demande. |
| 12 | Auto-trigger | Out-of-scope. Aucun cron, aucun déclenchement automatique. 100% on-demand par l'utilisateur. |
| 13 | Suppression | Une session peut être supprimée par l'utilisateur. Cascade DELETE sur `replay_events` et `replay_llm_calls` ; le workflow Temporal correspondant est terminé via `terminateWorkflow`. Le `llm_response_cache` survit (mutualisé entre sessions). |
| 14 | Échec en cours de step | Si un LLM call échoue (timeout, rate limit, erreur provider), la session passe en `FAILED` avec le message d'erreur. Reprenable après résolution (retry idempotent grâce au cache). |
| 15 | Telegram preview | Capture la string formatée *qu'aurait* émise le notifier, sans appeler l'API Telegram. Affichée dans l'UI à côté du verdict, en grisé `(NEUTRALISÉ)`. |
| 16 | Lessons injectées dans la pipeline | Paramétrable au create-time via `lessons_mode` ∈ `{current, historical, disabled}`. Default `current` (les lessons actives aujourd'hui). `historical` filtre par `activated_at <= window_start_at` pour reproduire fidèlement le bot d'époque. `disabled` n'injecte aucune lesson (utile pour mesurer leur impact). |
| 17 | Feedback loop sur fermeture | Paramétrable via `feedback_mode` ∈ `{run, skip}`. Default `run` : à chaque fermeture de trade (SL, TP final, INVALIDATED post-trade, TIME_OUT), le workflow appelle l'activité `runFeedbackAnalysis` existante avec `replayContext`. Les lessons générées sont stockées en `replay_events` (event type `FeedbackLessonProposed`), **jamais** dans la table `lessons` live. Permet d'observer ce que le bot aurait appris, et offre un futur bouton "Promouvoir en prod" (cf §14 évolutions). |
| 18 | Convention intra-bougie | Quand le high et le low d'une bougie déclenchent **à la fois** un TP et un SL pour le même setup : convention conservatrice — **SL prioritaire**. Documenté comme limitation (pas d'access intra-bougie aux ticks WebSocket en replay). |
| 19 | Hard cap window size | 300 bougies maximum, validé au create-time. Couvre l'usage typique (24-100) avec marge, évite les abus, garde le coût LLM dans les limites raisonnables (~$3-5 worst case). |

---

## 3. Architecture haut-niveau

### Principe d'économie de code

Le replay **réutilise tout ce que la prod a déjà** : les activités Temporal (Detector / Reviewer / Finalizer / persistEvent), les fonctions domain (`applyVerdict`, scoring, state machine), les ports/adapters, le `PromptBuilder`, l'`IndicatorCalculator`, le `ChartRenderer`. La seule chose **nouvelle** côté backend est :

1. Un workflow Temporal dédié `replaySessionWorkflow` (thin, ~150 lignes).
2. Un branchement dans les activités existantes : si l'arg `replaySessionId` est présent, l'activité utilise des stores/notifier replay-scopés au lieu des stores live.
3. Un endpoint API qui drive le workflow par signaux.

Pas d'orchestrateur in-process parallèle, pas de duplication de la state machine, pas de re-implémentation du tracking. La règle est : **un seul code path métier, deux comportements via DI sur un seul flag**.

### Diagramme : composants et dépendances

```
┌────────────────────────────────────────────────────────────────────────┐
│                            tf-web (Bun.serve)                          │
│                                                                        │
│  Routes /api/replay/*  ──────►  ReplaySessionService (domain)          │
│                                       │                                │
│                                       ▼                                │
│            ┌──────────────────────────────────────────┐                │
│            │   TemporalClient (déjà existant)         │                │
│            │                                          │                │
│            │   - startWorkflow(replaySessionWorkflow) │                │
│            │   - signalWorkflow(replayTickSignal)     │                │
│            │   - queryWorkflow(getStateQuery)         │                │
│            └──────────────────────────────────────────┘                │
└────────────────────────────────────────────────────────────────────────┘
                                       │ signal "replayTickSignal"
                                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                analysis-worker (déjà existant)                          │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  replaySessionWorkflow (NOUVEAU, ~150 lignes)                    │ │
│  │                                                                  │ │
│  │   workflow state durable :                                       │ │
│  │     - sessionId, watchId, windowStart, windowEnd                 │ │
│  │     - aliveSetups: Map<setupId, SetupState>                      │ │
│  │     - costSoFar, costCap, status                                 │ │
│  │                                                                  │ │
│  │   setHandler(replayTickSignal, async ({ tickAt }) => {           │ │
│  │     // exactement la séquence d'un tick live, sans timer          │ │
│  │     await runDetector({ replaySessionId, tickAt, ... })          │ │
│  │     for (setup of aliveSetups) {                                 │ │
│  │       if (status REVIEWING) await runReviewer(...)               │ │
│  │       if (score >= threshold) await runFinalizer(...)            │ │
│  │       if (status TRACKING) await checkTPSLForBar(...)            │ │
│  │     }                                                            │ │
│  │   });                                                            │ │
│  │                                                                  │ │
│  │   await condition(() => playhead >= windowEnd);                  │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                       │                                │
│                                       ▼ active                         │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  ACTIVITÉS EXISTANTES (1 seul fichier, 2 comportements)          │ │
│  │                                                                  │ │
│  │  runDetector(args) {                                             │ │
│  │    const stores = args.replaySessionId                           │ │
│  │      ? deps.replayStores                                         │ │
│  │      : deps.liveStores;                                          │ │
│  │    const clock = args.tickAt                                     │ │
│  │      ? new FixedClock(args.tickAt)                               │ │
│  │      : deps.systemClock;                                         │ │
│  │    const llm = args.replaySessionId                              │ │
│  │      ? deps.cachedLLM                                            │ │
│  │      : deps.liveLLM;                                             │ │
│  │    const notifier = args.replaySessionId                         │ │
│  │      ? deps.noopNotifier                                         │ │
│  │      : deps.telegramNotifier;                                    │ │
│  │    // ... reste de l'activité INCHANGÉ                           │ │
│  │  }                                                               │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### La règle d'or : RIEN d'automatique en replay

Le workflow replay **ne fait rien tout seul**. Il est créé en idle, attend des signaux, exécute la pipeline pour le signal reçu, retourne en idle. Aucune activité ne tourne entre les ticks demandés par l'utilisateur.

| Mécanisme | Live (prod) | Replay |
|---|---|---|
| Temporal Schedule (cron) | Créé via `bootstrap-schedules.ts` | **Jamais créé** |
| `priceMonitorWorkflow` (WebSocket) | Long-running par symbole | **Jamais démarré** |
| `trackingLoop` qui poll en temps réel | Boucle continue | **Pas exécuté** ; TP/SL calculés sur high/low de la bougie au tick |
| Temporal sleeps / timers (TTL setup) | Déclenchent l'expiration | **TTL checké uniquement au tick** dans le workflow |
| Child workflows `setupWorkflow` par setup | Un par setup vivant | **Aucun child** ; l'état des setups est porté par le state du workflow replay |
| Telegram | Réel via grammy | Capturé seulement (NoopNotifier) |
| Activité au démarrage | Schedule fire t+0 | Workflow en idle, aucune activité |

Conséquence opérationnelle : si l'utilisateur ferme l'onglet, le workflow reste en idle indéfiniment. Aucun coût LLM n'est dépensé. L'état est durable (Temporal le garantit). Si l'utilisateur revient demain et clique Step, ça reprend exactement où c'était.

À l'intérieur d'un seul tick (un seul click), plusieurs activités s'enchaînent **séquentiellement** (Detector + N Reviewers + Finalizer + tracking check). C'est UN tick, UN click, mais qui peut produire plusieurs events. C'est l'équivalent exact de ce que fait la prod en quelques secondes pour un tick live.

### Diagramme : flux d'une session

```
[user] clique "Nouvelle session"
   │
   ▼
POST /api/replay/sessions
   │  1. snapshot config watch, valide cost_cap, valide window
   │  2. INSERT replay_sessions (status=READY)
   │  3. startWorkflow(replaySessionWorkflow, { sessionId, ... })
   │     → workflow démarré en idle (await condition)
   ▼
[user] redirect → /replay/:sessionId

[user] clique "Step" (count=1)
   │
   ▼
POST /api/replay/sessions/:id/step
   │  1. lire la session, calculer nextTickAt = currentPlayhead + 1 bougie
   │  2. signalWorkflow(replayTickSignal, { tickAt: nextTickAt })
   │  3. wait for new replay_events emitted by the workflow
   │     (poll par session_id + sequence, ou query workflow state)
   │  4. UPDATE replay_sessions.cost_usd_so_far (depuis activity)
   │  5. RETURN { newEvents, playheadAt, costUsdSoFar, status }
   ▼
[frontend] append events to log + markers on chart
```

Le workflow lui-même persiste son state (`aliveSetups`, `costSoFar`, etc.) dans Temporal. La table `replay_sessions` ne contient que la métadonnée + les agrégats lisibles par l'API/UI sans avoir à interroger Temporal.

---

## 4. Schéma de données

Toutes les tables sont préfixées `replay_*`. Aucune modification des tables live.

**Principe** : on ne dédouble pas le state qui est déjà porté par Temporal. Le workflow replay maintient son `aliveSetups` Map dans son state durable. La DB sert uniquement à :

1. Stocker la métadonnée de session (`replay_sessions`).
2. Persister les events émis (`replay_events`) — c'est notre projection lisible et la source de vérité de l'UI.
3. Auditer les LLM calls (`replay_llm_calls`).
4. Mutualiser les réponses LLM cachées (`llm_response_cache`).

Pas de `replay_setups` ni de `replay_session.current_playhead_at` : la "vue setups" et la position du playhead sont **dérivés** des events et du workflow state.

### `replay_sessions`

```sql
CREATE TABLE replay_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id               text NOT NULL,                 -- referenced (loose, no FK; survives watch deletion)
  name                   text,                          -- user-given label, optional
  status                 text NOT NULL,                 -- READY | PAUSED | COMPLETED | COST_CAPPED | FAILED
  window_start_at        timestamptz NOT NULL,
  window_end_at          timestamptz NOT NULL,
  workflow_id            text NOT NULL UNIQUE,          -- Temporal workflowId for this session
  config_snapshot        jsonb NOT NULL,                -- full WatchConfig at creation; immutable
  lessons_mode           text NOT NULL DEFAULT 'current', -- current | historical | disabled (see §6)
  feedback_mode          text NOT NULL DEFAULT 'run',     -- run | skip (see §6)
  cost_cap_usd           numeric(10, 4) NOT NULL DEFAULT 5.0,
  cost_usd_so_far        numeric(10, 4) NOT NULL DEFAULT 0,  -- updated by activities; not the source of truth
  failure_reason         text,                          -- non-null if status=FAILED
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replay_sessions_status_chk CHECK (
    status IN ('READY','PAUSED','COMPLETED','COST_CAPPED','FAILED')
  ),
  CONSTRAINT replay_sessions_window_chk CHECK (window_end_at > window_start_at),
  CONSTRAINT replay_sessions_lessons_mode_chk CHECK (
    lessons_mode IN ('current','historical','disabled')
  ),
  CONSTRAINT replay_sessions_feedback_mode_chk CHECK (
    feedback_mode IN ('run','skip')
  )
);

CREATE INDEX idx_replay_sessions_watch_created ON replay_sessions (watch_id, created_at DESC);
CREATE INDEX idx_replay_sessions_status ON replay_sessions (status);
CREATE UNIQUE INDEX ux_replay_sessions_workflow ON replay_sessions (workflow_id);
```

**Note** : la validation du `window_end_at - window_start_at <= 300 bougies` est faite au create-time côté domain (pas en CHECK SQL car ça dépend du timeframe de la watch). Cf §10 invariant 8.

Notes :
- `current_playhead_at` n'est plus une colonne — la position courante est queryable depuis le workflow Temporal via `getStateQuery`. L'API peut aussi la dériver depuis `MAX(occurred_at)` des `replay_events` de la session, ce qui est suffisant pour l'UI.
- `cost_usd_so_far` reste comme cache lisible rapide (mis à jour par les activités quand elles facturent un LLM call). Le compteur autoritaire est dans le workflow state, mais cette colonne évite de query Temporal pour la liste des sessions.
- `status` reflète l'état macro (READY, PAUSED, etc.) — il est mis à jour par le workflow via une activité dédiée.

### `replay_events`

Event-sourcé miroir de `events`. Inclut les events Telegram-preview neutralisés.

```sql
CREATE TABLE replay_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  setup_id          uuid,                                                 -- nullable; identifies which alive setup this event applies to (no FK; setups live in workflow state)
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

Note : `setup_id` est une UUID interne au workflow (générée par le workflow lui-même via `crypto.randomUUID()` du SDK Temporal pour rester déterministe). Il n'y a pas de FK car les setups n'ont pas de table dédiée — leur état vit dans le workflow state. La projection "liste des setups d'une session" est dérivée d'une requête event-sourcée sur `replay_events GROUP BY setup_id`.

**Event types** étendent ceux de la prod avec :
- `DetectorTickProcessed` : émis à chaque step, même si Detector retourne `ignore_reason`. Permet d'afficher la trace continue.
- `ReplayMeta` : événements meta (cap atteint, pause, resume).
- `FeedbackLessonProposed` : émis quand le feedback loop produit une lesson sur fermeture de trade. Le `payload` contient l'action (`CREATE`/`REINFORCE`/`REFINE`/`DEPRECATE`), le titre, le body, le rationale, et le `sourceTradeSetupId`. **Ces lessons ne sont jamais écrites dans la table `lessons` live** ; elles vivent uniquement dans `replay_events` jusqu'à promotion manuelle (cf §14).

**Types d'events spécifiques au replay** (en plus des types existants `SetupCreated`, `Strengthened`, `Confirmed`, `TPHit`, etc.) :

- `DetectorTickProcessed` : émis à chaque step même si le Detector retourne `ignore_reason`. Contient le reasoning, le ignore_reason, le coût.
- `ReplayMeta` : événements méta (session pausée, reprise, cost-capped). Stage = `replay-meta`.

### `replay_llm_calls`

Miroir de `llm_calls`. Permet l'audit fin du coût d'une session par stage / modèle.

```sql
CREATE TABLE replay_llm_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  setup_id            uuid,                            -- nullable, no FK (setups live in workflow state)
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

Une seule migration ajoutée (n° 0015) qui crée les 4 tables (`replay_sessions`, `replay_events`, `replay_llm_calls`, `llm_response_cache`). Aucune modification des tables live.

---

## 5. Domain & adapters de neutralisation

### Vue d'ensemble

La pipeline domain reste **strictement inchangée**. Les activités existantes (`runDetector`, `runReviewer`, `runFinalizer`, `runFeedbackAnalysis`, `persistEvent`, `markSetupClosed`, `notifyTelegram*`) sont **les mêmes** ; elles reçoivent un nouveau paramètre optionnel `replayContext` qui, s'il est présent, fait basculer l'activité vers les adapters replay-scopés.

### Le branchement DI dans les activités existantes

Les activités sont composées dans `src/workers/buildContainer.ts` avec un set de dépendances (live ou replay) injecté à la construction. La méthode propre est de **wrapper le container** : à chaque activité, on choisit le bon set de dépendances selon `args.replayContext`.

```ts
// src/workflows/scheduler/activities.ts (existing file, modified)

export function buildSchedulerActivities(deps: SchedulerActivityDeps) {
  return {
    async runDetector(args: RunDetectorArgs): Promise<RunDetectorResult> {
      // Single branch at the top — the rest of the activity is unchanged.
      const ctx = args.replayContext;
      const eventStore     = ctx ? deps.replayEventStore : deps.eventStore;
      const llmCallStore   = ctx ? deps.replayLlmCallStore : deps.llmCallStore;
      const llmProviders   = ctx ? deps.cachedLlmProviders : deps.llmProviders;
      const notifier       = ctx ? deps.noopNotifier : deps.notifier;
      const clock          = ctx ? new FixedClock(ctx.tickAt) : deps.clock;
      const sessionId      = ctx?.sessionId ?? null;

      // ... unchanged: snapshot creation, prompt build, LLM call, persist ...
    },
    // ... idem for runReviewer, runFinalizer, runFeedbackAnalysis, persistEvent, markSetupClosed, notifyTelegram*
  };
}
```

Cinq dépendances changent. Le reste de l'activité (~200 lignes par activité) reste à l'identique. **Pas de fork, pas de duplication.**

### Adapters à créer

Les adapters live existent déjà. Ceux à créer sont les variantes replay :

#### `CachedLLMProvider`

Wrapper d'un `LLMProvider` existant qui consulte `llm_response_cache` avant l'appel réel.

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

Le `inputHash` inclut le sha256 de l'image PNG → invalidation automatique si la donnée d'entrée change.

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

Le `capture` callback persiste les previews dans `replay_events.payload.telegram_preview`. **Aucun appel à l'API Telegram.**

#### `ReplayEventStore`, `ReplayLLMCallStore`, `ReplayLLMResponseCacheStore`

Implémentent les ports existants (`EventStore`, `LLMCallStore`) en écrivant dans les tables `replay_*`. Le `session_id` est porté par le contexte d'activité (passé dans `replayContext`).

#### `FixedClock`

```ts
// src/adapters/time/FixedClock.ts
export class FixedClock implements Clock {
  constructor(private fixedAt: Date) {}
  now(): Date { return this.fixedAt; }
}
```

Garantit que `now()` dans la pipeline retourne le timestamp de la bougie courante, pas l'heure réelle.

### Le workflow `replaySessionWorkflow`

Nouveau workflow Temporal, ~150 lignes. Il **n'a pas** de timer, **n'a pas** de child workflow, **n'a pas** de polling. Il attend des signaux et exécute la pipeline sur réception.

```ts
// src/workflows/replay/replaySessionWorkflow.ts (NEW)

type AliveSetup = {
  setupId: string;
  status: SetupStatus;
  currentScore: number;
  patternHint: string;
  direction: "LONG" | "SHORT";
  invalidationLevel: number;
  entry?: number;
  stopLoss?: number;
  takeProfits?: number[];
  ttlExpiresAt: Date;
};

type ReplayState = {
  status: "READY" | "PAUSED" | "COMPLETED" | "COST_CAPPED" | "FAILED";
  playheadAt: Date;
  costSoFar: number;
  alive: Map<string, AliveSetup>;
  closed: AliveSetup[];
};

export async function replaySessionWorkflow(args: {
  sessionId: string;
  watchId: string;
  windowStart: Date;
  windowEnd: Date;
  configSnapshot: WatchConfig;
  costCap: number;
}): Promise<void> {
  const state: ReplayState = { /* init from args */ };

  setHandler(replayTickSignal, async ({ tickAt }) => {
    if (state.status !== "READY") return;
    if (state.costSoFar >= args.costCap) {
      state.status = "COST_CAPPED";
      return;
    }

    // 1. Detector (always called)
    const det = await activities.runDetector({
      watchId: args.watchId,
      tickAt,
      replayContext: { sessionId: args.sessionId, tickAt },
    });
    // process new_setups → state.alive.set(...)
    // process corroborations → applyVerdict on alive[]

    // 2. For each alive setup → Reviewer (or Finalizer if score >= threshold)
    for (const setup of state.alive.values()) {
      if (setup.status === "REVIEWING" || setup.status === "FINALIZING") {
        const verdict = await activities.runReviewer({ /* ... */ replayContext: { sessionId: args.sessionId, tickAt } });
        applyVerdict(setup, verdict);
        if (setup.currentScore >= args.configSnapshot.scoreThresholdFinalizer) {
          const final = await activities.runFinalizer({ /* ... */ replayContext: { sessionId: args.sessionId, tickAt } });
          if (final.decision === "GO") {
            setup.status = "TRACKING";
            setup.entry = final.entry;
            // ... persist EntryFilled event
          } else {
            setup.status = "REJECTED";
          }
        }
      }
      // 3. Tracking deterministic check on the bar
      if (setup.status === "TRACKING") {
        const candle = await activities.fetchCandle({ symbol: args.watchId, at: tickAt });
        const hits = checkTPSL(setup, candle);
        for (const hit of hits) {
          await activities.persistEvent({ /* TPHit or SLHit */, replayContext: ... });
          if (hit.terminal) state.alive.delete(setup.setupId);
        }
      }
      // 4. TTL deterministic check
      if (tickAt >= setup.ttlExpiresAt && !["CLOSED","REJECTED"].includes(setup.status)) {
        await activities.persistEvent({ /* Expired */, replayContext: ... });
        state.alive.delete(setup.setupId);
      }
    }

    state.playheadAt = tickAt;
    if (tickAt >= args.windowEnd) state.status = "COMPLETED";
  });

  setHandler(replayPauseSignal, () => { state.status = "PAUSED"; });
  setHandler(replayResumeSignal, () => { state.status = "READY"; });
  setHandler(getStateQuery, () => state);

  // Idle until COMPLETED, COST_CAPPED, or FAILED. The workflow does NOTHING
  // on its own — it only acts on signals.
  await condition(() =>
    state.status === "COMPLETED" ||
    state.status === "COST_CAPPED" ||
    state.status === "FAILED"
  );
}
```

Points importants :

- **Pas de `sleep`, pas de timer Temporal.** Si le user ne signale jamais, le workflow attend pour toujours.
- **Pas de child workflow.** L'état des setups est dans `state.alive` (Map en mémoire workflow, durable via Temporal event history).
- **Pas de tracking en boucle.** TP/SL sont vérifiés exactement au tick utilisateur, sur la bougie correspondante.
- **Le `replayContext` est forwardé à chaque activité** pour activer le branchement DI.

### Domain : `ReplaySessionService`

Service domain pur (sans I/O) qui encapsule les règles autour des sessions :

```ts
export class ReplaySessionService {
  validateCreateArgs(args): ValidationResult       // window valide, ne touche pas le présent, etc.
  buildWorkflowId(sessionId): string               // déterministe pour idempotence
  computeNextTickAt(playheadAt, timeframe): Date   // playhead + 1 bougie
}
```

Pas de référence à Temporal ni à la DB. Testable en isolation.

---

## 6. Mécanisme de stepping

### Distinction lookback vs window

Deux notions à ne pas confondre :

- **Lookback** — combien de bougies d'historique le Detector a besoin pour calculer ses indicateurs et rendre son chart. C'est **fixé par la config de la watch** (`candles.detector_lookback`, typiquement 200). Ce n'est pas choisi par l'utilisateur, c'est imposé par la pipeline domain.
- **Window** — la plage `[window_start, window_end]` que l'utilisateur choisit à la création de la session. C'est la plage de bougies sur laquelle il va pouvoir cliquer Step.

À chaque tick au playhead `T` : le Detector reçoit les bougies `[T - detector_lookback, T]`, dont les `T - window_start` premières sont DANS la window (déjà jouées) et les `detector_lookback - (T - window_start)` autres sont du contexte hors-window.

### Multi-setup par session

**Une session peut contenir plusieurs setups simultanés**, exactement comme la prod. Le Detector peut proposer un setup A à `T+4`, puis un setup B à `T+9`. Tant qu'aucun ne ferme, ils coexistent dans le `state.alive` du workflow et reçoivent chacun leurs Reviewer ticks. La session est scopée à une **watch + window**, pas à un setup.

### Une bougie à la fois (logique du workflow sur réception du `replayTickSignal`)

À chaque tick `T` reçu par signal :

1. Le workflow vérifie son status (READY ? sinon ignore le signal).
2. Le workflow vérifie le cost cap (`costSoFar < costCap` ? sinon passe en COST_CAPPED).
3. **Detector** — appelé via activity. Reçoit `replayContext = { sessionId, tickAt: T }`.
   L'activity côté serveur :
   - fetch OHLCV `[T - lookback, T]`
   - compute scalars
   - render chart PNG figé à `T`
   - call LLM via `CachedLLMProvider`
   - persiste les events dans `replay_events` via `ReplayEventStore`
   - retourne `{ new_setups, corroborations, ignore_reason, costUsd, ...  }`
   Le workflow met à jour son `state.alive` selon le retour.
4. **Reviewer** — pour chaque alive setup en status `REVIEWING`. Idem, activité avec `replayContext`. Le workflow applique le verdict via la même fonction `applyVerdict` que la prod.
5. **Finalizer** — déclenché si `setup.currentScore >= configSnapshot.scoreThresholdFinalizer`. Si `GO`, le workflow passe le setup en `TRACKING` et persiste un event `EntryFilled` (entry = close de la bougie `T`). Si `NO_GO`, le setup passe en `REJECTED`.
6. **Tracking déterministe** — pour chaque setup en `TRACKING`, le workflow lit la bougie `T` (déjà fetchée pour le Detector) et applique :
   - `LONG` : `bar.high >= TP[i]` → TPHit ; `bar.low <= currentSL` → SLHit.
   - `SHORT` : symétrique.
   - **Convention intra-bougie** : si **dans la même bougie** la high déclenche un TP ET la low déclenche un SL, **le SL est prioritaire** (convention conservatrice — on ne sait pas l'ordre intra-bougie sans les ticks WebSocket d'époque ; mieux vaut sous-estimer les wins).
   - Premier TP hit → TrailingMoved (SL → entry).
   - SLHit ou TP final → setup passe en `CLOSED`.
7. **TTL déterministe** — pour chaque alive setup, si `T >= setup.ttlExpiresAt` → event `Expired`, setup passe en `EXPIRED`.
8. **Feedback loop sur fermeture** — pour chaque setup qui vient de passer dans un état terminal éligible (`CLOSED` après SL/TP, `INVALIDATED` post-trade, `EXPIRED` après EntryFilled — cf `shouldTriggerFeedback` dans la spec feedback-loop) ET si `feedback_mode = 'run'`, le workflow appelle `runFeedbackAnalysis` avec `replayContext`. L'activité :
   - utilise `CachedLLMProvider` (Opus) → gratuit si déjà fait
   - écrit les lessons produites dans `replay_events` (event type `FeedbackLessonProposed`)
   - **n'écrit JAMAIS** dans la table `lessons` live ni dans `lesson_events`
   - capture le Telegram preview via `NoopTelegramNotifier`
9. **`state.playheadAt = T`**, mise à jour du `state.costSoFar` cumulé.
10. Si `T >= windowEnd` → `state.status = "COMPLETED"`.

**Aucune activité n'est appelée si le workflow ne reçoit pas de signal.** L'utilisateur clique → l'API signale → le workflow exécute les 10 étapes → retourne en idle.

### Lookup des lessons selon `lessons_mode`

Avant l'étape 3 (Detector), l'activité construit le prompt en injectant des lessons selon le mode de la session :

- **`current`** (default) — query `lessons WHERE watch_id = ? AND status = 'ACTIVE' AND deprecated_at IS NULL` (comme la prod live). Le bot replayé "voit" les lessons d'aujourd'hui même si elles n'existaient pas à l'époque.
- **`historical`** — query `lessons WHERE watch_id = ? AND activated_at <= ? AND (deprecated_at IS NULL OR deprecated_at > ?)` avec `?` = `window_start_at`. Reproduit fidèlement le bot d'époque.
- **`disabled`** — liste vide. Utile pour mesurer l'impact des lessons (lancer 2 sessions identiques `current` vs `disabled` et comparer).

Le mode est immutable après création de session (porté par `config_snapshot` + colonne `lessons_mode`).

### Convention intra-bougie : pourquoi cette limitation

En production, le `priceMonitorWorkflow` reçoit des ticks WebSocket pendant la formation d'une bougie. Si dans une bougie le prix monte d'abord à TP1 puis redescend à SL=BE, la prod sait dans quel **ordre** ces niveaux ont été touchés et émet le bon event.

En replay, on n'a que l'OHLC final de la bougie. On ne peut pas reconstruire la séquence intra-bougie. **Quand TP et SL sont tous les deux dans le range high–low d'une même bougie, le replay choisit le SL** (convention conservatrice).

Conséquence : sur les setups serrés (TP et SL proches dans le range typique d'une bougie), le replay peut **sous-estimer** le R-multiple par rapport à la réalité. Ce biais est documenté dans l'UI ("résultat conservateur, peut différer du live sur les setups serrés").

### Step multiple (count > 1)

L'API peut envoyer plusieurs signaux d'affilée :

```ts
// POST /api/replay/sessions/:id/step?count=5
for (let i = 0; i < count; i++) {
  const nextTick = addCandle(currentPlayhead, i + 1, timeframe);
  await temporalClient.signalWorkflow(workflowId, replayTickSignal, { tickAt: nextTick });
  // Wait until events from this tick are emitted (poll replay_events.sequence > prevMax).
}
```

Pendant l'exécution des steps, l'API peut **streamer** les events au frontend via SSE pour montrer la progression. v1 peut se contenter d'attendre la fin du batch et retourner d'un coup ; SSE est une amélioration UX possible.

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
| GET | `/api/replay/sessions/:id/setups` | Vue dérivée : projection event-sourcée des setups apparus dans la session (groupé depuis `replay_events.setup_id`). Inclut leur état courant (status, score, R-multiple final si clos). |
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
- `windowStartAt`, `windowEndAt` (date pickers, default = 7 derniers jours). Validation client : window size ≤ 300 bougies (selon timeframe de la watch), `windowEndAt < now()`.
- `costCapUsd` (Input number, default 5).
- `lessons_mode` (Radio group) : `current` (default) / `historical` / `disabled`. Description courte sous chaque option pour guider le choix.
- `feedback_mode` (Toggle) : `run` (default) / `skip`. Hint : *"Si activé, le bot analyse les pertes pendant le replay et propose des lessons à promouvoir en prod."*
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
- **Liste des setups de la session** (en haut) :
  - Affiche tous les setups (vivants + clos), un par ligne.
  - Pour chaque setup : id court, direction, pattern_hint, score courant ou R-multiple final, status badge.
  - Tabs filter : `[Tous] [Setup A] [Setup B]` pour focus le decisions log et les markers du chart sur un setup donné.
  - Click sur un setup → focus appliqué.
- **Phase courante** (au milieu) : pour le dernier event ajouté (ou l'event actuellement focusé), affiche :
  - Le stage (Detector/Reviewer/Finalizer/Tracker).
  - Le verdict / type d'event.
  - Le reasoning textuel du LLM.
  - L'input snapshot (collapsible : prompt complet, scalars, image SHA).
  - Le telegram preview (`(NEUTRALISÉ)` en grisé).
  - Le coût + cache hit/miss.
- **Decisions log** (en bas, scrollable) : tous les events de la session par ordre chronologique, filtré par le tab actif. Chaque ligne tagguée `[Setup A]` / `[Setup B]` selon son `setup_id`. Click sur un event → focus dans la phase courante.
- **Feedback analysis card** : apparaît automatiquement quand un setup se ferme et que `feedback_mode = 'run'`. Affiche les lessons proposées par le LLM Opus : titre, action (CREATE/REINFORCE/REFINE/DEPRECATE), body, rationale, source trade. Chaque lesson a un bouton `[Promouvoir en prod]` (désactivé en v1 avec badge "Coming soon" — l'archi le supporte mais le flux de validation cross-watch sera implémenté post-v1).

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
├── replay-session-card.tsx     # card dans la liste /replay
├── new-session-modal.tsx       # modal création
├── replay-chart.tsx            # wrapper TVChart with markers + transparency
├── replay-controls.tsx         # step buttons + auto-step
├── setups-tabs.tsx             # tabs [Tous] [Setup A] [Setup B] avec filtre
├── alive-setups-list.tsx       # liste des setups (vivants + clos) en haut du panel
├── decisions-panel.tsx         # phase courante + log
├── current-phase-card.tsx      # detail of latest event
├── decisions-log.tsx           # chronological list (filtré par tab)
├── telegram-preview.tsx        # neutralized telegram message rendering
├── feedback-analysis-card.tsx  # lessons proposées par le feedback loop (avec bouton Promouvoir disabled v1)
└── replay-marker-config.ts     # mapping event type → marker shape/color (avec couleur par setup)
```

### State management

- React Query pour les fetches REST (`/api/replay/*`).
- `useReplaySteps(sessionId)` hook custom qui encapsule :
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

**Mécanisme** : le branchement DI dans chaque activité (cf §5) garantit que dès que `args.replayContext` est présent, l'activité utilise les stores replay-scopés. Les ports live (`EventStore`, `LLMCallStore`) et les ports replay (`ReplayEventStore`, `ReplayLLMCallStore`) sont des types **distincts** ; le compilateur TypeScript empêche la confusion.

### Invariant 2 : aucun appel Telegram en mode replay

Quand `replayContext` est présent, l'activité utilise `NoopTelegramNotifier` au lieu de `TelegramNotifier`. Aucun appel à l'API Telegram via grammy.

### Invariant 3 : aucun workflow Temporal long-running démarré

Le `replaySessionWorkflow` :
- ne crée **aucune** Temporal Schedule.
- ne démarre **aucun** child workflow (pas de `SetupWorkflow`, pas de `PriceMonitorWorkflow`, pas de `TrackingLoop`).
- n'utilise **aucun** Temporal sleep ou timer.

Le tracking TP/SL est calculé déterministiquement sur la bougie au tick reçu. Le TTL est checké au tick. Aucune activité n'est appelée tant qu'un signal n'est pas reçu.

### Invariant 4 : `playhead <= windowEnd` à tout moment

Garanti par le workflow lui-même : à chaque réception de signal, le tickAt est validé. Si `tickAt > windowEnd`, le signal est ignoré et le workflow termine.

### Invariant 5 : `costSoFar <= costCap` à tout moment

Vérifié AVANT chaque appel d'activité LLM dans le workflow. Si dépassement, le workflow passe en `COST_CAPPED` sans faire l'appel.

### Invariant 6 : suppression d'une watch ne casse pas les sessions

`replay_sessions.watch_id` est un `text` sans FK. Les sessions héritent du `config_snapshot` au create-time, donc elles peuvent revivre une watch supprimée. La page `/replay/:id` affiche un badge "Watch supprimée" si la watch n'existe plus.

### Invariant 7 : reproductibilité

Le workflow est déterministe (pas de `Date.now()`, pas de `Math.random()` non-Temporal). Les activités utilisent `FixedClock` quand `replayContext` est présent. Donc rejouer la même fenêtre avec la même config produit les mêmes events (modulo cache miss → la première fois facture le LLM, les suivantes hit le cache).

### Invariant 8 : window size cappée

Validé au create-time : `(window_end_at - window_start_at) / timeframe.primary <= 300`. Refus de créer la session sinon, avec message clair. Évite les sessions à coût LLM ingérable.

### Invariant 9 : lessons générées en replay ne polluent JAMAIS la prod

Les lessons proposées par le feedback loop en mode replay (`FeedbackLessonProposed` dans `replay_events`) **ne sont jamais écrites** dans la table `lessons` live ni dans `lesson_events`. La pipeline live continue à fonctionner sur son propre pool, indifférente aux sessions de replay.

**Mécanisme** : l'activité `runFeedbackAnalysis` avec `replayContext` utilise un `ReplayLessonStore` qui écrit dans `replay_events` au lieu de `lessons`. Le port `LessonStore` live n'est pas accessible depuis ce code path (DI strict).

La seule façon pour une lesson de replay d'arriver en prod sera **une action manuelle explicite** de l'utilisateur via un futur bouton "Promouvoir en prod" (hors scope v1, mais l'archi le supporte).

### Invariant 10 : convention intra-bougie documentée

Quand la bougie courante remplit à la fois la condition TP et la condition SL, le workflow choisit SL (cf §6 Convention intra-bougie). Cette convention est testée explicitement (cf §11) et affichée dans l'UI comme limitation transparente.

---

## 11. Stratégie de tests

L'avantage de réutiliser activités + domain : on **hérite des tests existants** pour 80% de la logique. Les tests spécifiques au replay couvrent uniquement le branchement DI, le workflow lui-même, le cache, et la frontend.

### Domain pur (`test/domain/replay/`)

- `ReplaySessionService.validateCreateArgs` : window valide, refus si `windowEnd <= windowStart`, refus si `windowEnd > now()`.
- `inputHash` (déjà existant — on ajoute juste un test que le hash inclut bien l'image SHA et le prompt version).

### Adapters (`test/adapters/replay/`)

- `ReplayEventStore` (testcontainers Postgres) : insert scopé par `session_id`, sequence monotonique, cascade delete.
- `NoopTelegramNotifier` : capture le message, n'appelle pas l'API (injection de fake fetch).
- `CachedLLMProvider` : miss → call inner, hit → retour sans call, `last_used_at` mis à jour, coût = 0 sur hit.
- `FixedClock` : `now()` retourne la valeur fixée.

### Activités branchées (`test/workflows/replay-activities.test.ts`)

- `runDetector` avec `replayContext` : vérifier que les écritures vont dans `replay_events` (pas `events`), que le LLM utilisé est le `CachedLLMProvider`, que le clock est `FixedClock(tickAt)`.
- `runDetector` sans `replayContext` : comportement live inchangé (régression test).

### Workflow (`test/workflows/replaySessionWorkflow.test.ts`)

- Workflow démarré, idle (aucune activité appelée).
- Signal `replayTickSignal` → activités appelées dans l'ordre attendu.
- Multi-setup : Detector crée Setup A à T+1, Setup B à T+5, vérifier que les deux reçoivent leurs Reviewer.
- TTL deterministic : setup créé à T+0 avec `ttl_candles=5`, vérifier qu'à T+5 il passe en EXPIRED.
- Cost cap : mock LLM à $0.05/call, cap=$0.10, vérifier que le 3e call ne se fait pas et le workflow passe en COST_CAPPED.
- Pause/resume : signal Pause → status PAUSED → tick suivant ignoré → signal Resume → tick suivant exécuté.
- **Intra-bougie SL prioritaire** : bougie où high touche TP1 et low touche SL → vérifier que SLHit est émis, pas TPHit.
- **`lessons_mode=current`** : injection des lessons ACTIVE du jour. Vérifier le contenu du prompt.
- **`lessons_mode=historical`** : injection filtrée par `activated_at <= window_start`. Mock 3 lessons (1 ancienne, 2 récentes) → seule l'ancienne est injectée.
- **`lessons_mode=disabled`** : aucune lesson dans le prompt.
- **Feedback loop sur fermeture** : SLHit déclenche `runFeedbackAnalysis`, lessons écrites dans `replay_events` (pas dans `lessons` live). Vérifier qu'aucun row n'apparaît dans la table `lessons`.
- **`feedback_mode=skip`** : SLHit ne déclenche PAS de feedback analysis.

Tests exécutés via `TestWorkflowEnvironment` du SDK Temporal (déjà utilisé dans `test/workflows/`).

### Intégration (`test/integration/replay/`)

- Création de session → premier step via API → vérifier qu'aucun row n'apparaît dans `setups`/`events`/`llm_calls` live.
- Suppression de session → cascade replay_events / replay_llm_calls, mais `llm_response_cache` conservé.

### Frontend (`test/client/frontend/components/replay/`)

- `ReplayChart` : transparence appliquée correctement aux bougies post-playhead.
- `DecisionsLog` : événements ordonnés, filtre par tab setup, click → focus.
- `SetupsTabs` : tabs générés depuis `replay_events GROUP BY setup_id`, click change le filtre.
- `NewSessionModal` : validation window (refus future), cost estimation affichée.
- `useReplaySteps` hook : auto-step pause/resume.

### E2E (`test/e2e/replay/` — RUN_E2E=1)

- Crée une watch, force un setup en live (existing), ouvre `/replay`, crée une session sur la fenêtre du setup, step jusqu'à la fin, vérifie que `events`/`setups`/`llm_calls` live n'ont pas été modifiés.

### Smoke LLM (`test/llm/replay-smoke.test.ts` — RUN_LLM_CLAUDE=1)

- Une session minimale (3 bougies) avec vraie API Claude. Vérifie le pipeline complet + le cache (re-run = $0).

---

## 12. Plan de phases & déploiement

Le produit cible est **la rétro-exécution interactive** décrite au préambule. On la livre en deux jalons pour réduire le risque et profiter de la valeur d'une UI fonctionnelle dès le premier jalon.

### Jalon 1 — Squelette navigable (3-4 jours, gratuit)

Objectif : la page `/replay` est en ligne, on peut créer une session sur une fenêtre passée et **naviguer dans les events des setups qui ont déjà tourné en prod** sur cette fenêtre. Le bouton "Step" est encore désactivé (pas de re-exécution LLM), mais toute la mécanique UI est là : chart, scrubber, decisions log, transparence des bougies futures.

Livrables :

- Migration 0015 : 4 tables `replay_*` + `llm_response_cache`.
- Domain pur : `ReplaySessionService` (validation des args, dérivation playhead).
- Adapters DB : `ReplaySessionRepository`, `ReplayEventStore`, `ReplayLLMCallStore`, `LLMResponseCacheStore`.
- Endpoints `/api/replay/sessions` (list/create/get/delete) + `/api/replay/sessions/:id/events|ohlcv|cost-breakdown`.
- À la création d'une session, on copie en `replay_events` les events live qui correspondent à la fenêtre demandée (lecture `events`, écriture `replay_events`). Cette copie sert de baseline visualisable jusqu'au Jalon 2.
- Pages `/replay` (liste + bouton créer) et `/replay/:id` (chart + scrubber + setups list + decisions log avec tabs par setup).
- Tests : domain, adapters (testcontainers), frontend (composants).

Ce qui **n'est pas** dans le Jalon 1 : workflow Temporal, step interactif, LLM calls, telegram preview, cost cap.

### Jalon 2 — Rétro-exécution active (1-2 semaines, payant cheap)

Objectif : le bouton "Step" déclenche réellement la pipeline LLM via le workflow Temporal. La session, à la création, démarre le `replaySessionWorkflow` en idle ; chaque click envoie un signal, exécute la pipeline pour la bougie courante, ajoute des events.

Livrables :

- Adapters de neutralisation : `CachedLLMProvider`, `NoopTelegramNotifier`, `FixedClock`.
- Branchement DI dans les activités existantes : `runDetector`, `runReviewer`, `runFinalizer`, `runFeedbackAnalysis`, `persistEvent`, `markSetupClosed`, `notifyTelegram*`. Une seule modification par activité (le bloc `if (args.replayContext) ...` au début). Pour `runFeedbackAnalysis` en mode replay : les lessons générées sont écrites dans `replay_events.payload` (event type `FeedbackLessonProposed`) au lieu de la table `lessons` / `lesson_events` live.
- Workflow Temporal `replaySessionWorkflow` (~150 lignes).
- Enregistrement du workflow + activités sur le worker `analysis-worker` existant (pas de nouveau worker process).
- Endpoint `/api/replay/sessions/:id/step` qui signale le workflow.
- Endpoints `/api/replay/sessions/:id/pause` et `/resume`.
- Cost cap vérifié dans le workflow + estimation pré-création.
- UI : step controls, current-phase card, telegram preview, breakdown coût en temps réel.
- Tests : workflow (TestWorkflowEnvironment), activités branchées (régression live + nouveaux replay), intégration isolation tables live, smoke LLM (RUN_LLM_CLAUDE=1).

À l'issue du Jalon 2, le produit cible est livré.

### Évolutions post-v1 (optionnelles, déclenchées par usage réel)

- **Override de config dans le modal** : choisir un prompt alternatif (v3 vs v4), un autre modèle, un seuil différent, désactiver un indicateur. Permet de tester une variation sans modifier le repo.
- **Comparaison de sessions** : page `/replay/compare?a=...&b=...` superposant deux sessions sur la même fenêtre (mêmes bougies, configs différentes).

Aucun engagement de planning sur ces évolutions — on les considère seulement si l'usage réel des Jalons 1+2 fait apparaître le besoin.

### Migration / déploiement

- Aucune modification des tables live.
- Aucune modification des workflows live (`schedulerWorkflow`, `setupWorkflow`, `priceMonitorWorkflow`).
- Modifications limitées aux **activités** (un bloc DI au début de chaque activité concernée, le reste inchangé).
- Pas de nouveau worker process : `analysis-worker` enregistre le `replaySessionWorkflow` en plus de l'existant.
- Aucune env var nouvelle pour la prod.
- Migration 0015 idempotente (`CREATE TABLE IF NOT EXISTS`).
- Rollback : `DROP TABLE replay_*; DROP TABLE llm_response_cache;` — aucun impact sur la prod.

---

## 13. Extensibilité

Points d'extension prévus (architecture le permet, code v1 ne les implémente pas) :

1. **Nouvelles brique pipeline** : si demain on ajoute un `RiskFilter` après le Finalizer, le Replay l'invoque automatiquement (DI). Aucun code Replay à modifier.

2. **Sources de données alternatives** : si on ajoute un futur `OnChainDataFetcher` au `MarketDataFetcher`, le replay l'utilise via injection. Aucun changement de schéma.

3. **Replay multi-watch** : aujourd'hui une session = une watch. Pour comparer deux watches sur la même période → deux sessions. v2 pourrait introduire un mode "groupé".

4. **Replay continu** : un cron qui lance des replays automatiques sur les 7 derniers jours quotidiennement pour détecter des régressions de prompts. Reposerait sur la même API.

5. **Export d'une session** : JSON/CSV pour analyse externe. Endpoint `/api/replay/sessions/:id/export`.

6. **Promotion d'une lesson replay vers la prod** : bouton dans la `feedback-analysis-card`. Workflow proposé : click → crée une row dans `lessons` live avec status `PENDING` + `source: 'replay_session_id_xxx'` → flux standard de validation par Telegram (réutilise la lesson approval pipeline existante). Cas d'usage : faire émerger des lessons en replay sur historique, valider seulement les meilleures, peupler le pool de prod sans attendre des pertes live. Désactivé en v1 (badge "Coming soon"), l'archi le supporte.

7. **Bootstrap d'une nouvelle watch** : lancer une série de replays sur les N derniers mois pour générer un corpus initial de lessons avant déploiement live. Repose intégralement sur les capacités v1, ne demande pas de code supplémentaire.

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
- **Auto-promotion des lessons replay → prod** : INTERDIT. Les lessons générées en replay ne peuvent jamais arriver automatiquement dans la table `lessons` live. Un bouton "Promouvoir en prod" est prévu (visible dans l'UI v1 mais désactivé avec badge "Coming soon"), avec un flux de validation manuelle plus tard. L'architecture est prête, l'UX validation reste à concevoir post-v1.
- **Reconstruction intra-bougie via ticks WebSocket historiques** : Binance / Yahoo ne fournissent pas un access stable aux ticks d'époque pour le retail. Le replay reste donc OHLC-only, avec la convention SL prioritaire documentée.
- **Hot reload du `lessons_mode` ou `feedback_mode`** : non. Ces modes sont fixés à la création de session. Changement = nouvelle session.

---

## 15. Glossaire

| Terme | Définition |
|---|---|
| **Session de replay** | Une instance de rétro-exécution sur une fenêtre temporelle, persistée dans `replay_sessions`. |
| **Playhead** | Le timestamp courant de simulation. Toutes les bougies `<= playhead` sont visibles au bot ; les autres sont cachées. |
| **Step** | Une avance du playhead d'une bougie (ou plus), exécutant la pipeline pour cette/ces bougies. |
| **Telegram preview** | Le message qui *aurait* été envoyé par le notifier en prod, capturé pour affichage dans l'UI. |
| **Cost cap** | Plafond de coût LLM par session. Atteint = session passe en COST_CAPPED. |
| **`inputHash`** | SHA-256 de (provider, model, prompt_version, prompt rendu, image SHA). Clé du cache LLM. |
| **`replayContext`** | Objet `{ sessionId, tickAt }` passé en argument aux activités existantes pour activer le branchement DI vers les adapters replay-scopés. Quand absent, l'activité utilise les adapters live (comportement prod inchangé). |
| **`replayTickSignal`** | Signal Temporal envoyé au `replaySessionWorkflow` pour avancer d'une bougie. Charge un `tickAt` (timestamp de la bougie). Émis par l'API en réponse à un click utilisateur, jamais automatiquement. |
| **Lookback** | Nombre de bougies d'historique nécessaires au Detector pour calculer ses indicateurs et rendre son chart. Fixé par la config de la watch (`candles.detector_lookback`). Distinct de la window utilisateur. |
| **Window** | La fenêtre temporelle `[window_start_at, window_end_at]` choisie par l'utilisateur à la création de la session — la plage sur laquelle il va pouvoir Step. |
| **Jalon 1 / Jalon 2** | Découpage de la livraison v1. Jalon 1 = fondations DB + UI sans LLM (lecture des events live d'une fenêtre passée). Jalon 2 = workflow + step interactif avec vrais LLM calls. |
| **Rétro-exécution contrôlée** | Synonyme du Replay Mode. Désigne la nature step-by-step, manuelle, contrôlée par l'utilisateur, de l'exécution de la pipeline sur des bougies passées. |
| **Side-effect neutralisé** | Un effet externe normalement présent en prod (Telegram, écriture sur tables live, démarrage de workflows Temporal long-running) qui est explicitement désactivé en replay via injection d'un adapter substitué. |
| **`lessons_mode`** | Paramètre de session ∈ `{current, historical, disabled}` qui contrôle quelles lessons sont injectées dans les prompts du replay. `current` (default) = lessons actives aujourd'hui ; `historical` = lessons qui existaient à `window_start_at` ; `disabled` = aucune. |
| **`feedback_mode`** | Paramètre de session ∈ `{run, skip}` qui contrôle si le feedback loop (analyse rétroactive via Opus à la fermeture d'un trade) tourne. Default `run`. |
| **`FeedbackLessonProposed`** | Type d'event spécifique au replay, émis par l'activité `runFeedbackAnalysis` quand elle produit une lesson. Le payload contient l'action proposée (CREATE/REINFORCE/REFINE/DEPRECATE), le title, le body, le rationale, et le `sourceTradeSetupId`. Ces lessons vivent dans `replay_events` uniquement, **jamais** dans la table `lessons` live. |
| **Convention intra-bougie** | Quand le high et le low d'une même bougie déclenchent à la fois un TP et un SL pour un setup en tracking, le replay choisit SL (convention conservatrice). Approximation imposée par l'absence d'access aux ticks WebSocket d'époque. |
| **Promouvoir en prod** | Action manuelle prévue (v2) permettant de copier une `FeedbackLessonProposed` de `replay_events` vers la table `lessons` live en status PENDING, où elle suivra le flux de validation Telegram standard. Bouton visible mais désactivé en v1. |
