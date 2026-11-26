# Quota weights

Generated table: `node scripts/fit-quota-weights.mjs` from `data/quota-weights/submissions/`. Weight = quota cost ÷ API list price; fresh input = 1. `—` = not identified.

<!-- fit-table:start -->
| Cell | Status | Cache read | 1h write | 5m write | Output | Sessions / accounts | LOSO median error |
|---|---|---|---|---|---|---|---|
| anthropic/claude-opus-5-5/5h/interactive | unmeasured | — | — | — | — | 1 / 1 | — |
| anthropic/claude-opus-5-5/5h/sdk | provisional | — | — | — | 1.00 (0.95–1.04) | 3 / 2 | — |

Unmeasured, no data: `anthropic/claude-fable-5-2/5h/interactive`, `anthropic/claude-fable-5-2/5h/sdk`, `anthropic/claude-fable-5-2/7d/interactive`, `anthropic/claude-fable-5-2/7d/sdk`, `anthropic/claude-haiku-5-5/5h/interactive`, `anthropic/claude-haiku-5-5/5h/sdk`, `anthropic/claude-haiku-5-5/7d/interactive`, `anthropic/claude-haiku-5-5/7d/sdk`, `anthropic/claude-opus-5-5/7d/interactive`, `anthropic/claude-opus-5-5/7d/sdk`, `anthropic/claude-sonnet-5-5/5h/interactive`, `anthropic/claude-sonnet-5-5/5h/sdk`, `anthropic/claude-sonnet-5-5/7d/interactive`, `anthropic/claude-sonnet-5-5/7d/sdk`.
<!-- fit-table:end -->

## Run a measurement

Requirements: Claude Pro, Max, Ultra or Team; Claude Code ≥ 2.1.300; Node ≥ 20; tmux (for `--drive tmux`); the account idle on every other device and surface (web, desktop, phone, scheduled and cloud agents).

1. Check the setup:

       node scripts/quota-probe.mjs probe

2. Practise without API calls:

       node scripts/quota-probe.mjs run --dry-run --bar 7d --class interactive --plan max_5x

3. Record. Pick the row for your cell, set `--plan` and `--submitter <your GitHub login>`:

   | Cell | Command |
   |---|---|
   | weekly bar, interactive (site cell, run first) | `node scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 7d --class interactive --plan max_5x` |
   | 5h bar, interactive | `node scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 5h --class interactive --plan max_5x` |
   | 5h bar, `claude -p` | `node scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 5h --class sdk --plan max_5x` |
   | weekly bar, `claude -p` | `node scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 7d --class sdk --plan max_5x` |

4. Upload the `.raw.jsonl` file the run prints (gist or issue attachment), then:

       node scripts/quota-probe.mjs set-raw <submission.jsonl> <url>

5. Submit (below).

Start with the bar under test below 60%. The run stops at 85% (5h) or 95% (weekly). On a weekly run it pauses when the 5h bar reaches 85% and resumes after the 5h reset.

### Values

| Run | Arms | Anchored points per arm | Quota used | Requests (Max 5x, simulated) |
|---|---|---|---|---|
| weekly bar | `input`, `read`, `write1h` | 3 | about 12% of a week; 1–2 five-hour windows on Pro and Max 5x | about 3,000 (`read` about 2,700) |
| 5h bar | `input`, `output`, `read`, `write1h`, `write5m` | 5 | about 30% of one window | about 700 (sdk) |

| Option | Values | Default |
|---|---|---|
| `--model` | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2` | `claude-opus-5-5` |
| `--bar` | `7d`, `5h` | `7d` |
| `--class` | `interactive`, `sdk` | `interactive` |
| `--plan` | `pro`, `max_5x`, `max_20x`, `ultra`, `team` | `max_5x` |
| `--drive` | `tmux`, `guided` | `tmux` when installed |
| `--meter` | `statusline`, `manual`, `oauth` | `statusline` |
| `--arms` | comma list of `input,output,read,write1h,write5m` | per bar, above |
| `--points` | anchored points per arm | 3 (7d), 5 (5h) |
| `--idle-min` | idle baseline before and after, minutes | 10 |
| `--scale` | request size multiplier | 1 |
| `--submitter` | GitHub login | `anonymous` |
| `--account-label` | any stable private string | account UUID in `~/.claude.json` |
| `--session-n` | arm rotation index | your earlier files today |
| `--no-safe-mode` | run Claude Code without `--safe-mode` | off |

Drives for `--class interactive`:

- `tmux`: the probe starts the TUI in a detached tmux session and pastes each prompt. Watch with `tmux attach -t <name>`; do not type into it.
- `guided`: the probe prints the command to start Claude Code in a second terminal, then one line per request (`/clear`, `@prompt-0001.txt Reply with the single word: ok`, or the question to paste). Press Enter in the probe terminal after each answer. Use it for 5h runs on Pro; a weekly `read` arm needs thousands of pastes.

`--meter manual` and `--meter oauth` record start and end readings only (`anchored: false`, ±1 point). Use at least 10 points per arm (`--points 10`). `manual`: type both bars from `/usage` when asked. `oauth`: read from `api.anthropic.com/api/oauth/usage` (undocumented; the token is read from `~/.claude/.credentials.json` and never written).

The submission stores no credentials, prompts, paths or email. `account_hash` = first 8 hex of SHA-256(account UUID + a random salt in `~/.config/ai-plan-value/quota-probe-salt`).

### Failures

| Message | Do |
|---|---|
| `CLAUDE_CODE_ENTRYPOINT=… is set in this shell` | `unset CLAUDE_CODE_ENTRYPOINT`, restart the terminal (and the tmux server) |
| `entrypoint mismatch` | same |
| `meter moved while idle` | something else is using the account; stop it and rerun |
| `window reset during arm …` | none; the probe restarts the arm. Rerun if it repeats |
| `request larger than 0.1 point` | rerun with `--scale 0.5` |
| `status line not running after 60 s` | rerun with `--no-safe-mode` |
| `tmux not found` | install tmux, or use `--drive guided` |
| `no account id found` | pass `--account-label <string>`; reuse the same string on every run from this account |
| `OAuth usage unavailable` | use `--meter manual` |
| `stopped at 85% of the 5h bar` / `95% of the 7d bar` | rerun after the reset time shown by `probe` |
| fitter: `raw.url missing` | step 4 |
| fitter: `idle_ticks = N` | rerun |

## Submit

Either:

- commit the `.jsonl` under `data/quota-weights/submissions/anthropic/` and open a pull request, or
- open a "Quota weights submission" issue and attach the `.jsonl` and the `.raw.jsonl`.

Before submitting, check the file: `node scripts/fit-quota-weights.mjs --cell anthropic/<model>/<bar>/<class>`.

## Submission format

JSON Lines, UTF-8. Line 1 is the header. Unknown schema versions are rejected.

`quota-weights.session/1` (anchored meter): then `req` and `meter` rows in time order.

| Header field | Value |
|---|---|
| `schema` | `quota-weights.session/1` or `quota-weights.segments/1` |
| `session_id` | unique in the repo |
| `submitter` | GitHub login |
| `account_hash` | 8 hex |
| `vendor`, `plan`, `plan_price_usd` | `anthropic`, `max_5x`, `100` |
| `model`, `effort` | `claude-opus-5-5`, `low` |
| `client`, `client_version`, `entrypoint` | `claude-code`, `2.1.332`, `cli` / `sdk-cli` / `sdk-ts` / `claude-vscode` |
| `client_class` | `interactive` / `sdk` (default: `sdk` when `entrypoint` starts with `sdk`) |
| `label_emulated` | `true` when `CLAUDE_CODE_ENTRYPOINT` was set by hand |
| `meter_source` | `rate_limit_event`, `statusline`, `oauth_usage`, `headers`, `usage_screenshot`, `manual`, `codex_rollout`, `antigravity_usage` |
| `meter_resolution` | `1` |
| `bars` | `[{id:"5h", resets_at}, {id:"7d", resets_at}]` |
| `bar_under_test` | `5h` / `7d` |
| `cache_ttl` | `1h`, `5m`, `off`, `mixed` |
| `shared_account` | `false` |
| `idle_before_min`, `idle_after_min`, `idle_ticks` | minutes, minutes, ticks (`null` = not recorded) |
| `prices_usd_per_mtok` | `{input, output, cacheRead, cacheWrite5m, cacheWrite1h}` |
| `raw` | `{url, sha256}` of the raw bundle |
| `segmenting` | `arm` (default) / `point` |
| `chain_anchors` | `true` = a run may start at the previous run's last tick (equal request sizes only) |
| `holdout` | `true` = mixed-workload session for G4, not fitted |
| `seed`, `source` | public measurements encoded in this repo |
| `notes` | text |

| Row | Fields |
|---|---|
| `req` | `{t:"req", ts, arm, block?, request_id, input, output, cache_read, cache_write_5m, cache_write_1h}`; integers; `input` excludes cached and written tokens; `output` includes thinking |
| `meter` | `{t:"meter", ts, after_request_id?, bar, used_pct, resets_at}` |
| `seg` (segments/1) | `{t:"seg", arm, bar, points, anchored, boundary_points?, input, output, cache_read, cache_write_5m, cache_write_1h, ts_start, ts_end}` |

Arms: `input`, `output`, `read`, `write1h`, `write5m`, `mixed` (counted, any workload), `context` (anchoring only, never counted).

A file is rejected when: the schema is unknown; a required header field is missing; `simulated: true`; `raw.url` is missing; `shared_account` is not `false`; `idle_ticks` > 0; header prices differ from `data/quota-weights/prices.json` by more than 1%; a token field is not a non-negative integer; a meter decreases inside a window; `resets_at` changes inside an arm on the bar under test. Reasons are listed in `data/quota-weights/fit.md`.

## Fit

    node scripts/fit-quota-weights.mjs                 # writes fit.json, fit.md, index.csv, the table above
    node scripts/fit-quota-weights.mjs --check         # exit 1 when fit.json is not current
    node scripts/fit-quota-weights.mjs --simulate      # recovery tables and the CI assertion
    node scripts/fit-quota-weights.mjs --cell <key>    # one cell
    node scripts/fit-quota-weights.mjs --pool-classes  # diagnostic: client classes pooled, emulated labels kept; prints only

Options: `--boot` (2000), `--perm` (1000), `--seed` (1), `--runs` (200).

- Cell: vendor × model × bar × client class, key `anthropic/claude-opus-5-5/7d/interactive`. Weights are shared inside a cell.
- Group: account × plan × bar × client class × model × ISO week; one scale γ per group.
- Model: `points = γ × Σ w_k × list-$_k`, `w_input = 1`, `w_k ≥ 0`.
- Segments: tick to tick. An anchor tick counts when the two requests before it each cost ≤ 0.15 point. Unanchored segments carry variance 1/6 point².
- Variance per segment: `(b_first² + b_last²)/12 + (τ × points)²`; τ from the anchored residuals, floor 0.01.
- Estimation: alternating γ and weighted NNLS over all active sets, until weights move < 1e-10 (200 rounds).
- A kind below 5% of list-$ in every segment is held at weight 1 and reported `—`.
- Identified: some segment has ≥ 50% of its list-$ and of its fitted quota-$ in the kind; the γ-profiled, column-normalised design has condition number < 100; the kind's estimate does not correlate ≥ 0.8 with a kind pinned at 0.
- Intervals: cluster bootstrap over sessions within group (segments when a group has < 3 sessions), 2,000 resamples, 2.5–97.5 percentiles, mulberry32 seed 1. 200 draws kept in `fit.json`.
- Heterogeneity per dimension (submitter, account, plan, entrypoint, client version): separate fits per level, Cochran's Q and I² on ln w, permutation p over session labels (1,000). Flagged at p < 0.05 with weights > 10% apart.
- τ_b: DerSimonian–Laird on per-submitter ln w.

## Gate

| Check | Pass |
|---|---|
| G1 coverage | ≥ 3 sessions, ≥ 2 accounts; every session has an `input` or `output` arm; output, cache read and 1h write identified, each in ≥ 2 sessions; no emulated labels; every session has a recorded idle baseline |
| G2 leave one session out | γ of the left-out session from its `input` / `output` arms; its other arms predicted with ≥ 2 sessions evaluated: median \|ln(pred/obs)\| ≤ 0.05, max ≤ 0.15 |
| G3 agreement | ≥ 2 submitters; each required weight within ×/÷ 1.15 of the pooled fit or Q-test p ≥ 0.05; no heterogeneity flag |
| G4 holdout | `holdout: true` sessions cut into ≥ 5-point chunks; cache-read share spans ≥ 20 pp; γ on half, the rest predicted: RMS ln error ≤ 0.07 and below list-price weights |
| G5 simulation | 200 seeded runs of 3 sessions × 3 points, noise 3%: \|bias\| ≤ 1% and 95% half-width ≤ 7% on every weight |

| Status | When | Build |
|---|---|---|
| `validated` | G1–G5 pass | correction applied |
| `provisional` | some kind identified | not applied; σ keeps the uncorrected range |
| `unmeasured` | nothing identified, or no data | not applied; σ keeps the uncorrected range |

Sessions with `label_emulated: true` are fitted only when a cell has no other sessions; such a cell cannot pass G1.

## Build

`node scripts/refresh-data.mjs` reads `data/quota-weights/fit.json`. Missing or unreadable: every cell `unmeasured`.

- Row → cells: φ(sample) from the measured sample's model (the chain's anchor for a derived row), φ(metric) from the row's model; bar `7d`; client class `sdk` when the sample notes say `-p`, SDK or relay, else `interactive`.
- Applied when every cell the row uses is `validated`, the sample has its own token breakdown, one sample model, and `FORCE_CLAUDE_MIX_CORRECTION_OFF` (in `scripts/refresh-data.mjs`) is `false`.
- Applied: `S_eff = S × F`, `F = φ(sample) ÷ φ(metric)`, `φ = Σ w_k × list-$_k ÷ list worth`. Benchmark cache writes count as 1h writes: weight `w_1h × p_1h ÷ p_5m`. Range: 2.5–97.5 percentiles of F over the bootstrap draws. When the range contains 1, F = 1. σ = √(sd(ln F)² + τ_b² + 0.03²).
- `stats.reliability.claudeMixCorrection` in `public/data/combined.json`: cell statuses, counts, rows applied. Each Claude row carries `rel.mix = {cells, status, applied}`.
