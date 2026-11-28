# Subsidy measuring kits

[Most needed](NEEDED.md): plans ranked by need for a measurement, with the model to measure first.

[Methods](METHODS.md): where each plan's usage meter is and how a kit reads it.

| Plan family | Harness | Instructions | One run uses |
|---|---|---|---|
| Claude (Pro, Max, Ultra, Team) | Claude Code | [docs/QUOTA-WEIGHTS.md](../docs/QUOTA-WEIGHTS.md) | about 12% of the weekly limit (weekly run); about 30% of one 5-hour window (5h run) |
| ChatGPT Plus | Codex CLI | [kits/codex/README.md](codex/README.md) | 12% of the weekly limit (run A) + 8% (run B) |
| Kimi, GLM Coding, MiniMax, 百炼 / Qwen Token Plan, DeepRelay, Ollama Cloud, Step Plan, MiMo Token Plan | API key, no harness | [kits/api-plan/README.md](api-plan/README.md) | 1% of the monthly pool; GLM 5% of the weekly limit; MiniMax 3% of the weekly limit |

Published results: [data/quota-measurements/](../data/quota-measurements/).

Send results by opening a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue with the result file attached.

## Next kits

1. Codex kit for ChatGPT Pro 10x, 20x, 500.
2. Grok kit for SuperGrok and X plans.
3. Gemini CLI kit for Google AI Pro and Ultra.
4. Factory Droid kit.
5. Generic semi-manual kit for Muse Code, Mistral Vibe, Cursor and Devin.

Details: [METHODS.md § Build order](METHODS.md#build-order).
