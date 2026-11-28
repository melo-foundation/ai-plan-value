# Quota token weights: measurement, fit, validation, publication

Date 2026-11-26. Scope: the mix correction `subsidy_for_benchmark = subsidy × φ(sample mix) / φ(benchmark mix)`.

Labels used throughout:

- **[verified]** I read the primary source or raw data in this session and the statement is what it says.
- **[computed]** my arithmetic on verified data; scripts in `docs/design/quota-weights-proto/` (paths in §10).
- **[inferred]** a conclusion that needs an assumption nobody has tested. The assumption is named.
- **[unverified]** a lead I could not confirm.

## 0. Findings that change the brief

1. **The only per-kind measurement is on the wrong bar and the wrong client.** [verified] Fei #98 measured the 5-hour bar with headless `claude -p`. Every Claude subsidy on the site comes from the weekly bar, and Fei's samples are interactive sessions. No public data has a cache arm on the weekly bar. Not one data point.
2. **Client label changes the burn rate by about 2×, and nobody has split that by token kind.** [verified] anthropics/claude-code #97074 (open, 77 comments, no staff reply) and #111890: `sdk-cli` and `sdk-ts` drain the 5h bar faster than interactive clients for the same tokens: 1.8–2.9× in five controlled runs (#97074 author 1.8, qvarker 2.3, Z3l20 2.0, kler 2.9, #111890 1.86), 1.3–1.5× in one observational log (futin). [computed] Re-fitting kler's raw run with fitted weights gives 2.09× (1.996–2.179). T3 Code runs Claude through the Agent SDK (`sdk-ts`) [verified, kler README], so a plan user's T3 turns burn the 5h bar about 2× faster than the TUI usage Fei's subsidies were measured on. This is a larger effect on the site's Claude × T3 Code numbers than the mix correction, and it is not modelled anywhere. Weekly-bar size of the effect: unmeasured.
3. **Indirect evidence points to a smaller cache discount on the weekly bar, possibly none.** [inferred] Same-account windows-per-week: headless no-cache Max 5x = 12.2 (#98); interactive cache-heavy Pro = 7.7–8.0 (Fei maintainer), Max 20x = 3.75–3.89 (#96), which is 7.5–7.8 on Max 5x by Fei's adopted 2× weekly / 4× 5h plan ratios. Ratio 0.62–0.66. "5h bar discounts cache, weekly bar does not" predicts 0.60–0.68 with no free parameter. The alternative is a client-label penalty that differs between bars. Cross-account, so weak. If true, the correction for weekly-based subsidies is × 1.00 and shipping × 0.80 adds a 25% error.
4. **Weights are per model.** [verified] ClaudeDevs, Oct 8: Sonnet 5.5 API cache reads halved, "API only, no change to Claude Code usage limits". ClaudeDevs, Sep 1: Fable 5.1 API cache reads cut $1 → $0.25 while subscription usage "remains unchanged". Quota rates are decoupled from API list prices, so a weight expressed relative to list price on Opus 5.5 does not transfer to Sonnet 5.5 or Fable 5.2. Neither has a per-kind measurement.
5. **The 0.31–0.81 range can be narrowed with data already public.** [computed] kler's A/B run was built to test the client label, but its `claude-vscode` blocks have a write-heavy first point and a read-heavy second point. Joint with #98: cache read 0.51 (0.49–0.54), 1h write 0.60 (0.55–0.64) of list. That is the "#98 row 2" scenario (reads $0.10/M, 1h writes about $4.8/M ≈ the 5m write price). [inferred] It assumes the same weights on Max 5x headless and Team with an emulated `claude-vscode` label.
6. **`APPLY_CLAUDE_MIX_CORRECTION` is `true` in the working tree** (`scripts/refresh-data.mjs:26`) [verified]. §7 recommends `false` until the gate in §4 passes.

## 1. Measurement protocol

### 1.1 What each tool exposes

| Tool | Gives | Precision | Status |
|---|---|---|---|
| `claude -p --output-format stream-json --verbose` | `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization` and `resetsAt`, emitted when a response changes the meter; per-request `usage` | 0.01 steps = whole percent; per request | [verified] kler raw `.jsonl`; #97074; #98 |
| Status line script | `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`, `resets_at`, `version`, `session_id`, `transcript_path` on stdin | docs example shows `23.5`; #96 logged integers | [verified] https://code.claude.com/docs/en/statusline.md ; integer per #96 |
| `/usage` in Claude Code | 5h bar, weekly bar, session token totals by kind, prompt-cache line with TTL | whole percent; totals rounded to 2–3 digits (`1.3b`) | [verified] https://code.claude.com/docs/en/costs.md ; Fei Max 5x screenshot record |
| `GET api.anthropic.com/api/oauth/usage` | `five_hour.utilization`, `seven_day.utilization`, `resets_at`, `seven_day_opus`, `extra_usage` | float type, integer values (1,670 of 1,670 rows in #124's CSV); refreshes about once a minute; endpoint is rate limited | undocumented by Anthropic; fields [verified] from #124 CSV and third-party clients (docs.rs `cship`, `claude-usage`); refresh rate per kler README; rate limit per costs.md |
| `anthropic-ratelimit-unified-{5h,7d}-utilization` response headers | meter fraction per response, `-reset`, `representative-claim` | 17 digits in Dec 2025 (gist); 2 decimals since Apr 2026 (ArkNill) | [verified] both sources; needs a logging proxy on `ANTHROPIC_BASE_URL` |
| Transcripts `~/.claude/projects/**/*.jsonl` | per API call `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`; `entrypoint`; `effort`; dedupe on `message.id` + `requestId` | exact tokens | [verified] #96, #97074, #124, prompt-caching.md |
| ccusage | sums the transcripts by session / day / 5h block: input, output, cache creation, cache read, list cost. Also Codex and Antigravity sources | exact tokens; no 5m/1h split found; reads no quota meter | [verified] https://ccusage.com/llms-full.txt (first 100k chars) |
| `claude-code-cache-fix` | proxy that logs `q5h_pct`, `q7d_pct`, `peak_hour` per call to `~/.claude/usage.jsonl`; `tools/quota-analysis.mjs` compares three fixed hypotheses (cache read at 0×, 0.1×, 1× input) by CV across 5h windows with fixed weights input 1 / output 5 / write 2 | integer percent per call | [verified] source read. Not an estimator: no free weights, no intervals. The package also rewrites cache TTLs, so use it only as a logger with fixes off |
| Codex rollouts `~/.codex/sessions/**/*.jsonl` | `token_count` events: cumulative and last usage (input incl. cached, cached input, output incl. reasoning); `rate_limits.primary/secondary.used_percent`, `window_minutes` | integer percent per turn | [verified] Fei #97; field names from third-party parsers |
| Antigravity CLI `/usage` (`/quota`) | quota bars | percent; users report it stale until relaunch; no official per-request token log | [verified] https://www.antigravity.google/docs/cli/commands/usage ; staleness [unverified, forum reports] |

### 1.2 Controls (all vendors)

1. Account idle everywhere else: no web or desktop chat, no second device, no scheduled or cloud agents. Tag the submission `shared_account: true` otherwise; it is excluded.
2. Idle baseline: log both bars for 10 minutes before the first arm and 10 minutes after the last with no requests. Any tick fails the session.
3. One bar window per session. If `resets_at` changes during an arm, drop the arm.
4. Start below 60% on the bar under test. Stop at 85% (5h) or 95% (weekly), or on any `overage` status.
5. Empty working directory. No hooks, MCP servers, plugins, skills, `CLAUDE.md`, subagents.
6. Fixed model, effort and client version for the session. Record all three.
7. Do not set `CLAUDE_CODE_ENTRYPOINT`. Check it is unset in the shell (a tmux server inherits it [verified, #97074]). Check the transcript's `entrypoint` after the run.
8. Arm order: rotate per session (session n starts at arm n mod k). Record UTC time; a peak-hour effect of 25–35% was reported once [unverified, #45756].
9. No request larger than 0.1 point of the bar. Size prompts from a 1-point pilot.

### 1.3 Arms (Claude Code)

Each arm is a designed mix, not a pure kind. The fit uses the tokens actually logged.

| Arm | Setup | Dominant kind |
|---|---|---|
| `input` | `DISABLE_PROMPT_CACHING=1`; each request carries N tokens of fresh text and asks for one word | fresh input ≥ 95% of list-$ |
| `output` | `DISABLE_PROMPT_CACHING=1`; short prompt, long answer (count to 3,000), effort `low` | output ≥ 95% |
| `read` | caching on; turn 1 reads a generated corpus (25k–150k tokens); every later turn asks a one-word question | cache read ≥ 85% after the first tick |
| `write1h` | caching on, `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`; every request is a new session whose prompt starts with a random nonce followed by N tokens | 1h write ≥ 85% |
| `write5m` | same with `FORCE_PROMPT_CACHING_5M=1` | 5m write ≥ 85% |

Confirm the TTL from `usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` [verified env vars and fields: https://code.claude.com/docs/en/prompt-caching.md].

Two client classes, run separately:

- `sdk`: `claude -p --input-format stream-json --output-format stream-json --verbose --model <id> --effort low`. Meter from `rate_limit_event`. This is #98's and kler's method.
- `interactive`: the real TUI in tmux, prompts sent with `tmux send-keys`, meter from a status line script that appends its stdin JSON to a file, tokens from the transcript. Real clients write no `rate_limit_event` to transcripts [verified, kler README], so the status line or `/api/oauth/usage` is the meter.

Site-relevant cell: `interactive` × weekly bar. Run it first.

### 1.4 Segments and rounding

1. Chain arms back to back. An arm starts at a meter tick and ends at a meter tick. The segment is tick to tick: points = ticks − 1, tokens = everything between the two ticking requests.
2. An anchor tick is valid only if the two requests before it each cost ≤ 0.15 point. After a large request (the `read` arm's first write), skip to the next tick. The simulation shows a +2% to +14% bias on the read weight without this rule [computed].
3. The meter can lag one request [verified in kler data: the tick after a 40k-token write shows on the next request]. Anchoring both ends on small requests cancels it.
4. With a polled meter (`/api/oauth/usage`, `/usage` screenshots) ticks cannot be placed. Record start and end readings two minutes after the last request. The segment is `anchored: false` and carries ±1 point (variance 1/6 point²).

### 1.5 Sample size

From `docs/design/quota-weights-proto/sim.mjs` and `sim2.mjs`, 150–300 simulated runs per row, true weights 1 / 1 / 0.5 / 0.9 / 0.6, integer meter, one-request lag [computed]. Half-width of the 95% interval on each weight:

| Design | Per-arm meter noise 1% | 3% | 6% |
|---|---|---|---|
| 1 session × 2 anchored points per arm | ±6% | ±10% | |
| 1 session × 3 | ±4% | ±9% | |
| 1 session × 5 | ±3% | ±9% | ±19% |
| 3 sessions × 3 | ±2.6% | ±5.4% | |
| 3 sessions × 5 | ±2.0% | ±5.0% | ±11% |
| 6 sessions × 5 | | ±3.5% | ±7.5% |
| 1 session × 10 unanchored points per arm | | ±17% | |
| 1 session × 20 unanchored | | ±11% | |
| 3 sessions × 20 unanchored | | ±6.5% | |
| Weekly bar, 1 session × 3 anchored | ±2.9% | ±7.7% | |

Observed within-session noise: 0.8% (Fei #98 group D, four 1-point intervals), 0.7% (kler, second point of three blocks) [computed]. Between-account noise is unknown; the 3% and 6% columns cover it.

Minimum per cell (model × bar × client class): **3 sessions from 2 accounts, 3 anchored points per arm** (5 on the 5h bar). Target: ±5% on each weight, which is ±2% on the correction factor. Anchored points beyond 5 per arm buy nothing; more sessions do.

Budget per session:

| Bar | Arms | Points used | Share of quota |
|---|---|---|---|
| 5h | 5 × 5 points + warm-ups | about 30 | 30% of one window |
| Weekly | `input`, `read`, `write1h` × 3 points + warm-ups | about 10 | 10% of a week; 1–2 five-hour windows on Pro and Max 5x |

### 1.6 Plans, bars, other vendors

- **Pro / Max 5x / Max 20x / Ultra / Team**: same arms. Shrink N by the plan ratio so rule 1.2.9 holds (Pro 5h point ≈ $0.25–0.29 parity, Max 5x interactive ≈ $1.4, headless ≈ $0.68 [computed]).
- **5h vs weekly**: the `sdk` class logs both bars on every event, so one long session yields both fits. The weekly fit uses weekly ticks as anchors.
- **OpenAI Codex** (parity check): `codex exec`, arms `input` (fresh text), `cached` (repeat a fixed long prefix), `output`. Read `token_count` and `rate_limits` from the rollout. Subtract cached from input. Fei #97 is this design: 5–8 points per arm on the weekly bar, burn ÷ credit-card price = 1.00 / 1.02 / 1.08 on GPT-6 Astra, 1.34 / 1.33 / 1.52 on GPT-6.1 Sol [verified]. Needed: a second account and one more model. Pass = all kinds within ×/÷1.10 of each other per model.
- **Google Antigravity** (parity check): arms `input` (fresh text per request), `cached` (repeat a fixed prefix; caching is implicit, so read the cached count afterwards), `output`. Meter from `/usage` after relaunching the CLI; tokens from ccusage's Antigravity source or the client's own counters. Segments are unanchored: 10 points per arm minimum, 20 preferred. No single-kind run exists today [verified, none in Fei's repo]. Existing weak evidence disagrees in sign with the official "drawn down according to API pricing" text (uncached probe × 1.2–1.37 vs cached usage; `reliability-design.md` §3.3).

## 2. Data format

Location `data/quota-weights/sessions/<vendor>/<yyyy-mm-dd>-<submitter>-<n>.jsonl`. JSON Lines, UTF-8. Line 1 is the header; then `req` and `meter` rows in time order. `schema: "quota-weights.session/1"`. Breaking changes bump the integer; the fitter refuses unknown versions.

Header:

| Field | Type | Notes |
|---|---|---|
| `schema` | string | `quota-weights.session/1` |
| `session_id` | string | unique in the repo |
| `submitter` | string | GitHub login |
| `account_hash` | string | first 8 hex of SHA-256 of the account id plus a private salt; separates accounts without naming them |
| `vendor`, `plan`, `plan_price_usd` | | `anthropic`, `max_5x`, 100 |
| `model`, `effort` | | `claude-opus-5-5`, `low` |
| `client`, `client_version`, `entrypoint` | | `claude-code`, `2.1.300`, `cli` / `sdk-cli` / `sdk-ts` / `claude-vscode` |
| `label_emulated` | bool | true if `CLAUDE_CODE_ENTRYPOINT` was set by hand |
| `meter_source` | enum | `rate_limit_event`, `statusline`, `oauth_usage`, `headers`, `usage_screenshot`, `codex_rollout`, `antigravity_usage` |
| `meter_resolution` | number | 1 for whole percent |
| `bars` | array | `[{id:"5h", resets_at}, {id:"7d", resets_at}]` |
| `cache_ttl` | enum | `1h`, `5m`, `off`, `mixed` |
| `shared_account` | bool | |
| `idle_before_min`, `idle_after_min`, `idle_ticks` | numbers | |
| `prices_usd_per_mtok` | object | `{input, output, cacheRead, cacheWrite5m, cacheWrite1h}` as used; the fitter re-prices from its own table and fails on a mismatch above 1% |
| `raw` | object | `{url, sha256}` of the raw log bundle or screenshots (gist, release asset, issue attachment) |
| `notes` | string | |

`req` row: `{t:"req", ts, arm, request_id, input, output, cache_read, cache_write_5m, cache_write_1h, reasoning?, images?}`. Token counts are integers; `input` excludes cached and written tokens; `output` includes reasoning.

`meter` row: `{t:"meter", ts, after_request_id?, bar, used_pct, resets_at}`.

Aggregate submissions (issues, screenshots) use `schema: "quota-weights.segments/1"`: the same header plus `seg` rows `{t:"seg", arm, bar, points, anchored, input, output, cache_read, cache_write_5m, cache_write_1h, ts_start, ts_end}`.

`data/quota-weights/index.csv` (generated): one row per segment: `session_id, submitter, account_hash, vendor, plan, model, entrypoint, bar, arm, points, anchored, usd_input, usd_output, usd_cache_read, usd_cache_write_5m, usd_cache_write_1h, included, exclude_reason`.

Validation on load (failure = file rejected, reason printed): schema version known; token fields non-negative integers; meter non-decreasing inside a bar window; `resets_at` constant inside an arm; `raw.url` present; `idle_ticks = 0`; `shared_account = false`; `label_emulated = false` for the validated fit.

## 3. Estimation

### 3.1 Model

For segment s in group g (one account × plan × bar × client class × model × week):

```
points_s = γ_g × Σ_k w_k × usd_sk + ε_s          usd_sk = tokens of kind k × list price
k ∈ {input, output, cacheRead, cacheWrite5m, cacheWrite1h}
w_input = 1 (fixed);  w_k ≥ 0;  γ_g = 1 / (parity-$ per point), free per group
φ(mix) = Σ_k w_k × usd_k / Σ_k usd_k
```

Weights are shared inside a cell (vendor × model × bar × client class). γ absorbs plan size, account differences and the client-label multiplier.

Error variance per segment: `v_s = r_s + (τ × points_s)²`, with `r_s = 1/6` for unanchored segments and `(b_first² + b_last²)/12` for anchored ones (b = boundary request cost in points). τ starts at 0.03 and is re-estimated as the RMS of relative residuals of anchored segments, floor 0.01.

Integer rounding is handled by design (anchoring turns interval censoring into a bounded boundary error) and by `r_s` for the rest. Censoring check: every unanchored segment's prediction must lie in `(points − 1, points + 1)`; violations are listed in the output.

### 3.2 Algorithm (`scripts/fit-quota-weights.mjs`, zero dependencies)

1. Load and validate sessions; build segments (§1.4); price tokens from `data/quota-weights/prices.json`.
2. Initialise `w = 1`, `γ_g = 1`.
3. Repeat until every weight moves less than 1e-10 (cap 200 rounds):
   a. For each g: `γ_g = Σ ω y z / Σ ω z²`, with `z = Σ_k w_k usd_k`, `ω = 1/v`.
   b. Weighted NNLS for the free weights: target `y/γ_g − usd_input`, predictors `usd_k`, weights `γ_g²/v`. With K ≤ 5, enumerate all 2^K active sets, solve each by normal equations, keep the feasible one with the lowest weighted RSS.
   c. Recompute `v`.
4. Identifiability: a kind is `identified` only if some segment has ≥ 50% of its fitted quota-$ in that kind and the weighted design, after profiling out γ, has condition number < 100. Unidentified kinds are reported as `null`, never as 0 or 1. (Fei #98 alone fails this: reads and 1h writes move together in group D, and NNLS returns a corner, read 0 / 1h write 1.63 [computed].)
5. Intervals: cluster bootstrap, 2,000 resamples of sessions within group (segments when a group has fewer than 3 sessions); 2.5 and 97.5 percentiles. Seeded PRNG (mulberry32) so the output is reproducible.
6. Heterogeneity, per dimension (submitter, plan, bar, client class, model, client version before/after a date): refit with separate weights per level; report each level's weights, Cochran's Q and I² on `ln w_k`, and a permutation p-value (1,000 label shuffles across sessions) for the drop in weighted RSS. Levels differ when p < 0.05 and the weights differ by more than 10%.
7. Pooling rule: pool across a dimension only when step 6 does not flag it with at least two levels measured. Never pool across models or bars by default.
8. Between-submitter spread `τ_b`: DerSimonian–Laird on per-submitter `ln w_k`; added to σ.

Outputs, `data/quota-weights/fit.json`:

```json
{
  "schema": "quota-weights.fit/1", "generatedAt": "...", "seed": 1,
  "cells": [{
    "key": "anthropic/claude-opus-5-5/7d/interactive",
    "status": "validated | provisional | unmeasured",
    "weights": { "input": 1, "output": 0.99, "cacheRead": 0.51, "cacheWrite5m": null, "cacheWrite1h": 0.60 },
    "ci95": { "cacheRead": [0.49, 0.54] },
    "tauBetween": { "cacheRead": 0.04 },
    "draws": [[...], "200 bootstrap weight vectors"],
    "n": { "sessions": 3, "submitters": 2, "segments": 15, "points": 51 },
    "diagnostics": { "tau": 0.012, "loso": { "medianAbsLn": 0.03, "maxAbsLn": 0.09 }, "conditionNumber": 14,
                     "censoringViolations": 0, "heterogeneity": [], "holdout": { "n": 2, "rmsLnFit": 0.05, "rmsLnList": 0.21 } },
    "gate": { "coverage": true, "loso": true, "agreement": true, "holdout": true, "simulation": true }
  }]
}
```

Plus `data/quota-weights/fit.md` (generated tables, like `docs/EFFORT-ESTIMATES.md`).

A Bayesian interval-censored model was considered and not chosen: it needs a sampler, the anchored design removes most of the censoring, and the WLS variance term covers the rest. The prototype recovers the truth without it (§3.3).

### 3.3 Simulation check

`node scripts/fit-quota-weights.mjs --simulate` generates protocol sessions from known weights (integer meter, random phase, one-request lag, per-arm noise) and fits them. Prototype result [computed, `docs/design/quota-weights-proto/`]: bias ≤ 0.5% on every weight in all designs once the anchor rule (§1.4.2) is on; interval widths in §1.5. Recovery with no meter noise: ±1.2% at 5 points per arm, ±0.2% at 10.

CI assertion: 200 seeded runs of "3 sessions × 3 points, noise 3%" recover each weight with |bias| ≤ 1% and 95% half-width ≤ 7%.

## 4. Validation and the gate

| Check | Method | Pass |
|---|---|---|
| G1 Coverage | per cell | ≥ 3 sessions, ≥ 2 accounts; every session has an `input` or `output` arm; each weight the correction uses is `identified` in ≥ 2 sessions; no emulated labels |
| G2 Leave-one-session-out | refit without session s (γ of its group from that session's parity arm only), predict points of its other arms | median \|ln(pred/obs)\| ≤ 0.05, max ≤ 0.15 |
| G3 Submitter agreement | per-submitter weights vs pooled | each within ×/÷ 1.15, or Q-test p ≥ 0.05 |
| G4 Mixed-workload holdout | real sessions not in the fit, cut into segments of ≥ 5 points whose cache-read share of list-$ spans ≥ 20 pp; γ fitted on half the segments, the rest predicted | RMS ln error ≤ 0.07 and lower than with list-price weights |
| G5 Simulation | §3.3 | assertion holds |
| G6 Effect | bootstrap interval of F = φ(sample)/φ(metric) for the row | if it contains 1, F is set to 1 |

G4 data: ordinary per-call logs joined to a meter log. Fei #124's and #96's submitters hold per-call JSONL and meter CSVs that are not public [verified, issue text]; ask for them. Cross-account samples cannot serve as holdout: Pro weekly list-$ per point ranges $2.96–$12.66 across accounts [verified], which swamps any mix effect.

Cell status:

- `validated`: G1–G5 pass. Correction applied. `σ_mix = sqrt(sd(ln F over draws)² + τ_b² + 0.03²)`.
- `provisional`: some per-kind data, gate not passed. Correction not applied. `σ_mix = sqrt(mean over draws and named scenarios of (ln F)²)`, so the range covers the uncorrected bias.
- `unmeasured`: no per-kind data. Correction not applied. `σ_mix` = the vendor default (0.15; 0.05 where an official per-kind rate card exists).

No transfer between models or between bars. Transfer between plans or client classes only after §3.2 step 6 has compared two measured levels and not flagged them.

## 5. Publication

### 5.1 Repo layout

```
data/quota-weights/
  sessions/<vendor>/*.jsonl      raw submissions
  prices.json                    list prices per model, with source URL and date
  index.csv                      generated
  fit.json, fit.md               generated
scripts/fit-quota-weights.mjs    --write, --simulate, --cell <key>, --loso
kits/claude-code/scripts/quota-probe.mjs          runs the arms and writes a session file (see §8 Q3)
docs/QUOTA-WEIGHTS.md            generated header + static protocol
.github/ISSUE_TEMPLATE/quota-weights.yml
```

### 5.2 `docs/QUOTA-WEIGHTS.md` (draft, static part)

```markdown
# Quota weights

Generated by `node scripts/fit-quota-weights.mjs --write` from `data/quota-weights/sessions/`.

| Cell | Status | Cache read | 1h write | 5m write | Output | Sessions / accounts | LOSO median error |
|---|---|---|---|---|---|---|---|
(generated)

Weights are quota cost ÷ API list price. Fresh input = 1.

## Run a measurement

Requirements: a Pro, Max, Ultra or Team plan; Claude Code ≥ 2.1.300; Node ≥ 20; the account idle on every other device.

1. `node kits/claude-code/scripts/quota-probe.mjs probe` prints plan, both bars and reset times.
2. `node kits/claude-code/scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 7d --class interactive`
3. Commit the file it writes under `data/quota-weights/sessions/anthropic/` and open a pull request, or attach it to a "Quota weights" issue.

Values: 3 arms × 3 points on the weekly bar (about 10% of a week); 5 arms × 5 points on the 5h bar (about 30% of a window). Stops at 85% (5h) or 95% (weekly).

Failures:
- `meter moved while idle`: something else is using the account. Stop it and rerun.
- `window reset during arm`: rerun after the reset time shown.
- `request larger than 0.1 point`: rerun with `--scale 0.5`.
- `entrypoint mismatch`: unset `CLAUDE_CODE_ENTRYPOINT` and restart the terminal.

## Reproduce the fit

    node scripts/fit-quota-weights.mjs --write
    node scripts/fit-quota-weights.mjs --simulate

## When the correction applies

A cell is `validated` with ≥ 3 sessions from ≥ 2 accounts, leave-one-session-out median error ≤ 5%, submitters within ×/÷ 1.15, and a mixed-workload holdout error ≤ 7%. Other cells show the uncorrected value with a wider range.
```

### 5.3 Methodology dialog (draft)

```
Token mix
Subsidy × φ(sample mix) ÷ φ(benchmark mix), φ = quota cost ÷ list cost
Applied: validated cells only
Weights, data, fit: docs/QUOTA-WEIGHTS.md
```

Per-row tooltip line: `mix ×0.80 · validated` or `mix not applied · provisional (range widened)`.

### 5.4 Build consumption

1. `refresh-data.mjs` reads `data/quota-weights/fit.json`. Missing or unreadable file: every cell `unmeasured`, build continues.
2. Row → cell key: vendor, the row's **measured** model (for a derived row, the anchor row's model for φ(sample) and the row's own model for φ(metric)), bar of the sample (`7d` for weekly-percent samples), client class of the sample (`interactive` unless the note says `-p`, SDK or a relay).
3. φ(sample) uses the sample's token counts by actual TTL priced at list, weighted, divided by **the list worth Fei used for the row**. Fei priced some 1h writes at the 5m price; the denominator must be Fei's figure or the factor is off by up to 7% [computed on the Pro maintainer window: 1h share 18% vs 12%].
4. φ(metric) uses `aaCostPerTaskBreakdown`. Benchmark cache writes are weighted as the plan client's TTL (1h): effective weight on AA's write dollars = `w_1h × price_1h / price_5m`.
5. `validated`: `S_eff = S × F`, W1 σ = `σ_mix`. Otherwise `S_eff = S`, W1 σ = `σ_mix` from §4.
6. `MIX_SCENARIOS` in `scripts/reliability.mjs` is replaced by the cell's `draws`. `APPLY_CLAUDE_MIX_CORRECTION` is removed; the status decides.
7. `stats.quotaWeights = {fitGeneratedAt, cells: {key: status}}` in `combined.json`.

### 5.5 Tests for `scripts/test-site.mjs`

| Test | Assertion |
|---|---|
| session files | every file under `data/quota-weights/sessions/` passes schema validation |
| fit is current | re-running the fit in memory equals `fit.json` to 1e-6 (same seed) |
| simulation recovery | §3.3 assertion |
| normalisation | `weights.input === 1`; φ of a pure-input mix is 1 for every cell |
| identifiability | no cell reports a number for a kind with `identified: false` |
| gate consistency | `status === "validated"` iff all five gate booleans are true |
| no silent correction | every row with `mixFactor ≠ 1` maps to a `validated` cell; every other row has `mixFactor === 1` |
| σ floor | applied rows have `σ_mix ≥ 0.03`; `provisional` rows have `σ_mix ≥ \|ln F_central\|/√3` |
| no cross-model transfer | a row's φ(metric) weights come from a cell whose model equals the row's model |
| OpenAI, Cursor, Copilot, GLM | `mixFactor === 1` |
| bounds | `0.5 ≤ F ≤ 1.5` on every applied row |
| docs | `docs/QUOTA-WEIGHTS.md` table equals `fit.json` |

### 5.6 Inviting submissions

Issue template `.github/ISSUE_TEMPLATE/quota-weights.yml`:

```yaml
name: Quota weights
description: Submit a per-kind quota measurement
title: "[quota-weights] <vendor> · <plan> · <model> · <bar>"
labels: [quota-weights]
body:
  - type: input
    attributes: { label: Session file, description: "Attach the .jsonl from quota-probe, or a link" }
    validations: { required: true }
  - type: input
    attributes: { label: Raw logs or screenshots, description: "Gist, release asset or attachments" }
    validations: { required: true }
  - type: dropdown
    attributes: { label: Bar, options: [5h, weekly, both] }
  - type: dropdown
    attributes: { label: Client, options: [Claude Code TUI, "claude -p", Agent SDK, VS Code, Desktop, Codex CLI, Antigravity, other] }
  - type: checkboxes
    attributes:
      label: Controls
      options:
        - label: Account idle on every other device and surface
        - label: Meter did not move during the idle baseline
        - label: CLAUDE_CODE_ENTRYPOINT not set
        - label: No prompts, replies, paths or account ids in the attached files
```

Outreach, in order:

1. Fei-Craft/real-api-pricing: open one issue asking muscgab (author of #98 and #97) to repeat #98 with separate `write1h` and `write5m` groups, a `read` group, on the weekly bar, once headless and once in the TUI; link the protocol and the session schema. Offer to send the fit back as a research file. Their template is `.github/ISSUE_TEMPLATE/contribute-data.md`.
2. Same repo: ask the #124 and #96 submitters for per-5-minute token sums by kind to join with their meter logs (holdout, G4).
3. kler/claude-usage-ab: propose a `--arms-kind` mode; its harness already chains tick-anchored blocks and logs `rate_limit_event`.
4. anthropics/claude-code #97074: post the kind-by-client result once measured.

## 6. Current best estimate

### 6.1 Evidence, re-verified

| Source | What it shows | Status |
|---|---|---|
| ClaudeDevs, 2026-09-01, https://api.fxtwitter.com/status/2094851235694497836 | "In Claude Code, cache reads count at a reduced rate toward subscription usage, which remains unchanged." No number. "Reduced" relative to what is not stated | [verified] text |
| ClaudeDevs, 2026-10-08, https://api.fxtwitter.com/status/2108287358374482381 | Sonnet 5.5 API cache reads $0.20 → $0.10, "API only, no change to Claude Code usage limits" | [verified] text |
| https://code.claude.com/docs/en/costs.md | Claude Code "re-reads that history at the cached token rate", linking the API price page | [verified]; says reads count, gives no plan weight |
| https://support.claude.com/en/articles/9797557-usage-limit-best-practices | cached project content "counts less against your limits" | [verified]; claude.ai projects, no number |
| Fei #98, https://github.com/Fei-Craft/real-api-pricing/issues/98 | Max 5x, Opus 5.5, `claude -p` 2.1.280, one 5h window. List-$ per point: input $0.677 (5 intervals, all 0.68), output $0.680 (0.65–0.73), images $0.653 (2 intervals), cached group $1.247 (1.24–1.26) = 4,132,092 read + 51,123 1h write + 523 output per point | [verified] issue body via `gh` and Fei's archived JSON |
| → output / input | 0.995 (0.94–1.05) | [computed] |
| → one equation | `0.826 × w_read + 0.409 × w_1h = 0.668`: (w_1h, w_read) = (1, 0.31), (0.625, 0.50), (0.5, 0.56), (0, 0.81) | [computed]; matches the issue's table |
| kler run, https://github.com/kler/claude-usage-ab `results/2026-10-17T09-41-03Z-run.jsonl` | Team plan, Opus 5.5 high, 2.1.300, 5h bar, 9 chained blocks. `claude-vscode` blocks (label set by the harness): point 1 after 43k written (95.7% 1h) + 1.13–1.22M read; point 2 after a further 5k written + 2.83–2.87M read | [verified] raw file |
| → ratio | point-1 ÷ point-2 quota-$ under each #98 scenario: 1.76, 1.05, 0.89, 0.45; list price 0.93. Only (0.50, 0.625) is near 1 | [computed] |
| claude-code #45756 | Apr 2026, Max 5x, Opus 4.6: first pass 0× (6 windows), second pass "about 0.1× input" (806 calls in one window, three fixed hypotheses). 0.1× input was the list read price then | [verified]; coarse, old model |
| Gist, Dec 2025, https://gist.github.com/andrew-kramer-inno/34f9303a5cc29a14af7c2e729b676fc9 | one probe on a 17-digit header: 5m write = 1.0007× input, output = 4.99× input, read delta below the 3-token noise floor | [verified]; plan and model not stated |
| Fei #96 | Max 20x, 314 weekly points: R² 0.935 at list, 0.931 with reads free; 5h: 0.993 vs 0.977. Constant mix, cannot separate | [verified] |
| Fei #124 | Pro, $12.66 list per weekly point, 3.96× the adopted row; `/api/oauth/usage` values all integers | [verified]; unexplained by any weights |
| claude-code #58786 | hypothesis: weekly bar counts reads at full weight. No readings. Closed stale | [verified]; see §0.3 |
| claude-code #97074, #111890 | headless and SDK drain 1.8–2.9× faster on the 5h bar | [verified] |

### 6.2 Weights, Opus 5.5, 5h bar

| Kind | Estimate (÷ list) | Interval | Basis |
|---|---|---|---|
| Fresh input | 1 | fixed | normalisation |
| Output incl. thinking | 0.995 | 0.94–1.05 | #98 [computed] |
| Cache read | 0.51 | 0.49–0.54 measurement error only; **0.31–0.81 without the kler constraint** | #98 + kler [computed, inferred] |
| 1h cache write | 0.60 | 0.55–0.64; **0–1 without kler** | same |
| 5m cache write | 0.8–1.0 | not measured on a current model | Dec 2025 gist (0.80); if every write costs the 1h quota rate, 0.96 |
| Client multiplier, SDK ÷ `claude-vscode` label | 2.09 | 1.996–2.179 | kler [computed]; kler's own 2.9 uses 1.25× for 1h writes |

Implied quota prices: read $0.103/M (0.098–0.108), 1h write $4.78/M (4.42–5.14), against list $0.20 and $8 [computed].

The narrow interval assumes weights are equal across Max 5x and Team and across `sdk-cli` and an emulated `claude-vscode` label. One account each. Under the gate this cell is `provisional`.

The interactive class has no input or output arm anywhere. kler's `claude-vscode` blocks fix only the ratio read ÷ 1h write = 0.86 (0.78–0.95); list-price weights (ratio 1.00) sit just outside it. How interactive cache weights compare with interactive input and output is unmeasured; the 2.09 multiplier is derived under the shared-weights assumption and would change with it.

Weak cross-check [inferred]: Fei's Pro maintainer window (interactive, 133.1M read, 0.925M written, 0.359M output = one full 5h window) costs $0.25 parity per point with these weights. #98's $0.68 × 2.09 ÷ 5 predicts $0.28. List-price weights give $0.41.

Weekly bar: **no estimate**. Sonnet 5.5, Fable 5.2, Haiku 5.5: **no estimate**.

### 6.3 What the correction would be

F = φ(sample) / φ(AA mix); real cost changes by 1/F. AA $ shares [verified, `combined.json`]: Opus 5.5 read 47.2 / write 17.9 / output 34.5; Sonnet 5.5 48.7 / 22.7 / 28.5; Fable 5.2 32.1 / 26.6 / 41.0. Sample $ shares: Max 5x × Opus 5.5 read 71.3 / 1h write 12.3 / output 16.4; Pro × Fable 5.2 read 21.4 / 1h write 51.4 / output 27.2 [computed].

| Row → metric | Assumption | F | Real cost |
|---|---|---|---|
| Max 5x × Opus 5.5 → AA Opus 5.5 | 5h weights hold on the weekly bar and in the TUI | 0.80 (0.78–0.83); 0.76–0.85 on the whole #98 line | +25% |
| Pro × Opus 5.5 → AA Opus 5.5 | same | 0.82 (0.79–0.84); 0.77–0.87 | +23% |
| either | weekly bar has no cache discount (§0.3) | 1.00 | 0 |
| Opus sample → AA Sonnet 5.5 | Opus weights transfer | 0.82 (0.79–0.84) | +23% |
| Opus sample → AA Sonnet 5.5 | Sonnet read quota rate unchanged by the Oct 8 cut (weight 2×) | 0.61 | +64% |
| Pro × Fable 5.2 → AA Fable 5.2 | Opus weights transfer | 0.84 (0.81–0.89); 0.49–1.13 on the whole #98 line | +18% |
| Pro × Fable 5.2 → AA Fable 5.2 | Fable reads at the same quota rate per input-$ as Opus (weight 2×) | 0.81 (0.78–0.85) | +23% |

The `reliability-design.md` figures (× 0.78 Max, × 0.86 Pro, × 0.83 Fable) are reproduced within 0.04 for Opus under the stated assumption [computed]. The assumption is the open part, not the arithmetic.

## 7. Decision rule for the flag

**Rule:** the correction applies to a row only when the row's cell is `validated` (§4). The flag becomes the cell status in `fit.json`.

**Today: off for every row.** Set `APPLY_CLAUDE_MIX_CORRECTION = false` and keep the W1 term wide.

Reasons:

1. The cell the site needs, Opus 5.5 × weekly × interactive, has zero per-kind measurements. The measured cell differs on both axes, and no interactive session anywhere has an input or output arm to normalise against.
2. Both untested axes have evidence of mattering: the client label moves burn by 2× (verified), and the windows-per-week comparison fits "no cache discount on the weekly bar" (inferred, weak). Under that reading the right factor is 1.00.
3. One account, one 20-minute run carries the whole magnitude. The second dataset has an emulated label on a different plan.
4. For Sonnet 5.5 and Fable 5.2 the weight could be 0.5 or 1.0 by Anthropic's own statements; F spans 0.61–0.82 and 0.49–1.13.
5. The cost of waiting is small: 3 sessions from 2 accounts, about 10% of a week each, pass G1–G3.

W1 σ while off [computed as RMS of ln F over the plausible range, including F = 1]:

| Rows | σ_mix |
|---|---|
| Claude × Opus 5.5 | 0.16 (F 0.76–1.00) |
| Claude × Sonnet 5.5, Haiku 5.5 | 0.28 (F 0.61–1.00) |
| Claude × Fable 5.2 | 0.25 (between 0.12 for F 0.81–1.00 with the kler constraint and 0.38 for F 0.49–1.13 without) |

If the reliability model can carry a one-sided range, extend it only toward higher real cost for Opus and Sonnet.

Switch-on sequence: weekly × interactive sessions arrive → fit → gate → status `validated` → build applies F with the fitted σ. No manual flag.

## 8. Open questions

1. **Run the weekly × interactive protocol on your own subscription this week?** Recommended: yes. It is the fastest way to turn §0.3 from a guess into a number, and it is one of the two accounts G1 needs. Cost: about 10% of a week on Opus 5.5.
2. **Model the client-label multiplier on the site?** Recommended: yes, as its own step, separate from mix. T3 Code drives Claude through the Agent SDK (`sdk-ts`); Fei's subsidies are taken as TUI usage (not verified per sample). A subsidy ÷ 2.1 (range 1.3–2.9 across six reports, five of them controlled, all on the 5h bar) for SDK-driven metrics on Claude plans is the current evidence; the weekly bar needs its own run (the `sdk` class of §1.3 gives it). Needs your decision because it moves Claude × T3 rows more than anything in this document.
3. **Ship `kits/claude-code/scripts/quota-probe.mjs`?** Recommended: yes. Without a harness, submissions will differ in anchoring and controls and most will be unanchored (±17% per session instead of ±4%). Alternative: contribute a kind mode to kler/claude-usage-ab and depend on it.
4. **Accept label-emulated sessions (`CLAUDE_CODE_ENTRYPOINT` set by hand)?** Recommended: store them, exclude them from validated fits. Setting the label changes how the account is metered; a real TUI session driven through tmux measures the same thing without that.
5. **Accept a logging proxy on `ANTHROPIC_BASE_URL` as a meter source?** Recommended: accept, not require. The status line and `rate_limit_event` give the same whole-percent resolution since April 2026.
6. **Which σ while off: symmetric or one-sided?** Recommended: one-sided toward higher real cost for Opus 5.5 and Sonnet 5.5, symmetric for Fable 5.2.
7. **Show the provisional factor anywhere?** Recommended: in the row tooltip only (`mix not applied · provisional ×0.80`), never in the ranking.
8. **Fable 5.2 and Sonnet 5.5 cells: wait for their own runs?** Recommended: yes. Anthropic decoupled their cache-read list prices from plan usage in writing; a transferred weight is a guess with a known reason to be wrong.
9. **Google and OpenAI parity runs: block anything on them?** Recommended: no. Keep `mixFactor = 1` with W1 0.05 (OpenAI) and 0.15 (Google); invite one Antigravity single-kind run because the existing weak evidence has the opposite sign to Claude.
10. **Minimum for G1: 2 accounts or 3?** Recommended: 2 to switch on, with `τ_b` in σ; re-evaluate at 4.

## 9. Verification ledger

Read or fetched in this session: Fei #96, #97, #98, #124 bodies (`gh`, Fei-Craft/real-api-pricing) and their archived JSON in the clone; #124's meter CSV (gist); claude-code #45756, #58786, #97074, #111890 (bodies and the comments quoted); kler/claude-usage-ab README, report and raw `.jsonl`; `tools/quota-analysis.mjs` source; ArkNill `02_RATELIMIT-HEADERS.md`; the Dec 2025 gist; code.claude.com `statusline.md`, `costs.md`, `prompt-caching.md`, `headless.md`; both ClaudeDevs posts via fxtwitter; support.claude.com articles 9797557 and 15036540; ccusage docs (first 100k characters); Fei's Gemini mix and Claude sample records; `public/data/combined.json` AA breakdowns; `scripts/reliability.mjs` and `scripts/refresh-data.mjs` mix code.

Computed here: every number in §1.5, §3.3, §6.2, §6.3, §7.

Not verified: `/api/oauth/usage` request headers (third-party clients only); Codex rollout field names (third-party parsers and #97); Antigravity token logging; the peak-hour effect; whether AA's cache writes are 5-minute; ccusage's handling of 5m vs 1h writes; Team-plan size in kler's run; that Fei's samples are all TUI sessions.

Not found: any per-kind measurement on the weekly bar; any per-kind measurement for Sonnet 5.5, Fable 5.2 or Haiku 5.5; any Anthropic statement on client-label weighting; any single-kind run on Antigravity.

## 10. Scratch files

- `docs/design/quota-weights-proto/fit-proto.mjs`: fitter and simulator prototype (alternating γ / NNLS, bootstrap, φ).
- `docs/design/quota-weights-proto/sim.mjs`, `sim2.mjs`: sample-size tables.
- `docs/design/quota-weights-proto/current.mjs`: §6 numbers from #98 and kler.
- `docs/design/quota-weights-proto/raw/`: downloaded sources (kler run, #124 CSV, docs, gist, `quota-analysis.mjs`).
