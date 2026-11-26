# Roadmap

Planned work, in order. Design notes live in `docs/design/`.

## 1. Claude quota-weight recordings

Measure how Claude's subscription quota counts each token kind, so the Claude mix correction can be validated and Claude Max/Pro rows can rise from Low.

- [ ] Build `scripts/quota-probe.mjs`. It runs the protocol arms (`input`, `output`, `read`, `write1h`, `write5m`) in Claude Code, reads `/usage` on meter ticks, and writes `quota-weights.session/1` JSONL.
- [ ] Record on our own subscription:
  - weekly bar, interactive client
  - 5h bar, interactive client
  - 5h bar, `claude -p` (headless)
  - Target: 3 sessions from 2 accounts, 3 anchored points per arm (about ±5% per weight, about 10% of a week's quota).
- [ ] Store submissions in `data/quota-weights/`. Store sessions with a hand-set `CLAUDE_CODE_ENTRYPOINT`, but exclude them from validated fits.
- [ ] Build `scripts/fit-quota-weights.mjs` (prototype: `docs/design/quota-weights-proto/`).
  - Output `fit.json` with a status per model × bar × client: `validated`, `provisional` or `unmeasured`.
- [ ] Replace `APPLY_CLAUDE_MIX_CORRECTION` with `fit.json` status. Apply the correction only to `validated` cells.
- [ ] Add `docs/QUOTA-WEIGHTS.md`, a Methodology entry, tests, and a GitHub issue template for submissions.

Spec: `docs/design/quota-weight-methodology.md`.

## 2. SDK/headless quota multiplier

- [x] Model the ÷2.1 SDK/headless burn rate (claude-code #97074, #111890) as its own step, `sdkClient`, for Claude rows in T3 turn mode (`APPLY_SDK_CLIENT_MULTIPLIER`).
- [ ] Confirm it with the headless arm from step 1, on both the 5h and the weekly bar.

## 3. Reliability calibration

- [x] Record each deploy's predicted ranges in `data/reliability/history.jsonl` (committed by the deploy workflow); results in `stats.reliability.calibration`.
- [x] When a derived value later gets a direct measurement, check whether it lands inside its 80% range. Target coverage is about 80%.
- [x] Report a step type's fitted σ once it has n ≥ 15 cases (`refitDue`).
- [ ] Apply the first refit to `STEP_SIGMA` once a step type reaches n ≥ 15.
- [x] Show step σ in coarse buckets (0.05 / 0.1 / 0.2 / 0.35 / 0.5 / 0.7). State in the Methodology that the values are starting estimates and that steps are treated as independent.
- [x] Re-examine the T3 cross-harness term (0.35 → live `t3HarnessSigma`, 0.15 today).
- [x] Add tests that need deploy history: calibration coverage, T3 harness drift, quad fails ≤ last deploy + 2.

## 4. Upstream reports

- [ ] Fei (Fei-Craft/real-api-pricing):
  - Opus 5 vs Opus 5.5 cross-plan inconsistency (×1.7–2.1)
  - stale Pro × Argon row (bucket removed 2026-11-23)
  - expired Pro × Fable 5.2 launch offer
  - request the #98 design with separate 5m and 1h write groups
- [ ] Priors (adamholter/priors):
  - Fable note has $34.2 and $14.1 swapped
  - confirm the `plans: []` + `ratio` / `sameAs` / `readings` record shape is stable

## 5. Site

- [ ] Mobile item 7: below 600px, render the full table as card rows, with a Sort select and "Show 50 more".
- [ ] Mobile item 8: full-screen dialogs using `dvh` units on phones.
- [ ] Self-host DejaVu Sans as the Verdana fallback for Android (about 40 KB).
- [ ] Hours/mo column in T3 mode.
- [ ] Provenance list in the plan drawer.
- [ ] Combined real-world cost metric with Raw / Harness / Custom mixes (`docs/design/combined-metric-design.md`). It depends on steps 1–3.
