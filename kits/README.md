# Subsidy measuring kits

Download the kits (no git needed) and run every command from the folder:

    curl -fsSL https://github.com/melo-foundation/ai-plan-value/archive/refs/heads/main.tar.gz | tar -xz
    cd ai-plan-value-main

Windows: `curl.exe -fsSLo kits.tar.gz https://github.com/melo-foundation/ai-plan-value/archive/refs/heads/main.tar.gz`, then `tar -xzf kits.tar.gz` and `cd ai-plan-value-main`. Browser: [main.zip](https://github.com/melo-foundation/ai-plan-value/archive/refs/heads/main.zip).

Run the smoke check first; it uses one short prompt and gives a report to send:

    node kits/codex/scripts/codex-quota.mjs smoke --plan plus
    node kits/harness/scripts/harness-quota.mjs smoke --harness grok --plan "SuperGrok"
    node kits/api-plan/scripts/api-plan.mjs smoke --provider glm --model glm-5.3
    node kits/claude-code/scripts/quota-probe.mjs probe --ping

Open the link it prints and press Create. If it says the link is too long, open a [Kit check](https://github.com/melo-foundation/ai-plan-value/issues/new?template=kit-check.yml) issue and attach `kits/<kit>/results/smoke-<harness>-<date>.json`.

The last line is the Claude Code check: it prints the meters it read; send them in a Kit check issue.

[Most needed](NEEDED.md): plans ranked by need for a measurement, with the model to measure first.

[Methods](METHODS.md): where each plan's usage meter is and how a kit reads it.

| Plans | Tool | Usage reading | One run uses | Status |
|---|---|---|---|---|
| Claude Pro, Max, Ultra, Team | [Claude Code](claude-code/README.md) | automatic | 12% of the weekly limit | Tested: Ultra (2026-11-28). Untested: Pro, Max, Team |
| ChatGPT Plus, Pro 10x, Pro 20x, Pro 500 | [Codex CLI](codex/README.md) | automatic | Plus 20% of the weekly limit; Pro 6% | Tested: Plus (2026-11-27). Untested: Pro 10x, Pro 20x, Pro 500 |
| Google AI Pro, Ultra 5x, Ultra 20x | [Gemini CLI](harness/README.md) | typed in¹ | 25% of one day's limit | Untested |
| SuperGrok, X Plus, X Ultra | [Grok Build](harness/README.md) | typed in¹ | 10% of the weekly limit | Untested |
| Droid Pro, Max | [Droid](harness/README.md) | typed in | 10% of the weekly limit | Untested |
| Mistral Vibe Pro | [Mistral Vibe](harness/README.md) | typed in¹ | 5% of the monthly limit | Untested |
| Kimi, 百炼 / Qwen Token Plan | [Kimi Code, Qwen Code](harness/README.md) | typed in¹ | 2% of the monthly limit | Untested |
| Cursor Pro, Pro+, Ultra | [Cursor CLI](harness/README.md) | typed in | 10% of the monthly included usage | Untested |
| Devin Pro, Max | [Devin](harness/README.md) | typed in | 10% of one day's (Pro) or week's (Max) limit | Untested |
| Muse Code (not on the site yet) | [Muse Code](harness/README.md) | typed in¹ | 10% of the weekly limit | Untested |
| Kimi, GLM Coding, MiniMax, 百炼 / Qwen Token Plan, DeepRelay, Ollama Cloud, Step Plan, MiMo Token Plan | [API key, no harness](api-plan/README.md) | automatic; typed in for Kimi and Step | 1% of the monthly limit; GLM 5% and MiniMax 3% of the weekly limit | Untested |

¹ `--auto-meter` reads it automatically through an unofficial route.

Usage reading: automatic means the kit reads the meter itself; typed in means you read the plan's usage page when the kit asks and type the number. One run uses: estimates; harness kit runs are untested.

Published results: [data/quota-measurements/](../data/quota-measurements/).

Send results by opening a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue with the result file attached.

## Next kits

2. Grok kit for SuperGrok and X plans.
3. Gemini CLI kit for Google AI Pro and Ultra.
4. Factory Droid kit.
5. Generic semi-manual kit for Muse Code, Mistral Vibe, Cursor and Devin.

Details: [METHODS.md § Build order](METHODS.md#build-order).
