# Subsidy measuring kits

[Most needed](NEEDED.md): plans ranked by need for a measurement, with the model to measure first.

[Methods](METHODS.md): where each plan's usage meter is and how a kit reads it.

| Plan family | Harness | Instructions | One run uses |
|---|---|---|---|
| Claude (Pro, Max, Ultra, Team) | Claude Code | [docs/QUOTA-WEIGHTS.md](../docs/QUOTA-WEIGHTS.md) | about 12% of the weekly limit (weekly run); about 30% of one 5-hour window (5h run) |
| ChatGPT Plus | Codex CLI | [kits/codex/README.md](codex/README.md) | 12% of the weekly limit (run A) + 8% (run B) |

Published results: [data/quota-measurements/](../data/quota-measurements/).

Send results by opening a [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue with the result file attached.

## Next kits

1. Codex kit for ChatGPT Pro 10x, 20x, 500.
2. Generic API kit for Kimi, MiniMax, GLM Coding, 百炼 / Qwen, DeepRelay, Ollama, Step and MiMo.
3. Grok kit for SuperGrok and X plans.
4. Gemini CLI kit for Google AI Pro and Ultra.
5. Factory Droid kit.
6. Generic semi-manual kit for Muse Code, Mistral Vibe, Cursor and Devin.

Details: [METHODS.md § Build order](METHODS.md#build-order).
