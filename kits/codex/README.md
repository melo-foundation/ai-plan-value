# Codex quota kit (ChatGPT Plus, Pro)

Measures the API dollars behind each percentage point of the Codex weekly limit on ChatGPT Plus, Pro 10x, Pro 20x and Pro 500, and the plan's monthly API value and subsidy multiple.

Run the smoke check first; it uses one short prompt and gives a report to send:

    node kits/codex/scripts/codex-quota.mjs smoke --plan plus

On Pro, pass `--plan pro-10x`, `pro-20x` or `pro-500`. Open the link it prints and press Create. The report is `kits/codex/results/smoke-codex-<date>.json`.

## Requirements

- ChatGPT Plus, Pro 10x, Pro 20x or Pro 500.
- Node.js 20 or newer.
- Codex CLI (`codex`) on your `PATH`, logged in with that ChatGPT account.
- Weekly limit below 65% at the start (Plus) or below 75% (Pro).
- A plain terminal, not one inside Codex, Claude Code or an IDE agent.

## Plans

| Plan | `--plan` | Fee | Status |
|---|---|---|---|
| ChatGPT Plus | `plus` (optional) | $20 | Tested (2026-11-27) |
| ChatGPT Pro 10x | `pro-10x` (required) | $100 | Untested: run `smoke` first |
| ChatGPT Pro 20x | `pro-20x` (required) | $200 | Untested: run `smoke` first |
| ChatGPT Pro 500 | `pro-500` (required) | $500 | Untested: run `smoke` first |

Pass `--plan` on Pro: its `plan_type` (`pro`, `prolite` or `promax`) does not name the tier. A `--plan` that does not match the account's `plan_type` stops the run after the first ping.

## Values

Defaults with GPT-6.2 Sol, medium effort. A run stops at the target, or at `--max-hours` once the weekly meter has moved 3 points, whichever comes first.

| Plan | Run | Uses | Tasks at a time | Takes | API value spent |
|---|---|---|---|---|---|
| Plus | A | +12% of the weekly limit | 1 | 1–3 h | about $8 |
| Plus | B | +8% | 1 | 1–2 h | about $5 |
| Pro 10x | A | +4% | 2 | about 2.6 h | about $19 |
| Pro 10x | B | +3% | 3 | about 1.5 h | about $15 |
| Pro 20x | A | +3% | 3 | about 2.6 h | about $29 |
| Pro 20x | B | +3% | 5 | about 1.8 h | about $29 |
| Pro 500 | A | +3% | 6 | about 3.3 h | about $73 |
| Pro 500 | B | +3% | 6 | about 3.8 h | about $73 |

Add 14 min of idle checks to each run. `run --dry-run` prints the target, tasks at a time and expected hours for your plan and `--model`.

If the 5-hour limit reaches 95%, the run pauses until its reset and prints the time.

## 1. Set up

Clone the repo and run every command from its root:

    git clone https://github.com/melo-foundation/ai-plan-value.git
    cd ai-plan-value

Check the setup; it must end with `ok` (Pro: add `--plan pro-20x` or your tier):

    node kits/codex/scripts/codex-quota.mjs check

Run the kit's tests:

    node --test kits/codex/test/*.test.mjs

Print the commands without spending quota:

    node kits/codex/scripts/codex-quota.mjs run --arm A --dry-run

## 2. Run

Close every other Codex session (CLI, IDE extension, desktop app, chatgpt.com Codex tasks) and every other tool logged in with the same ChatGPT account until both runs end.

Run A first:

    node kits/codex/scripts/codex-quota.mjs run --arm A --tag plus-A1

Then run B:

    node kits/codex/scripts/codex-quota.mjs run --arm B --tag plus-B1

On Pro, add your tier and name the tags after it:

    node kits/codex/scripts/codex-quota.mjs run --arm A --plan pro-20x --tag pro20-A1
    node kits/codex/scripts/codex-quota.mjs run --arm B --plan pro-20x --tag pro20-B1

Press `Ctrl-C` once to stop after the current tasks and analyse up to that point; press it again to quit at once.

Task folders: `~/.cache/codex-quota-runs/<tag>/`. Logs and manifest: `kits/codex/results/runs/<tag>/`.

## 3. Watch

One line per task:

    14:02 r1-lru           exit 0       calls  18  $  0.412  5h 6%  weekly 20%  +1/12 pp  ~95 min left

Plans without a 5-hour window show no `5h` column.

| You see | Do |
|---|---|
| `calls` above 0 and `$` rising | nothing |
| `exit` not 0 three times in a row | the run stops; send the `stderr` lines with your result |
| weekly not moving after 10 tasks (Plus) or 40 tasks (Pro) | press `Ctrl-C` and send the output |

## 4. Result

Each run writes `kits/codex/results/<tag>.json` and prints a summary. Compare the two runs:

    node kits/codex/scripts/codex-quota.mjs compare kits/codex/results/plus-A1.json kits/codex/results/plus-B1.json

This writes `kits/codex/results/compare-plus-A1-vs-plus-B1.json`.

To analyse a run again:

    node kits/codex/scripts/codex-quota.mjs analyse --run plus-A1

| Line | Value |
|---|---|
| `weekly … $x/pp (95% lo–hi)` | API $ per 1% of the weekly limit |
| `monthly API value` | 100 × weekly $/pp × 4 |
| `subsidy` | monthly API value ÷ the plan's fee |
| `measured ÷ site` | your multiple ÷ the site's multiple for the model on your plan |
| `verdict` | `clean`, `check` (warnings) or `contaminated` (errors) |
| compare `verdict` | `price-proportional`, `not price-proportional` or `inconclusive` |

## Token weights

Measures the meter's weight for uncached input, cached input, visible output and reasoning, each relative to its API price (uncached input = 1), on the 5-hour and weekly windows.

Start with the weekly limit below 70% and the 5-hour limit below 20%. Run the four arms one after another:

    node kits/codex/scripts/codex-quota.mjs run --arm cache --tag plus-cache1
    node kits/codex/scripts/codex-quota.mjs run --arm input --tag plus-input1
    node kits/codex/scripts/codex-quota.mjs run --arm output --tag plus-output1
    node kits/codex/scripts/codex-quota.mjs run --arm reasoning --tag plus-reasoning1

Fit them, with your A and B runs as holdouts:

    node kits/codex/scripts/codex-quota.mjs weights --runs plus-cache1,plus-input1,plus-output1,plus-reasoning1,plus-A1,plus-B1

Runs kept in another folder: add `--runs-dir <folder holding <tag>/manifest.json>`. The result is `kits/codex/results/weights-<plan>-<model>.json`.

Plus, GPT-6.2 Sol, defaults:

| Arm | Calls | Effort | Tasks at a time | Uses | Takes | API value spent |
|---|---|---|---|---|---|---|
| `cache` | one ≈ 40k-token first message per stream, then `codex exec resume` with a one-word question | low | 2 | +3% of the weekly limit, about +18% of the 5-hour limit | about 25 min | about $2 |
| `input` | a unique ≈ 30k-token prompt, one-word answer | low | 1 | same | about 10 min | about $2 |
| `output` | a short prompt for 400 numbered lines | low | 3 | same | about 15 min | about $2 |
| `reasoning` | a short puzzle, number-only answer | high | 3 | same | about 20 min | about $2 |

All four: +12% of the weekly limit. Add 14 min of idle checks to each arm. An arm stops at 2 h once the meter has moved 3 points. `run --arm <arm> --dry-run` prints the commands and the expected time.

With `--window 5h` an arm targets +6% of the 5-hour limit (about +1% of the weekly limit) instead; `weights` then fits the 5-hour window only.

| Line | Value |
|---|---|
| `<window> · … $x/pp at weight 1` | API $ per 1% of the window at API prices |
| `cached input 2.95 (95% lo–hi)` | meter weight ÷ API price |
| `holdout plus-A1 predicted ÷ measured` | the run's meter use predicted from the weights ÷ measured; 1 inside the interval passes |
| `at API prices` | the same ratio with every weight 1 |
| `5h ÷ weekly` | weight on the 5-hour window ÷ weight on the weekly window; `same weights` when every interval contains 1 |

| Message or flag | Do |
|---|---|
| `cached N% of input: below 80%` (cache arm) | press `Ctrl-C`, rerun with `--cache-mode fresh` and a new `--tag` |
| `cache_low` | same |
| `run <tag> not found` | pass `--runs-dir <folder holding <tag>/manifest.json>` |
| `run_short`, `window_unusable` | rerun that arm with `--target-pp 4` and a new `--tag` |
| `arm_impure`, `holdout_miss`, `windows_differ`, `weight_unidentified` | send the result as is |
| `run_contaminated` | rerun that arm with a new `--tag` |

To read rollouts straight from the sessions folder:

    node kits/codex/scripts/codex-quota.mjs analyse --dir ~/.codex/sessions --root ~/.cache/codex-quota-runs/plus-A1 --plan plus

## When it fails

| Message or flag | Do |
|---|---|
| `check`: `codex not found` | install the Codex CLI or pass `--codex <path>` |
| `check`: `no ~/.codex/sessions` | run `codex` once and log in |
| `check`: `close the processes listed above` | close them and run `check` again |
| `smoke`: `close these first (or pass --force)` | close the other Codex sessions and run `smoke` again |
| `smoke`: `partly` or `fails` | send the report as is |
| `plan_type pro is one of …: pass --plan` | add `--plan pro-10x`, `pro-20x` or `pro-500` |
| `--plan … does not match plan_type …` | log in with the account for that plan, or fix `--plan` |
| `plan_type … is not a plan this kit measures` | log in with a Plus or Pro account |
| `ChatGPT Business: no monthly fee in scripts/billing-periods.mjs` | add a `ChatGPT Business` record to `scripts/billing-periods.mjs` |
| `weekly at N%: +X pp would pass 85%` | run after the weekly reset |
| `run <tag> exists` | pick another `--tag` |
| `no price for <model>` | run the `prices` command it prints |
| `meter_jump`, `meter_moved_idle` | close everything else using the account; rerun with a new `--tag` |
| `other_codex_session` | close that session; rerun with a new `--tag` |
| `window_reset` on weekly | rerun inside one week |
| `window_unusable` on weekly | rerun with a larger `--target-pp` or `--max-hours` |
| `window_missing` | send the result as is |
| `plan_mismatch`, `plan_unknown`, `plan_ambiguous` | analyse again with the right `--plan` |
| `credits` | rerun after the weekly reset |
| `model_mismatch`, `effort_mismatch`, `effort_unrecorded` | send the result as is |

## Options

| Option | Values | Default |
|---|---|---|
| `--arm` | `A`, `B`, `cache`, `input`, `output`, `reasoning` | none |
| `--window` | `weekly`, `5h` | `weekly` |
| `--cache-mode` | `resume`, `fresh` | `resume` |
| `--plan` | `plus`, `pro-10x`, `pro-20x`, `pro-500` | from `plan_type`; required on Pro |
| `--model` | `gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6.2-astra`, `gpt-6-astra` | `gpt-6.2-sol` |
| `--tag` | letters, digits, `.` `_` `-` | `<date>-<arm>` |
| `--target-pp` | % of the `--window` limit | per plan: see Values; at most A 12, B 8; token-weight arms 3 (weekly) or 6 (5h) |
| `--max-hours` | hours; applies once the window has moved 3 points | A 3, B 2, token-weight arms 2 |
| `--parallel` | tasks at a time, 1–6 | per plan: see Values and Token weights |
| `--max-weekly` | weekly % to stop at | 85 |
| `--effort` | `low`, `medium`, `high`, `xhigh`, `max` | `medium`; `cache`, `input`, `output`: `low`; `reasoning`: `high` |
| `--idle-min` | minutes | 5 |
| `--settle-min` | minutes | 2 |
| `--task-timeout-min` | minutes | 25 |
| `--codex` | path | `codex` |
| `--force` | start with other Codex processes open, or reuse a tag | off |
| `--dry-run` | print commands only | off |

`analyse` also takes `--dir <folder of rollout-*.jsonl, searched recursively>` or `--from <ISO> --to <ISO>`, with `--root <dir>`, `--plan`, `--model`, `--effort`, `--out <file>`.

`weights` takes `--runs <tags or folders>`, `--holdout <tags>` (default: every run that is not a token-weight arm), `--runs-dir <folders>`, `--sessions-dir <folder>` (default `~/.codex/sessions`), `--plan`, `--model`, `--boot` (400), `--seed` (1), `--out <file>`.

Refresh `kits/codex/prices.json` from the site data:

    node kits/codex/scripts/codex-quota.mjs prices

## Send your result

Open a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue and attach both result files and the compare file, e.g. `kits/codex/results/plus-A1.json`, `plus-B1.json` and `compare-plus-A1-vs-plus-B1.json`.

After a token-weight fit, also attach `kits/codex/results/weights-<plan>-<model>.json`.
