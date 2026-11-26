# Reliability

Every row carries `σ`, the standard deviation of ln(real cost). The build writes it to `entry.rel`; the page recomputes it for the active cost metric, benchmark and Fable cap.

## Levels

| Level | Glyph | σ | 80% of values within | Score error | Shown by default |
|---|---|---|---|---|---|
| High | ● | ≤ 0.18 | ×1.25 | ≤ 1.5 pts | yes |
| Medium | ◐ | ≤ 0.40 | ×1.7 | ≤ 3 pts | yes |
| Low | ○ | ≤ 0.70 | ×2.5 | ≤ 5 pts | yes, faded |
| Speculative | ◌ | > 0.70 | beyond ×2.5 | > 5 pts | no |

Row level = the worst of: the cost level from σ, the score level from the active benchmark's error, and the upstream grade (Fei2411 / Priors `high`, `medium`, `low`). A row with an M4 or M5 step, or data predating a listed quota change, is Speculative.

## Combination

```
σ² = σ_S² + σ_W² + σ_C²
σ_S² = Σ subsidy-chain steps (A, B)
σ_W  = token-mix term for the active cost metric
σ_C  = cost-metric step (C)
range = real cost × e^(±1.2816 σ)
```

- Independent steps add in quadrature.
- An agent estimate built on an effort estimate counts the effort step once.
- Two sources for one cell pool in log space with weights 1/σ² when they differ by ≤ 2·√(σ₁² + σ₂²); otherwise the lower-σ source is kept and widened by |ln S₁ − ln S₂| / 2.
- Upstream grade floors σ_S: high 0.08, medium 0.18, low 0.40.

## Step σ

### A. Sources

| Id | Source | σ |
|---|---|---|
| S1 | Official credit pool, rate table, API list price | 0.03 |
| S2 | Official quota table through a workload mix | 0.12 |
| S3 | Several accounts, ≥ 100 pp, within ×1.1 | 0.10 |
| S4 | One account, own token logs + first-party meter | 0.20 |
| S5 | Screenshot: first-party panel, token breakdown, ≥ 15 pp | 0.35 |
| T | Known account, large sample, figures in text | 0.30 |
| S6 | Tweet, gateway panel, any other screenshot | 0.45 |
| S7 | Claim with no numbers | 0.70 |
| Priors | Preliminary, n users | 0.40 / √n |
| Priors | Graded row: high / medium / low | 0.10 / 0.22 / 0.45 |

Tweets and single screenshots start at S6 (Low). They start at S5 (Medium) only with a first-party panel, a token breakdown and ≥ 15 pp of quota.

Add-ons: integer % reading over Δ pp `0.41/Δ`; promo period 0.20; attribution inferred 0.15; raw tokens 0.10; data older than 45 / 90 days 0.15 / 0.30.

### B. Transfers

| Id | Step | σ |
|---|---|---|
| P1 | Sibling plan, official ratio | 0.25 |
| P2 | Sibling plan, ruled ratio | 0.35 |
| X1 | Sibling plan via the model's measured ratio to an anchor model | 0.15 + pooled σ of the cells used |
| M1 | Other model, same pool, vendor-stated price-proportional draw | 0.15 |
| M2 | Other model, same pool, rate card (OpenAI) | 0.30 |
| M3 | Other model, price ratio assumed (≤ 5× / > 5× or ruled weight) | 0.25 / 0.45 |
| M4 | Successor assumed equal | 0.70 |
| M5 | Model with its own weight or cap valued by another model's multiple | 1.0 |
| token | Token-denominated pool, list-price blend ratio | 0 |
| inconsistent | Failed cross-plan quad or same-pool check | + \|D\| / 2 |

### W. Token mix

| Plans | σ_W |
|---|---|
| Claude Pro / Max / Ultra / Team | from the scenario range below, min 0.05 (0.12 when the sample mix is unrecorded); CursorBench 0.15 |
| Google AI, SuperGrok, Kimi, MiniMax | 0.15 |
| ChatGPT, Cursor, GitHub Copilot, GLM | 0.05 |
| API, Kilo Pass, Ollama credits | 0 |
| Other | 0.10 |

Claude correction (`APPLY_CLAUDE_MIX_CORRECTION` in `scripts/refresh-data.mjs`, reported as `stats.reliability.claudeMixCorrection`):

```
φ(mix) = Σ w_k · $_k / Σ $_k
w = { input 1, output 1, cache write 5m 1, cache write 1h 0.625, cache read 0.5 }
S_eff = S × φ(sample mix) / φ(metric mix)
```

- Scenarios (cache read, 1h write): (0.31, 1.0), (0.50, 0.625), (0.56, 0.5), (0.81, 0). The metric's cache writes are also evaluated as 1-hour writes.
- σ_W = ln(max/min factor) / 2.563.
- Sample mix: Fei's `worth $X（读 … 写 … 入 … 出 …）` breakdown; else the anchor row's; else Fei's anthropic workload convention.
- Metric mix: AA Intelligence cost breakdown; T3 per-turn tokens (also used for AA Coding Agent); 3:1 input:output for per-1M tokens.
- Flag off: S stays uncorrected and σ_W = √(σ_range² + (ln factor)²).

### C. Cost and score

| Step | σ ($) | Score error |
|---|---|---|
| AA measured | 0.05 | 0 |
| Effort interpolated | live LOOCV (≈ 0.17) | ≈ ±1.1 pts |
| Effort extrapolated 1 / 2 / 3 / 4+ steps | ≈ 0.21 / 0.37 / 0.52 / 0.70 | ≈ ±1.5 / 2.6 / 3.1 / 4.6 |
| ARC-AGI-2 effort ratio | 0.39 | ±2.9 |
| Agent: same agent / other agent | ≈ 0.16 / 0.40 | ±1.5 / 2.7 |
| Agent: Terminal-Bench fit / below range | 0.25 / 0.60 | ±2.8 / 4.6 |
| T3 turn: ≥ 1,000 / ≥ 100 / < 100 turns, plus cross-harness 0.35 | 0.10 / 0.25 / 0.40 | — |
| CursorBench | 0.10 | 0 |
| Per 1M tokens | 0.03 | — |

LOOCV values: σ = ln(1 + median % error) / 0.6745, from `stats.effortAccuracy` and `stats.codingAgentEstimates.accuracy`.

## Consistency checks

| Check | Rule | Action |
|---|---|---|
| T-quad | Plan families (Claude, ChatGPT, Google AI, Kimi, SuperGrok, Cursor); quads with ≥ 3 measured cells; D = ln[S(a,p)/S(b,p)] − ln[S(a,q)/S(b,q)] | \|D\| ≤ ln 1.3 pass; > ln 1.6 or z > 2 fail: the largest-σ cell gets \|D\|/2 and flag `inconsistent` |
| T-pool | Measured Gemini models on one Google plan; Opus / Sonnet on one Claude plan | > ×1.3: higher-σ cell gets \|D\|/2 and flag `inconsistent` |

Results: `stats.reliability.consistency`.

## Site-side lists (`scripts/refresh-data.mjs`)

| List | Effect |
|---|---|
| `PROMO_EXPIRY` (`plan`, `model`, `until`) and Fei `promo_until` | row dropped after `until`; kept as a ratio-transfer reference |
| `QUOTA_CHANGES` (`plan`, `model`, `date`, `action`) | older rows dropped (`drop`) or Speculative |
| `MODEL_RETIREMENTS` (`model`, `after`) | rows dropped after the date |
| `sharedPoolRules` | `same-pool` (M1) or `token` carryover; skipped when the cell is measured |
| `ratioTransferRules` | X1 carryover, pooled over reference plans |

## Billing

```
Yearly fee     = annual price ÷ 12
Yearly subsidy = subsidy × monthly price ÷ yearly price per month
σ²            += 0.03²   (official annual list price, Yearly only)
```

| Row | Monthly | Yearly |
|---|---|---|
| Official annual price | monthly fee | `$X/yr` |
| No annual option | monthly fee | `$X/mo (no annual)` |
| Annual price unknown | monthly fee | `$X/mo (annual ?)` |
| Annual variant (`(Annual)`, `(CN Annual)`) | hidden | shown; its monthly twin for the same model is hidden |

- Prices, sources and check dates: `BILLING_PERIODS` in `scripts/billing-periods.mjs`.
- To add a plan: add a record with `status` `official` (and `annual`), `none` or `unknown`, plus `url` and `checked`. `legacy: true` applies the record to the `, legacy` row.
- `stats.billing.unmatched` non-empty: add records for the listed plans.
- `stats.billing.mismatches` non-empty: recheck the official monthly price.

## Fable cap

Fable on Claude Pro / Max / Ultra: `capShare` 0.5, `subsidyReadings { shared, own }`, own = shared × 0.5. `Tasks/mo` = fee ÷ real cost × capShare in the Shared reading.

## Markers

| Mark | Meaning |
|---|---|
| `~` before a value | derived cell: subsidy with a transfer step, estimated cost, or estimated score |
| ● ◐ ○ ◌ after the model name | row level; tooltip lists level, ×factor, subsidy chain, cost source, score error, range |
| faded row | Low or Speculative |

## Settings

| Setting | Values | Default |
|---|---|---|
| Min confidence | High, Medium, Low, Speculative | Medium |
| Cost | Point, Range | Point |
| Fable cap | Shared, Fable only | Shared |
| Billing | Monthly, Yearly | Monthly |

The bar chart and the table both show rows at or above the Min confidence setting. Range shows `$lo–hi` for Medium, Low and Speculative rows.

## URL parameters

| Parameter | Values |
|---|---|
| `conf` | `h`, `m`, `s` (`l` is the default) |
| `cost` | `range`, a max cost, or both: `cost=2,range` |
| `fable` | `own` |
| `billing` | `yearly` |
| `est` (legacy) | `0` → `h`, `h` → `m`, `hm` → `l`, `hml` → `s` |
| `extrap=1` / `nointerp=1` (legacy) | `s` / `h` |
| `noest=1` (legacy) | at most `m` |

## Data

- `entry.rel`: `level`, `sigma`, `lo`, `hi` (AA task cost, Intelligence Index, Shared); `s`; `w` and `c` per cost metric; `score { ii, agent }`; `cap`; `chain`; `flags`; `sd` (subsidy derived); `ce` (metrics with an estimated cost); `cl` (cost source labels).
- `entry.quotaMix[metric]`: `{ f, lo, hi }` on corrected Claude rows.
- Subscription rows: `priceUsdMonthly`; `priceUsdYearly` (annual fee ÷ 12, or null); `billingYearly` (`official`, `none`, `unknown`, `variant`); `billingOnly: "yearly"` on annual-variant rows; `hideYearly` on their monthly twins; `rel.y` (0.03) on rows with an official annual price.
- `stats.billing`: row counts per status, `unmatched` plans, `mismatches` (stored vs official monthly price).
- `stats.chains[id]`: `steps [{k, s, t}]`, `lines` (nearest step first), `anchors`, `flags`.
- `stats.reliability`: σ tables, thresholds, `counts`, `consistency`, `unresolved`, `priorsSkipped`, `droppedRows`, `t3Harness`.

## Tests

`node scripts/test-site.mjs` fails when: an entry lacks `rel`; Σ step σ² ≠ rel.s²; a derived subsidy is above its anchor's level or a row above its upstream grade; an M4/M5 row is not Speculative; an expired promotion or pre-change row is listed; a failed quad is not allow-listed; the Priors `plans: []` records are missing; Neon is not pooled; Kimi K3.1 Pro ≠ K3 × 0.667; Fable readings are inconsistent; the Claude mix correction does not match the flag; `t3Harness` has < 5 Codex or Claude Code pairs; > 5% of Fei derived rows are unresolved; a subscription row lacks `priceUsdMonthly`; a yearly price exceeds the monthly one; a plan × model shows twice in Monthly or Yearly; the yearly subsidy ≠ subsidy × monthly ÷ yearly; a plan has no billing record.
