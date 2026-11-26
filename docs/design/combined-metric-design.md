# Combined real-world $/work metric: design

Data: `public/data/combined.json` (generated 2026-11-26) and the Priors snapshot (2026-11-25). Analysis scripts are in `scratchpad/cm/` (`build.py`, `analyze.py`, `loo.py`, `resid.py`, `sim.py`). The variant key is `model@effort`, with dots changed to hyphens and the `aa-` prefix and `~config` suffix removed. Where a benchmark has several harness rows for one variant, the cost is the geometric mean of those rows.

## 1. Inventory

### 1a. Sources

| id | source | unit of work | harness | success | variants w/ cost | sample per variant | freshness |
|---|---|---|---|---|---|---|---|
| aa-index | AA Intelligence Index v5.0.2 `aaCostPerTaskUsd` | 1 index task (9 evals) | raw / AA's own (Stirrup, mini-SWE) | score | 136 measured; site: 1488 entries measured + 1089 effort-estimated | 9 evals | 2026-11-25 |
| aa-agent | AA Coding Agent Index `codingAgent.costPerTaskUsd` | 1 agent task (3 evals) | vendor product (15 agents) | score | 40 variants / 66 configs; site: 332 entries measured, 2003 estimated | ~966 attempts per config | 2026-11-25 |
| cursor | CursorBench v4.1 | 1 Cursor task | Cursor | score (grading not published) | 53 | not published | snapshot |
| t3 | T3 Code `t3Turn.costPerTurnUsd` | 1 real user turn | first-party mix (Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok) | **none** | 179 | turns: min 33, median 4,380, max 52.9M; 48 variants < 1k turns | rolling 30 days, 2026-10-26..11-25 |
| price | `aaPricing.blended3to1Per1M` | 1M tokens | n/a | none | 221 | n/a | live |
| deepswe | DeepSWE 1.1 | 1 SWE task | mini-swe-agent (neutral) | pass rate | 70 | 113 tasks × 4 | snapshot |
| fc2 | FrontierCode 2.0 main (Cognition) | 1 mergeable-PR task | vendor (Devin 48, Codex 39, Claude Code 35, Antigravity 11) | pass rate | 144 | 132 tasks | snapshot |
| fc11 | FrontierCode 1.1 main | same | vendor (claude-code 52, codex 43, devin 20) | pass rate | 134 | 100 tasks | snapshot |
| weirdml | WeirdML v3 | 1 ML task | vendor CLI | score | 27 | 11 tasks, 76–105 runs | run 2026-11-13 |
| ramp | Ramp SWE-Bench v2 | 1 SWE task | the lab's own harness | pass rate | 18 (high effort only) | 500 tasks | snapshot |
| ramp-bash | Ramp SWE-Bench v2 (Bash) | 1 SWE task | mini-swe-agent | pass rate | 24 (high only) | 500 tasks | snapshot |
| bughunt | Bug Hunt Bench | 1 run (105 bugs) | vendor CLI | fixed share | 133 | 105 bugs × 3 runs | row dates 2026-07-26..11-25 |
| arc2 | ARC-AGI-2 | 1 puzzle | raw CoT | pass rate | 279 | semi-private set | snapshot |
| aa-tb41 / aa-fc2 | AA Terminal-Bench 4.1 / FrontierCode-AA (per-eval) | 1 task | mini-SWE / Stirrup | pass rate | 136 each | 66×3 / 132×3 | **components of aa-index: not independent** |
| tb41 | Terminal-Bench 4.1 (tbench.ai) | 1 trial | mixed (Claude Code 28, Codex 15, mini-swe 10) | pass rate | 64 | 66 tasks × 5 | snapshot |
| company | Company Agent Bench | 1 question | simple Slack harness | accuracy | 26 | 205 q | snapshot (not coding) |
| gdpx | GDPx | 1 long task | vendor | score | 20 | 206 × 3 | snapshot (not coding; $50–90/task) |
| vals-swe / vals-tb4 / vals-index | Vals AI | 1 task | unstated | score | 83 / 66 / 41 | varies | snapshot |
| frontierswe | FrontierSWE v2 | 1 20-hour task | proximus | score | 27 (max only) | 34 × 5 | snapshot |

Every Priors `observedAt` value is the snapshot date. Real run dates exist only for bughunt (`details.date`) and weirdml (in the note). A recency weight therefore has nothing to act on in v1.

### 1b. Current-model coverage (number of efforts with cost data)

| model | aa-index | aa-agent | cursor | t3 | fc2 | bughunt | arc2 | deepswe | ramp / bash |
|---|---|---|---|---|---|---|---|---|---|
| Opus 5.5 | 5 | 1 | 5 | 5 | 5 | 5 | 5 | – | 1/1 |
| Fable 5.2 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | – | 1/1 |
| Sonnet 5.5 | 5 | 1 | 5 | 5 | 5 | 5 | 4 | – | 1/1 |
| Haiku 5.5 | 5 | 1 | 5 | 6 | 5 | 5 | 4 | – | 1/1 |
| GPT-6.2 Astra | 5 | 5 | **–** | 5 | 5 | 5 | 5 | – | 1/1 |
| GPT-6.2 Sol | 5 | 5 | **–** | 5 | 5 | 5 | 5 | – | 1/1 |
| GPT-6 Luna | 6 | 1 | **–** | 6 | 5 | 5 | 6 | – | 1/1 |
| Gemini 4 Neon | 4 | 1 | 4 | 4 | 4 | 4 | 3 | – | 1/1 |
| Gemini 4 Carbon | 3 | 1 | 3 | 5 | 3 | 3 | 3 | – | 1/1 |
| Gemini 4 Hydrogen | 4 | 1 | 4 | 4 | 4 | 4 | 4 | – | 1/1 |
| Gemini 4 Argon | site only (2) | 1 | – | – | – | – | – | – | – |
| Grok 4.7 | 3 | 1 | 4 | 5 | 4 | – | 4 | – | 1/1 |
| Kimi K3.1 (Pro) | 1 (max) | 1 | – | – | 3 | 1 | – | – | –/1 |
| GLM-5.3 | 2 | 1 | – | 5 | 3 | 1 | – | 1 | – |
| GLM-5.3 Flash | 1 | 1 | – | 4 | 3 | 4 | 3 | 1 | – |
| DeepSeek V4.1 Flash | 3 | 1 | – | 1 | 3 | 3 | 4 | – | 1/1 |

CursorBench has no OpenAI rows. Kimi and Gemini Argon are thin everywhere. Of the site's 2577 entries, 554 have all four core costs (aa / agent / cursor / t3, estimates included), 1097 have 3, 853 have 2 and 73 have 1.

## 2. Empirical analysis

### 2a. Pairwise agreement (log cost, shared variants)

Columns: Spearman ρ; scale `k` = median of c_b/c_a; `sd` = sd of ln(c_b/c_a), which is the error left after one global factor.

| a → b | n | ρ | k (b/a) | sd ln |
|---|---|---|---|---|
| aa-index → aa-agent | 36 | 0.96 | 1.19 | 0.39 |
| aa-index → cursor | 38 | 0.96 | 1.20 | 0.34 |
| aa-index → t3 | 86 | 0.85 | 0.305 | **0.78** |
| aa-agent → t3 | 31 | 0.81 | 0.318 | 0.79 |
| cursor → t3 | 53 | 0.81 | 0.194 | 0.63 |
| aa-agent → cursor | 13 | 0.88 | 1.09 | 0.41 |
| aa-index → fc2 | 80 | 0.94 | 1.16 | 0.54 |
| aa-index → bughunt | 85 | 0.90 | 5.69 | 0.76 |
| aa-index → arc2 | 88 | 0.82 | 0.213 | 0.85 |
| aa-index → ramp-bash | 20 | 0.94 | 0.51 | 0.48 |
| aa-index → deepswe | 14 | 0.45 | 1.12 | 0.80 |
| aa-index → price | 124 | 0.72 | 1.80 | 1.15 |
| t3 → price | 120 | 0.72 | 6.52 | 0.82 |
| fc2 → aa-fc2 | 80 | 0.97 | 0.97 | 0.46 |
| ramp-bash → ramp | 18 | 0.92 | 1.82 | 0.51 |

Every per-task source ranks cost alike (ρ 0.81–0.96). $/1M tokens is the outlier (ρ 0.72, sd 1.15), so it stays out of the blend.

### 2b. Vendor effect (the harness test)

Median ln(b/a) per vendor; `R²v` = share of the ratio's variance explained by vendor; `sd|v` = sd within vendor.

| ratio | n | overall | OpenAI | Anthropic | Google | xAI | R²v | sd\|v |
|---|---|---|---|---|---|---|---|---|
| **t3 / aa-index** | 86 | ×0.30 | **×0.83** (34) | **×0.20** (27) | ×0.24 (15) | ×0.23 (4) | **0.73** | 0.40 |
| t3 / aa-agent | 31 | ×0.32 | ×0.68 | ×0.16 | ×0.22 | – | 0.73 | 0.41 |
| t3 / cursor | 53 | ×0.19 | ×0.54 (5) | ×0.17 | ×0.14 | ×0.21 | 0.40 | 0.49 |
| aa-agent / aa-index | 36 | ×1.19 | ×1.27 | ×1.04 | ×1.26 | – | 0.32 | 0.32 |
| cursor / aa-index | 38 | ×1.20 | – | ×1.20 | ×1.60 | ×1.12 | **0.04** | 0.33 |
| fc2 / aa-index | 80 | ×1.16 | ×1.51 | ×0.85 | ×1.14 | ×1.79 | 0.70 | 0.30 |
| aa-tb41 / aa-index | 136 | ×1.62 | ×1.55 | ×1.52 | ×1.49 | ×1.51 | 0.22 | 0.30 |
| **ramp (own) / ramp-bash** | 18 | ×1.82 | **×3.35** (6/6 in 2.7–3.8) | ×1.77 | ×1.36 | ×1.09 | 0.70 | 0.28 |
| **t3 / ramp (own)** | 13 | – | **×0.49** | **×0.43** | ×0.20 (3) | – | – | – |

Findings:
- **The harness effect is real and depends on the vendor.** On the same 500 Ramp tasks, Codex costs 3.35× the neutral Bash harness and Claude Code costs 1.77×. Codex also scores 1–10 points higher.
- T3 against raw AA shows a gap of about 4× between OpenAI and Anthropic. Against Ramp, where both sides run in first-party harnesses, the T3 ratio is the same for OpenAI and Anthropic (×0.49 vs ×0.43). **T3's vendor offset is therefore a harness effect, not noise.**
- AA Coding Agent disagrees on Claude Code: t3/aa-agent for Anthropic is ×0.16, against ×0.68 for OpenAI. AA's Claude Code runs cost more than T3 and Ramp imply.
- CursorBench needs one factor only (R²v 0.04).
- **Normalize with one global factor per source.** A per-vendor factor would erase the harness signal that the "with harness" preset exists to capture. Use per-vendor factors only to impute a missing source (§3e).

### 2c. Effort gradient (within-model slope of ln cost_b on ln cost_aa-index)

| b | slope | OpenAI | Anthropic | Google |
|---|---|---|---|---|
| t3 | **0.76** | 0.73 | 0.74 | 0.78 |
| cursor | 1.09 | – | 1.03 | 1.24 |
| aa-agent | 1.14 | 0.97 | – | – |
| fc2 | 0.96 | 0.63 | 1.21 | 1.04 |
| bughunt / arc2 | 0.77 / 0.77 | | | |

On T3, higher effort raises cost less than it does on AA. The reason is that cached context dominates T3 turn cost: an Opus 5.5 xhigh turn carries 3.6M cached tokens against 11k output tokens. The slope is the same for every vendor, so one global factor is enough here. Selection bias (harder tasks run at higher effort) would make the slope steeper than 1; it is shallower, so the bias does not show and may be masked.

T3 sample size does not predict T3 error. The median |residual| is 0.26 / 0.26 / 0.35 / 0.30 (ln) for <1k / <10k / <100k / ≥100k turns. The error is systematic, not sampling noise, so weighting by turns buys nothing beyond a floor (≥30 turns).

### 2d. Leave-one-source-out (5-fold over variants; median |error| of the predicted $, p80 in brackets)

Latent model: ln c[s,v] = a_s (+ b_{s,vendor}) + u_v, fitted by ALS.

| held-out | core-4, global factor | core-4, + vendor factor | 11 sources, global | 11 sources, + vendor |
|---|---|---|---|---|
| aa-index | 39% (77) | 22% (45) | 30% (66) | 27% (64) |
| aa-agent | 34% (49) | 17% (38) | 22% (37) | 15% (41) |
| cursor | 33% (65) | 26% (53) | 26% (59) | 21% (40) |
| t3 | 57% (96) | **29%** (57) | 50% (86) | 36% (65) |
| fc2 / fc11 / deepswe | | | 25 / 33 / 28% | 23 / 31 / 27% |
| arc2 / bughunt / ramp-bash | | | 42 / 40 / 42% | 36 / 36 / 39% |

Residual sd per source (ln, 11-source vendor model): aa-agent 0.25, cursor 0.25, fc2 0.30, tb41 0.33, fc11 0.36, aa-index 0.40, t3 0.40, deepswe 0.41, bughunt 0.50, ramp-bash 0.50, arc2 0.53.

## 3. Combination method

### 3a. Scale factors (computed at build time)

Fit ln c_{s,v} = a_s + u_v + ε over all sources at once (ALS, a_{aa-index} = 0), then set k_s = exp(a_s). Current values:

| source | k_s | source | k_s |
|---|---|---|---|
| aa-index | 1 | fc2 | 1.09 |
| aa-agent | 1.08 | deepswe | 1.09 |
| cursor | 1.33 | ramp | 0.90 |
| t3 | 0.317 | ramp-bash | 0.479 |
| bughunt | 4.72 | arc2 | 0.223 |

The joint fit is used rather than pairwise ratios to the anchor, because sources with little anchor overlap (cursor, ramp) still get a stable factor.

### 3b. Per-entry normalized cost and weight

For entry e (plan × model × effort) and source s with a value:

```
x_{s,e} = ln(c_{s,e}) − ln(k_s)                      # in ln(AA-task $)
w_{s,e} = p_s · q_{s,e} · h_{s,e}
  p_s  = preset or custom weight (Σ p_s = 1)
  q    = 1 measured | 0.6 estimate-high | 0.35 estimate-medium | 0.15 estimate-low
  h    = 1   raw source, or harness source whose harness = plan harness
         0.5 harness source run in a different harness from the plan
```

Harness match:
- `codingAgent` is already resolved to the plan's harness (`HARNESS_TO_AA_AGENT`): h = 1, or 0.5 when `crossAgent`.
- CursorBench: h = 1 for "Cursor IDE" plans, otherwise 0.5.
- T3: h = 1 for first-party plans (Claude Code, Codex, Gemini CLI, Grok, OpenCode, Cursor), 0.5 for Kilo, Copilot, Droid, Command Code and any API.

### 3c. Combine

```
X_e  = Σ_s w_{s,e} x_{s,e} / Σ_s w_{s,e}
API_e = exp(X_e)                                   # $ per AA-task-equivalent at API price
Real_e = API_e / subsidy_e                         # same subsidy path as other modes
W_e  = Σ_{s present} p_s q h / Σ_s p_s             # coverage, 0..1
D_e  = sqrt( Σ w (x − X_e)² / Σ w )                # disagreement, ln units
```

### 3d. Gate and confidence tier (reuses the existing estShow tiers)

| condition | result |
|---|---|
| W_e ≥ 0.5, or (n_sources ≥ 2 and W_e ≥ 0.3) | shown |
| otherwise | null (row hidden in combined mode, like a missing cost) |
| W ≥ 0.7 and D ≤ 0.35 | high |
| D ≤ 0.6 | medium |
| else | low |

Simulated at variant level, measured values only: Raw shows 136 variants (73 high / 55 medium / 8 low). Harness shows 137 (29 / 101 / 7). Balanced shows 159 (35 / 112 / 12). With site estimates included (q < 1), coverage rises to nearly every entry.

### 3e. Missing sources

- v1: renormalize over the sources present; W and the tier carry the penalty.
- v2 (option): impute a missing harness source as `â_s + b̂_{s,vendor} + u_v`, using the vendor model from §2d, with q = 0.35. Without this, a GPT entry that lacks T3 falls back to raw-scaled values that understate its Codex cost by about 1.9×.

### 3f. $ per successful task (toggle, default off)

```
x'_{s,e} = x_{s,e} − ln(max(p̂_{s,e}, 0.1))        # p̂ = pass rate 0..1 where the source has one
```

After applying it, refit k_s on x'. T3 has no p̂ and is left unchanged. Default off: the Min benchmark filter already gates quality, so dividing as well counts quality twice.

### 3g. Validation reported in `stats.combined`

- Per preset and source: LOO median / p80 |error| (§2d method, using the preset weights). Shown in the same place as `effortAccuracy`.
- Current values (preset weights, global k):

| preset | held-out source: median (p80) |
|---|---|
| Raw | aa-index 29% (74), arc2 35% (79), deepswe 43% (119), ramp-bash 40% (53) |
| Harness | t3 45% (73), aa-agent 39% (105), cursor 35% (67), fc2 30% (68), bughunt 47% (102), ramp 25% (54) |
| Balanced | aa-index 34% (86), t3 50% (75), aa-agent 25% (41), cursor 32% (60), fc2 27% (56), bughunt 37% (111) |

## 4. Presets

Weights are p_s. Reliability is built into these numbers. A hidden 1/σ² multiplier was tested: it moved T3 from 0.40 to 0.24 of the Harness preset, because it rewards agreement with the consensus. It is dropped.

| source | Raw | Balanced | Harness |
|---|---|---|---|
| aa-index | **0.60** | 0.30 | – |
| deepswe | 0.15 | 0.05 | – |
| ramp-bash | 0.15 | – | – |
| arc2 | 0.10 | – | – |
| t3 | – | 0.25 | **0.40** |
| aa-agent (plan harness) | – | 0.15 | 0.25 |
| cursor | – | 0.10 | 0.15 |
| fc2 | – | 0.10 | 0.10 |
| bughunt | – | 0.05 | 0.05 |
| ramp (own harness) | – | – | 0.05 |

Rationale:
- **Raw** is anchored on aa-index (broadest measured coverage) and uses neutral-harness SWE runs. arc2 is low-weighted because it is puzzles, not coding.
- **Harness** leads with T3 (real usage, 179 variants). aa-agent and cursor are next: lowest residual (0.25), plan-harness matched. fc2 and bughunt are vendor-harness benchmarks with a success measure. ramp is low-weighted (18 variants, high effort only).
- **Excluded:** aa-tb41 and aa-fc2 (inside aa-index), price (not work), gdpx and company (not coding, n ≤ 26), vals-* (harness unstated), frontierswe (max effort only, ρ 0.44–0.6).

Preset agreement (Spearman over variants shown in both): Raw–Harness 0.93, Raw–Balanced 0.98, Harness–Balanced 0.99. Harness ÷ Raw by vendor: OpenAI **×1.94**, Anthropic ×0.82, Google ×0.82, xAI ×0.78.

Examples ($ per AA-task-equivalent at API price):

| variant | Raw | Balanced | Harness |
|---|---|---|---|
| Opus 5.5 high | 2.93 | 2.98 | 2.62 |
| Opus 5.5 xhigh | 5.47 | 5.02 | 4.36 |
| Fable 5.2 high | 8.86 | 6.89 | 5.78 |
| Sonnet 5.5 high | 1.28 | 1.44 | 1.23 |
| GPT-6.2 Astra high | 2.06 | 2.98 | 3.60 |
| GPT-6.2 Sol high | 0.57 | 0.90 | 1.20 |
| Gemini 4 Neon high | 4.17 | 3.60 | 3.51 |
| Grok 4.7 high | 6.60 | 5.94 | 5.45 |
| GLM-5.3 max | 4.71 | 4.10 | 3.58 |

**Output unit: $ per task, scaled to the AA Intelligence task (k_aa = 1). Recommended.**
- At Raw with aa-index = 100%, the value equals the current default "Real $/task", so readers already know the number.
- The existing COST_STOPS_TASK, "Max cost/task" filter and "Tasks/mo" column carry over unchanged.
- The scale stays the same whichever preset is active, so switching presets only moves rows.
- Rejected: a dimensionless index (no dollar meaning, breaks the budget/volume columns). "T3-turn equivalents" (×0.317; changes the default scale).

## 5. UI

`COST_MODES.combined = { unit: "task", heading: "Best Real Cost per Task · Combined", maxLabel: "Max cost/task:", vol: "Tasks/mo" }`

Settings, Cost metric section:

```
Cost metric      [ Combined                    ▾ ]   (adds option after "Per AA Intelligence task")
Mix              ( Raw | Balanced | Harness | Custom )
— when Custom —
AA Intelligence  [■■■■■■□□□□]  60
AA Coding Agent  [□□□□□□□□□□]   0
CursorBench      [□□□□□□□□□□]   0
T3 Code          [■■■□□□□□□□]  30
FrontierCode 2.0 [■□□□□□□□□□]  10
Bug Hunt         [□□□□□□□□□□]   0
DeepSWE          [□□□□□□□□□□]   0
Ramp SWE         [□□□□□□□□□□]   0
Ramp SWE (Bash)  [□□□□□□□□□□]   0
ARC-AGI-2        [□□□□□□□□□□]   0
Per success      [ Off | On ]
```

- Slider values are raw integers 0–100 and are normalized internally. No "%" sign and no sum-to-100 constraint, so there is no prose about normalization.
- When every slider is 0, the table shows the empty state "No sources".
- The Mix row is visible only when Cost metric = Combined. Custom rows are visible only when Mix = Custom.
- Table cost cell: the value plus the existing estimate marker, carrying the tier from §3d.
- URL: `mode=combined&mix=raw|bal|har|c:aa60.t330.fc210&succ=1`.
- Data: refresh-data attaches the Priors extras per entry as `extraCosts: {fc2, bughunt, deepswe, ramp, rampBash, arc2}`. It writes `stats.combined = {k, loo, presets}`. The client computes §3b–3d.

## 6. Tests (scripts/test-site.mjs)

| test | assertion |
|---|---|
| k_s present | every source in the presets has a finite k > 0 in `stats.combined.k`; k_aa = 1 |
| k_s stability | k_s from a bootstrap or half-split of variants stays within ×1.25 of the full-fit value; failure → refresh warning |
| k_s drift | each k_s stays within ×1.5 of the previous deploy's value (stored); larger → fail the build |
| preset sums | each preset's p sums to 1 ± 1e-9; no preset includes aa-tb41, aa-fc2 or price |
| custom normalize | custom [60,0,…,30,10] gives the same X as [6,0,…,3,1]; all-zero gives null |
| identity | Raw with only aa-index at 1 returns exactly `aaCostPerTaskUsd / subsidy` on every entry |
| bounds | X_e lies between min_s x_{s,e} and max_s x_{s,e} |
| monotonic | raising one source's cost for an entry never lowers the combined cost; a larger subsidy never raises Real |
| effort order | for each model × plan, median combined cost is non-decreasing low→medium→high→xhigh→max in ≥ 90% of models |
| LOO bounds | per preset: held-out median |error| ≤ 50% and p80 ≤ 110% (current maximum 47% / 119%; deepswe p80 would need a 120% allowance or exclusion) |
| gate | entries with W < 0.3, or with W < 0.5 and one source, have null combined cost; tier counts are reported in stats |
| harness match | Cursor IDE plans get h = 1 on cursor; Kilo/Copilot plans get h = 0.5 on t3 |
| coverage floor | ≥ 90% of current-model (§1b) entries have a non-null combined cost under every preset |

## 7. Risks and open questions

1. **T3 turn ≠ fixed work.** Codex turns are longer (4.6 vs 3.2 median minutes) and carry more cached context (2.6M vs 1.8M). The Ramp triangulation (t3/ramp ×0.49 OpenAI vs ×0.43 Anthropic) says the offset is mostly harness, but n = 13. Decide: trust T3 as is, or cap T3's weight for OpenAI until more same-task harness data exists.
2. **AA Coding Agent vs T3/Ramp on Claude Code.** AA's Claude Code runs look about 4× pricier relative to T3. In the Harness preset, aa-agent and t3 pull Claude in opposite directions. Decide the aa-agent weight (0.25 proposed).
3. **Imputation (§3e).** v1 renormalization lets a GPT entry with no T3 look about 1.9× too cheap under Harness. Decide whether to ship vendor-aware imputation in v1.
4. **Per success default.** Off is proposed. On rewards strong models, and the effect stacks with Min benchmark.
5. **No OpenAI data on CursorBench, and thin Kimi / Gemini Argon / Qwen4 coverage.** These rows depend on one or two sources, so they come out at medium or low tier at best.
6. **Freshness is not observable.** Every Priors `observedAt` is the snapshot date. Decide whether to ask the Priors maintainer for run dates, or to use model release date as a proxy.
7. **Scale drift.** k_s re-fits every deploy, so rankings can shift with no new data for a variant. The k-drift test fails the build above ×1.5. Decide whether to freeze k_s and refit manually instead.
8. **Selection bias in T3** is not identifiable from these data (the effort slope is 0.76, not > 1). Revisit if T3 publishes per-task-type splits or success signals.
9. **AA Index double-counting.** Estimated `codingAgent` values from the terminal-bench path are derived from data that overlaps aa-index. Under Balanced they get q = 0.35, but they are partly the same information. Decide whether to set q = 0 when the aa-index weight is > 0.
