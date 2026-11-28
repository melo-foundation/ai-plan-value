# Quota weights

Generated table: `node scripts/fit-quota-weights.mjs` from `data/quota-weights/submissions/`. Weight = quota cost ÷ API list price; fresh input = 1. `—` = not identified.

<!-- fit-table:start -->
| Cell | Status | Cache read | 1h write | 5m write | Output | Sessions / accounts | LOSO median error |
|---|---|---|---|---|---|---|---|
| anthropic/claude-opus-5-5/5h/interactive | unmeasured | — | — | — | — | 1 / 1 | — |
| anthropic/claude-opus-5-5/5h/sdk | provisional | — | — | — | 1.00 (0.95–1.04) | 3 / 2 | — |

Unmeasured, no data: `anthropic/claude-fable-5-2/5h/interactive`, `anthropic/claude-fable-5-2/5h/sdk`, `anthropic/claude-fable-5-2/7d/interactive`, `anthropic/claude-fable-5-2/7d/sdk`, `anthropic/claude-haiku-5-5/5h/interactive`, `anthropic/claude-haiku-5-5/5h/sdk`, `anthropic/claude-haiku-5-5/7d/interactive`, `anthropic/claude-haiku-5-5/7d/sdk`, `anthropic/claude-opus-5-5/7d/interactive`, `anthropic/claude-opus-5-5/7d/sdk`, `anthropic/claude-sonnet-5-5/5h/interactive`, `anthropic/claude-sonnet-5-5/5h/sdk`, `anthropic/claude-sonnet-5-5/7d/interactive`, `anthropic/claude-sonnet-5-5/7d/sdk`.
<!-- fit-table:end -->

## Run a measurement

Instructions, submission and file format: [kits/claude-code/README.md](../kits/claude-code/README.md).

## Fit

    node scripts/fit-quota-weights.mjs                 # writes fit.json, fit.md, index.csv, the table above
    node scripts/fit-quota-weights.mjs --check         # exit 1 when fit.json is not current
    node scripts/fit-quota-weights.mjs --simulate      # recovery tables and the CI assertion
    node scripts/fit-quota-weights.mjs --cell <key>    # one cell
    node scripts/fit-quota-weights.mjs --pool-classes  # diagnostic: client classes pooled, emulated labels kept; prints only

Options: `--boot` (2000), `--perm` (1000), `--seed` (1), `--runs` (200).

- Cell: vendor × model × bar × client class, key `anthropic/claude-opus-5-5/7d/interactive`. Weights are shared inside a cell.
- Group: account × plan × bar × client class × model × ISO week; one scale γ per group.
- Model: `points = γ × Σ w_k × list-$_k`, `w_input = 1`, `w_k ≥ 0`.
- Segments: tick to tick. An anchor tick counts when the two requests before it each cost ≤ 0.15 point. Unanchored segments carry variance 1/6 point².
- Variance per segment: `(b_first² + b_last²)/12 + (τ × points)²`; τ from the anchored residuals, floor 0.01.
- Estimation: alternating γ and weighted NNLS over all active sets, until weights move < 1e-10 (200 rounds).
- A kind below 5% of list-$ in every segment is held at weight 1 and reported `—`.
- Identified: some segment has ≥ 50% of its list-$ and of its fitted quota-$ in the kind; the γ-profiled, column-normalised design has condition number < 100; the kind's estimate does not correlate ≥ 0.8 with a kind pinned at 0.
- Intervals: cluster bootstrap over sessions within group (segments when a group has < 3 sessions), 2,000 resamples, 2.5–97.5 percentiles, mulberry32 seed 1. 200 draws kept in `fit.json`.
- Heterogeneity per dimension (submitter, account, plan, entrypoint, client version): separate fits per level, Cochran's Q and I² on ln w, permutation p over session labels (1,000). Flagged at p < 0.05 with weights > 10% apart.
- τ_b: DerSimonian–Laird on per-submitter ln w.

## Gate

| Check | Pass |
|---|---|
| G1 coverage | ≥ 3 sessions, ≥ 2 accounts; every session has an `input` or `output` arm; output, cache read and 1h write identified, each in ≥ 2 sessions; no emulated labels; every session has a recorded idle baseline |
| G2 leave one session out | γ of the left-out session from its `input` / `output` arms; its other arms predicted with ≥ 2 sessions evaluated: median \|ln(pred/obs)\| ≤ 0.05, max ≤ 0.15 |
| G3 agreement | ≥ 2 submitters; each required weight within ×/÷ 1.15 of the pooled fit or Q-test p ≥ 0.05; no heterogeneity flag |
| G4 holdout | `holdout: true` sessions cut into ≥ 5-point chunks; cache-read share spans ≥ 20 pp; γ on half, the rest predicted: RMS ln error ≤ 0.07 and below list-price weights |
| G5 simulation | 200 seeded runs of 3 sessions × 3 points, noise 3%: \|bias\| ≤ 1% and 95% half-width ≤ 7% on every weight |

| Status | When | Build |
|---|---|---|
| `validated` | G1–G5 pass | correction applied |
| `provisional` | some kind identified | not applied; σ keeps the uncorrected range |
| `unmeasured` | nothing identified, or no data | not applied; σ keeps the uncorrected range |

Sessions with `label_emulated: true` are fitted only when a cell has no other sessions; such a cell cannot pass G1.

## Build

`node scripts/refresh-data.mjs` reads `data/quota-weights/fit.json`. Missing or unreadable: every cell `unmeasured`.

- Row → cells: φ(sample) from the measured sample's model (the chain's anchor for a derived row), φ(metric) from the row's model; bar `7d`; client class `sdk` when the sample notes say `-p`, SDK or relay, else `interactive`.
- Applied when every cell the row uses is `validated`, the sample has its own token breakdown, one sample model, and `FORCE_CLAUDE_MIX_CORRECTION_OFF` (in `scripts/refresh-data.mjs`) is `false`.
- Applied: `S_eff = S × F`, `F = φ(sample) ÷ φ(metric)`, `φ = Σ w_k × list-$_k ÷ list worth`. Benchmark cache writes count as 1h writes: weight `w_1h × p_1h ÷ p_5m`. Range: 2.5–97.5 percentiles of F over the bootstrap draws. When the range contains 1, F = 1. σ = √(sd(ln F)² + τ_b² + 0.03²).
- `stats.reliability.claudeMixCorrection` in `public/data/combined.json`: cell statuses, counts, rows applied. Each Claude row carries `rel.mix = {cells, status, applied}`.
