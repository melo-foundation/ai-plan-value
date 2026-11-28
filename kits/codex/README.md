# Codex quota kit (ChatGPT Plus)

Measures the API dollars behind each percentage point of the Codex weekly limit on ChatGPT Plus, and the plan's monthly API value and subsidy multiple.

## Requirements

- ChatGPT Plus.
- Node.js 20 or newer.
- Codex CLI (`codex`) on your `PATH`, logged in with that ChatGPT account.
- Weekly limit below 65% at the start.
- A plain terminal, not one inside Codex, Claude Code or an IDE agent.

## Values

| Run | Uses | Takes |
|---|---|---|
| A. Coding tasks, medium effort | +12% of the weekly limit | 1–3 h, plus 14 min of idle checks |
| B. Low-cache prompts, medium effort | +8% of the weekly limit | 1–1.5 h, plus 14 min of idle checks |
| A + B | +20% of the weekly limit | 2.5–5 h |

If the 5-hour limit reaches 95%, the run pauses until its reset and prints the time.

## 1. Set up

Clone the repo and run every command from its root:

    git clone https://github.com/melo-foundation/ai-plan-value.git
    cd ai-plan-value

Check the setup; it must end with `ok`:

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

Press `Ctrl-C` once to stop after the current task and analyse up to that point; press it again to quit at once.

Task folders: `~/.cache/codex-quota-runs/<tag>/`. Logs and manifest: `kits/codex/results/runs/<tag>/`.

## 3. Watch

One line per task:

    14:02 r1-lru           exit 0       calls  18  $  0.412  5h 6%  weekly 20%  +1/12 pp  ~95 min left

| You see | Do |
|---|---|
| `calls` above 0 and `$` rising | nothing |
| `exit` not 0 three times in a row | the run stops; send the `stderr` lines with your result |
| weekly not moving after 10 tasks | press `Ctrl-C` and send the output |

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
| `subsidy` | monthly API value ÷ $20 |
| `measured ÷ site` | your multiple ÷ the site's ChatGPT Plus multiple for the model |
| `verdict` | `clean`, `check` (warnings) or `contaminated` (errors) |
| compare `verdict` | `price-proportional`, `not price-proportional` or `inconclusive` |

## When it fails

| Message or flag | Do |
|---|---|
| `check`: `codex not found` | install the Codex CLI or pass `--codex <path>` |
| `check`: `no ~/.codex/sessions` | run `codex` once and log in |
| `check`: `close the processes listed above` | close them and run `check` again |
| `check`: `plan_type is …, not plus` | log in with a ChatGPT Plus account |
| `weekly at N%: +12 pp would pass 85%` | run after the weekly reset |
| `run <tag> exists` | pick another `--tag` |
| `no price for <model>` | run the `prices` command it prints |
| `meter_jump`, `meter_moved_idle` | close everything else using the account; rerun with a new `--tag` |
| `other_codex_session` | close that session; rerun with a new `--tag` |
| `window_reset` on weekly | rerun inside one week |
| `window_unusable` on weekly | rerun with a larger `--target-pp` |
| `credits` | rerun after the weekly reset |
| `model_mismatch`, `effort_mismatch`, `effort_unrecorded` | send the result as is |

## Options

| Option | Values | Default |
|---|---|---|
| `--arm` | `A`, `B` | none |
| `--model` | `gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6.2-astra` | `gpt-6.2-sol` |
| `--tag` | letters, digits, `.` `_` `-` | `<date>-<arm>` |
| `--target-pp` | % of the weekly limit | A 12, B 8 |
| `--max-weekly` | weekly % to stop at | 85 |
| `--effort` | `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `--idle-min` | minutes | 5 |
| `--settle-min` | minutes | 2 |
| `--task-timeout-min` | minutes | 25 |
| `--codex` | path | `codex` |
| `--force` | start with other Codex processes open, or reuse a tag | off |
| `--dry-run` | print commands only | off |

`analyse` also takes `--dir <folder of rollout-*.jsonl>` or `--from <ISO> --to <ISO>`, with `--root <dir>`, `--model`, `--effort`, `--out <file>`.

Refresh `kits/codex/prices.json` from the site data:

    node kits/codex/scripts/codex-quota.mjs prices

## Send your result

Open a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue and attach `kits/codex/results/plus-A1.json`, `plus-B1.json` and `compare-plus-A1-vs-plus-B1.json`.
