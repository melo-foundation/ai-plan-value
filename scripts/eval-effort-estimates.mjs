#!/usr/bin/env node
/**
 * Leave-one-out cross-validation (LOOCV) of effort interpolation (†) and
 * extrapolation (‡) accuracy by degree of separation, against real Artificial
 * Analysis measurements in public/data/combined.json (and live ARC-AGI-2).
 *
 * Pass --write-doc to regenerate docs/EFFORT-ESTIMATES.md.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_PATH = path.join(ROOT_DIR, "public", "data", "combined.json");
const DOC_PATH = path.join(ROOT_DIR, "docs", "EFFORT-ESTIMATES.md");
const ORDERED = ["none", "low", "medium", "high", "xhigh", "max"];
const WRITE_DOC = process.argv.includes("--write-doc");
const UA = "ai-plan-value-eval/1.0";

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (pos - lo) * (s[hi] - s[lo]);
}
const median = (arr) => quantile(arr, 0.5);
const fmt = (n, d = 1) => (n == null ? "—" : n.toFixed(d));
const logitProb = (p) => {
  const c = Math.max(0.005, Math.min(0.995, p));
  return Math.log(c / (1 - c));
};
const sigmoidProb = (x) => 1 / (1 + Math.exp(-x));

function normSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^[a-z0-9_-]+\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function canonicalModelFamily(slug, creatorName) {
  const s = `${slug || ""} ${creatorName || ""}`.toLowerCase();
  if (/\bclaude\b|anthropic/.test(s)) return "anthropic";
  if (/\bgpt\b|\bo1\b|\bo3\b|\bo4\b|openai/.test(s)) return "openai";
  if (/\bgemini\b|\bgemma\b|\bgoogle\b/.test(s)) return "google";
  if (/\bgrok\b|\bxai\b|spacexai/.test(s)) return "xai";
  if (/deepseek/.test(s)) return "deepseek";
  if (/\bqwen|alibaba/.test(s)) return "alibaba";
  if (/\bglm\b|zhipu|\bz[\s-]?ai\b/.test(s)) return "zhipu";
  if (/\bkimi\b|moonshot/.test(s)) return "moonshot";
  if (/mistral|devstral|codestral|pixtral|ministral/.test(s)) return "mistral";
  if (/\bllama\b|\bmeta\b/.test(s)) return "meta";
  if (/minimax/.test(s)) return "minimax";
  if (/\bstep[-\s]?\d|stepfun/.test(s)) return "stepfun";
  if (/\bmuse\b/.test(s)) return "muse";
  if (/hunyuan|tencent/.test(s)) return "tencent";
  if (/doubao|seed|bytedance/.test(s)) return "bytedance";
  const c = String(creatorName || "").toLowerCase().trim();
  return c || null;
}

function extractArcEffort(rawName) {
  const s = String(rawName || "").toLowerCase();
  if (/\b(?:xhigh|extra[-_\s]?high)\b/.test(s)) return "xhigh";
  if (/\b(?:max|maximum)\b/.test(s)) return "max";
  if (/\b(?:non[-_\s]?reasoning|no[-_\s]?thinking|thinking[-_\s]?off|effort[=:\s_-]*none|\(none\))\b/.test(s)) {
    return "none";
  }
  if (/\b(?:low|minimal)\b/.test(s)) return "low";
  if (/\b(?:medium|med)\b/.test(s)) return "medium";
  if (/\bhigh\b/.test(s)) return "high";
  return null;
}

function confidenceRating(intelMed, costMed) {
  if (intelMed == null || costMed == null) return "—";
  if (intelMed <= 1.5 && costMed <= 15) return "High";
  if (intelMed <= 2.5 && costMed <= 20) return "Medium-High";
  if (intelMed <= 4.0 && costMed <= 35) return "Medium";
  if (intelMed <= 6.5 && costMed <= 50) return "Low";
  return "Very Low";
}

function summarize(intelArr, costArr) {
  const iMed = median(intelArr);
  const iP75 = quantile(intelArr, 0.75);
  const cMed = median(costArr);
  const cP75 = quantile(costArr, 0.75);
  return {
    n: intelArr.length,
    iMed,
    iP75,
    cMed,
    cP75,
    tier: confidenceRating(iMed, cMed),
  };
}

const dataset = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));

// Deduplicate real measured variants by (baseModelId, effort)
const byModel = new Map();
for (const e of dataset.entries || []) {
  if (e.effortEstimate) continue;
  const idx = ORDERED.indexOf(e.effort);
  if (idx === -1) continue;
  if (!(e.intelligenceIndex > 0) || !(e.aaCostPerTaskUsd > 0)) continue;
  if (!byModel.has(e.baseModelId)) byModel.set(e.baseModelId, new Map());
  const effMap = byModel.get(e.baseModelId);
  if (!effMap.has(e.effort)) {
    effMap.set(e.effort, {
      baseModelId: e.baseModelId,
      effort: e.effort,
      idx,
      family: canonicalModelFamily(e.baseModelId, e.modelCreator),
      intel: e.intelligenceIndex,
      cost: e.aaCostPerTaskUsd,
    });
  }
}

function fitInterpCurves(excludeModel) {
  const stepI = Array.from({ length: ORDERED.length - 1 }, () => []);
  const stepC = Array.from({ length: ORDERED.length - 1 }, () => []);
  for (const [slug, effMap] of byModel.entries()) {
    if (slug === excludeModel) continue;
    for (let i = 0; i < ORDERED.length - 1; i++) {
      const a = effMap.get(ORDERED[i]);
      const b = effMap.get(ORDERED[i + 1]);
      if (!a || !b) continue;
      if (b.intel > a.intel) stepI[i].push(b.intel - a.intel);
      if (b.cost > a.cost) stepC[i].push(Math.log(b.cost / a.cost));
    }
  }
  const defI = [6.0, 5.0, 4.0, 2.5, 1.5];
  const defC = [0.6, 0.55, 0.5, 0.45, 0.45];
  const cumI = [0];
  const cumC = [0];
  for (let i = 0; i < ORDERED.length - 1; i++) {
    cumI.push(cumI[i] + Math.max(0.5, median(stepI[i]) ?? defI[i]));
    cumC.push(cumC[i] + Math.max(0.1, median(stepC[i]) ?? defC[i]));
  }
  return { cumI, cumC };
}

function fitFamilyRatios(excludeModel) {
  const fI = new Map();
  const fC = new Map();
  const fAllI = new Map();
  const fAllC = new Map();
  for (const [slug, effMap] of byModel.entries()) {
    if (slug === excludeModel) continue;
    for (let i = 0; i < ORDERED.length - 1; i++) {
      const a = effMap.get(ORDERED[i]);
      const b = effMap.get(ORDERED[i + 1]);
      if (!a || !b || !b.family) continue;
      const dI = b.intel - a.intel;
      const rC = b.cost / a.cost;
      if (dI >= 0 && dI <= 25) {
        if (!fI.has(b.family)) {
          fI.set(b.family, Array.from({ length: ORDERED.length - 1 }, () => []));
          fAllI.set(b.family, []);
        }
        fI.get(b.family)[i].push(dI);
        fAllI.get(b.family).push(dI);
      }
      if (rC >= 1.0 && rC <= 8.0) {
        if (!fC.has(b.family)) {
          fC.set(b.family, Array.from({ length: ORDERED.length - 1 }, () => []));
          fAllC.set(b.family, []);
        }
        fC.get(b.family)[i].push(rC);
        fAllC.get(b.family).push(rC);
      }
    }
  }
  return (family, idx, kind) => {
    if (!family) return null;
    const m = kind === "intel" ? fI : fC;
    const all = kind === "intel" ? fAllI : fAllC;
    const vals = m.has(family) ? m.get(family)[idx] : [];
    const any = all.get(family) || [];
    const raw = vals.length >= 1 ? median(vals) : any.length >= 1 ? median(any) : null;
    if (raw == null) return null;
    return kind === "intel" ? Math.max(0.2, Math.min(15, raw)) : Math.max(1.1, Math.min(4.0, raw));
  };
}

// 1. Bracketed interpolation (†) LOOCV
const interpI = [];
const interpC = [];
for (const [slug, effMap] of byModel.entries()) {
  const pts = [...effMap.values()].sort((a, b) => a.idx - b.idx);
  if (pts.length < 3) continue;
  const { cumI, cumC } = fitInterpCurves(slug);
  for (let p = 1; p < pts.length - 1; p++) {
    const t = pts[p], lo = pts[p - 1], hi = pts[p + 1];
    const tI = Math.max(0.15, Math.min(0.85, (cumI[t.idx] - cumI[lo.idx]) / (cumI[hi.idx] - cumI[lo.idx])));
    const tC = Math.max(0.15, Math.min(0.85, (cumC[t.idx] - cumC[lo.idx]) / (cumC[hi.idx] - cumC[lo.idx])));
    const predI = lo.intel + tI * (hi.intel - lo.intel);
    const predC = Math.exp(Math.log(lo.cost) + tC * (Math.log(hi.cost) - Math.log(lo.cost)));
    interpI.push(Math.abs(predI - t.intel));
    interpC.push((Math.abs(predC - t.cost) / t.cost) * 100);
  }
}

// 2. Same-family AA extrapolation (‡) by step distance (1, 2, 3, 4+)
const famByDist = {
  1: { i: [], c: [] },
  2: { i: [], c: [] },
  3: { i: [], c: [] },
  4: { i: [], c: [] },
};
for (const [slug, effMap] of byModel.entries()) {
  const pts = [...effMap.values()].sort((a, b) => a.idx - b.idx);
  if (pts.length < 2) continue;
  const fStep = fitFamilyRatios(slug);
  for (const target of pts) {
    for (const anchor of pts) {
      if (anchor.idx === target.idx) continue;
      const dist = Math.abs(target.idx - anchor.idx);
      const bucket = Math.min(4, dist);
      let dI = 0, mC = 1, bad = false;
      for (let i = Math.min(anchor.idx, target.idx); i < Math.max(anchor.idx, target.idx); i++) {
        const sI = fStep(target.family, i, "intel");
        const rC = fStep(target.family, i, "cost");
        if (sI == null || rC == null) { bad = true; break; }
        if (target.idx > anchor.idx) { dI += sI; mC *= rC; }
        else { dI -= sI; mC /= rC; }
      }
      if (bad) continue;
      const predI = Math.max(1, Math.min(95, anchor.intel + dI));
      const predC = Math.max(0.001, anchor.cost * mC);
      famByDist[bucket].i.push(Math.abs(predI - target.intel));
      famByDist[bucket].c.push((Math.abs(predC - target.cost) / target.cost) * 100);
    }
  }
}

// 3. ARC-AGI-2 (v2_Semi_Private) LOOCV: exact-model transfer AND same-family ARC transfer
const arcExactI = [], arcExactC = [];
const arcFamI = [], arcFamC = [];
try {
  const [eRes, mRes] = await Promise.all([
    fetch("https://arcprize.org/media/data/evaluations.json", { headers: { "user-agent": UA } }),
    fetch("https://arcprize.org/media/data/models.json", { headers: { "user-agent": UA } }),
  ]);
  if (eRes.ok && mRes.ok) {
    const evals = await eRes.json();
    const models = await mRes.json();
    const mMap = new Map((Array.isArray(models) ? models : Object.values(models)).map((m) => [m.id || m.modelId || m.slug, m]));
    const arcByBase = new Map();
    for (const r of Array.isArray(evals) ? evals : Object.values(evals)) {
      if ((r.datasetId || r.dataset) !== "v2_Semi_Private") continue;
      const m = mMap.get(r.modelId) || {};
      const label = m.displayName || m.name || r.modelId || "";
      const eff = extractArcEffort(r.modelId) || extractArcEffort(label) || extractArcEffort(m.reasoningEffort);
      if (!eff) continue;
      const stripped = normSlug(
        String(label || r.modelId)
          .replace(/\([^)]*(?:reasoning|thinking|effort|low|medium|high|xhigh|max|none|minimal|default)[^)]*\)/gi, " ")
          .replace(/[-_\s]+(?:xhigh|extra[-_\s]?high|high|medium|med|low|minimal|max|none|non[-_\s]?reasoning|thinking[-_\s]?\d+k?)\b/gi, " ")
          .replace(/\b202\d[-_]?\d{2}[-_]?\d{2}\b/g, " ")
      );
      const score = Number(r.score ?? r.accuracy);
      const cost = Number(r.costPerTask ?? r.cost_per_task ?? r.cost);
      if (!stripped || !Number.isFinite(score) || !(cost > 0)) continue;
      if (!arcByBase.has(stripped)) arcByBase.set(stripped, new Map());
      arcByBase.get(stripped).set(eff, { score, cost });
    }

    // Collect overlapping pairs for LOOCV slope fitting
    const overlapPairs = [];
    for (const [slug, effMap] of byModel.entries()) {
      const arcEffs = arcByBase.get(normSlug(slug));
      if (!arcEffs) continue;
      const common = ORDERED.filter((e) => effMap.has(e) && arcEffs.has(e));
      for (const e1 of common) {
        for (const e2 of common) {
          if (e1 === e2) continue;
          overlapPairs.push({
            slug,
            family: effMap.get(e1).family,
            idx1: ORDERED.indexOf(e1),
            idx2: ORDERED.indexOf(e2),
            a1: effMap.get(e1),
            a2: effMap.get(e2),
            x1: arcEffs.get(e1),
            x2: arcEffs.get(e2),
          });
        }
      }
    }

    // Exact-model ARC-AGI-2 LOOCV (IRT logit-space transfer)
    for (const p of overlapPairs) {
      const train = overlapPairs.filter((t) => t.slug !== p.slug);
      const num = train.reduce(
        (s, t) => s + (logitProb(t.x2.score) - logitProb(t.x1.score)) * (logitProb(t.a2.intel / 100) - logitProb(t.a1.intel / 100)),
        0
      );
      const den = train.reduce((s, t) => s + (logitProb(t.x2.score) - logitProb(t.x1.score)) ** 2, 0);
      if (den <= 1e-9) continue;
      const slope = num / den;
      const predLogit = logitProb(p.a1.intel / 100) + slope * (logitProb(p.x2.score) - logitProb(p.x1.score));
      const predI = Math.max(1, Math.min(95, sigmoidProb(predLogit) * 100));
      const costRatio = Math.max(0.15, Math.min(6.0, p.x2.cost / p.x1.cost));
      const predC = Math.max(0.001, p.a1.cost * costRatio);
      arcExactI.push(Math.abs(predI - p.a2.intel));
      arcExactC.push((Math.abs(predC - p.a2.cost) / p.a2.cost) * 100);
    }

    // Same-family ARC-AGI-2 LOOCV (IRT logit-space, holding out entire target model)
    for (const [slug, effMap] of byModel.entries()) {
      const pts = [...effMap.values()].sort((a, b) => a.idx - b.idx);
      if (pts.length < 2) continue;
      const fam = pts[0].family;
      if (!fam) continue;
      const train = overlapPairs.filter((t) => t.slug !== slug);
      const num = train.reduce(
        (s, t) => s + (logitProb(t.x2.score) - logitProb(t.x1.score)) * (logitProb(t.a2.intel / 100) - logitProb(t.a1.intel / 100)),
        0
      );
      const den = train.reduce((s, t) => s + (logitProb(t.x2.score) - logitProb(t.x1.score)) ** 2, 0);
      if (den <= 1e-9 || num <= 0) continue;
      const slope = num / den;

      const stepL = Array.from({ length: ORDERED.length - 1 }, () => []);
      const stepC = Array.from({ length: ORDERED.length - 1 }, () => []);
      const allL = [], allC = [];
      for (const [arcSlug, arcEffs] of arcByBase.entries()) {
        if (arcSlug === normSlug(slug)) continue;
        if (canonicalModelFamily(arcSlug, null) !== fam) continue;
        const apts = ORDERED.map((e, idx) => ({ idx, v: arcEffs.get(e) })).filter((x) => x.v && x.v.cost > 0);
        for (let k = 0; k < apts.length - 1; k++) {
          const steps = apts[k + 1].idx - apts[k].idx;
          const rC = Math.pow(apts[k + 1].v.cost / apts[k].v.cost, 1 / steps);
          const dL = (slope * (logitProb(apts[k + 1].v.score) - logitProb(apts[k].v.score))) / steps;
          if (rC >= 1.0 && rC <= 6.0) {
            for (let i = apts[k].idx; i < apts[k + 1].idx; i++) stepC[i].push(rC);
            allC.push(rC);
          }
          if (dL >= 0 && dL <= 1.5) {
            for (let i = apts[k].idx; i < apts[k + 1].idx; i++) stepL[i].push(dL);
            allL.push(dL);
          }
        }
      }
      if (!allL.length || !allC.length) continue;

      for (const target of pts) {
        for (const anchor of pts) {
          if (anchor.idx === target.idx) continue;
          let lSum = 0, cMult = 1;
          for (let i = Math.min(anchor.idx, target.idx); i < Math.max(anchor.idx, target.idx); i++) {
            const dL = Math.max(0.02, Math.min(0.8, median(stepL[i]) ?? median(allL)));
            const rC = Math.max(1.1, Math.min(4.0, median(stepC[i]) ?? median(allC)));
            if (target.idx > anchor.idx) { lSum += dL; cMult *= rC; }
            else { lSum -= dL; cMult /= rC; }
          }
          const predI = Math.max(1, Math.min(95, sigmoidProb(logitProb(anchor.intel / 100) + lSum) * 100));
          const predC = Math.max(0.001, anchor.cost * cMult);
          arcFamI.push(Math.abs(predI - target.intel));
          arcFamC.push((Math.abs(predC - target.cost) / target.cost) * 100);
        }
      }
    }
  }
} catch (err) {
  console.warn(`[eval] Skipped live ARC-AGI-2 LOOCV: ${err.message}`);
}

const rows = [
  { deg: "0 — Measured (Artificial Analysis)", mark: "—", s: { n: null, iMed: 0, iP75: 0, cMed: 0, cP75: 0, tier: "Ground truth" } },
  { deg: "1 — Bracketed interpolation (same model)", mark: "`†`", s: summarize(interpI, interpC) },
  { deg: "2 — Same-family AA, 1 effort step", mark: "`‡`", s: summarize(famByDist[1].i, famByDist[1].c) },
  { deg: "3 — Same-family AA, 2 effort steps", mark: "`‡`", s: summarize(famByDist[2].i, famByDist[2].c) },
  { deg: "4 — Same-family AA, 3 effort steps", mark: "`‡`", s: summarize(famByDist[3].i, famByDist[3].c) },
  { deg: "5 — Same-family AA, 4+ effort steps", mark: "`‡`", s: summarize(famByDist[4].i, famByDist[4].c) },
  { deg: "6 — Exact-model ARC-AGI-2 transfer", mark: "`‡`", s: summarize(arcExactI, arcExactC) },
  { deg: "7 — Same-family ARC-AGI-2 transfer", mark: "`‡`", s: summarize(arcFamI, arcFamC) },
];

console.log("=== Effort Estimate Accuracy by Degree of Separation (LOOCV) ===");
for (const r of rows) {
  const s = r.s;
  const nStr = s.n == null ? "—" : `n=${s.n}`;
  console.log(
    `  ${r.deg.padEnd(42)} | ${nStr.padEnd(6)} | Intel ±${fmt(s.iMed)} (P75 ±${fmt(s.iP75)}) pts | Cost ±${fmt(s.cMed)}% (P75 ±${fmt(s.cP75)}%) | ${s.tier}`
  );
}

if (WRITE_DOC) {
  const mdLines = [
    "# Effort Estimate Accuracy & Confidence",
    "",
    `Generated from live leave-one-out cross-validation (LOOCV) against real multi-effort Artificial Analysis measurements in \`public/data/combined.json\` (${dataset.generatedAt?.slice(0, 10) || "latest"}).`,
    "",
    "Every held-out test point is excluded from both the scaling curves and regression slopes before prediction (zero data leakage).",
    "",
    "## Empirical Error by Degree of Separation",
    "",
    "| Degree / Method | Marker | Held-out `n` | Intelligence median err | Intelligence P75 err | `$/task` median err | `$/task` P75 err | Confidence |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...rows.map((r) => {
      const s = r.s;
      const nCell = s.n == null ? "—" : String(s.n);
      const iMed = s.n === 0 ? "—" : `±${fmt(s.iMed)} pts`;
      const iP75 = s.n === 0 ? "—" : `±${fmt(s.iP75)} pts`;
      const cMed = s.n === 0 ? "—" : `±${fmt(s.cMed)}%`;
      const cP75 = s.n === 0 ? "—" : `±${fmt(s.cP75)}%`;
      return `| ${r.deg} | ${r.mark} | ${nCell} | ${iMed} | ${iP75} | ${cMed} | ${cP75} | **${s.tier}** |`;
    }),
    "",
    ...(dataset.stats?.codingAgentEstimates?.accuracy
      ? (() => {
          const a = dataset.stats.codingAgentEstimates.accuracy;
          return [
            "## Coding Agent Index Estimates",
            "",
            "| Method | Marker | Held-out `n` | Agent score median err | `$/task` median err |",
            "|---|---:|---:|---:|---:|",
            `| Same model, other effort | ‡ | ${a.sameModel.n} | ±${a.sameModel.pts} pts | ±${a.sameModel.costPct}% |`,
            ...(a.crossAgent ? [`| Same model, other agent | ‡ | ${a.crossAgent.n} | ±${a.crossAgent.pts} pts | ±${a.crossAgent.costPct}% |`] : []),
            `| Terminal-Bench 4.0 fit | ‡ | ${a.model.n} | ±${a.model.pts} pts | ±${a.model.costPct}% |`,
            "",
          ];
        })()
      : []),
    "## How Each Method Works",
    "",
    "- **Bracketed interpolation (`†`, on by default):** Only fills missing efforts strictly between a lower and higher measured effort on the *same* model, using empirical cumulative Intelligence and log-cost step weights. Gated on OpenRouter's `reasoning.supported_efforts` (and `mandatory` flag).",
    "- **Same-family AA extrapolation (`‡`, off by default):** Uses median additive Intelligence point deltas (`+Δ`) and multiplicative `$/task` ratios measured on other multi-effort models in the *same* canonical family (`anthropic`, `openai`, `google`, `xai`, `deepseek`, `alibaba`, `zhipu`, `mistral`, `meta`). No cross-family global fallback.",
    "- **ARC-AGI-2 (`v2_Semi_Private`) fallback (`‡`, off by default):** Only used for model families with no multi-effort AA data (e.g. `moonshot` / Kimi, `thinking machines` / Inkling). Transfers exact-model ARC-AGI-2 cost ratios and a live-fitted IRT logit-space slope (`Δlogit(ARC) → Δlogit(AA)`, following Truong et al., arXiv:2606.07616) first, then pools same-family ARC-AGI-2 step curves for sibling models (e.g. `Kimi K3.1 Pro` from `Kimi K3`).",
    "- **Coding Agent Index, same model (`‡`, off by default):** Nearest measured effort of the same model in the plan's agent, else in another agent; score shifted 1:1 by the Intelligence Index gap, `$/task` scaled by the AA Intelligence `$/task` ratio.",
    "- **Coding Agent Index, Terminal-Bench 4.0 (`‡`, off by default):** Models with no agent run; score from a linear fit on Terminal-Bench 4.0, `$/task` = AA `$/task` × median agent/AA ratio. Plans on agents AA has not run (Cursor, Factory Droid, Command Code, Devin) stay empty.",
    "",
    "## Reproducing These Numbers",
    "",
    "```bash",
    "node scripts/eval-effort-estimates.mjs --write-doc",
    "```",
    "",
    "## Relevant Literature",
    "",
    "- Snell et al. (2024), *Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters* — https://arxiv.org/abs/2408.03314",
    "- Muennighoff et al. (2025), *s1: Simple test-time scaling* — https://arxiv.org/abs/2501.19393",
    "- Agarwal et al. (2025), *The Art of Scaling Test-Time Compute for Large Language Models* — https://arxiv.org/abs/2512.02008",
    "- Zhou et al. (ACL 2026), *When More Thinking Hurts: Overthinking in LLM Test-Time Compute Scaling* — https://arxiv.org/abs/2604.10739",
    "- Truong et al. (ICLR 2026), *Item Response Scaling Laws* — https://arxiv.org/abs/2606.07616",
    "- Jiang et al. (2026), *Can We Trust Item Response Theory for AI Evaluation?* — https://arxiv.org/abs/2607.15190",
    "",
  ];
  await fs.mkdir(path.dirname(DOC_PATH), { recursive: true });
  await fs.writeFile(DOC_PATH, mdLines.join("\n"), "utf8");
  console.log(`\nWrote ${DOC_PATH}`);
}
