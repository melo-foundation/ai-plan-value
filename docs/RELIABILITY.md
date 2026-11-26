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
σ² = σ_S² + σ_W² + σ_C² + σ_X²
σ_S² = Σ subsidy-chain steps (A, B)
σ_W  = token-mix term for the active cost metric
σ_C  = cost-metric step (C)
σ_X  = subsidy step for one cost metric only (sdkClient, T3 turn)
range = real cost × e^(±1.2816 σ)
```

- Independent steps add in quadrature.
- An agent estimate built on an effort estimate counts the effort step once.
- Two sources for one cell pool in log space with weights 1/σ² when they differ by ≤ 2·√(σ₁² + σ₂²); otherwise the lower-σ source is kept and widened by |ln S₁ − ln S₂| / 2.
- Upstream grade floors σ_S: high 0.08, medium 0.18, low 0.40.

## Step σ

Values are starting estimates. Steps are treated as independent.

Tables show σ snapped to the buckets 0.05 / 0.1 / 0.2 / 0.35 / 0.5 / 0.7 (nearest in log space; ≥ 0.7 shows as 0.7). The computation uses the exact values: `STEP_SIGMA` and `costSteps` in `scripts/reliability.mjs`, published as `stats.reliability.steps` and `stats.reliability.costSteps`.

### A. Sources

| Id | Source | σ |
|---|---|---|
| S1 | Official credit pool, rate table, API list price | 0.05 |
| S2 | Official quota table through a workload mix | 0.1 |
| S3 | Several accounts, ≥ 100 pp, within ×1.1 | 0.1 |
| S4 | One account, own token logs + first-party meter | 0.2 |
| S5 | Screenshot: first-party panel, token breakdown, ≥ 15 pp | 0.35 |
| T | Known account, large sample, figures in text | 0.35 |
| S6 | Tweet, gateway panel, any other screenshot | 0.5 |
| S7 | Claim with no numbers | 0.7 |
| Priors | Preliminary, n users | 0.40 / √n |
| Priors | Graded row: high / medium / low | 0.1 / 0.2 / 0.5 |

Tweets and single screenshots start at S6 (Low). They start at S5 (Medium) only with a first-party panel, a token breakdown and ≥ 15 pp of quota.

Add-ons: integer % reading over Δ pp `0.41/Δ`; promo period 0.2; attribution inferred 0.2; raw tokens 0.1; data older than 45 / 90 days 0.2 / 0.35.

### B. Transfers

| Id | Step | σ |
|---|---|---|
| P1 | Sibling plan, official ratio | 0.2 |
| P2 | Sibling plan, ruled ratio | 0.35 |
| X1 | Sibling plan via the model's measured ratio to an anchor model | 0.2 + pooled σ of the cells used |
| M1 | Other model, same pool, vendor-stated price-proportional draw | 0.2 |
| M2 | Other model, same pool, rate card (OpenAI) | 0.35 |
| M3 | Other model, price ratio assumed (≤ 5× / > 5× or ruled weight) | 0.2 / 0.5 |
| M4 | Successor assumed equal | 0.7 |
| M5 | Model with its own weight or cap valued by another model's multiple | > 0.7 |
| token | Token-denominated pool, list-price blend ratio | 0 |
| inconsistent | Failed cross-plan quad or same-pool check | + \|D\| / 2 |

### W. Token mix

| Plans | σ_W |
|---|---|
| Claude Pro / Max / Ultra / Team | from the scenario range below, min 0.05 (0.1 when the sample mix is unrecorded); CursorBench 0.2 |
| Google AI, SuperGrok, Kimi, MiniMax | 0.2 |
| ChatGPT, Cursor, GitHub Copilot, GLM | 0.05 |
| API, Kilo Pass, Ollama credits | 0 |
| Other | 0.1 |

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
| Effort interpolated | live LOOCV (≈ 0.2) | ≈ ±1.1 pts |
| Effort extrapolated 1 / 2 / 3 / 4+ steps | ≈ 0.2 / 0.35 / 0.5 / 0.7 | ≈ ±1.5 / 2.6 / 3.1 / 4.6 |
| ARC-AGI-2 effort ratio | 0.35 | ±2.9 |
| Agent: same agent / other agent | ≈ 0.2 / 0.35 | ±1.5 / 2.7 |
| Agent: Terminal-Bench fit / below range | 0.2 / 0.7 | ±2.8 / 4.6 |
| T3 turn: ≥ 1,000 / ≥ 100 / < 100 turns | 0.1 / 0.2 / 0.35 | — |
| T3 turn: across agents | live, 0.15–0.35 (≈ 0.2) | — |
| CursorBench | 0.1 | 0 |
| Per 1M tokens | 0.05 | — |

LOOCV values: σ = ln(1 + median % error) / 0.6745, from `stats.effortAccuracy` and `stats.codingAgentEstimates.accuracy`.

T3 across agents (`REL.t3HarnessSigma`, reported as `stats.reliability.t3HarnessFit`):

```
σ = n-weighted sd of ln(T3 min/turn) over stats.reliability.t3Harness groups with n ≥ 3, × k/(k − 1)
clamped to 0.15–0.35; 0.2 with fewer than 2 groups
```

- Inputs on 2026-11-26: Codex 5.8 min (n 14), Claude Code 6.8 (n 9), Antigravity 7.0 (n 4), OpenCode 5.1 (n 3). Raw sd 0.12; σ = 0.15 (floor).
- The T3 $/turn ÷ AA $/task gap (Codex 0.68, Claude Code 0.16) is on the AA side: AA Coding Agent tasks take 16 min in Codex and 53 min in Claude Code.

### X. Metric-only subsidy steps

| Id | Rows | Factor on subsidy | σ |
|---|---|---|---|
| sdkClient | Claude Pro / Max / Ultra / Team, T3 turn metric | ÷ 2.1 (range 1.8–2.9) | 0.2 |

- Switch: `APPLY_SDK_CLIENT_MULTIPLIER` in `scripts/refresh-data.mjs`; constants `REL.SDK_CLIENT`; σ = ln(2.9 / 1.8) / 2.563 = 0.186.
- Sources: [claude-code #97074](https://github.com/anthropics/claude-code/issues/97074) (1.8×, 2.0×, 2.4× via T3 Code, 2.83–2.97× via the Agent SDK, 1.6–1.7× from the T3 Code maintainer), [claude-code #111890](https://github.com/anthropics/claude-code/issues/111890) (1.86× over 8 runs).
- The reports measure the 5-hour bar. Two of them see no change on the weekly bar.
- Data: `entry.clientFactor.turn { f, lo, hi, k }`, `entry.rel.x.turn`, `stats.reliability.sdkClient`.

## Consistency checks

| Check | Rule | Action |
|---|---|---|
| T-quad | Plan families (Claude, ChatGPT, Google AI, Kimi, SuperGrok, Cursor); quads with ≥ 3 measured cells; D = ln[S(a,p)/S(b,p)] − ln[S(a,q)/S(b,q)] | \|D\| ≤ ln 1.3 pass; > ln 1.6 or z > 2 fail: the largest-σ cell gets \|D\|/2 and flag `inconsistent` |
| T-pool | Measured Gemini models on one Google plan; Opus / Sonnet on one Claude plan | > ×1.3: higher-σ cell gets \|D\|/2 and flag `inconsistent` |

Results: `stats.reliability.consistency`.

## Calibration

Ledger: `data/reliability/history.jsonl`, one JSON object per line.

| Line | Fields | Written when |
|---|---|---|
| cell | `d` date, `id` (`plan\|model[\|offpeak]`), `v` subsidy, `s` σ_S, `lo` / `hi` 80% range of the subsidy, `k` chain step kinds, `x` 1 derived / 0 direct | derived cell new or changed (value ±0.5%, σ ±0.005, kinds); direct cell right after a derived line |
| deploy | `t: "deploy"`, `d`, `counts`, `quadFails`, `t3` (harness ratios, n ≥ 3), `t3Sigma` | every recorded run |

- Recorded when `GITHUB_ACTIONS=true` or with `node scripts/refresh-data.mjs --record-history`. Other runs read the ledger only.
- CI: the deploy workflow appends this run's new lines to the latest `main` in a separate worktree and pushes `Record reliability history … [skip ci]` (needs `contents: write`). A failed push logs a warning and the deploy continues; that run's lines are lost.
- Branch protection that blocks `github-actions[bot]` pushes to `main` stops the ledger; allow the bot or the push fails every run.
- `.gitattributes` sets `merge=union` on the ledger.

`stats.reliability.calibration`:

| Field | Value |
|---|---|
| `cases` | derived cells later measured directly |
| `coverage` | share of cases whose direct value fell inside the old 80% range; target 0.8 |
| `kinds[k]` | per step kind: `n`, `coverage`, `meanLn` and `sdLn` of ln(direct / derived), `prior` |
| `kinds[k].fitted`, `refitDue` | from n ≥ 15: σ_k² = mean[ln² r − (σ_pred² − σ_k,prior²) − σ_direct²]; reported, not applied |
| `refitDue`, `lowCoverage` | kinds with n ≥ 15; kinds with n ≥ 15 and coverage < 0.6 |
| `recent` | last 50 cases |

To apply a refit: copy `kinds[k].fitted` into `STEP_SIGMA` in `scripts/reliability.mjs`.

`stats.reliability.lastDeploy` is the previous deploy line; `stats.reliability.history` gives the ledger size.

## Site-side lists (`scripts/refresh-data.mjs`)

| List | Effect |
|---|---|
| `PROMO_EXPIRY` (`plan`, `model`, `until`) and Fei `promo_until` | row dropped after `until`; kept as a ratio-transfer reference |
| `QUOTA_CHANGES` (`plan`, `model`, `date`, `action`) | older rows dropped (`drop`) or Speculative |
| `MODEL_RETIREMENTS` (`model`, `after`) | rows dropped after the date |
| `sharedPoolRules` | `same-pool` (M1) or `token` carryover; skipped when the cell is measured |
| `ratioTransferRules` | X1 carryover, pooled over reference plans |

## Fable cap

Fable on Claude Pro / Max / Ultra: `capShare` 0.5, `subsidyReadings { shared, own }`, own = shared × 0.5. `Tasks/mo` = fee ÷ real cost × capShare in the Shared reading.

## Markers

| Mark | Meaning |
|---|---|
| `~` before a value | derived cell: subsidy with a transfer step, estimated cost, or estimated score |
| ● ◐ ○ ◌ after the model name | row level; tooltip lists level, ×factor, subsidy chain (with token mix and Agent SDK client factors), cost source, score error, range |
| faded row | Low or Speculative |

## Settings

| Setting | Values | Default |
|---|---|---|
| Min confidence | High, Medium, Low, Speculative | Medium |
| Cost | Point, Range | Point |
| Fable cap | Shared, Fable only | Shared |

The bar chart and the table both show rows at or above the Min confidence setting. Range shows `$lo–hi` for Medium, Low and Speculative rows.

## URL parameters

| Parameter | Values |
|---|---|
| `conf` | `h`, `m`, `s` (`l` is the default) |
| `cost` | `range`, a max cost, or both: `cost=2,range` |
| `fable` | `own` |
| `est` (legacy) | `0` → `h`, `h` → `m`, `hm` → `l`, `hml` → `s` |
| `extrap=1` / `nointerp=1` (legacy) | `s` / `h` |
| `noest=1` (legacy) | at most `m` |

## Data

- `entry.rel`: `level`, `sigma`, `lo`, `hi` (AA task cost, Intelligence Index, Shared); `s`; `w` and `c` per cost metric; `x` per cost metric (metric-only subsidy steps); `score { ii, agent }`; `cap`; `chain`; `flags`; `sd` (subsidy derived); `ce` (metrics with an estimated cost); `cl` (cost source labels).
- `entry.quotaMix[metric]`: `{ f, lo, hi }` on corrected Claude rows.
- `entry.clientFactor[metric]`: `{ f, lo, hi, k }`; the page multiplies the subsidy by `f`.
- `stats.chains[id]`: `steps [{k, s, t}]`, `lines` (nearest step first), `anchors`, `flags`.
- `stats.reliability`: σ tables, `sigmaBuckets`, thresholds, `counts`, `countsByMode`, `consistency`, `unresolved`, `priorsSkipped`, `droppedRows`, `t3Harness`, `t3HarnessFit`, `sdkClient`, `calibration`, `lastDeploy`, `history`.

## Tests

`node scripts/test-site.mjs` fails when: an entry lacks `rel`; Σ step σ² ≠ rel.s²; a derived subsidy is above its anchor's level or a row above its upstream grade; an M4/M5 row is not Speculative; an expired promotion or pre-change row is listed; a failed quad is not allow-listed; the Priors `plans: []` records are missing; Neon is not pooled; Kimi K3.1 Pro ≠ K3 × 0.667; Fable readings are inconsistent; the Claude mix correction does not match the flag; `t3Harness` has < 5 Codex or Claude Code pairs; > 5% of Fei derived rows are unresolved; the SDK client step is on a row other than a Claude first-party T3 row, or off the flag; `rel.c.turn` ≠ sample term ⊕ `t3HarnessSigma`; a Methodology or step-table σ is not a bucket; a ledger line is malformed; the workflow does not commit the ledger with `[skip ci]`.

Tests that need history print `SKIP` until the ledger has the data:

| Test | Fails when | Needs |
|---|---|---|
| Calibration coverage | a step kind with n ≥ 15 has coverage < 60% | a kind with n ≥ 15 |
| T3 harness drift | Codex or Claude Code ratio moved more than ×1.5 since the last deploy | a previous deploy line |
| Quad fails | quad fails > last deploy's + 2 | a previous deploy line |
