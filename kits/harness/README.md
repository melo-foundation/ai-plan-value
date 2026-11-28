# Harness quota kit (Gemini CLI, Grok Build, Factory Droid, Kimi Code, Qwen Code, Mistral Vibe)

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

| | Factory Droid | Kimi Code | Qwen Code | Mistral Vibe |
|---|---|---|---|---|
| `--harness` | `factory` | `kimi` | `qwen` | `mistral` |
| Plans (`--plan`) | `Droid Pro`, `Droid Max` | `Kimi Plus`, `Kimi Pro`, `Kimi Max`, `Kimi Ultra`, `Kimi Moderato`, `Kimi Allegretto`, `Kimi Allegro`, and the `, legacy` variants | `阿里云百炼 Token Plan Lite (¥39)`, `… Essential (¥79)`, `… Standard (¥139)`, `… Pro (¥312)`, `Qwen Token Plan Standard` | `Mistral Vibe Pro` |
| Install | `curl -fsSL https://app.factory.ai/cli \| sh`, plus `bubblewrap` on Linux | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` or `npm install -g @moonshot-ai/kimi-code` | `npm install -g @qwen-code/qwen-code@latest` (Node 22+), plus Docker or Podman on Linux | `curl -LsSf https://mistral.ai/vibe/install.sh \| bash` |
| Login | run `droid`, sign in in the browser (or `/login`) | `kimi login` | run `qwen`, `/auth` > Alibaba ModelStudio > Token Plan, paste the Token Plan key; `Qwen Token Plan Standard` = ModelStudio Singapore unverified | run `vibe`, sign in in the browser (or `vibe --setup`) |
| Command | `node kits/harness/scripts/harness-quota.mjs run --harness factory --plan "Droid Pro"` | `node kits/harness/scripts/harness-quota.mjs run --harness kimi --plan "Kimi Pro"` | `node kits/harness/scripts/harness-quota.mjs run --harness qwen --plan "阿里云百炼 Token Plan Standard (¥139)"` | `node kits/harness/scripts/harness-quota.mjs run --harness mistral --plan "Mistral Vibe Pro"` |
| Headless | `droid exec` | `kimi -p` | `qwen -p` | `vibe -p` |
| Model (`--model`) | `claude-opus-5-5` (default) | `kimi-k3` (default; sent as `kimi-code/kimi-k3`, unverified) | `qwen4-max` (default), `qwen3.8-max`, `glm-5.3`, `deepseek-v4.1-flash-1017` | `mistral-large-4-0` (default), `mistral-medium-3.5` |
| Effort (`--effort`) | `none`, `minimal`, `low`, `medium` (default), `high`, `xhigh`, `max`; per model | none | none | `default` (no `--thinking`), `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| Meter | % of the 7-day Standard Credits window (credits × model multiplier); the subsidy uses 7-day × 4; `--window 30d` × 1, `5h` none | % of the monthly total; legacy plans `--window weekly`, × 5 | % of the monthly Token Plan quota; `--window weekly` × 4, `5h` none | % of the monthly Vibe budget |
| Meter mode | manual only | manual (default); `--auto-meter` calls the undocumented `GET api.kimi.com/coding/v1/usages` with `$KIMI_CODE_API_KEY` | manual (default); `--auto-meter` runs `bl usage token-plan --output json` (field names undocumented) | manual (default); `--auto-meter` calls the undocumented `GET api.mistral.ai/v1/billing/budget` with `$MISTRAL_API_KEY` |
| Where to read it (manual) | `/limits` in an interactive `droid` session: the 7-day % (screen format unverified) | `/usage` in an interactive `kimi` session: Monthly limit | [Bailian console](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan) > Token Plan: the monthly % | [console](https://console.mistral.ai) > Code > CLI > View organization usage, or the usage gauge in the `vibe` footer (menu path unverified) |
| Tokens | per task from `-o json` (`input_tokens` read as uncached, unverified); the requested model is recorded | per call from `~/.kimi-code/sessions/*/<session>/agents/*/wire.jsonl` | per call from the telemetry file; per task from `--output-format json` when the file is missing (always missing with Docker or Podman, unverified) | per task from `--output-dir` `export.json`; the requested model is recorded |
| Sandbox | `--settings` file with `sandbox.enabled: true`, `mode: "whole-process"`; `--auto medium` | none: writes are not confined to the task folder; `-p` runs with `auto` permission | `--sandbox` with `QWEN_SANDBOX` = `docker`, `podman` or `sandbox-exec` (macOS), `--approval-mode yolo` | none on the host; `--approval-policy accept-edits` approves file edits inside the task folder and denies everything that asks (shell commands, paths outside) |
| Typical run (unverified) | 1–3 h, +10 pp of one week | 1–3 h, +2 pp of one month | 1–3 h, +2 pp of one month | 1–3 h, +5 pp of one month |

## 1. Set up

Clone the repo and run every command from its root:

    git clone https://github.com/melo-foundation/ai-plan-value.git
    cd ai-plan-value

Check the setup; it must end with `ok`:

    node kits/harness/scripts/harness-quota.mjs check --harness gemini --plan "Google AI Pro"

Add `--auto-meter` to `check` to test the automatic meter; it makes no model call.

Qwen Code automatic meter: `npm install -g bailian-cli`, then `bl auth login --console` with the account that holds the plan.

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

Gemini CLI: open `gemini` in a second terminal when asked, type `/stats model`, then exit it. Factory Droid and Kimi Code: the same with `droid` and `/limits`, `kimi` and `/usage`.

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
| `check`: `no sandbox for Qwen Code` | install Docker or Podman, or pass `--qwen-sandbox docker\|podman\|sandbox-exec` |
| `has no automatic meter` (Factory Droid) | run without `--auto-meter` |
| `auto meter failed: Kimi /usages HTTP 401` or `export KIMI_CODE_API_KEY` | export a valid `KIMI_CODE_API_KEY`, or run without `--auto-meter` |
| `auto meter failed: bl … exited`, `hasQuotaData is false` | run `bl auth login --console` with the account that holds the plan, or pass `--bl <path>` |
| `auto meter failed: MISTRAL_API_KEY is not set`, `HTTP 403` | export `MISTRAL_API_KEY` with a key that has `see_org_inference_usage`, or type the readings |
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
| `--harness` | `gemini`, `grok`, `factory`, `kimi`, `qwen`, `mistral` | none |
| `--plan` | a plan from the table | none |
| `--model` | harness model id | per harness |
| `--effort` | Grok Build, Factory Droid, Mistral Vibe: see the tables | `medium`; Mistral `default` |
| `--auto-meter` | on / off | off |
| `--every` | tasks between manual readings | 5 |
| `--target-pp` | meter points to use | Gemini 25, Grok 10, Factory 10, Kimi 2, Qwen 2, Mistral 5 |
| `--max-pct` | meter % to stop at | 85 |
| `--window` | Gemini `daily`; Grok `weekly`, `monthly`; Factory `7d`, `30d`, `5h`; Kimi and Qwen `monthly`, `weekly`, `5h`; Mistral `monthly` | Gemini `daily`, Grok `weekly`, Factory `7d`, others `monthly` |
| `--idle-min` | minutes | 5 |
| `--task-timeout-min` | minutes | 25 |
| `--max-tasks` | tasks | 200 |
| `--meter-timeout-s` | seconds per automatic reading | 90 |
| `--arm` | `A` (coding tasks), `B` (low-cache prompts) | `A` |
| `--tag` | letters, digits, `.` `_` `-` | `<date>-<harness>-<arm>` |
| `--bin` | path | `gemini`, `grok`, `droid`, `kimi`, `qwen`, `vibe` |
| `--gemini-sandbox` | `docker`, `podman`, `sandbox-exec` | Docker, then Podman; `sandbox-exec` on macOS |
| `--qwen-sandbox` | `docker`, `podman`, `sandbox-exec` | Docker, then Podman; `sandbox-exec` on macOS |
| `--bl` | path to `bl` (Qwen Code automatic meter) | `bl` |
| `--site` | path to `combined.json` | `public/data/combined.json` |
| `--force` | start with other harness processes or preflight warnings, or reuse a tag | off |
| `--dry-run` | print commands only | off |

## Send your result

Open a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue and attach `kits/harness/results/<tag>.json`.
