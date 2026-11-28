# Subsidy measuring kits

Run the smoke check first; it uses one short prompt and gives a report to send:

    node kits/codex/scripts/codex-quota.mjs smoke --plan plus
    node kits/harness/scripts/harness-quota.mjs smoke --harness grok --plan "SuperGrok"
    node kits/api-plan/scripts/api-plan.mjs smoke --provider glm --model glm-5.3

Open the link it prints and press Create. If it says the link is too long, open a [Kit check](https://github.com/melo-foundation/ai-plan-value/issues/new?template=kit-check.yml) issue and attach `kits/<kit>/results/smoke-<harness>-<date>.json`.

Claude Code has no smoke check.

[Most needed](NEEDED.md): plans ranked by need for a measurement, with the model to measure first.

[Methods](METHODS.md): where each plan's usage meter is and how a kit reads it.

| Plan family | Harness | Instructions | One run uses | Status |
|---|---|---|---|---|
| Claude (Pro, Max, Ultra, Team) | Claude Code | [docs/QUOTA-WEIGHTS.md](../docs/QUOTA-WEIGHTS.md) | about 12% of the weekly limit (weekly run); about 30% of one 5-hour window (5h run) | Tested (2026-11-28) |
| ChatGPT Plus, Pro 10x / 20x / 500 | Codex CLI | [kits/codex/README.md](codex/README.md) | Plus: 12% of the weekly limit (run A) + 8% (run B); Pro: 3–4% (A) + 3% (B) | Plus: Tested (2026-11-27); Pro 10x, Pro 20x, Pro 500: Untested: run `smoke` first |
| Google AI (Pro, Ultra 5x / 20x) | Gemini CLI | [kits/harness/README.md](harness/README.md) | meter typed by hand from the Gemini app; `--auto-meter` reads it automatically | Untested: run `smoke` first |
| SuperGrok (Lite, Plus, Heavy), X Plus / Ultra | Grok Build | [kits/harness/README.md](harness/README.md) | meter typed by hand from grok.com Settings > Usage; `--auto-meter` reads it automatically | Untested: run `smoke` first |
| Factory Droid (Pro, Max) | Droid | [kits/harness/README.md](harness/README.md) | meter typed by hand from `/limits` | Untested: run `smoke` first |
| Mistral Vibe Pro | Mistral Vibe | [kits/harness/README.md](harness/README.md) | meter typed by hand; `--auto-meter` optional | Untested: run `smoke` first |
| Kimi, 百炼 / Qwen Token Plan | Kimi Code, Qwen Code | [kits/harness/README.md](harness/README.md) | meter typed by hand; `--auto-meter` optional | Untested: run `smoke` first |
| Cursor (Pro, Pro+, Ultra) | Cursor CLI | [kits/harness/README.md](harness/README.md) | included-usage $ typed by hand from the dashboard | Untested: run `smoke` first |
| Devin (Pro, Max) | Devin | [kits/harness/README.md](harness/README.md) | ACUs per task; quota typed by hand | Untested: run `smoke` first |
| Muse Code (not on the site yet) | Muse Code | [kits/harness/README.md](harness/README.md) | meter typed by hand from `muse usage`; `--auto-meter` optional | Untested: run `smoke` first |
| Kimi, GLM Coding, MiniMax, 百炼 / Qwen Token Plan, DeepRelay, Ollama Cloud, Step Plan, MiMo Token Plan | API key, no harness | [kits/api-plan/README.md](api-plan/README.md) | 1% of the monthly pool; GLM 5% of the weekly limit; MiniMax 3% of the weekly limit | Untested: run `smoke` first |

Published results: [data/quota-measurements/](../data/quota-measurements/).

Send results by opening a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue with the result file attached.

## Next kits

2. Grok kit for SuperGrok and X plans.
3. Gemini CLI kit for Google AI Pro and Ultra.
4. Factory Droid kit.
5. Generic semi-manual kit for Muse Code, Mistral Vibe, Cursor and Devin.

Details: [METHODS.md § Build order](METHODS.md#build-order).
