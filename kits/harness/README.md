# Harness quota kit (Gemini CLI, Grok Build)

Measures the API dollars behind each percentage point of a subscription's usage meter by running the vendor's coding CLI on the Codex kit's fixed workload. It also gives the plan's monthly API value and subsidy multiple.

## Requirements

- A plan from the table below.
- Node.js 20 or newer.
- The harness installed and logged in with that plan's account.
- A plain terminal, not one inside Claude Code, Codex or an IDE agent.
- Meter below 85% minus the target at the start.

## Harnesses

"Unverified" means not found in the vendor's docs or source.

| | Gemini CLI | Grok Build |
|---|---|---|
| Plans (`--plan`) | `Google AI Pro`, `Google AI Ultra 5x`, `Google AI Ultra 20x` | `SuperGrok Lite`, `SuperGrok`, `SuperGrok Plus`, `SuperGrok Heavy`, `X Plus`, `X Ultra`, and the `, legacy` variants |
| Install | `npm install -g @google/gemini-cli`, plus Docker or Podman on Linux | `curl -fsSL https://x.ai/cli/install.sh \| bash`, plus `bubblewrap` on Linux |
| Login | run `gemini`, choose Sign in with Google | `grok login` (`grok login --device-auth` over SSH); subscription billing for a CLI login is unverified |
| Command | `node kits/harness/scripts/harness-quota.mjs run --harness gemini --plan "Google AI Pro"` | `node kits/harness/scripts/harness-quota.mjs run --harness grok --plan "SuperGrok"` |
| Model (`--model`) | `gemini-3.8-flash` (default); Gemini 4 model ids unverified | `grok-4.7` (default, unverified); `grok-4.6` |
| Effort (`--effort`) | none | `none`, `minimal`, `low`, `medium` (default), `high`, `xhigh`, `max` |
| Meter | % of the model's daily requests; the subsidy uses daily × 30 | % of the weekly pool shared with grok.com and Cursor; the subsidy uses weekly × 4 |
| Meter mode | manual (default); `--auto-meter` reads the undocumented Code Assist `retrieveUserQuota` call through the installed CLI's core package (written from source, untested against a real install) | manual (default); `--auto-meter` asks `grok agent stdio` for `x.ai/billing` (written from source; the `_x.ai/billing` method name is unverified) |
| Where to read it (manual) | `/stats model` in an interactive `gemini` session: the model's usage (screen format unverified) | [grok.com](https://grok.com) > Settings > Usage: the weekly % |
| Tokens | per call from the telemetry file; per task from `--output-format json` when the file is missing | per task from `--output-format json` |
| Sandbox | `--sandbox` with `GEMINI_SANDBOX` = `docker`, `podman` or `sandbox-exec` (macOS), `--approval-mode yolo` | `--sandbox strict`, `--permission-mode bypassPermissions` |
| Typical run (unverified) | 1–3 h, +25 pp of one day | 1–3 h, +10 pp of one week |

## 1. Set up

Clone the repo and run every command from its root:

    git clone https://github.com/melo-foundation/ai-plan-value.git
    cd ai-plan-value

Check the setup; it must end with `ok`:

    node kits/harness/scripts/harness-quota.mjs check --harness gemini --plan "Google AI Pro"

Add `--auto-meter` to `check` to test the automatic meter; it makes no model call.

Run the kit's tests:

    node --test kits/harness/test/*.test.mjs

Print the commands without spending quota:

    node kits/harness/scripts/harness-quota.mjs run --harness gemini --plan "Google AI Pro" --dry-run

List the plans with fee and site multiple:

    node kits/harness/scripts/harness-quota.mjs plans --harness grok

## 2. Run

Close every other session of the harness and every other tool on the same account (for Grok: grok.com chats, the Grok app, Cursor) until the run ends.

Run the command from the table, with a tag:

    node kits/harness/scripts/harness-quota.mjs run --harness grok --plan "SuperGrok" --tag supergrok-1

Gemini CLI: run inside one day.

### Manual readings

The kit asks for the meter before the run, after 5 minutes idle, after every 5 tasks, at the end and after 5 more idle minutes.

| Type | Means |
|---|---|
| `37`, `37.5%`, `37% used` | % used |
| `63% left` | % left |
| `skip` | no reading this time |
| `stop` | end the run here |

Gemini CLI: open `gemini` in a second terminal when asked, type `/stats model`, then exit it.

### Automatic readings

With `--auto-meter` the kit reads the meter after every task. If a reading fails, it prints `auto meter failed: <reason>; switching to manual` and asks for manual readings from then on.

Press `Ctrl-C` once to stop after the current task, give the final reading and analyse; press it again to quit at once.

Task folders: `~/.cache/harness-quota-runs/<tag>/`. Logs and manifest: `kits/harness/results/runs/<tag>/`.

## 3. Result

Each run writes `kits/harness/results/<tag>.json` and prints a summary. To analyse a run again:

    node kits/harness/scripts/harness-quota.mjs analyse --run supergrok-1

| Line | Value |
|---|---|
| `daily` / `weekly … $x/pp (95% lo–hi)` | API $ per 1% of the meter |
| `monthly API value` | 100 × $/pp × 30 (daily) or × 4 (weekly) |
| `subsidy` | monthly API value ÷ the plan's monthly fee |
| `measured ÷ site` | your multiple ÷ the site's multiple for the plan and model |
| `verdict` | `clean`, `check` (warnings) or `contaminated` (errors) |

## When it fails

| Message or flag | Do |
|---|---|
| `check`: `<bin> not found` | install the harness or pass `--bin <path>` |
| `check`: `close the processes listed above` | close them and run `check` again |
| `check`: `no sandbox for Gemini CLI` | install Docker or Podman, or pass `--gemini-sandbox docker\|podman\|sandbox-exec` |
| `check`: `bubblewrap (bwrap) not found` | install `bubblewrap` |
| `meter at N%: +T pp would pass 85%` | run after the reset, or pass a smaller `--target-pp` |
| `auto meter failed: …` | type the readings by hand; send the message with your result |
| `run <tag> exists` | pick another `--tag` |
| `no aaPricing for <model>` | pick a `--model` the site prices |
| `first task made no calls`, `3 failed tasks in a row` | send the `stderr` lines with your result |
| `meter_moved_idle`, `meter_jump` | close everything else on the account; rerun with a new `--tag` |
| `window_reset` | rerun inside one window |
| `window_unusable`, `too_few_steps` | rerun with a larger `--target-pp` or a smaller `--every` |
| `model_mismatch` | send the result as is |
| `plan_mismatch` | rerun with the `--plan` the meter reports |
| `on_demand` | turn off on-demand credits; rerun after the reset |

## Options

| Option | Values | Default |
|---|---|---|
| `--harness` | `gemini`, `grok` | none |
| `--plan` | a plan from the table | none |
| `--model` | harness model id | per harness |
| `--effort` | Grok Build: see the table | `medium` |
| `--auto-meter` | on / off | off |
| `--every` | tasks between manual readings | 5 |
| `--target-pp` | meter points to use | Gemini 25, Grok 10 |
| `--max-pct` | meter % to stop at | 85 |
| `--window` | Gemini `daily`; Grok `weekly`, `monthly` | Gemini `daily`, Grok `weekly` |
| `--idle-min` | minutes | 5 |
| `--task-timeout-min` | minutes | 25 |
| `--max-tasks` | tasks | 200 |
| `--meter-timeout-s` | seconds per automatic reading | 90 |
| `--arm` | `A` (coding tasks), `B` (low-cache prompts) | `A` |
| `--tag` | letters, digits, `.` `_` `-` | `<date>-<harness>-<arm>` |
| `--bin` | path | `gemini`, `grok` |
| `--gemini-sandbox` | `docker`, `podman`, `sandbox-exec` | Docker, then Podman; `sandbox-exec` on macOS |
| `--site` | path to `combined.json` | `public/data/combined.json` |
| `--force` | start with other harness processes or preflight warnings, or reuse a tag | off |
| `--dry-run` | print commands only | off |

## Send your result

Open a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue and attach `kits/harness/results/<tag>.json`.
