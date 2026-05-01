# Naked vs Equipped — Empirical Validation Runbook

Date: 2026-05-01

## Goal

Validate the core hypothesis that drove the indicators modularization: **does the LLM produce better trading proposals with no indicators ("naked") or with the recommended set?** Without this data, the modularization is architecturally clean but operationally untested.

## Setup

### 1. Pick a stable, liquid asset

- Recommended: BTC/USDT on Binance, 1h timeframe.
- Avoid weekends if testing < 1 week (lower liquidity, fewer signals).

### 2. Create two watches with identical config except `indicators`

Watch A: **naked**
- `id: btc-1h-naked`
- `indicators: {}`
- `analyzers.detector.fetch_higher_timeframe: true` (for fair HTF comparison)
- Same `setup_lifecycle`, `pre_filter` (mode = lenient, default thresholds), `analyzers` model selection.

Watch B: **equipped (recommended preset)**
- `id: btc-1h-equipped`
- `indicators: { ema_stack: { enabled: true }, rsi: { enabled: true }, volume: { enabled: true }, swings_bos: { enabled: true }, structure_levels: { enabled: true } }`
- All other config identical to A.

### 3. Run for a fixed window

- Minimum: 48 hours.
- Recommended: 1 week (covers full daily cycle).

## Metrics to compare

After the window closes, query the database for both watches:

### A. Setup volume
```sql
SELECT watch_id, COUNT(*) AS proposed_setups
FROM setups
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
  AND created_at >= '<start>'::timestamptz
GROUP BY watch_id;
```

### B. Setup confirmation rate
```sql
SELECT watch_id,
       COUNT(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed,
       COUNT(*) FILTER (WHERE status = 'INVALIDATED') AS invalidated,
       COUNT(*) FILTER (WHERE status = 'EXPIRED') AS expired
FROM setups
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
GROUP BY watch_id;
```

### C. Setup outcome (after maturation)
```sql
SELECT watch_id, outcome, COUNT(*)
FROM setups
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
  AND outcome IS NOT NULL
GROUP BY watch_id, outcome;
```

### D. Token cost per watch
```sql
SELECT watch_id,
       SUM(prompt_tokens + completion_tokens) AS total_tokens,
       SUM(cost_usd) AS total_cost
FROM llm_calls
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
GROUP BY watch_id;
```

### E. Qualitative — read 5 setups from each

Pick the 5 highest-`initial_score` setups from each watch. Read the `raw_observation` field on each.
- Naked: are the observations creative / qualitatively different from the equipped ones?
- Equipped: do the observations cite indicator values that are absent from the naked observations?

## Decision criteria

| Outcome | Verdict |
|---------|---------|
| Equipped: more confirmed, fewer invalidated, lower cost-per-confirmation | Equipped is better. Modularization let user pick the right tradeoff (this is the expected result). |
| Naked: comparable confirmed count, lower cost, novel pattern types in raw_observation | Naked is interesting — keep iterating on prompt creativity. |
| Both: similar confirmed counts | Modularization neutral; the architecture pays off in flexibility but not in raw quality. |
| Naked: many fewer setups | Expected — naked is less guided. Verify whether the few setups it does propose are higher-quality. |

## Follow-up actions

After 1 week of data:

- If equipped wins clearly → mark `recommended` as the default UI suggestion in the wizard, deprioritize naked-mode prompt-engineering work.
- If naked wins on quality (even if fewer signals) → invest in better naked prompts (stronger creativity prompts, more visual cues in chart, etc.).
- If neutral → document the findings and let users pick based on cost preference.

Track findings in this same file as an addendum.
