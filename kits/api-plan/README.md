# API plan kit

Measures the API dollars behind each unit of a coding plan's quota meter when you use the plan through its API key, and the plan's monthly API value and subsidy multiple.

Run the smoke check first; it uses one short prompt and gives a report to send:

    export ZAI_API_KEY=<your key>
    node kits/api-plan/scripts/api-plan.mjs smoke --provider glm --model glm-5.3

Use your provider's `--provider`, key variable and `--model` from the table below. On a manual meter, type the dashboard value at the `used:` prompt. Open the link it prints and press Create. The report is `kits/api-plan/results/smoke-<provider>-<date>.json`.

## Requirements

- A paid plan from the table below and its API key.
- Node.js 20 or newer.
- Automatic Bailian runs: the `bl` CLI, logged in with `bl auth login` on the account that holds the plan.
- Automatic DeepRelay runs: the `deeprelay` CLI, logged in on the account that holds the plan.
- The primary window below 85% used at the start.
- No other tool or device using the same plan until the run ends.

## Providers

| `--provider` | Plans | Key variable | Meter | Meter source | Dashboard | One run uses | Takes | Status |
|---|---|---|---|---|---|---|---|---|
| `kimi` | Kimi Moderato, Allegretto, Allegro, Plus, Pro, Max, Ultra | `KIMI_API_KEY` | manual | dashboard | https://www.kimi.com/membership/subscription?tab=quota | +1% of the monthly total | 20 min – 4.5 h | Untested |
| `glm` | GLM Coding Lite, Pro, Max | `ZAI_API_KEY` | automatic | `GET api.z.ai/api/monitor/usage/quota/limit` (undocumented) | https://z.ai/manage-apikey/coding-plan/personal/my-plan | +5% of the weekly limit | 40 min – 11.5 h | Untested |
| `minimax` | MiniMax M Plan Go, Explore, Build; Token Plan Plus, Max, Ultra | `MINIMAX_API_KEY` | automatic | `GET www.minimax.io/v1/token_plan/remains` (documented endpoint, undocumented fields) | https://platform.minimax.io/console/usage | +3% of the weekly limit | 1 – 17.5 h | Untested |
| `bailian` | 阿里云百炼 Token Plan Lite, Essential, Standard, Pro; Qwen Token Plan Standard (`--region intl`, meter unverified) | `BAILIAN_API_KEY` (`sk-sp-…`) | automatic | `bl usage token-plan --output json` (documented command, undocumented fields) | https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan | +1% of the monthly quota | 20 min – 2.5 h | Untested |
| `deeprelay` | DeepRelay Base, Plus | `DEEPRELAY_API_KEY` | automatic | `deeprelay billing subscription -o json` (documented) | https://deeprelay.ai/dashboard | +1% of the monthly input allowance | 30 min – 1.7 h | Untested |
| `ollama` | Ollama Pro, Max | `OLLAMA_API_KEY` | automatic | `GET ollama.com/api/balance` (documented) | https://ollama.com/settings | +1% of the monthly credits | Pro 4 h, Max 18 h | Untested |
| `step` | Step Plan Mini, Plus, Pro, Max | `STEPFUN_API_KEY` | manual | dashboard | https://platform.stepfun.com/step-plan | +1% of the monthly credits | 50 min – 14 h (Max 67 h) | Untested |
| `mimo` | MiMo Token Plan Lite, Standard, Pro, Max | `MIMO_API_KEY` (`tp-…`) | automatic | `GET token-plan-cn.xiaomimimo.com/v1/platform/token_plan` (documented) | https://platform.xiaomimimo.com/#/console/plan-manage | +1% of the monthly credits | 20 min – 4.5 h | Untested |

Times include 10 minutes of idle checks. Per-plan figures (API $, calls, time):

    node kits/api-plan/scripts/api-plan.mjs estimate

Every automatic provider also runs with `--manual`.

## Values

| Window | Month factor |
|---|---|
| monthly | × 1 |
| weekly, 7-day | × 4 |
| Kimi weekly (legacy plans) | × 5 |
| 5-hour, session | none |

| Value | Source |
|---|---|
| API price | `public/data/combined.json` `aaPricing` for the model, or `--price input,cached,output` |
| Plan fee | the site's USD fee; CNY plans at the site's USD/CNY rate, CNY fee recorded |
| Site multiple | `combined.json` `subsidyMultiple` for the plan and model |

If a 5-hour or session window reaches 95%, the run pauses until its reset and prints the time.

## 1. Set up

Download the kits (no git needed) and run every command from the folder:

    curl -fsSL https://github.com/melo-foundation/ai-plan-value/archive/refs/heads/main.tar.gz | tar -xz
    cd ai-plan-value-main

Windows: `curl.exe -fsSLo kits.tar.gz https://github.com/melo-foundation/ai-plan-value/archive/refs/heads/main.tar.gz`, then `tar -xzf kits.tar.gz` and `cd ai-plan-value-main`. Browser: [main.zip](https://github.com/melo-foundation/ai-plan-value/archive/refs/heads/main.zip).

Set the key variable for your provider:

    export ZAI_API_KEY=<your key>

List the plan names your provider takes:

    node kits/api-plan/scripts/api-plan.mjs plans --provider glm

Check the setup; it must end with `ok`:

    node kits/api-plan/scripts/api-plan.mjs check --provider glm --model glm-5.3 --plan "GLM Coding Lite ¥118 (mixed)"

Run the kit's tests:

    node --test kits/api-plan/test/*.test.mjs

Print the request without spending quota:

    node kits/api-plan/scripts/api-plan.mjs run --provider glm --model glm-5.3 --plan "GLM Coding Lite ¥118 (mixed)" --dry-run

## 2. Run

Close every other tool, IDE, agent and device that uses the same plan until the run ends.

Automatic meter:

    node kits/api-plan/scripts/api-plan.mjs run --provider glm --model glm-5.3 --plan "GLM Coding Lite ¥118 (mixed)" --tag glm-lite-1

Manual meter:

    node kits/api-plan/scripts/api-plan.mjs run --provider kimi --model kimi-k3 --plan "Kimi Allegretto" --tag kimi-allegretto-1

At each `meter>` prompt, open the dashboard and type the window's value with every digit it shows:

| Dashboard shows | Type |
|---|---|
| 12.34% used | `12.34%` |
| 62.5% left | `62.5% left` |
| 1,234,567 credits used | `1234567` |
| 765,433 credits left | `765433 left` (with `--capacity <window size>`) |

A manual run asks four times: before, after a 2-minute idle check, 5 minutes after the last call, and 2 minutes later.

Press `Ctrl-C` once to stop after the current call and analyse up to that point; press it again to quit at once.

Run file: `kits/api-plan/results/runs/<tag>/run.json`.

## 3. Watch

One line per call:

    14:02 s0004 shared 200 in 7360 (cached 6615) out 912  $0.0068  Σ$0.412  weekly 24.00% +3.00/5  5h 41.0%  ~12 min left

| You see | Do |
|---|---|
| status `200` and `Σ$` rising | nothing |
| `failed` three times in a row | the run stops; send the output with your result |
| the meter not moving after 30 calls | press `Ctrl-C` and send the output |

## 4. Result

Each run writes `kits/api-plan/results/<tag>.json` and prints a summary. To analyse a run again:

    node kits/api-plan/scripts/api-plan.mjs analyse --run glm-lite-1

| Line | Value |
|---|---|
| `<window> … $x per pp (95% lo–hi)` | API $ per 1% of the window (per credit, count or token on those meters) |
| `window $` | API $ in one full window |
| `month $` | window $ × the month factor |
| `monthly API value` | the smallest month $ over the windows |
| `subsidy` | monthly API value ÷ the plan fee in USD |
| `measured ÷ site` | your multiple ÷ the site's multiple for the plan and model |
| `verdict` | `clean`, `check` (warnings) or `contaminated` (errors) |

## When it fails

| Message or flag | Do |
|---|---|
| `set <VAR>` | export the provider's key variable |
| `smoke`: `partly` or `fails` | send the report as is |
| `rejected the key in $<VAR>` | use the plan's own key (Bailian `sk-sp-…`, MiMo `tp-…`, MiniMax Token Plan key) |
| `no API price for <model>` | pass `--site-model <id>` from the list it prints, or `--price input,cached,output` |
| `plan "…" is not a … plan`, `no plan "…"` | copy a name from the `plans` command |
| `meter: unexpected response` | rerun with `--manual` and send the message with your result |
| `bl not found`, `deeprelay not found` | install the CLI, pass `--bl <path>` / `--deeprelay <path>`, or rerun with `--manual` |
| `hasQuotaData is false` | run `bl auth login` with the account that holds the plan |
| `<window> at N%: +T pp would pass` | run after the window resets |
| `run <tag> exists` | pick another `--tag` |
| `no site multiple … pass --usd-target` | pass `--usd-target <API $ to spend>` |
| `meter_moved_idle`, `meter_jump` | close everything else using the plan; rerun with a new `--tag` |
| `window_reset` (error) | rerun inside one window |
| `window_unusable` | rerun with a larger `--target` |
| `model_mismatch` | pass `--expect-model <name the responses carry>` if it is an alias; otherwise send the result as is |
| `no_usage` | send the result as is |

## Options

| Option | Values | Default |
|---|---|---|
| `--provider` | `kimi`, `glm`, `minimax`, `bailian`, `deeprelay`, `ollama`, `step`, `mimo` | none |
| `--model` | the model name the provider's API takes | none |
| `--plan` | a name from `plans` | none |
| `--tag` | letters, digits, `.` `_` `-` | `<date>-<provider>` |
| `--manual` | type the meter from the dashboard | automatic where the table says so |
| `--window` | a window the meter reports | per provider |
| `--target` | % of that window | per provider (table above) |
| `--region` | `glm`, `minimax`: `cn`; `bailian`, `step`: `intl`; `mimo`: `sgp` | global (`bailian`, `step`, `mimo`: mainland China) |
| `--api` | `openai`, `anthropic`, `ollama` | `minimax`: `anthropic`; `ollama`: `ollama`; others `openai` |
| `--base-url` | API base URL | per provider and region |
| `--meter-url` | meter URL | per provider and region |
| `--bl`, `--deeprelay` | path to the meter CLI | `bl`, `deeprelay` |
| `--price` | `input,cached,output` USD per 1M tokens | from `combined.json` |
| `--site-model` | a `combined.json` `baseModelId` | `--model` lowercased, `.` → `-` |
| `--expect-model` | model name in the responses | `--model` |
| `--capacity` | window size in the meter's unit | from the meter |
| `--usd-target` | API $ to spend (manual runs) | target × the site's $ per % |
| `--max-pct` | % of any monthly or weekly window to stop at | 90 |
| `--max-usd` | API $ to stop at | 3 × the expected $ |
| `--max-calls` | calls | 3000 |
| `--max-tokens` | output tokens per call | 4000 |
| `--poll-every` | calls between meter reads | 1 |
| `--idle-min` | minutes | 3 (manual 2) |
| `--settle-min` | minutes | 2 (manual 5) |
| `--force` | reuse a tag | off |
| `--dry-run` | print the request only | off |

## Send your result

Open a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue, pick harness `API plan kit`, and attach `kits/api-plan/results/<tag>.json`.
