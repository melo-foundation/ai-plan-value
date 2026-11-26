# Reliability model and dataset fixes: design

Date 2026-11-26. Data: `public/data/combined.json` generated 2026-11-26T02:06Z (2,577 entries, 634 plan × model base rows), Fei2411/real-api-pricing clone at `cce3f28` (2026-11-25), Priors snapshot 2026-11-25. No repo files were edited. Analysis scripts: `docs/design/reliability-sim.py`.

Labels used below: **[verified]** I computed it from the files or fetched the source in this session; **[agent]** fetched by a research subagent in this session, URL given; **[Fei]** / **[Priors]** stated in that dataset, not re-verified outside it; **[inferred]** my reasoning.

## 0. Findings that change the brief

These came out of reading the data and are prerequisites for the rest.

1. **The Priors parser drops every record with `plans: []`.** [verified] `parsePriors` loops over `det.plans`, so four Priors records never reach the site: Fable 5.2 on Claude Ultra (`ratio` 0.0367 = 27.2×, plus a `readings` array with "shared" 27.2× and "own" 13.6×), Gemini 4 Carbon and Gemini 4 Argon (`sameAs: gemini-3.8-flash`), and Hydrogen's paid record (nested under `details.paid`). The Fable 5.2 and Argon placeholders exist only because of this.
2. **A "preliminary" Priors row replaces a newer direct Fei measurement.** [verified] `existingId && item.isPrelim` makes the Priors row win regardless of date or evidence. For Gemini 4 Neon the site shows Priors 20.8× / 24.0× / 48.0× (Pro / Ultra 5x / Ultra 20x; 2026-11-18; one or two users; the Ultra 5x figure is itself extrapolated from 20x). Fei has direct maintainer samples dated 2026-11-20 to 11-25 with 37, 36 and 39 pp of weekly quota: 17.1× / 21.3× / 35.0× (own-mix list-$ per fee-$). The placeholder anchor is therefore 1.13–1.37× above the best available measurement before any carryover.
3. **Fei's Argon figure is stale, and the Pro Fable 5.2 figure was a launch-week promotion.** [agent, official sources in §3.1 and §3.2] Google removed the separate Argon bucket on Pro on 2026-11-23; Fei's 1.4× was measured on 2026-10-16 on that bucket. Anthropic's help page says Fable is not included in Pro's limits; Pro had Fable "up to 50%" only from Nov 9 to Nov 16, and Fei's Pro sample is dated Nov 9. Neither row describes a plan a reader can buy today.
4. **Fei's "Kimi K3" quota was measured on K3.1 Pro traffic.** [verified in Fei notes] `kimi_allegretto_cn::kimi-k3`: "k3.1-pro 单日 37362656 ÷ 控制台月总1.92%"; `kimi_allegro_cn::kimi-k3`: "旧版 699 Allegro × k3.1-pro 控制台". The K3.1 Pro row is closer to the sample than the K3 row it is copied from, but K3.1 Pro's list price is 2/3 of K3's, so copying the multiple overstates it by 1.5×.
5. **The subsidy `confidence` field is never rendered or filtered.** [verified] `app.js` reads `estimateConfidence` and `codingAgent.confidence` only. The 274 `confidence: "low"` entries show no mark unless they are also `isPreliminary`. With today's defaults, the cheapest rows at Intelligence ≥ 50 are GPT-6.2 Sol on ChatGPT Pro, all `priors-assumed`.
6. **The AA Intelligence Index is not an output-heavy, no-cache workload.** [verified] `aaCostPerTaskBreakdown` for Opus 5.5 (max): cache reads 47% of dollars, cache writes 18%, output 35%, fresh input 0.4%. Across the 26 variants that carry a breakdown, cache reads are 17–83% of dollars. The earlier `quota-token-weights.md` estimate (Claude subsidy × 0.55 on AA Intelligence) assumed 70% output dollars and no cache; with the real mix the correction is about × 0.78–0.86 (§3.3).
7. **Fei already publishes structured derivation fields.** [verified] `data_date_kind` ∈ {sample 43, official 252, derived 93} and `data_date_from` (the anchor row) in `data/adopted.csv` and `derived/points.csv`; derived rows' `source` follows `由同套餐 <model> <亿> 亿 × <ratio>`. The site reads neither.

## 1. Recommended reliability model

### 1.1 Decision: numeric underneath, four categories on display

Store one number per derivation step: σ, the standard deviation of the natural log of the value (so `exp(σ)` is the typical multiplicative error). Sum variances along the chain. Map the total to four displayed levels. Show an 80% range on request.

Why this and not pure categories:

- The pipeline is a product and quotient of positive numbers (`real cost = API cost ÷ subsidy`, subsidy = anchor × ratios). GUM §5.1.6 Note 1: "the logarithmic transformation Z = ln Y and Wi = ln Xi leads to an exact linearization", so variances of ln add exactly for independent inputs. [agent, https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf]
- The ecoinvent pedigree matrix does exactly this for life-cycle data: five quality indicators scored 1–5, each score mapped to an added variance of ln(x), summed with a basic term, zero covariance assumed. Its "further technological correlation" indicator (data from a different technology applied to the target) carries the largest factors, up to GSD² 2.0; this is the analogue of "measured on model A, applied to model B". [agent, Weidema et al. 2013, https://lca-net.com/files/Overview_and_methodology.pdf ch. 10]
- Epoch AI already labels estimates this way: "Confident" ±3×, "Likely" ±10×, "Speculative" ±31×, each a 90% interval. [agent, https://epoch.ai/data/ai-models-documentation/estimation]
- Categorical tiers cannot accumulate. Today's rule ("take the lower of two tiers") means two medium inputs give medium, and ten would too. GRADE accumulates by counting downgrade levels, but each step is a whole level, which is too coarse for a chain where steps range from ×1.03 to ×3.
- Interval arithmetic (worst-case bounds) over-widens: four ×1.5 steps give ×5.1 worst case against about ×2.25 at 95% under independence. [agent]

What is kept from the categorical schemes:

- **GRADE** [agent, https://gdt.gradepro.org/app/handbook/handbook.html]: a starting level set by evidence type, then named downgrade domains. Mapping: risk of bias → source type (§1.2 A); imprecision → reading resolution and n; indirectness → plan and model transfer steps (§1.2 B); inconsistency → the cross-plan test (§3.5); publication bias has no analogue. GRADE's upgrade for corroboration becomes precision-weighted pooling of independent sources.
- **Cochrane RoB 2** [agent, https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-08]: "The overall risk of bias for the result is the least favourable assessment across the domains." Kept as hard caps (§1.4): a fatal flaw sets the level regardless of the arithmetic.
- **IPCC** [agent, Mastrandrea et al. 2010]: use quantified likelihood where it can be quantified, qualitative confidence otherwise, and give every finding a "traceable account". The chain stored per row is the traceable account.
- **Admiralty code** [agent, secondary: https://arxiv.org/html/2405.19968v1]: grade the source and the information separately. Used for tweet and screenshot starting levels (§3.6).
- **Particle Data Group scale factor / Birge ratio** [inferred, standard practice; not fetched]: when independent measurements disagree by more than their stated errors, inflate the errors until they agree. Used in §3.5.

### 1.2 Per-step penalty table

σ values are priors. The "calibration" column is what Fei's own revision history and the Fei-vs-Priors overlaps show when a derived value was later measured directly [verified from Fei notes; n is small].

**A. Starting σ by source type**

| id | Source | σ | ×factor | Calibration |
|---|---|---|---|---|
| S1 | Official credit pool in dollars, or rate table (Copilot, Kilo, Ollama, OpenCode Go, API list price) | 0.03 | 1.03 | deterministic |
| S2 | Official quota table converted through a workload mix (GLM credits, MiMo, official token tables) | 0.12 | 1.13 | — |
| S3 | Several accounts or sources, ≥100 pp of quota in total, sources within ×1.1 | 0.10 | 1.11 | Claude Pro × Opus 5.5: three sources 28.98 / 29.35 / 30.65 亿 |
| S4 | One account, own token logs plus first-party meter, ≥20 pp | 0.20 | 1.22 | pairs of independent sources differ ×1.03–1.37 (n=5, RMS of ln 0.19 → 0.13 per source) |
| S5 | One first-party screenshot with token breakdown and quota % | 0.35 | 1.42 | — |
| S6 | Tweet, third-party gateway panel, verbal or rounded % ("~75%") | 0.45 | 1.57 | Claude Team claim "6.25× Pro" vs measured: ×1.52 |
| S7 | Claim with no numbers, or unattributed | 0.70 | 2.0 | — |

Add-ons to the source term (each added in quadrature):

| Add-on | σ |
|---|---|
| Reading resolution: integer % readings over Δ pp | 0.41 / Δ (7 pp → 0.06; 37 pp → 0.01) |
| Sample taken in a promo period and re-based by a factor | 0.20 |
| Attribution inferred (other usage possible in the window; pool identity assumed) | 0.15 |
| Raw token total, no per-kind breakdown (Fei `workload = measured`) | 0.10 |

**B. Transfer steps**

| id | Step | σ | ×factor | Calibration |
|---|---|---|---|---|
| P1 | Same model, sibling plan, official ratio stated as dollar or token worth | 0.25 | 1.28 | Claude Pro / Max / Ultra official 1 : 5 : 10 vs measured Opus 5.5 multiples 63.8 / 76.8 / 66.1 (×1.20, ×1.04); Google Pro×5 → Ultra 5x: ×1.25 off; Pro×20 → Ultra 20x: ×1.02; Kimi official 60/20: ×1.54; Priors 20x÷4 → 5x: ×1.13. RMS 0.29, n=5 |
| P2 | Same model, sibling plan, ratio ruled by a maintainer or taken from a window multiplier | 0.35 | 1.42 | Claude Max 20x÷2 → 5x: ×1.16 (Opus 5.5), ×1.53 (Fable 5). RMS 0.32, n=2 |
| X1 | Same model, sibling plan, via the model's measured ratio to an anchor model (§3.1) | 0.15 plus the σ of the three cells used | 1.16 | 7 informative quads: ×1.02–1.25, RMS 0.145; Fable 5.2 / Opus 5.5 on Pro vs Ultra: ×1.04 |
| M1 | Other model, same pool, vendor states price-proportional draw, checked by a control | 0.15 | 1.16 | Gemini Flash vs Neon parity 1.00 and Hydrogen vs Flash 0.99 (Priors controls); 3.6 vs 3.8 Flash $1.19 vs $1.23 per 1%; Opus 5 → 5.5 weight 0.520 vs price 0.514 |
| M2 | Other model, same pool, official rate card, included usage not guaranteed to follow it (OpenAI) | 0.30 | 1.35 | GPT-6.1 Sol burned 1.33× its credit rate (Fei #97) |
| M3 | Other model, same pool, price ratio assumed without a vendor statement | 0.25 (ratio ≤ 5×), 0.45 (ratio > 5×) | 1.28 / 1.57 | Fei rates these low; Haiku 5.5 is ×19.5 by price |
| M4 | Successor assumed equal to predecessor | 0.70 | 2.0 | Opus 5 → 5.5: ×1.55 (Pro), ×1.33 (Max); GPT-5.6 Luna → 6 Luna: ×1.59; GPT-6 Sol → 6.1 Sol: ×1.08; Kimi K3 → K3.1 Pro: ×1.5; Fable 5.1 → 5.2: ×2.1 like-for-like, ×4.2 as shipped. RMS 0.45–0.67, n=6 |
| M5 | Model with its own weight, cap or pool, valued by another model's multiple | 1.0 | 2.7 | Fable 5 by price ratio: ×2.1–3.25; Fable 5.2 vs price-proportional: ×2.5; Argon (old separate pool) vs Neon: ×15 |
| T1 | Data older than 45 days / 90 days | 0.15 / 0.30 | 1.16 / 1.35 | Claude +25% on 9/14, Kimi v2 ×½ on 10/26, Google pool change on 11/23: one ×1.25–2 change per vendor every 1–2 months |
| W1 | Subsidy measured on one token mix, applied to another (§3.3): Claude after correction 0.12; Claude write-heavy sample (Fable 5.2 Pro) 0.25; Google, xAI, Kimi, MiniMax 0.15; OpenAI, Cursor, Copilot, GLM 0.05 | | | Claude range × 0.75–1.0; Google uncached probe vs cached usage ×1.2–1.37 |

The user's two examples land where expected: same model to another plan by a known ratio is ×1.16–1.28 (small); cross-model "assume the same" is ×2.0–2.7 (large). The calibration shows one refinement: cross-model is small when the vendor states the mechanism and a control confirms it (M1), and large otherwise.

**C. Cost and score steps** (σ from the live LOOCV: σ = ln(1 + median error) / 0.6745; `eval-effort-estimates.mjs` should emit the RMS of ln error directly)

| Step | σ ($/task) | Score error |
|---|---|---|
| AA measured | 0.05 | 0 |
| Effort interpolated | 0.17 | ±1.1 pts |
| Same-family, 1 / 2 / 3 / 4+ steps | 0.21 / 0.37 / 0.52 / 0.70 | ±1.4 / 2.5 / 3.1 / 4.6 |
| ARC-AGI-2 transfer | 0.39 | ±2.8–3.0 |
| Agent: same model, same agent | 0.16 | ±1.4 |
| Agent: same model, other agent | 0.40 | ±2.7 |
| Agent: Terminal-Bench fit (in range / below range) | 0.25 / 0.60 | ±2.8 |
| T3 turn: ≥1,000 turns / <1,000 / <100 | 0.10 / 0.25 / 0.40 | — |
| CursorBench | 0.10 | 0 |

### 1.3 Combination rule

```
σ_S²   = Σ source and transfer steps of the subsidy chain (A, B)
σ_C²   = Σ steps of the cost in the active cost metric (C), built on its own inputs
σ²     = σ_S² + σ_C²                      # real cost = C / S; ln cost = ln C − ln S
range  = cost × exp(±1.2816 σ)            # 80% interval
```

- Independent steps add in quadrature. Steps that share one assumption add linearly (σ₁ + σ₂). The only current case: an agent estimate whose input is the same effort estimate already counted in σ_C counts that effort step once.
- n effort steps use the LOOCV σ for n steps, not n × σ₁.
- Two independent sources for one cell are pooled in log space with weights 1/σ²: `ln S = Σ wᵢ ln Sᵢ / Σ wᵢ`, `σ = (Σ wᵢ)^-½`. If they disagree by more than `2·sqrt(σ₁² + σ₂²)`, do not pool: keep the lower-σ source and add `|ln S₁ − ln S₂| / 2` to its σ.
- The score is not multiplicative. Its level comes from the point error in column C: ≤1.5 pts High, ≤3 Medium, ≤5 Low, else Speculative (the first three are today's thresholds).
- **Row level = the worse of the cost level and the score level** for the active benchmark and cost metric.

Levels, named by what they mean numerically:

| Level | σ | 80% of values within | Default |
|---|---|---|---|
| High | ≤ 0.18 | ×1.25 | shown |
| Medium | ≤ 0.40 | ×1.7 | shown |
| Low | ≤ 0.70 | ×2.5 | shown |
| Speculative | > 0.70 | beyond ×2.5 | hidden |

### 1.4 Caps (RoB-style overrides)

| Condition | Effect |
|---|---|
| A quota change for that plan is known after the row's data date and the row was not re-based | Speculative |
| A direct measurement of the same plan × model exists and differs by more than ×1.6 | the derived row is dropped |
| Cross-plan consistency test fails (§3.5) | the weakest cell in the quad gets `|D| / 2` added to σ |
| Chain cannot be resolved by the parser | σ floor from the upstream grade: Fei / Priors high 0.08, medium 0.18, low 0.40 |

The upstream grade is also a floor in every case: the parsed chain may lower a row's level, never raise it above what the maintainer assigned.

### 1.5 Effect on the dataset [verified, `docs/design/reliability-sim.py`, cost metric = AA task]

| | High | Medium | Low | Speculative |
|---|---|---|---|---|
| Today, subsidy `confidence` (not displayed) | 1,533 | 770 | 274 | — |
| Proposed, subsidy only, data as is | 1,874 | 455 | 177 | 71 |
| Proposed, subsidy + cost, data as is | 918 | 825 | 655 | 179 |
| Proposed, subsidy + cost, after the §3 fixes | 918 | 857 | 684 | 118 |
| Of the 1,888 entries visible by default today, after fixes | 918 | 773 | 187 | 10 |

The parser used for this table is a prototype; the counts will move by tens when the production parser reads token breakdowns and dates properly.

### 1.6 Worked examples (max effort, AA $/task, numbers before any §3.3 mix correction unless stated)

| Row | Chain | σ | Level | Real $/task | 80% range |
|---|---|---|---|---|---|
| Claude Pro · Opus 5.5 | S3 0.10 ⊕ W1 0.12 ⊕ cost 0.05 | 0.16 | High | $0.157 ($0.184 after mix fix) | $0.15–0.23 |
| Claude Pro · Fable 5.2 (as a measurement; the offer ended Nov 16, so the row itself is capped Speculative, §3.2) | S4 0.20 ⊕ reading 7 pp 0.06 ⊕ W1 0.25 ⊕ 0.05 | 0.33 | Medium | $1.05 ($1.26 after mix fix) | $0.83–1.93 |
| Claude Ultra · Fable 5.2, today | Opus 5 Max 20x: S4 0.20 ⊕ promo 0.20 ⊕ raw 0.10; Fable 5.1 weight from one promo-period sample 0.45; M4 0.70; T1 0.30; 0.05 | 0.93 | Speculative | $4.14 | $1.25–13.7 |
| Claude Ultra · Fable 5.2, proposed | Opus 5.5 Ultra S4 0.20 ⊕ measured Fable/Opus ratio (Theo 2.43, Fei Pro 2.53, pooled) 0.20 ⊕ 0.05 | 0.29 | Medium | $0.98 | $0.67–1.41 |
| Claude Max · Fable 5.2, proposed | Opus 5.5 Max S5 0.35 ⊕ ratio 0.20 ⊕ X1 0.15 ⊕ 0.05 | 0.43 | Low | $0.86 (today $4.14) | $0.49–1.49 |
| Claude Max · Opus 5 | S4 0.20 ⊕ promo 0.20 ⊕ raw 0.10 ⊕ P2 0.35 ⊕ T1 0.30 ⊕ inconsistency 0.36 ⊕ 0.05 | 0.66 | Low | $0.205 | $0.09–0.48 |
| Google AI Ultra 5x · Neon, today | Priors 1 user 0.40 ⊕ P1 0.25 ⊕ 0.05 | 0.47 | Low | $0.268 | $0.15–0.49 |
| Google AI Ultra 5x · Neon, Fei direct | S4 0.20 ⊕ W1 0.15 ⊕ 0.05 | 0.25 | Medium | $0.302 | $0.22–0.42 |
| Google AI Ultra 20x · Argon, today | Priors 1 user 0.40 ⊕ M4 0.70 (no mechanism recorded) ⊕ 0.05 | 0.81 | Speculative | $0.207 | $0.07–0.58 |
| Google AI Ultra 20x · Argon, proposed | pooled Neon anchor 0.18 ⊕ M1 0.15 ⊕ W1 0.15 ⊕ 0.05 | 0.28 | Medium | $0.267 | $0.19–0.38 |
| Google AI Pro · Argon, today | Fei S6 0.45, measured on a bucket removed Nov 23 | cap | Speculative | $7.09 | — |
| Claude Team Premium · Opus 5.5 | S6 0.45 ⊕ attribution 0.15 ⊕ W1 0.12 ⊕ 0.05 | 0.49 | Low | $0.238 | $0.13–0.45 |
| ChatGPT Pro 20x · GPT-6.2 Sol | GPT-6.1 Sol anchor 0.22 ⊕ M2 0.30 ⊕ 0.05 | 0.38 | Medium | $0.034 | $0.021–0.055 |

The true Fable 5.2 value on Ultra (about $0.98) sits inside today's 80% range ($1.25–13.7) only if the range is widened to 90%. That is the right behaviour for a Speculative row: the label and the hidden-by-default rule do the work, not the point value.

## 2. Marker and UI proposal

Today [verified]: `*` after the plan name and the subsidy (preliminary or assumed subsidy); `~` before score and cost values that are estimated; `●◐○` after the model name (effort or agent estimate tier); faded rows for ◐ ○; four footnotes; four checkboxes. Three marks answer overlapping questions, and the subsidy grade has no mark.

### 2.1 Two marks, two questions

| Mark | Question it answers | Scope | Where |
|---|---|---|---|
| `~` | Is this number derived, not measured? | one cell, yes/no | prefix on Score, Subsidy, API cost, Real cost |
| `◐` `○` `◌` | How far can I trust this row? | one row, graded | after the Real cost value |

- High rows carry no glyph. `●` and `*` are removed.
- `◐` Medium, `○` Low, `◌` Speculative: one glyph family, monotonic in fill, the order readable without a legend. Existing users already read ◐ ○ as medium and low.
- Low and Speculative rows keep the existing fade. MacEachren et al. 2012 found fuzziness and value the most intuitive encodings of ordinal uncertainty and saturation and hue poor. [agent, https://geography.wisc.edu/cartography/projects/publications/MacEachrenEtAl_2012_TVCG.pdf]
- The glyph follows the active cost metric and benchmark, because σ_C and the score level do.

### 2.2 Tooltip on the glyph (no sentences)

```
Low · ×1.7
Subsidy  31.0×  Opus 5.5 Max ÷ 2.48 (Fable/Opus, Pro + Ultra)
         Opus 5.5 Max: 1 screenshot, 19 pp, 2026-10-03
Cost     $26.54  AA measured
Range    $0.49–1.49
```

Line format: label, value, source chain from nearest step to origin. Dates and counts as bare values.

### 2.3 Settings (label, value, options)

```
Min confidence   [ High | Medium | Low | Speculative ]      default Low
Cost             [ Point | Range ]                          default Point
Fable cap        [ Shared | Fable only ]                    default Shared   (§3.2)
```

Removed: "Hide estimated subsidies (*)", "Show high / medium / low-confidence estimates".

- `Range` shows `$0.49–1.49` in the Real cost cell for Medium, Low and Speculative rows and a point for High rows. Sorting stays on the point value. Padilla, Kay and Hullman warn that readers treat a bare interval as a category boundary, so the point value stays in the tooltip. [agent]
- The "Best" cards take rows at Medium or better regardless of the setting (open question 2).
- URL: `conf=h|m|l|s`, `cost=range`, `fable=own`. Legacy `est=`, `extrap=1`, `nointerp=1` map to `conf=`: `est=h` → `m`, `est=hm` → `l`, `est=hml` → `s`, `est=0` → `h`.

### 2.4 Legend and methodology

- One legend line under the table replaces the four footnotes: `~ derived   ◐ medium   ○ low   ◌ speculative`.
- Infobar: `118 speculative rows hidden` with the existing link-button `Show`.
- Methodology panel: a three-column table (Level, Within, Typical source) filled from `stats.reliability`, replacing the three prose `<dd>` blocks.
- Plan drawer: the same glyph per cell; the provenance list (source link, date, n, pp) under the grid.

## 3. Dataset fixes

### 3.1 Placeholder carryovers (`sharedPoolRules`)

**Rule to adopt.** A carried row must name its mechanism. Three are allowed, each with its σ from §1.2:

```
same pool, price-proportional (M1/M2/M3):   S(m, p) = S(a, p)
token-denominated pool:                     S(m, p) = S(a, p) × blend(m) / blend(a)
ratio transfer (X1):                        S(m, p) = S(a, p) × S(m, q) / S(a, q)
   m target model, a anchor model, p target plan, q a sibling plan where both are measured
   with several sibling plans q: geometric mean of the ratios, weights 1/σ²
```

"Successor assumed equal" (M4) stays possible but lands at Speculative and is hidden by default. The site's current rule is M4 for every target.

| Carryover | Verdict | Replace with | Numeric effect (multiple; real $/task at the effort shown) |
|---|---|---|---|
| Claude Max / Ultra: Fable 5.1 → 5.2 | **Invalid.** Different model, and the 5.1 figure is a cap-halved "Fable only" reading on an Opus 5 pool from August, while Fei's 5.2 Pro figure is a "shared" reading | Ultra: read Priors' `ratio` record directly, 27.2× (shared), 13.6× (Fable only). Max: X1, `S(Opus 5.5, Max) ÷ 2.48` = 31.0× | 6.4× → 27.2× / 31.0×. Max effort: $4.14 → $0.98 (Ultra), $0.86 (Max) |
| Google AI Pro / Ultra: Neon → Carbon, Hydrogen | **Valid as M1** [Priors: same Gemini pool, price-proportional; Fei's Ultra 5x sample includes Hydrogen in the Neon pool], but the anchor is wrong (finding 2) | Same rule, anchor = pooled Fei direct + Priors: Pro 18.9×, Ultra 5x 21.3×, Ultra 20x 37.3× | 20.8 / 24.0 / 48.0 → 18.9 / 21.3 / 37.3. Carbon high on Pro: $0.373 → $0.410. Level Speculative → Medium |
| Google AI Ultra: Neon → Argon | **Valid as M1.** Ultra never had a separate Argon bucket; the wrong row is Fei's Pro figure, now stale | Same rule and anchor as Carbon, on all three plans; drop Fei's Pro × Argon row; remove Argon after 2026-11-30 (retired) | Ultra 5x / 20x: 24.0 / 48.0 → 21.3 / 37.3. Pro: 1.40 → 18.9. Argon high on Pro: $7.09 → $0.53 |
| Kimi Plus / Pro / Max / Ultra: K3 → K3.1 Pro | **Wrong factor, right anchor.** The pool was measured on K3.1 Pro tokens | token-denominated rule: `× blend(K3.1 Pro) / blend(K3)` = × 0.294 / 0.441 = × 0.667; level = the K3 row's level, no model step | Max 8.45 → 5.64, Plus 4.53 → 3.02, Pro 11.0 → 7.33, Ultra 8.41 → 5.61. K3.1 Pro max on Kimi Max: $0.435 → $0.653 |
| ChatGPT Pro 10x → 20x (GPT-6 Sol, Luna) | **Valid as P1; dormant** [verified: Priors already supplies both rows, so the rule never fires] | delete the rule, or keep it as P1 with σ 0.25 | none |

**Argon** [agent]:

- Oct 15, @antigravity (official): "We've rolled out a separate weekly-only Argon quota for Pro on top of the existing Gemini bucket for 3.8 Flash" (https://api.fxtwitter.com/status/2110866531932316011; forum copy https://discuss.ai.google.dev/t/gemini-4-argon-ultra/188901).
- Ultra: the quota API's own group description, captured in tddworks/ClaudeBar PR #591 (2026-10-20): "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans."
- Nov 23, Varun Mohan (Antigravity lead, personal account, fxtwitter status 2124971131312734707): "we're also getting rid of the separate Argon bucket for paid Pro users. The capacity from that is moving to the general Gemini bucket". Confirmed by two community measurements on agy 1.5.16 (https://dev.to/wassim-azi/antigravity-cli-on-google-ai-pro-argon-now-shares-the-gemini-quota-3omm; aqua5230/usage PR #421).
- https://antigravity.google/docs/models: Argon and 3.8 Flash are "leaving on November 30, 2026".
- No official Argon multiplier for Ultra was found.

**Is "drawn down according to API pricing" contradicted by Argon's 1.4×?** No. The blog sentence [agent, https://antigravity.google/blog/changes-to-antigravity-plans, May 19] describes the shared Gemini bucket: "combining these into a single rate limit, drawn down according to API pricing"; the only exception it lists is non-Gemini models. Argon on Pro sat in a separate bucket from Oct 15 to Nov 23, so 1.4× measured the size of that bucket, not a different draw rate. Supporting measurements for price-proportional draw inside the bucket: Priors' Flash controls at 1.00× parity with Neon; Hydrogen at 0.165–0.166% of the pool per dollar against Flash 0.167% [Priors source]. The lesson for the model: a carried row needs the pool identity recorded (`pool: "gemini"`), and a bucket change is a quota-change event that caps older rows (§1.4).

Carbon and Hydrogen on Pro date from Nov 23 (Varun Mohan, fxtwitter status 2124960419429458207); Carbon on Ultra from Nov 10 (blog.google). Rows for Pro × Carbon before Nov 23 would have been wrong.

Kimi [agent, https://www.kimi.com/code/docs/kimi-code/models]: no K3.1 Pro multiplier relative to K3 is published; the pool is weighted by model ("`k3`（1M）消耗约为 `k3-256k` 两倍"; HighSpeed "2 倍消耗"). List prices [agent, platform.kimi.ai]: K3.1 Pro $2 / $10 / $0.20, K3 $3 / $15 / $0.30. Because the sample was K3.1 Pro traffic, the K3.1 Pro value needs no weight assumption; the K3 rows do, and should carry M3.

ChatGPT [agent]: the current help page gives no 10x or 20x figures ("Pro 200 includes more usage than Pro 100"; "Pro 100 and Pro 500 now include twice their previous Work and Codex allowance. On Pro 200, only the lower allowance doubled", https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers). Fei #97 measured a Pro $200 week at 4.1–4.2× a Pro $100 week before that change. "Pro 20x = 2 × Pro 10x" is not established; any 10x ↔ 20x transfer is P2 (0.35), and the identical Priors multiples on the two tiers should carry it.

Claude [agent, https://claude.com/pricing]: Max 5x is "5x Pro usage" per 5h and per week; Ultra is "10x Pro usage" every week. So Max ↔ Ultra is an official 2× (P1), and official text predicts equal multiples on Pro, Max and Ultra. Measured for Opus 5.5: 63.8 / 76.8 / 66.1.

**Parser fixes that remove the need for most placeholders** [verified]:

1. Read Priors records with `plans: []`: when `details.ratio` is present, `multiple = 1 / ratio` for `details.plan`; when `details.sameAs` is present, emit one row per plan of the `sameAs` model with step M1 or M4 by vendor; read `details.readings` into `subsidyReadings`; read `details.paid` when the top record is a free tier.
2. Replace "preliminary always wins" with "lower σ wins; within 2σ pool both" (§1.3).
3. Carry tokens, not multiples, for token-denominated plans (Kimi, MiniMax, official token tables).

### 3.2 Fable 5.2's 50% weekly cap

Official text [agent]:

- https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan: "You can use up to 50% of your weekly usage limits on Fable models at no extra cost." "They draw from your plan's regular weekly usage limits and use them faster than other Claude models." "your use of other models draws from the same usage limits". A sub-cap inside the shared weekly limit. No multiplier is published.
- Same page: on Pro, "Fable models aren't included in your plan's usage limits". Launch offer Nov 9–16: Pro got Fable up to 50% (https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers).
- https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan: Ultra has "a separate weekly limit for Fable". This conflicts with "draw from your plan's regular weekly usage limits"; see open question 12.

Numbers [agent, Theo's tweet images via https://api.fxtwitter.com/status/2119960608816988596; one Max 20x account, 1.1M requests]: a full week of Opus 5.5 is $3,421 of API value ($34.2 per 1%); Fable 5.2 reaches its cap at $705 for 50% ($14.1 per 1%). A Fable dollar uses 2.43× as much of the week. Priors' note text has the two figures swapped; its 2.43 is right. Fei's Pro sample gives 2.53 [verified from Fei: $1.259 vs $3.191 per weekly pp].

Consequence for rows: **Claude Pro × Fable 5.2 must go** (offer ended Nov 16; keep the sample only as the second measurement of the Fable / Opus ratio). `promo_until` in Fei is empty for this row, so the site needs its own expiry list.

| Reading | Definition | Ultra multiple | Max multiple | Fable 5.2 max, real $/task (Ultra) |
|---|---|---|---|---|
| Shared | `S(Opus 5.5, p) ÷ 2.43` | 27.2× | 31.0× | $0.98 |
| Fable only | shared ÷ 2 (other half of the week unused) | 13.6× | 15.5× | $1.95 |

**Recommendation: Shared is the default for cost; the cap always applies to volume.**

- Real cost is a rate: what one task removes from the pool, priced at what the pool cost. The half of the week Fable cannot use is still usable by Opus and Sonnet, so charging it to Fable prices a waste that a full-use subscriber does not incur. The site's definition is "at full use" of the plan, not of one model.
- `Tasks/mo` is a capacity. It must use the cap: `tasksPerMonth = capShare × fee × S_shared / apiCost`, with `capShare = 0.5` for Fable. Today the column would overstate Fable volume by 2×.
- The `Fable cap` setting switches the cost to the "Fable only" reading for a reader who uses nothing else. Priors exposes the same two readings with Shared as default [Priors `details.readings`].
- Data: `capShare` per plan × model (0.5 for Fable 5.x on Pro, Max, Ultra; 1 elsewhere), `subsidyReadings: { shared, own }`.
- Fei's `claude_pro::claude-fable-5.2` (25.2× on the site) is a Shared reading ("50% 周帽不套"). Fei's Fable 5 and 5.1 rows on Max are Fable-only readings ("157×50%÷4.54"). The site mixes both today; tag each row with its reading and convert (× 2 or ÷ 2) to the active one.

### 3.3 Claude quota token weighting

Verification status of the claim "cache reads count at about 0.5× API price; input and output at parity" [agent, via `gh` on Fei-Craft/real-api-pricing, the repo's new home, and fxtwitter]:

- Official: @ClaudeDevs, Sep 1 2026: "In Claude Code, cache reads count at a reduced rate toward subscription usage" (https://api.fxtwitter.com/status/2094851235694497836). https://support.claude.com/en/articles/9797557-usage-limit-best-practices: cached project content "counts less against your limits when reused". No number anywhere.
- Fei #98 (Max 5x, Opus 5.5, headless `claude -p`, one 5h window): list dollars per 1% of the window: text input $0.677, output $0.680, images $0.653, cached group $1.247. Input and output are at parity. Implied cache-read weight relative to the $0.20 API price: 31% if 1h writes count at $8, 50% at $5, 56% at $4, 81% if writes are free. **Confirmed as stated, with the range.**
- Fei #96 (Max 20x, 314 weekly points): R² 0.935 at API price, 0.931 with cache reads free, 0.800 on raw tokens. Rules out raw-token counting; cannot separate the other two.
- Fei #124 (Pro, 99% cache reads): $12.66 per weekly pp, 3.96× the adopted #52 figure. Unexplained; a lower cache-read weight alone does not cover it.
- anthropics/claude-code #45756: first fit 0× (1,500 calls), revised to about 0.1× the input rate (16,531 calls, 57 windows), which was the full API read price for that model. This disagrees with 0.5 and is why the range must reach 1.0.
- anthropics/claude-code #97074 and #111890: headless `-p` uses 1.8–2.0× more of the 5h window per token than interactive. Fei #98 ran headless, so its absolute $ per 1% may carry that factor; the ratios between its groups do not.

Verdict: direction confirmed by Anthropic; magnitude 0.3–1.0 of API read price, 0.5 central; cache-write treatment unresolved.

**Formula.** For a token mix with list dollars `$_k` per kind k:

```
φ(mix) = Σ_k w_k · $_k / Σ_k $_k
w = { freshInput: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 0.625, cacheRead: 0.5 }     # central
scenarios consistent with Fei #98:  (cacheRead, cacheWrite1h) = (0.31, 1.0), (0.50, 0.625), (0.56, 0.5), (0.81, 0)

S_eff(row, metric) = S_row × φ(sample mix of the row) / φ(metric mix of the model)
```

`S_row` is list dollars of the sample's own mix per fee dollar (that is what the site's own-mix path already computes), so the numerator must use the sample's mix, not Fei's 97 / 2.5 / 0.5 convention.

**Inputs and where they come from** [verified]:

| Input | Source | State |
|---|---|---|
| Sample mix per Fei row | `decision_note`: "段 worth $X（读 A×$p＋1h写 B×$p＋入 C×$p＋出 D×$p）"; newer `data/research/*.json` have `samples[].tokens` | parseable; fallback = the row's workload mix |
| AA Intelligence mix | `aaCostPerTaskBreakdown` (`cacheRead`, `cacheWrite`, `nonCacheInput`, `output`) | only the 26 headline variants; use the model's headline mix for its other efforts |
| T3 mix | Priors `t3-cost-per-turn` `details.perTurn` {fresh, cached, written, output} | present in Priors for every variant; the site drops it; add `t3Turn.perTurn` |
| AA Coding Agent mix | not published | use the T3 mix of the same model as proxy |
| CursorBench mix | `tokensPerTask` only | no correction; W1 0.15 |

**Values** [verified, central weights; range over the four scenarios]:

| Mix | Read / write / output share of $ | φ |
|---|---|---|
| Fei Max 5x × Opus 5.5 sample | 71 / 12 (1h) / 16 | 0.60 (0.51–0.74) |
| Fei Pro × Opus 5.5 (maintainer window) | 69 / 12 / 19 | 0.65 |
| Fei Pro × Fable 5.2 sample (44 requests) | 21 / 51 (1h) / 27 | 0.70 (0.45–0.85) |
| AA Intelligence, Opus 5.5 max | 47 / 18 / 35 | 0.76 (0.67–0.76) |
| AA Intelligence, Fable 5.2 max | 32 / 27 / 41 | 0.84 (0.67–0.84) |
| T3, Opus 5.5 (all efforts) | 56–59 / 21–29 / 15–22 | 0.71–0.72 |
| T3, Fable 5.2 | 34–38 / 28–41 / 25–34 | 0.81–0.83 |

**Expected effect on Claude rows:**

| Row | Metric | S factor | Real cost change | Range of the factor |
|---|---|---|---|---|
| Max × Opus 5.5 | AA Intelligence | × 0.78 | +28% | 0.75–1.01 |
| Max × Opus 5.5 | T3 turn | × 0.84 | +19% | 0.77–0.97 |
| Pro × Opus 5.5 | AA Intelligence | × 0.86 | +17% | — |
| Pro × Fable 5.2 | AA Intelligence | × 0.83 | +20% | 0.66–1.10 |
| Ultra × Fable 5.2 (Theo ratio, measured on T3-like usage) | AA Intelligence | × 0.97 | +3% | — |

This replaces the × 0.55 (+80%) figure in `quota-token-weights.md`, which assumed a no-cache workload. The cross-checks there (5h cached vs no-cache 0.545; weekly 0.43) are correct for a workload with no cache at all; no benchmark on the site is one.

**Other vendors:**

- OpenAI [agent, Fei #97]: per-kind burn follows the credit rate card (input 1.00, cached 1.02, output 1.08 on GPT-6 Astra; 1.34 / 1.33 / 1.52 on GPT-6.1 Sol). No per-mix correction. A per-model factor exists (GPT-6.1 Sol 1.33×); that is step M2, not a mix effect.
- Google: official text says price-proportional. New weak evidence against [verified from Priors and Fei notes]: on Ultra 20x an uncached Neon probe implies $2,402 per week, 88%-cached real usage $1,752 (×1.37); on Pro $105 vs $85.5 (×1.23), while a second Pro user at 94.7% cache gives $102.7. Direction: cached usage buys fewer list dollars, the opposite of Claude. No correction yet; W1 0.15 and a request for a #97-style single-kind run.
- Cursor, Copilot, GLM: official per-kind rates (GLM formula and multipliers at https://docs.z.ai/devpack/overview [agent]). None.
- xAI, Kimi, MiniMax: no weight table or per-kind test found [agent]. W1 0.15.

### 3.4 T3 Code $/turn

[verified from `combined.json`: variants with a measured AA Coding Agent run in the plan's harness and a T3 figure]

| Harness | n | T3 $/turn ÷ AA agent $/task (median) | sd of ln | T3 min/turn | AA min/task | T3 $/min ÷ AA $/min |
|---|---|---|---|---|---|---|
| Codex | 14 | 0.68 | 0.22 | 6.3 | 16.2 | 1.68 |
| Claude Code | 9 | 0.16 | 0.63 | 6.8 | 53.2 | 1.29 |
| Antigravity | 4 | 0.19 | 0.41 | 7.0 | 32.8 | 0.77 |

Reading [inferred from the table]:

- The 4.1× gap between Codex and Claude Code is mostly on the AA side. T3 turns last about the same in both harnesses (6.3 vs 6.8 minutes on these variants; 11.8 vs 7.3 at max effort only). AA's tasks take 3.3× longer in Claude Code than in Codex. `combined-metric-design.md` §2b agrees: against Ramp's own-harness runs the T3 ratio is the same for OpenAI and Anthropic (0.49 vs 0.43, n=13).
- So "turn size differs 4× by harness" is not established. Turn size differs by about 1.4–1.6×; the rest is AA Coding Agent's Claude Code runs being long.

Options:

| Option | Formula | For | Against |
|---|---|---|---|
| $/minute | `t3 $/turn ÷ min/turn` | harness gap falls from 4.1× to 1.3× (Codex vs Claude Code) | a rate, not work: a model that finishes the same work in half the time looks twice as expensive |
| Harness-normalized | `t3 $/turn ÷ r_h`, r_h from the table | puts T3 on the AA task scale | imports AA's Claude Code asymmetry into T3; r_h has sd 0.22–0.63 and n ≤ 14; T3 stops being independent evidence |
| Within-harness only | rank by $/turn inside one harness | no assumption | no cross-vendor ranking |

**Recommendation:**

1. Keep `Per T3 Code turn` as a cost metric with the raw $/turn. Do not normalize by harness.
2. Grade it: T3 has no success measure and no fixed task, so a cross-harness comparison carries σ 0.35 (the 1.4–1.6× turn-size spread); a same-harness comparison carries only the sample-size term. In practice: in T3 mode every row is at best Medium unless a harness filter is active.
3. Add `Hours/mo` in T3 mode in place of `Tasks/mo`: `fee × S / ($/turn ÷ min/turn × 60)`. This is the one place $/minute is the right quantity: how long the plan lasts at T3's observed burn rate.
4. Emit `stats.t3Harness = { harness: { n, ratio, sdLn, minPerTurn } }` and test its drift (§5).

**Priors' default** [agent, read in the clone at `959654f`, not on the web]: `src/engine/index.ts` `computeIndex` multiplies the cost by the plan ratio (`cost.usd *= plan.aaCostRatio ?? plan.ratio`); `defaultCostSource` in `src/data/task-metrics.ts` is `t3-code` once T3 has per-effort costs for at least 5 models. The axis reads "Subscription cost per task ($, log)". So Priors' headline "cost per task" is T3 $/turn × the plan's share of API price: a turn, labelled a task.

What the site should do differently:

- Keep the unit in the label: `Per T3 Code turn`, column `Real $/turn`. Never show a T3 figure under a "task" heading.
- Do not compare Priors' "cost per task" with this site's `Real $/task` in copy or tests; they differ by the turn/task factor (0.16–0.68 by harness).
- Priors drops `low` rows when a better row exists and skips models with only low rows. The proposed `Min confidence` does the same job with the reader in control.

### 3.5 Opus 5 and the cross-plan consistency test

**The inconsistency** [verified]:

| | Pro | Max (5x) | Ultra (20x) |
|---|---|---|---|
| Opus 5 | 99.2× (high; 2 accounts, 148 pp, Sept 14–22) | 57.8× (medium; Ultra ÷ 2 by ruling) | 57.8× (medium; August, mixed-model sample, re-based from a promo pool, raw tokens) |
| Opus 5.5 | 63.8× (high) | 76.8× (medium; 1 screenshot, 19 pp) | 66.1× (medium) |
| Opus 5 ÷ Opus 5.5 | 1.55 | 0.75 | 0.87 |

Fei flags it in the Pro row's own note: "张力：与 Max 20x 采用值 157 的比从 8.35× 变为 5.68×，与 Opus 5.5 的 … ≈9.9× 不一致 … 待裁定". Two things are wrong at once: the ratio moves by ×1.8–2.1 across plans, and on Pro Opus 5 gets 1.55× the list dollars of Opus 5.5 although Fei measured the pool weight at the price ratio (0.520 vs 0.514).

**Test T-quad (ratio stability).** For a plan family F (one seller's ladder with the same quota mechanics: Claude Pro / Max / Ultra; ChatGPT Plus / Pro 10x / Pro 20x; Google AI Pro / Ultra 5x / Ultra 20x; Kimi; SuperGrok; Cursor), models a, b and plans p, q with all four cells present:

```
D = ln[S(a,p) / S(b,p)] − ln[S(a,q) / S(b,q)]
informative ⇔ at least 3 of the 4 cells are not derived from another cell of the quad
z = |D| / sqrt(σ_ap² + σ_bp² + σ_aq² + σ_bq²)
```

| |D| | Verdict | Action |
|---|---|---|
| ≤ ln 1.3 (0.26) | pass | none |
| ln 1.3 – ln 1.6 | warn | listed in the refresh log and `stats.consistency` |
| > ln 1.6 (0.47), or z > 2 | fail | the cell with the largest σ (ties: oldest data date) gets `|D| / 2` added in quadrature and the flag `inconsistent` |

Calibration [verified]: of 491 quads in Fei's families, 430 are identical by construction (derived cells), and 7 are informative with one workload convention; their |D| is ×1.02, 1.05, 1.14, 1.16, 1.16, 1.20, 1.25. The Opus 5 / Opus 5.5 quads are ×1.71 (Pro vs Ultra, all four sampled) and ×1.99 (Pro vs Max). Fable 5.2 / Opus 5.5, Pro vs Ultra (Fei vs Theo): ×1.04.

**Test T-pool (price proportionality).** Where a vendor is price-proportional (M1 families, and Claude's Opus / Sonnet line), two measured models on one plan should have equal multiples: flag `|ln S(a,p) / S(b,p)| > ln 1.3`. Models with a declared weight or cap (Fable) are exempt and must carry that weight in `capShare` / `poolWeight`.

**What to do with Opus 5 now.** Keep Fei's values; the fail verdict adds 0.36 to Opus 5 on Max and 0.29 on Ultra, which with T1 (data from August) puts both at Low (σ 0.66 and 0.58). The alternative values are 66× (price-proportional to Opus 5.5) and 103× (Pro ratio); the 80% range $0.09–0.48 covers both. Opus 5 on Pro stays High on its own evidence but fails T-pool against Opus 5.5 by ×1.55; flag it `inconsistent` at Medium. Report the quad to Fei (they already list it as pending).

### 3.6 Tweet and single-screenshot sources

Admiralty-style: grade who and what separately, then map to a starting σ.

| Source (who) | Information (what) | Start | σ |
|---|---|---|---|
| Unknown account | claim only, rounded % or "used it all" | S7 | 0.70 → Speculative |
| Unknown account | one screenshot of a third-party gateway or relay panel | S6 | 0.45 → Low |
| Unknown account | one screenshot of the vendor's own usage panel with tokens by kind and quota % | S5 | 0.35 → Medium, lower edge |
| Known account with a track record, large sample, no raw data (Theo, 1.1M requests) | figures in text | between S4 and S5 | 0.30 → Medium |

Upgrades (replace the start, do not subtract):

- Dollar closure: the panel's dollar figure equals tokens × list price within 3% → treat S6 as S5.
- A second independent source within ×1.25 → pool (§1.3); two S5 sources give σ 0.25.
- Maintainer reproduces on an own account → S4.

Downgrades are the add-ons in §1.2 A (reading resolution, promo period, attribution inferred, raw total).

Fei's own practice matches [verified]: of four tweet + screenshot samples, three are low and one medium; maintainer-local samples are medium or high.

**Starting level: Low**, Medium only with a first-party panel, a token breakdown and at least 15 pp of quota.

## 4. Data model changes

### 4.1 Fields

Per entry (small; computed at build):

```jsonc
"rel": {
  "s": 0.43,                 // σ of ln subsidy
  "c": { "task": 0.05, "agent": 0.16, "turn": 0.10, "cursor": 0.10, "tokens": 0.03 },
  "score": { "intelligenceIndex": 0, "codingAgentIndex": 1.4 },   // ± pts
  "chain": "c0412",          // key into stats.chains (shared by all efforts of a base row)
  "flags": ["inconsistent"]  // stale | inconsistent | capped | pooled | unresolved
},
"capShare": 0.5,             // share of the pool this model may use; 1 if absent
"subsidyReadings": { "shared": 27.2, "own": 13.6 },   // only where they differ
"sampleMix": { "cacheRead": 0.71, "cacheWrite1h": 0.12, "cacheWrite5m": 0, "input": 0, "output": 0.16 },  // $ shares
"t3Turn": { "...": "...", "perTurn": { "fresh": 3869, "cached": 5888269, "written": 85099, "output": 22415 } }
```

`stats.chains[id]` (one per base row, about 634), PROV vocabulary [agent, https://www.w3.org/TR/prov-o/]:

```jsonc
{
  "entity": "claude_max_5x::claude-fable-5.2",
  "value": 31.0,
  "steps": [
    { "activity": "sample",        "kind": "S5", "sigma": 0.35,
      "wasAttributedTo": "fei2411", "entity": "claude_max_5x::claude-opus-5.5",
      "hadPrimarySource": "data/research/claude-max5x-opus55-round1-2026-10-03.json",
      "n": 1, "pp": 19, "date": "2026-10-03" },
    { "activity": "ratio-transfer", "kind": "X1", "sigma": 0.15, "factor": 0.403,
      "wasDerivedFrom": ["claude_pro::claude-fable-5.2", "claude_pro::claude-opus-5.5", "priors::claude-ultra::claude-fable-5.2"],
      "wasAttributedTo": "ai-plan-value" }
  ]
}
```

`stats.reliability`: the σ table in force, the level thresholds, level counts, `consistency` (every warn and fail quad), `t3Harness`.

`confidence`, `isPreliminary`, `estimateType`, `estimateConfidence`, `codingAgent.confidence` stay for one schema version, then go. `origin` stays.

Client: `σ = sqrt(rel.s² + rel.c[mode]²)`, level from thresholds and `rel.score[bench]`, range from σ. No chain logic in the client.

### 4.2 Parsing Fei

Order of trust: structured fields, then fixed-pattern text, then keyword flags, then the upstream grade as floor.

1. **Structured** (`data/adopted.csv` or `derived/points.csv`): `data_date_kind` → `sample` / `official` / `derived`; `data_date_from` → anchor (`"<plan> · <model>"`, `、`-separated when two); `confidence`; `workload` (`measured` = raw tokens, add-on 0.10); `data_date` → T1; `promo_until`.
2. **Derived rows, `source`**:
   - `^由同套餐 (\S+) ([\d.]+) 亿 × ([\d.]+)` → same plan, other model, ratio r: r = 1 → M1 (σ 0.15); model is Fable → weight ruled (0.45); r > 5 or < 0.2 → M3 far (0.45); else M3 (0.25), or M1 where the vendor is price-proportional.
   - `官方` with `倍率|worth|\d+/\d+|为.*的\d倍` → P1.
   - `裁定|周池` without an official ratio → P2.
   - `由 .* 共享周池` → M1 on a dollar pool (Devin Max).
   - `同 .* 额度` → cross-region carry, P2.
3. **Sample rows, `source` + `decision_note`**:
   - channel: `issue #\d+`, `维护者(本机|本地|实测|提供样本)`, `X @|推文`, `截图`, `Reddit|V2EX|Zenn`, `第三方|网关|relay`, `口述`.
   - quota used: `周[^，；]*?\+?([\d.]+)\s*(pp|个百分点)`, `(\d+)%\s*→\s*(\d+)%`.
   - dollars by kind: `(读|1h\s*写|写|入|出)\s*([\d.,]+)\s*([KMB]?)\s*×\s*\$([\d.]+)` → `sampleMix`.
   - n: `n\s*=\s*1|单账号|单一`; accounts: `两个 .* 账号`.
4. **Flags from keywords** (any field): `派生|推算|外推|非实测|非独立实测|借|沿用|继承|假设` → the row must have resolved to a derived chain, else `unresolved`; `张力|矛盾|不一致|待裁定|待复核` → `inconsistent` candidate (checked against T-quad); `促销|活动期` → promo add-on; `未折算` → raw add-on.
5. **Floor**: σ ≥ 0.08 / 0.18 / 0.40 for Fei high / medium / low.
6. **Guard**: a derived row whose anchor does not resolve, or a row with a step keyword and no parsed step, is logged and counted in `stats.reliability.unresolved`; the build fails above a threshold (§5).

Priors: `details.confidence` (`preliminary` with `preliminary.samples` → S6 at n=1, σ / √n above; label `Extrapolated from …` → P1; `assumed` + `sameAs` → M1, M2 or M4 by vendor), `details.ratio`, `details.readings`, `details.dataDate`. Rows mirrored from Fei (`sourceUrl` realapipricing.com) take the Fei chain of the matching row.

## 5. Tests to add (`scripts/test-site.mjs`)

| Test | Assertion |
|---|---|
| rel present | every entry has finite `rel.s ≥ 0`, `rel.c[mode]` for each mode it has a cost in, and a `rel.chain` that exists in `stats.chains` |
| chain arithmetic | `rel.s² = Σ step σ²` (± 1e-6) plus cap adjustments listed in `flags` |
| monotone | appending any step never lowers σ; a derived row's σ ≥ its anchor's σ |
| floor | no Fei or Priors row has a level above its upstream `confidence` |
| no silent carry | every row whose subsidy equals another row's subsidy on the same plan, or the same model's on a sibling plan × a constant, has at least one transfer step |
| M4 hidden | every row with an M4 or M5 step is Speculative |
| direct beats derived | no plan × model has both a sample row and a carried row in the output; no `replacesId` points from a higher-σ row to a lower-σ row |
| Priors coverage | every `subscription-token-price` observation yields ≥ 1 row or is listed in `stats.priorsSkipped` with a reason; `plans: []` with `ratio` or `sameAs` is not a reason |
| T-quad | `stats.consistency` lists every informative quad; no quad with `|D| > ln 1.6` lacks the `inconsistent` flag; the count of fails ≤ last deploy + 2 |
| T-pool | on M1 families, measured same-plan models differ by ≤ ×1.3 or are flagged |
| cap | Fable rows on Claude Pro / Max / Ultra have `capShare = 0.5` and both `subsidyReadings`; `own = shared × capShare` ± 1%; `Tasks/mo` uses `capShare` in both readings |
| token-denominated | Kimi K3.1 Pro multiple = K3 multiple × blend ratio ± 1% on every plan |
| mix correction | for Claude rows, `S_eff / S` is within 0.6–1.15 for every metric; equals 1 for OpenAI, Cursor, Copilot rows; φ of a pure-output mix is 1 |
| AA mix | every headline AA variant's breakdown sums to `total` ± 1%; cache-read share is reported in stats |
| T3 harness | `stats.t3Harness` has Codex and Claude Code with n ≥ 5; each ratio within ×1.5 of the previous deploy |
| stale | no row older than 90 days is High; no row predating a listed quota change is above Speculative unless re-based |
| parser coverage | ≥ 95% of Fei `derived` rows resolve an anchor; 0 rows contain `派生|推算|外推|非实测|借` without a transfer step |
| level counts | Speculative ≤ 8% of entries; High ≥ 30% (alerts, not hard failures) |
| calibration | for every step type, the RMS of ln(derived ÷ later direct value) over recorded replacements is within ×1.5 of the table σ; the list of replacements is appended at each refresh |
| UI | `Min confidence` hides exactly the rows below the level; `conf=` round-trips; legacy `est=` maps as specified; no `*` or `●` in rendered rows; `Range` cells match `cost × exp(±1.2816σ)` |

## 6. Open questions, each with a recommended answer

1. **Default `Min confidence`: Low or Medium?** Low. It hides only Speculative, which is what was asked for. It newly shows about 580 two- and three-step effort extrapolations that today's defaults hide; they are faded and marked ○. If that is too noisy, Medium shows 1,775 rows against today's 1,888.
2. **Should the "Best" cards obey the setting?** No: fix them at Medium or better, so a headline never rests on a Low row.
3. **Rank on the point value or a conservative bound?** Point value. A `Sort: Worst case` option (`cost × exp(1.28σ)`) can follow once the σ table has been live for a few refreshes.
4. **Fable cap default.** Shared for cost, cap always applied to volume (§3.2).
5. **Mix correction: ship now with the central weights, or wait for a cache-write experiment?** Ship now. The correction is +17–28% with a known sign, and W1 carries the range. Ask Fei for the #98 design with separate 5m and 1h write groups; it would cut the range to a few percent.
6. **Neon anchor: Fei direct, Priors preliminary, or pooled?** Pooled by 1/σ² (§1.3): the two agree within 2σ on every plan. Fei alone if a single source is preferred.
7. **Drop M4 placeholders entirely?** Keep them as Speculative and hidden. They are useful on launch day for a new model and disappear from the default view without code changes.
8. **Level names.** High / Medium / Low / Speculative, each defined by its ×factor in the methodology table.
9. **Calibrate σ per vendor?** Not yet: n per step type is 2–7. Record every "derived value later measured" pair in `stats.reliability.calibration` and refit the table when a step type reaches n ≥ 15.
10. **Age penalty thresholds (45 / 90 days).** Keep as proposed; they are the least supported numbers in the table. Priors' `planResets` and Fei's `DECISIONS.md` dates can replace them with "known change since the data date" once parsed.
11. **Tell Fei and Priors?** Yes. Fei: the Opus 5 quad, the stale Pro × Argon row, the expired Pro × Fable 5.2 offer. Priors: the swapped $34.2 / $14.1 in the Fable note; and confirm the `plans: []` + `ratio` / `sameAs` / `readings` shape is stable before the parser depends on it.
12. **Does Ultra have a separate Fable weekly limit?** The Ultra help page says so; the Fable help page says Fable draws from the regular weekly limit. If separate, using Fable costs no Opus quota and "Shared" has no meaning on Ultra: the cost should then be fee ÷ (Fable pool + other pool) allocated by use, which the site cannot compute per row. Recommended: keep Shared as default, tag Ultra × Fable `capped`, and settle it with one reading of an Ultra usage panel (is there a second weekly bar that moves alone?).
13. **Promotions.** Add a site-side expiry list (`plan`, `model`, `until`) checked at build, since Fei's `promo_until` missed the Pro Fable offer. Expired rows are dropped, not downgraded.

## 7. Verification ledger

**Computed or read by me in this session:** every count and multiple from `combined.json`; Fei rows, notes and `data_date_kind` fields; the Priors records with `plans: []`; AA and T3 dollar splits and φ values; the T3 vs AA Coding Agent table; the consistency quads; the level simulation; the calibration ratios in §1.2 (from figures quoted in Fei notes and Priors notes).

**Fetched by research subagents in this session (URLs inline):** GRADE handbook; Cochrane ch. 8 and 14; IPCC guidance note (Berkeley mirror; ipcc.ch returned 403); W3C PROV-O / PROV-DM; ecoinvent data quality guideline and Ciroth 2012; GUM; Epoch AI estimation page; MacEachren 2012; Padilla, Kay, Hullman; 538 pollster ratings (ABC copy); Vals AI, SWE-bench, Epoch Benchmarking Hub methodology; Antigravity blog, docs and tweets; Google forum post; Anthropic help pages and pricing; @ClaudeDevs post; Theo's tweet and images; Fei issues #96, #97, #98, #124; claude-code issues #45756, #58786, #97074, #111890; Kimi docs and price page; OpenAI help page; GLM weight table.

**Not verified:** STANAG 2511 primary text (tables via an arXiv paper); PDG scale factor (from memory); Ciroth et al. 2016 final table; OWID written policy (behaviour read from owid-grapher code); Priors' engine code beyond the clone; the agy sentence "consumed proportionally to the cost of the tokens" (Priors source only); Fei's Pro $100 "10x" ruling; whether Ultra's Fable limit is separate.

**Inferred:** every σ in §1.2 (priors, with the calibration shown); the level thresholds; the 0.5 central cache-read weight and 0.625 for 1h writes; the reading that the T3 / AA gap is mostly on the AA side; the Shared-default recommendation.

**Other practice surveyed, not adopted** [agent]: 538 combines measured error with a transparency score into stars; SWE-bench marks independently re-run submissions; Epoch separates internal from external runs and shows error bars only on its own; Vals pools variance across components and states what its error bars omit; Artificial Analysis publishes no intervals and no self-reported flag. Our World in Data draws projected series dashed with a "projected data" tooltip. The common pattern is a binary "who ran it" flag plus an interval where one can be computed, which is what `~` plus the graded glyph reproduce.

**Tools noticed:** `api.fxtwitter.com/status/<id>` returns tweet text and images when x.com is blocked; `claude-code-cache-fix` (npm) has `tools/quota-analysis.mjs`, which fits cache-read weights from per-call 5h-quota logs and could turn the 0.3–1.0 range into a point value from the maintainer's own logs.
