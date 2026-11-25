# Effort Estimate Accuracy & Confidence

Generated from live leave-one-out cross-validation (LOOCV) against real multi-effort Artificial Analysis measurements in `public/data/combined.json` (2026-11-25).

Every held-out test point is excluded from both the scaling curves and regression slopes before prediction (zero data leakage).

## Empirical Error by Degree of Separation

| Degree / Method | Marker | Held-out `n` | Intelligence median err | Intelligence P75 err | `$/task` median err | `$/task` P75 err | Confidence |
|---|---:|---:|---:|---:|---:|---:|---|
| 0 — Measured (Artificial Analysis) | — | — | ±0.0 pts | ±0.0 pts | ±0.0% | ±0.0% | **Ground truth** |
| 1 — Bracketed interpolation (same model) | ● | 45 | ±1.1 pts | ±1.8 pts | ±11.7% | ±18.5% | **High** |
| 2 — Same-family AA, 1 effort step | ● | 112 | ±1.4 pts | ±2.8 pts | ±15.2% | ±34.0% | **Medium-High** |
| 3 — Same-family AA, 2 effort steps | ◐ | 82 | ±2.5 pts | ±4.3 pts | ±28.2% | ±52.0% | **Medium** |
| 4 — Same-family AA, 3 effort steps | ○ | 52 | ±3.1 pts | ±6.5 pts | ±37.9% | ±69.7% | **Low** |
| 5 — Same-family AA, 4+ effort steps | ○ | 30 | ±4.6 pts | ±6.3 pts | ±60.2% | ±108.6% | **Very Low** |
| 6 — Exact-model ARC-AGI-2 transfer | ◐ | 228 | ±2.8 pts | ±5.6 pts | ±30.4% | ±56.1% | **Medium** |
| 7 — Same-family ARC-AGI-2 transfer | ◐ | 294 | ±3.0 pts | ±5.4 pts | ±29.5% | ±65.5% | **Medium** |

## Coding Agent Index Estimates

| Method | Marker | Held-out `n` | Agent score median err | `$/task` median err |
|---|---:|---:|---:|---:|
| Same model, other effort | ● | 17 | ±1.4 pts | ±11% |
| Same model, other agent | ◐ | 312 | ±2.7 pts | ±31% |
| Terminal-Bench 4.0 fit | ◐ (○ below measured range) | 39 | ±2.8 pts | ±18% |

## How Each Method Works

- **Bracketed interpolation (●):** Only fills missing efforts strictly between a lower and higher measured effort on the *same* model, using empirical cumulative Intelligence and log-cost step weights. Gated on OpenRouter's `reasoning.supported_efforts` (and `mandatory` flag).
- **Same-family AA extrapolation (● 1 step, ◐ 2 steps, ○ 3+ steps):** Uses median additive Intelligence point deltas (`+Δ`) and multiplicative `$/task` ratios measured on other multi-effort models in the *same* canonical family (`anthropic`, `openai`, `google`, `xai`, `deepseek`, `alibaba`, `zhipu`, `mistral`, `meta`). No cross-family global fallback.
- **ARC-AGI-2 (`v2_Semi_Private`) fallback (◐):** Only used for model families with no multi-effort AA data (e.g. `moonshot` / Kimi, `thinking machines` / Inkling). Transfers exact-model ARC-AGI-2 cost ratios and a live-fitted IRT logit-space slope (`Δlogit(ARC) → Δlogit(AA)`, following Truong et al., arXiv:2606.07616) first, then pools same-family ARC-AGI-2 step curves for sibling models (e.g. `Kimi K3.1 Pro` from `Kimi K3`).
- **Coding Agent Index, same model (● same agent, ◐ other agent):** Nearest measured effort of the same model in the plan's agent, else in another agent; score shifted 1:1 by the Intelligence Index gap, `$/task` scaled by the AA Intelligence `$/task` ratio.
- **Coding Agent Index, Terminal-Bench 4.0 (◐, ○ below the measured Terminal-Bench range):** Models with no agent run; score from a linear fit on Terminal-Bench 4.0, `$/task` = AA `$/task` × median agent/AA ratio. Plans on Cursor, Factory Droid and Command Code stay empty.
- **Stacking:** an agent estimate whose Intelligence Index or Terminal-Bench input is itself an effort estimate takes the lower of the two tiers.
- **Settings:** Show high-confidence estimates (●, on by default), medium (◐) and low (○) toggle separately; URL `est=` takes the shown tiers as letters (`h`, `hm`, `hml`, `0`).

## Reproducing These Numbers

```bash
node scripts/eval-effort-estimates.mjs --write-doc
```

## Relevant Literature

- Snell et al. (2024), *Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters* — https://arxiv.org/abs/2408.03314
- Muennighoff et al. (2025), *s1: Simple test-time scaling* — https://arxiv.org/abs/2501.19393
- Agarwal et al. (2025), *The Art of Scaling Test-Time Compute for Large Language Models* — https://arxiv.org/abs/2512.02008
- Zhou et al. (ACL 2026), *When More Thinking Hurts: Overthinking in LLM Test-Time Compute Scaling* — https://arxiv.org/abs/2604.10739
- Truong et al. (ICLR 2026), *Item Response Scaling Laws* — https://arxiv.org/abs/2606.07616
- Jiang et al. (2026), *Can We Trust Item Response Theory for AI Evaluation?* — https://arxiv.org/abs/2607.15190
