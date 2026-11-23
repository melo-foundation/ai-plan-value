# AI Plan Value

Live site: **https://melo-foundation.github.io/ai-plan-value/**

Compares real effective AI subscription costs by combining measured subscription subsidies with Artificial Analysis benchmarks and per-task API pricing across reasoning effort levels.

## What It Does

- **Best Real Cost chart (`Per task` or `Per 1M tokens`):** Ranks the cheapest qualifying plan for each model across reasoning effort levels (`Non-reasoning`, `Low`, `Medium`, `High`, `XHigh`, `Max`), with a **Cheapest applicable reasoning level only** toggle that picks the lowest-cost qualifying effort per model (breaking ties by higher score).
- **Inline plan matrix (`▸`):** Expand any subscription plan to inspect every model and reasoning effort level on that plan side by side.
- **Filter bar & Settings:**
  - Filter by **Overall** (Intelligence Index), **Domains** (Engineering, Finance & Accounting, Strategy & Ops, Legal, Healthcare & Medical, Economics), **Tests** (HLE, HLE Diamond, FrontierCode 2.0, Terminal-Bench 4.0, TB Science, CritPt Hard, AutomationBench, Omniscience, GDP PDF, AA-LCR, SciCode, GDPval), and **Specs** (Context Window, Output Speed).
  - Stack additional selectable minimum thresholds from **Settings**.
  - Switch cost metric (`Per task` / `Per 1M tokens`) and toggle filters for legacy plans, off-peak quotas, estimated subsidies (`*`), domestic CN (¥) portal plans, pay-as-you-go API baselines, and open-weights models.
- **Full Comparison Table:** Searchable, sortable table of all matching `(model, reasoning level, plan)` rows with dynamic columns for any active extra minimum thresholds.

## Data Sources

Data refreshes automatically every 6 hours via GitHub Actions (`.github/workflows/deploy.yml`) and deploys statically to GitHub Pages:

1. **[Artificial Analysis](https://artificialanalysis.ai/models#price-cost):** Live benchmark scores, domain capability indices, context window, output speed, and average API cost per benchmark task.
2. **[Fei2411/real-api-pricing](https://github.com/Fei2411/real-api-pricing):** Primary upstream subscription quota measurements (`derived/points.csv`) and multi-effort benchmark configurations (`derived/benchmark-configurations.csv`).
3. **[GitHub Copilot Plans](https://github.com/features/copilot/plans):** Live-parsed first-party AI Credit tiers and per-plan available model matrix.
4. **[Ollama Cloud Pricing](https://ollama.com/pricing):** Live-parsed first-party Ollama Team credit pool.
5. **[adamholter/priors](https://github.com/adamholter/priors):** Secondary backfill only (`data/snapshots/latest.json.gz`) for per-effort sub-tests and preliminary/carryover estimates (marked with `*`).

Automated monitoring (`scripts/check-alerts.mjs`) opens deduplicated GitHub Issues on upstream fetch/parse failures (`[Data Alert]`, auto-closed on recovery) and when new frontier models (`Intelligence >= 45`) appear (`[New Model]`).

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
