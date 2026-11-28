# Reliability

Every row carries `σ`, the standard deviation of ln(real cost). The build writes it to `entry.rel`; the page recomputes it for the active cost metric, benchmark and Fable cap.

## Levels

| Level | Glyph | σ | 80% of values within | Score error | Shown by default |
|---|---|---|---|---|---|
| High | ● | ≤ 0.18 | ×1.25 | ≤ 1.5 pts | yes |
| Medium | ◐ | ≤ 0.40 | ×1.7 | ≤ 3 pts | yes |
| Low | ○ | ≤ 0.70 | ×2.5 | ≤ 5 pts | yes, faded |
| Speculative | ◌ | > 0.70 | beyond ×2.5 | > 5 pts | no |

Row level = the worst of: the cost level from σ, the score level from the active benchmark's error, and the upstream grade (Fei2411 / Priors `high`, `medium`, `low`). A row with an M4 or M5 step, or data predating a listed quota change, is Speculative.

## Combination

```
σ² = σ_S² + σ_W² + σ_C² + σ_X²
σ_S² = Σ subsidy-chain steps (A, B)
σ_W  = token-mix term for the active cost metric
σ_C  = cost-metric step (C)
σ_X  = subsidy step for one cost metric only (sdkClient, T3 turn)
range = real cost × e^(±1.2816 σ)
```

- Independent steps add in quadrature.
- An agent estimate built on an effort estimate counts the effort step once.
- Two sources for one cell pool in log space with weights 1/σ² when they differ by ≤ 2·√(σ₁² + σ₂²); otherwise the lower-σ source is kept and widened by |ln S₁ − ln S₂| / 2.
- Upstream grade floors σ_S: high 0.08, medium 0.18, low 0.40.

## Step σ

Values are starting estimates. Steps are treated as independent.

Tables show σ snapped to the buckets 0.05 / 0.1 / 0.2 / 0.35 / 0.5 / 0.7 (nearest in log space; ≥ 0.7 shows as 0.7). The computation uses the exact values: `STEP_SIGMA` and `costSteps` in `scripts/reliability.mjs`, published as `stats.reliability.steps` and `stats.reliability.costSteps`.

### A. Sources

| Id | Source | σ |
|---|---|---|
| S1 | Official credit pool, rate table, API list price | 0.05 |
| S2 | Official quota table through a workload mix | 0.1 |
| S3 | Several accounts, ≥ 100 pp, within ×1.1 | 0.1 |
| S4 | One account, own token logs + first-party meter | 0.2 |
| S5 | Screenshot: first-party panel, token breakdown, ≥ 15 pp | 0.35 |
| T | Known account, large sample, figures in text | 0.35 |
| S6 | Tweet, gateway panel, any other screenshot | 0.5 |
| S7 | Claim with no numbers | 0.7 |
| Priors | Preliminary, n users | 0.40 / √n |
| Priors | Graded row: high / medium / low | 0.1 / 0.2 / 0.5 |

Tweets and single screenshots start at S6 (Low). They start at S5 (Medium) only with a first-party panel, a token breakdown and ≥ 15 pp of quota.

Add-ons: integer % reading over Δ pp `0.41/Δ`; promo period 0.2; attribution inferred 0.2; raw tokens 0.1; data older than 45 / 90 days 0.2 / 0.35.

### B. Transfers

| Id | Step | σ |
|---|---|---|
| P1 | Sibling plan, official ratio | 0.2 |
| P2 | Sibling plan, ruled ratio | 0.35 |
| X1 | Sibling plan via the model's measured ratio to an anchor model | 0.2 + pooled σ of the cells used |
| M1 | Other model, same pool, vendor-stated price-proportional draw | 0.2 |
| M2 | Other model, same pool, rate card (OpenAI) | 0.35 |
| M3 | Other model, price ratio assumed (≤ 5× / > 5× or ruled weight) | 0.2 / 0.5 |
| M4 | Successor assumed equal | 0.7 |
| M5 | Model with its own weight or cap valued by another model's multiple | > 0.7 |
| token | Token-denominated pool, list-price blend ratio | 0 |
| inconsistent | Fei and Priors disagree on the same plan × model | + \|D\| / 2 |

### W. Token mix

| Plans | σ_W |
|---|---|
| Claude Pro / Max / Ultra / Team | from the scenario range below, min 0.05 (0.1 when the sample mix is unrecorded); CursorBench 0.2 |
| Google AI, SuperGrok, Kimi, MiniMax | 0.2 |
| ChatGPT, Cursor, GitHub Copilot, GLM | 0.05 |
| API, Kilo Pass, Ollama credits | 0 |
| Other | 0.1 |

Claude correction (per quota-weight cell in `data/quota-weights/fit.json`, reported as `stats.reliability.claudeMixCorrection`; `docs/QUOTA-WEIGHTS.md`):

```
φ(mix) = Σ w_k · $_k / Σ $_k
w = { input 1, output 1, cache write 5m 1, cache write 1h 0.625, cache read 0.5 }
S_eff = S × φ(sample mix) / φ(metric mix)
```

- Scenarios (cache read, 1h write): (0.31, 1.0), (0.50, 0.625), (0.56, 0.5), (0.81, 0). The metric's cache writes are also evaluated as 1-hour writes.
- σ_W = ln(max/min factor) / 2.563.
- Sample mix: Fei's `worth $X（读 … 写 … 入 … 出 …）` breakdown; else the anchor row's; else Fei's anthropic workload convention.
- Metric mix: AA Intelligence cost breakdown; T3 per-turn tokens (also used for AA Coding Agent); 3:1 input:output for per-1M tokens.
- Cells not `validated` (today: all): S stays uncorrected and σ_W = √(σ_range² + (ln factor)²).
- `validated` cells: fitted weights replace the scenarios; σ_W = √(sd(ln F)² + τ_b² + 0.03²). `FORCE_CLAUDE_MIX_CORRECTION_OFF = true` in `scripts/refresh-data.mjs` keeps every row uncorrected.

### C. Cost and score

| Step | σ ($) | Score error |
|---|---|---|
| AA measured | 0.05 | 0 |
| Effort interpolated | live LOOCV (≈ 0.2) | ≈ ±1.1 pts |
| Effort extrapolated 1 / 2 / 3 / 4+ steps | ≈ 0.2 / 0.35 / 0.5 / 0.7 | ≈ ±1.5 / 2.6 / 3.1 / 4.6 |
| ARC-AGI-2 effort ratio | 0.35 | ±2.9 |
| Agent: same agent / other agent | ≈ 0.2 / 0.35 | ±1.5 / 2.7 |
| Agent: Terminal-Bench fit / below range | 0.2 / 0.7 | ±2.8 / 4.6 |
| T3 turn: ≥ 1,000 / ≥ 100 / < 100 turns | 0.1 / 0.2 / 0.35 | — |
| T3 turn: across agents | live, 0.15–0.35 (≈ 0.2) | — |
| CursorBench | 0.1 | 0 |
| Per 1M tokens | 0.05 | — |

LOOCV values: σ = ln(1 + median % error) / 0.6745, from `stats.effortAccuracy` and `stats.codingAgentEstimates.accuracy`.

T3 across agents (`REL.t3HarnessSigma`, reported as `stats.reliability.t3HarnessFit`):

```
σ = n-weighted sd of ln(T3 min/turn) over stats.reliability.t3Harness groups with n ≥ 3, × k/(k − 1)
clamped to 0.15–0.35; 0.2 with fewer than 2 groups
```

- Inputs on 2026-11-26: Codex 5.8 min (n 14), Claude Code 6.8 (n 9), Antigravity 7.0 (n 4), OpenCode 5.1 (n 3). Raw sd 0.12; σ = 0.15 (floor).
- The T3 $/turn ÷ AA $/task gap (Codex 0.68, Claude Code 0.16) is on the AA side: AA Coding Agent tasks take 16 min in Codex and 53 min in Claude Code.

### X. Metric-only subsidy steps

| Id | Rows | Factor on subsidy | σ |
|---|---|---|---|
| sdkClient | Claude Pro / Max / Ultra / Team, T3 turn metric | ÷ 2.1 (range 1.8–2.9) | 0.2 |

- Switch: `APPLY_SDK_CLIENT_MULTIPLIER` in `scripts/refresh-data.mjs`; constants `REL.SDK_CLIENT`; σ = ln(2.9 / 1.8) / 2.563 = 0.186.
- Sources: [claude-code #97074](https://github.com/anthropics/claude-code/issues/97074) (1.8×, 2.0×, 2.4× via T3 Code, 2.83–2.97× via the Agent SDK, 1.6–1.7× from the T3 Code maintainer), [claude-code #111890](https://github.com/anthropics/claude-code/issues/111890) (1.86× over 8 runs).
- The reports measure the 5-hour bar. Two of them see no change on the weekly bar.
- Data: `entry.clientFactor.turn { f, lo, hi, k }`, `entry.rel.x.turn`, `stats.reliability.sdkClient`.

## Own measurements

Files: `data/quota-measurements/*.json` (schema `ai-plan-value.quota-measurement/1`), public copies of the quota kit results. One file per workload.

| Cell | Workload | Weekly limit used | $/pp (95% CI) | Subsidy (95% CI) | Cost metrics |
|---|---|---|---|---|---|
| ChatGPT Plus × GPT-6.2 Sol, all levels | agentic coding, 643 calls, 80% of input cached | 19 → 31% (12 pp) | 0.6609 (0.6165–0.7054) | 13.22× (12.33–14.11) | AA Coding Agent, CursorBench, T3 turn, per 1M tokens |
| ChatGPT Plus × GPT-6.2 Sol, all levels | single long prompts, little caching | 31 → 39% (8 pp) | 0.4825 (0.4660–0.4989) | 9.65× (9.32–9.98) | AA Intelligence task |

- Run: 1 account, Codex CLI 0.172.0, GPT-6.2 Sol medium, 2026-11-27; API prices $2 input, $0.10 cached, $10 output per 1M tokens.
- Subsidy = 100 × weekly $/pp × 4 weeks ÷ $20.
- $/pp ratio agentic ÷ single: 1.37 (1.28–1.46), `chatgpt-plus-gpt-6-2-sol-compare.json`.
- Agentic run verdict `contaminated`: the 5-hour meter moved 1 pp in the idle check before the run; the weekly meter did not move. Used as is.
- Grade: S4 (one account, own token logs + first-party meter), σ_S 0.2, no transfer step (no †), no upstream cap. The measured CI (σ 0.014–0.030) is inside σ_S.
- Replaces: 14.93× = GPT-6.1 Sol Plus via M2 (Priors, 2026-11-09).
- Not applied: ChatGPT Pro plans, other GPT models.
- Build: the file with `appliesTo.default` sets `subsidyMultiple`; each file sets `subsidyByMode[metric]` for its `appliesTo.modes`. Row id prefix `own-measurement::`. The page uses `subsidyByMode[metric]` for real cost, sort and ranges.
- To add a cell: commit the kit's result as a new file with `plan`, `siteModelId`, `accounts`, `meter.ppConsumed`, `subsidy { est, ci95 }`, `appliesTo { modes, default }`. Strip account and session ids, paths, timestamps and prompts.

## Consistency checks

| Check | Rule | Action |
|---|---|---|
| T-quad | Plan families (Claude, ChatGPT, Google AI, Kimi, SuperGrok, Cursor); quads with ≥ 3 measured cells; D = ln[S(a,p)/S(b,p)] − ln[S(a,q)/S(b,q)] | \|D\| ≤ ln 1.3 pass; > ln 1.6 or z > 2 fail: listed under Disagreements; no σ change |
| T-pool | Measured Gemini models on one Google plan; Opus / Sonnet on one Claude plan | > ×1.3 fail: listed under Disagreements; no σ change |

Results: `stats.reliability.consistency`.


### Disagreements worth measuring

Failed T-quad and T-pool checks change no range and show nothing on the site. Each build lists them in the log line `Disagreements worth measuring` and in `stats.reliability.consistency` (`verdict: "fail"`, `flagged` = the least certain cell). To clear one, measure the flagged cell.

As of 2026-11-28:

| Check | Gap | Measure next |
|---|---|---|
| Claude Opus 5 / Opus 5.5, Pro vs Max | ×2.07 | Claude Max, Opus 5 |
| Claude Opus 5 / Opus 5.5, Pro vs Ultra | ×1.78 | Claude Ultra, Opus 5 |
| Claude Opus 5 vs Opus 5.5, same pool on Pro | ×1.55 | Claude Pro, Opus 5 |
| ChatGPT GPT-6.2 Sol / GPT-6 Astra, Plus vs Pro 20x | ×1.63 | ChatGPT Pro 20x, GPT-6 Astra |
| Google Gemini 3.8 Flash vs Gemini 4 Neon, same pool on Pro | ×1.49 | Google AI Pro, Gemini 3.8 Flash |

## Calibration

Ledger: `data/reliability/history.jsonl`, one JSON object per line.

| Line | Fields | Written when |
|---|---|---|
| cell | `d` date, `id` (`plan\|model[\|offpeak]`), `v` subsidy, `s` σ_S, `lo` / `hi` 80% range of the subsidy, `k` chain step kinds, `x` 1 derived / 0 direct | derived cell new or changed (value ±0.5%, σ ±0.005, kinds); direct cell right after a derived line |
| deploy | `t: "deploy"`, `d`, `counts`, `quadFails`, `t3` (harness ratios, n ≥ 3), `t3Sigma` | every recorded run |

- Recorded when `GITHUB_ACTIONS=true` or with `node scripts/refresh-data.mjs --record-history`. Other runs read the ledger only.
- CI: the deploy workflow appends this run's new lines to the latest `main` in a separate worktree and pushes `Record reliability history … [skip ci]` (needs `contents: write`). A failed push logs a warning and the deploy continues; that run's lines are lost.
- Branch protection that blocks `github-actions[bot]` pushes to `main` stops the ledger; allow the bot or the push fails every run.
- `.gitattributes` sets `merge=union` on the ledger.

`stats.reliability.calibration`:

| Field | Value |
|---|---|
| `cases` | derived cells later measured directly |
| `coverage` | share of cases whose direct value fell inside the old 80% range; target 0.8 |
| `kinds[k]` | per step kind: `n`, `coverage`, `meanLn` and `sdLn` of ln(direct / derived), `prior` |
| `kinds[k].fitted`, `refitDue` | from n ≥ 15: σ_k² = mean[ln² r − (σ_pred² − σ_k,prior²) − σ_direct²]; reported, not applied |
| `refitDue`, `lowCoverage` | kinds with n ≥ 15; kinds with n ≥ 15 and coverage < 0.6 |
| `recent` | last 50 cases |

To apply a refit: copy `kinds[k].fitted` into `STEP_SIGMA` in `scripts/reliability.mjs`.

`stats.reliability.lastDeploy` is the previous deploy line; `stats.reliability.history` gives the ledger size.

## Site-side lists (`scripts/refresh-data.mjs`)

| List | Effect |
|---|---|
| `PROMO_EXPIRY` (`plan`, `model`, `until`) and Fei `promo_until` | row dropped after `until`; kept as a ratio-transfer reference |
| `QUOTA_CHANGES` (`plan`, `model`, `date`, `action`) | older rows dropped (`drop`) or Speculative |
| `MODEL_RETIREMENTS` (`model`, `after`) | rows dropped after the date |
| `sharedPoolRules` | `same-pool` (M1) or `token` carryover; skipped when the cell is measured |
| `ratioTransferRules` | X1 carryover, pooled over reference plans |

## Billing

```
Yearly fee     = annual price ÷ 12
Yearly subsidy = subsidy × monthly price ÷ yearly price per month
σ²            += 0.03²   (official annual list price, Yearly only)
```

| Row | Monthly | Yearly |
|---|---|---|
| Official annual price | monthly fee | `$X/yr` |
| No annual option | monthly fee | `$X/mo (no annual)` |
| Annual price unknown | monthly fee | `$X/mo (annual ?)` |
| Annual variant (`(Annual)`, `(CN Annual)`) | hidden | shown; its monthly twin for the same model is hidden |

- Prices, sources and check dates: `BILLING_PERIODS` in `scripts/billing-periods.mjs`.
- To add a plan: add a record with `status` `official` (and `annual`), `none` or `unknown`, plus `url` and `checked`. `legacy: true` applies the record to the `, legacy` row.
- `unknown` records also need `reason` and `tried` (see Unknown reasons).
- `stats.billing.unmatched` non-empty: add records for the listed plans.
- `stats.billing.mismatches` non-empty: recheck the official monthly price.

## Included credits

Credits and products a plan bundles outside its quota (API credits, cloud credits, storage, X Premium) are listed per plan and not counted in the subsidy or any cost.

| Where | Shows |
|---|---|
| Bar meta line, bar and row tooltips, table row | `+$100/mo API credits (not counted)`; more items as `, +N more` |
| Plan drawer | one line per item: value, official quote, check date, link |

- Records, sources and check dates: `INCLUDED_CREDITS` in `scripts/included-credits.mjs`.
- To add a plan: add a record with `status` `listed` (and `credits`), `none` or `unknown`, plus `url` and `checked`. Set `usdPerMonth` only when the official page states a $ amount per month.
- `unknown` records: `unknown(plan, url, reason)` sets `reason` and `tried`.
- `stats.includedCredits.unmatched` non-empty: add records for the listed plans.
- The build throws if applying the records changes `subsidyMultiple`, a price or a cost.

## Sources

- Intelligence Index, cost per task, the six capability indices, token prices and output speed, per model and reasoning level: [Artificial Analysis](https://artificialanalysis.ai/) free API (`/api/v2/language/models/free`). Status in `sources.aaApi`, provenance per row in `entry.aaSource` (`api`, `fei`, `priors`, `scrape`, `estimate`), counts in `stats.aaApi`.
- Key: repo secret `AA_API_KEY` in CI. Local build: `AA_API_KEY="$(cat ~/.config/ai-plan-value/aa-api-key)" node scripts/refresh-data.mjs`.
- Levels the API does not list: Fei2411 benchmark configurations or Priors, newest observation first, then the artificialanalysis.ai/models page.
- Per-test scores (HLE, Terminal-Bench, FrontierCode and the rest) and subscription subsidies: Priors and Fei2411. ChatGPT Plus × GPT-6.2 Sol: own measurement (Own measurements).
- Coding Agent Index: the artificialanalysis.ai/agents/coding-agents page (the free API tier returns 403).
- Key missing or API down: `sources.aaApi.error` names the failure, the build uses the fallbacks above, and the data alert lists the source.
- Read every pricing page with headless Chrome: `node scripts/check-pricing-pages.mjs --url URL --text`. Add `--click 年付` (or `Yearly`, `连续包年`) to read an annual tab.
- One-off: `chromium-browser --headless=new --disable-gpu --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" --virtual-time-budget=15000 --dump-dom URL`. Pages that never go idle (kimi.com/en/help, bigmodel.cn) hang with `--virtual-time-budget`; use the script.
- Host fails to resolve locally: look it up with `curl "https://dns.google/resolve?name=HOST&type=A"`, then `CHROME_ARGS='--host-resolver-rules=MAP HOST IP'`.
- grok.com/plans shows local currency; read USD prices from docs.x.ai/x-subscription/pricing.
- StepFun: platform.stepfun.com/step-plan (CN, ¥), platform.stepfun.ai/step-plan (global, $).

## Unknown reasons

Every `unknown` record in `BILLING_PERIODS` and `INCLUDED_CREDITS` has `reason` and `tried` (date of the last render).

| `reason` | Page state | Action |
|---|---|---|
| `blocked` | 403 / bot wall in headless Chrome | find another official page |
| `login` | figure shown only when signed in (GLM existing-subscriber tiers) | read it from a subscriber account or an official doc |
| `dns` | host does not resolve | retry with public DNS (Sources) |
| `not-stated` | page renders and does not state it | wait for the page watch to report a change |
| `js-only` | figure needs interaction `--click` cannot reproduce | read it in a browser |

## Page watch

`scripts/check-pricing-pages.mjs` renders every URL cited in both tables (deduplicated) and compares each page with `data/pricing-pages/baseline.json`.

- Chrome: `CHROME_BIN`, else `google-chrome`, `chromium-browser`, `chromium`. Extra flags: `CHROME_ARGS`. Node ≥ 22.
- Page state: `ok`, `blocked` (401 / 403 / 429 or bot wall), `login`, `dns`, `error`, `empty` (< 200 characters).
- Hash: sha256 (16 hex) of the unique, sorted lines carrying a digit and a currency, period or credit word (`$`, `¥`, `/mo`, `annual`, `年付`, `credits`, `额度` …); of the unique, sorted lines carrying a digit when none.
- A page reported `changed` or `stopped` is rendered again; it is reported only when both renders differ from the baseline (`flaky` otherwise).
- Report (stdout, `--out FILE`): `pages`, `readable` (was not `ok`, now `ok`), `changed` (hash differs), `stopped` (was `ok`, now not). Entries list the `unknown` plans citing that URL.
- Deploy workflow, scheduled runs only, after the tests, `continue-on-error`: `--issue` comments on the open "Pricing pages changed" issue or opens it.
- After updating the tables: run the workflow manually with `pricing_baseline` ticked (Actions → Refresh Data and Deploy → Run workflow). The CI runner records the baseline in USD and commits it.
- Never record the baseline locally: pages show local currency outside the US.
- The baseline keeps each page's price lines; the issue lists lines removed (−) and added (+).

## Fable cap

Fable on Claude Pro / Max / Ultra: `capShare` 0.5, `subsidyReadings { shared, own }`, own = shared × 0.5. `Tasks/mo` = fee ÷ real cost × capShare in the Shared reading.

## Markers

| Mark | Meaning |
|---|---|
| `~` before a value | derived cell: subsidy with a transfer step, estimated cost, or estimated score |
| ● ◐ ○ ◌ after the model name | row level; tooltip lists level, the 80% likely range of real cost, subsidy chain (with token mix and Agent SDK client factors), cost source, score error |
| faded row | Low or Speculative |

## Settings

| Setting | Values | Default |
|---|---|---|
| Min confidence | High, Medium, Low, Speculative | Medium |
| Cost | Point, Range | Point |
| Fable use | With other models (`shared`), Fable only (`own`) | With other models |
| Billing | Monthly, Yearly | Monthly |

The bar chart and the table both show rows at or above the Min confidence setting. Range shows `$lo–hi` for Medium, Low and Speculative rows.

## URL parameters

| Parameter | Values |
|---|---|
| `conf` | `h`, `m`, `s` (`l` is the default) |
| `cost` | `range`, a max cost, or both: `cost=2,range` |
| `fable` | `own` |
| `billing` | `yearly` |
| `est` (legacy) | `0` → `h`, `h` → `m`, `hm` → `l`, `hml` → `s` |
| `extrap=1` / `nointerp=1` (legacy) | `s` / `h` |
| `noest=1` (legacy) | at most `m` |

## Data

- `entry.rel`: `level`, `sigma`, `lo`, `hi` (AA task cost, Intelligence Index, Shared); `s`; `w` and `c` per cost metric; `x` per cost metric (metric-only subsidy steps); `score { ii, agent }`; `cap`; `chain`; `flags`; `sd` (subsidy derived); `ce` (metrics with an estimated cost); `cl` (cost source labels).
- `entry.quotaMix[metric]`: `{ f, lo, hi }` on corrected Claude rows.
- `entry.clientFactor[metric]`: `{ f, lo, hi, k }`; the page multiplies the subsidy by `f`.
- `entry.subsidyByMode[metric]`: measured subsidy per cost metric on own-measurement rows; the page uses it instead of `subsidyMultiple`. `entry.ownMeasurement`: `[{ file, workload, modes, subsidy, ci95, pp }]`. `stats.reliability.ownMeasurements`: files read, cells applied.
- Subscription rows: `priceUsdMonthly`; `priceUsdYearly` (annual fee ÷ 12, or null); `billingYearly` (`official`, `none`, `unknown`, `variant`); `billingOnly: "yearly"` on annual-variant rows; `hideYearly` on their monthly twins; `rel.y` (0.03) on rows with an official annual price.
- Subscription rows: `includedCredits` (`[{ kind, usdPerMonth, text, url, checked }]`); `includedCreditsStatus` (`listed`, `none`, `unknown`).
- `stats.includedCredits`: row counts per status, `unmatched` plans, `subsidyUnchanged`.
- `stats.billing`: row counts per status, `unmatched` plans, `mismatches` (stored vs official monthly price).
- `stats.chains[id]`: `steps [{k, s, t}]`, `lines` (nearest step first), `anchors`, `flags`.
- `stats.reliability`: σ tables, `sigmaBuckets`, thresholds, `counts`, `countsByMode`, `consistency`, `unresolved`, `priorsSkipped`, `droppedRows`, `t3Harness`, `t3HarnessFit`, `sdkClient`, `calibration`, `lastDeploy`, `history`.

## Tests

`node scripts/test-site.mjs` fails when: an entry lacks `rel`; Σ step σ² ≠ rel.s²; a derived subsidy is above its anchor's level or a row above its upstream grade; an M4/M5 row is not Speculative; an expired promotion or pre-change row is listed; a failed quad or pool check has no cell to measure or still changes a range; the Priors `plans: []` records are missing; Neon is not pooled; Kimi K3.1 Pro ≠ K3 × 0.667; Fable readings are inconsistent; the Claude mix correction does not match the flag; `t3Harness` has < 5 Codex or Claude Code pairs; > 5% of Fei derived rows are unresolved; a subscription row lacks `priceUsdMonthly`; a yearly price exceeds the monthly one; a plan × model shows twice in Monthly or Yearly; the yearly subsidy ≠ subsidy × monthly ÷ yearly; a plan has no billing record; a subscription row lacks `includedCreditsStatus`; a listed credit lacks a URL or check date; Claude Max ≠ $100 or Claude Ultra ≠ $200 API credits; a subsidy changes with `includedCredits`; a plan has no included-credits record; an `unknown` record lacks a valid `reason` or `tried` date; a `listed` or `official` record lacks a URL or check date; the page-watch baseline is malformed or misses a table URL; the watch step is missing, not scheduled-only, before the tests or without `continue-on-error`; the page diff misreports readable / changed / stopped.

Tests that need history print `SKIP` until the ledger has the data:

| Test | Fails when | Needs |
|---|---|---|
| Calibration coverage | a step kind with n ≥ 15 has coverage < 60% | a kind with n ≥ 15 |
| T3 harness drift | Codex or Claude Code ratio moved more than ×1.5 since the last deploy | a previous deploy line |
| Quad fails | quad fails > last deploy's + 2 | a previous deploy line |
