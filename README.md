# AI Plan Value

Live site: **https://melo-foundation.github.io/ai-plan-value/**

Compares real effective AI subscription costs by combining measured subscription subsidies with Artificial Analysis benchmarks and API pricing across reasoning effort levels.

## Data Sources

Data refreshes automatically every 6 hours via GitHub Actions (`.github/workflows/deploy.yml`) and deploys statically to GitHub Pages:

1. **[Artificial Analysis](https://artificialanalysis.ai/models#price-cost):** Live benchmark scores, domain capability indices, context window, output speed, and API pricing (`$/task` and 3:1 blended `$/1M tokens`). Optional `AA_API_KEY` repo secret enables API v2 backfill.
2. **[OpenRouter Models API](https://openrouter.ai/api/v1/models):** Public zero-auth catalog used to backfill context window lengths, open-weights status, AA domain scores, and Kilo Gateway model availability.
3. **[Fei2411/real-api-pricing](https://github.com/Fei2411/real-api-pricing):** Primary upstream subscription quota measurements (`derived/points.csv`) and multi-effort benchmark configurations (`derived/benchmark-configurations.csv`).
4. **[GitHub Copilot Plans](https://github.com/features/copilot/plans):** Live-parsed first-party AI Credit tiers and per-plan available model matrix.
5. **[Ollama Cloud Pricing](https://ollama.com/pricing):** Live-parsed first-party Ollama Team credit pool.
6. **[Kilo Pass Pricing](https://kilo.ai/pricing):** Live-parsed first-party Kilo Pass annual credit pools (net of the 5% credit purchase processing fee).
7. **[adamholter/priors](https://github.com/adamholter/priors):** Secondary backfill only (`data/snapshots/latest.json.gz`) for per-effort sub-tests and preliminary/carryover estimates (marked with `*`).
8. **[ARC Prize](https://arcprize.org/leaderboard):** Optional ARC-AGI-2 (`v2_Semi_Private`) fallback for opt-in extrapolated reasoning efforts (`‡`) on model families without multi-effort AA data.

See **[docs/EFFORT-ESTIMATES.md](./docs/EFFORT-ESTIMATES.md)** for leave-one-out cross-validation error and confidence scores by degree of separation (`†` interpolation vs `‡` extrapolation).

Automated monitoring (`scripts/check-alerts.mjs` + `scripts/test-site.mjs`) runs on every refresh and opens deduplicated GitHub Issues on test failures (`[Test Failure]`), upstream fetch/parse failures (`[Data Alert]`, auto-closed on recovery), unclassified plans (`[New Plan]`), and new frontier models (`[New Model]`).

## Local Preview

Requires Node.js >= 20 (zero external npm dependencies).

```bash
git clone https://github.com/melo-foundation/ai-plan-value.git
cd ai-plan-value
node server.mjs
```

Then open `http://127.0.0.1:3456`.

To refresh data manually from live upstream sources:

```bash
node scripts/refresh-data.mjs
```
