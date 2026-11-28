# Claude Code kit

Measures how a Claude plan's usage limit counts each token type (input, output, cache read, cache write), and the plan's API value.

## Run a measurement

Requirements: Claude Pro, Max, Ultra or Team; Claude Code ≥ 2.1.300; Node ≥ 20; tmux (for `--drive tmux`); the account idle on every other device and surface (web, desktop, phone, scheduled and cloud agents).

0. Update Claude Code, then open a new terminal outside Claude Code:

       unset CLAUDE_CODE_ENTRYPOINT
       export DISABLE_AUTOUPDATER=1

   Download the kit and run every command from the folder:

       curl -fsSL https://github.com/melo-foundation/ai-plan-value/archive/refs/heads/main.tar.gz | tar -xz
       cd ai-plan-value-main

   Check it works first (one short prompt): `node kits/claude-code/scripts/quota-probe.mjs probe --ping`.

   `DISABLE_AUTOUPDATER=1` applies to this terminal only; it keeps `claude -p` runs on one version. Every file records the client version.

1. Check the setup (`--oauth` also prints both bars from `api.anthropic.com/api/oauth/usage`):

       node kits/claude-code/scripts/quota-probe.mjs probe --oauth

2. Practise without API calls:

       node kits/claude-code/scripts/quota-probe.mjs run --dry-run --bar 7d --class interactive --plan ultra

3. Record. Pick the row for your cell, set `--plan` and `--submitter <your GitHub login>`:

   | Cell | Command |
   |---|---|
   | weekly bar, interactive (site cell, run first) | `node kits/claude-code/scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 7d --class interactive --plan ultra` |
   | 5h bar, interactive | `node kits/claude-code/scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 5h --class interactive --plan ultra` |
   | 5h bar, `claude -p` | `node kits/claude-code/scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 5h --class sdk --plan ultra` |
   | weekly bar, `claude -p` | `node kits/claude-code/scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 7d --class sdk --plan ultra` |

4. Upload the `.raw.jsonl` file the run prints (gist or issue attachment), then:

       node kits/claude-code/scripts/quota-probe.mjs set-raw <submission.jsonl> <url>

5. Submit (below).

6. Record a holdout for G4 (once per account): work normally in one of your own projects, one Claude Code session at a time, for at least 20 points of the bar:

       node kits/claude-code/scripts/quota-probe.mjs record-holdout --dir <project> --model claude-opus-5-5 --plan ultra --bar 7d

   Then step 4 and 5 for the file it writes.

Start with the bar under test below 60%. The run stops at 85% (5h) or 95% (weekly). On a weekly run it pauses when the 5h bar reaches 85% and resumes after the 5h reset.

### Values

| Run | Arms | Anchored points per arm | Quota used | Requests (Max, simulated) |
|---|---|---|---|---|
| weekly bar | `input`, `read`, `write1h` | 3 | about 12% of a week; 1–2 five-hour windows on Pro and Max | about 3,000 (`read` about 2,700) |
| 5h bar | `input`, `output`, `read`, `write1h`, `write5m` | 5 | about 30% of one window | about 700 (sdk) |

| Option | Values | Default |
|---|---|---|
| `--model` | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2` | `claude-opus-5-5` |
| `--bar` | `7d`, `5h` | `7d` |
| `--class` | `interactive`, `sdk` | `interactive` |
| `--plan` | `pro`, `max`, `ultra`, `team` (`max_5x` → `max`, `max_20x` → `ultra`) | `max` |
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
| `--oauth` | allow reads of `api.anthropic.com/api/oauth/usage` (idle baseline, `--meter oauth`, `probe`) | off |

Drives for `--class interactive`:

- `tmux`: the probe starts the TUI in a detached tmux session and pastes each prompt. Watch with `tmux attach -t <name>`; do not type into it.
- `guided`: the probe prints the command to start Claude Code in a second terminal, then one line per request (`/clear`, `@prompt-0001.txt Reply with the single word: ok`, or the question to paste). Press Enter in the probe terminal after each answer. Use it for 5h runs on Pro; a weekly `read` arm needs thousands of pastes.

`--meter manual` and `--meter oauth` record start and end readings only (`anchored: false`, ±1 point). Use at least 10 points per arm (`--points 10`). `manual`: type both bars from `/usage` when asked. `oauth` (needs `--oauth`): read from `api.anthropic.com/api/oauth/usage` (undocumented; the token is read from `~/.claude/.credentials.json` or `CLAUDE_CODE_OAUTH_TOKEN` and never written).

Idle baseline: `sdk` sends a one-word request before and after `--idle-min` minutes; `interactive` asks you to type both bars from `/usage` (`--oauth`: reads them).

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
| `--meter oauth needs --oauth` | add `--oauth` |
| `record-holdout`: `fewer than 20 points` | keep working and record again |
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
| `vendor`, `plan`, `plan_price_usd` | `anthropic`, `max`, `100` |
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
