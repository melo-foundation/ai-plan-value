#!/usr/bin/env node
/**
 * 3-in-1 empirical experiment before publishing:
 *   1. LOOCV comparison of Intelligence scaling functional forms:
 *      Multiplicative vs Additive vs IRT Logit (Truong et al. 2026) vs Error-Reduction
 *      (+ Linear vs Logit for ARC-AGI-2 -> AA transfer)
 *   2. LOOCV comparison of distance-aware hybrid routing (same-family AA vs exact-model ARC-AGI-2)
 *   3. Inspect OpenRouter raw `reasoning` metadata for Qwen 3.8 / MiniMax / MiMo / Step / Hy4
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, "..", "public", "data", "combined.json");
const ORDERED = ["none", "low", "medium", "high", "xhigh", "max"];
const UA = "ai-plan-value-exp/1.0";

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (pos - lo) * (s[hi] - s[lo]);
}
const median = (arr) => quantile(arr, 0.5);
const fmt = (n, d = 2) => (n == null ? "—" : n.toFixed(d));
const logit = (p) => {
  const c = Math.max(0.005, Math.min(0.995, p));
  return Math.log(c / (1 - c));
};
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

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
  const c = String(creatorName || "").toLowerCase().trim();
  return c || null;
}

function extractArcEffort(rawName) {
  const s = String(rawName || "").toLowerCase();
  if (/\b(?:xhigh|extra[-_\s]?high)\b/.test(s)) return "xhigh";
  if (/\b(?:max|maximum)\b/.test(s)) return "max";
  if (/\b(?:non[-_\s]?reasoning|no[-_\s]?thinking|thinking[-_\s]?off|effort[=:\s_-]*none|\(none\))\b/.test(s)) return "none";
  if (/\b(?:low|minimal)\b/.test(s)) return "low";
  if (/\b(?:medium|med)\b/.test(s)) return "medium";
  if (/\bhigh\b/.test(s)) return "high";
  return null;
}

const dataset = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const byModel = new Map();
for (const e of dataset.entries || []) {
  if (e.effortEstimate) continue;
  const idx = ORDERED.indexOf(e.effort);
  if (idx === -1 || !(e.intelligenceIndex > 1) || !(e.aaCostPerTaskUsd > 0)) continue;
  if (!byModel.has(e.baseModelId)) byModel.set(e.baseModelId, new Map());
  if (!byModel.get(e.baseModelId).has(e.effort)) {
    byModel.get(e.baseModelId).set(e.effort, {
      idx,
      family: canonicalModelFamily(e.baseModelId, e.modelCreator),
      intel: e.intelligenceIndex,
      cost: e.aaCostPerTaskUsd,
    });
  }
}

// === EXPERIMENT 1: Same-family AA functional forms ===
const forms = {
  multiplicative: {
    stepVal: (a, b) => (b.intel / a.intel >= 1 && b.intel / a.intel <= 2.5 ? b.intel / a.intel : null),
    clampStep: (v) => Math.max(1.01, Math.min(1.6, v)),
    forward: (cur, v) => cur * v,
    backward: (cur, v) => cur / v,
  },
  additive: {
    stepVal: (a, b) => (b.intel - a.intel >= 0 && b.intel - a.intel <= 25 ? b.intel - a.intel : null),
    clampStep: (v) => Math.max(0.2, Math.min(15, v)),
    forward: (cur, v) => cur + v,
    backward: (cur, v) => cur - v,
  },
  logit_irt: {
    stepVal: (a, b) => {
      const d = logit(b.intel / 100) - logit(a.intel / 100);
      return d >= 0 && d <= 2.0 ? d : null;
    },
    clampStep: (v) => Math.max(0.02, Math.min(1.2, v)),
    forward: (cur, v) => sigmoid(logit(cur / 100) + v) * 100,
    backward: (cur, v) => sigmoid(logit(cur / 100) - v) * 100,
  },
  err_reduction: {
    stepVal: (a, b) => {
      const r = (100 - b.intel) / (100 - a.intel);
      return r > 0.4 && r <= 1.0 ? r : null;
    },
    clampStep: (v) => Math.max(0.6, Math.min(0.995, v)),
    forward: (cur, v) => 100 - (100 - cur) * v,
    backward: (cur, v) => 100 - (100 - cur) / v,
  },
};

console.log("=== EXPERIMENT 1: Same-Family AA Intelligence Functional Forms (LOOCV) ===");
for (const [name, fn] of Object.entries(forms)) {
  const byDist = { 1: [], 2: [], 3: [], 4: [], all: [] };
  for (const [heldSlug, effMap] of byModel.entries()) {
    const pts = [...effMap.values()].sort((a, b) => a.idx - b.idx);
    if (pts.length < 2) continue;
    const fam = pts[0].family;
    if (!fam) continue;

    // Fit same-family steps excluding heldSlug
    const stepArr = Array.from({ length: ORDERED.length - 1 }, () => []);
    const allArr = [];
    for (const [s, em] of byModel.entries()) {
      if (s === heldSlug) continue;
      for (let i = 0; i < ORDERED.length - 1; i++) {
        const a = em.get(ORDERED[i]), b = em.get(ORDERED[i + 1]);
        if (!a || !b || b.family !== fam) continue;
        const sv = fn.stepVal(a, b);
        if (sv != null) { stepArr[i].push(sv); allArr.push(sv); }
      }
    }
    if (!allArr.length) continue;

    for (const target of pts) {
      for (const anchor of pts) {
        if (anchor.idx === target.idx) continue;
        let cur = anchor.intel;
        const lo = Math.min(anchor.idx, target.idx);
        const hi = Math.max(anchor.idx, target.idx);
        if (target.idx > anchor.idx) {
          for (let i = lo; i < hi; i++) cur = fn.forward(cur, fn.clampStep(median(stepArr[i]) ?? median(allArr)));
        } else {
          for (let i = hi - 1; i >= lo; i--) cur = fn.backward(cur, fn.clampStep(median(stepArr[i]) ?? median(allArr)));
        }
        const pred = Math.max(1, Math.min(95, cur));
        const err = Math.abs(pred - target.intel);
        byDist[Math.min(4, hi - lo)].push(err);
        byDist.all.push(err);
      }
    }
  }
  console.log(
    `  ${name.padEnd(15)} | 1-step: ±${fmt(median(byDist[1]))} | 2-step: ±${fmt(median(byDist[2]))} | 3-step: ±${fmt(median(byDist[3]))} | 4+: ±${fmt(median(byDist[4]))} | ALL (n=${byDist.all.length}): ±${fmt(median(byDist.all))} (P75 ±${fmt(quantile(byDist.all, 0.75))})`
  );
}

// === EXPERIMENT 2: ARC-AGI-2 Linear vs Logit & Distance-Aware Routing ===
const [eRes, mRes, orRes] = await Promise.all([
  fetch("https://arcprize.org/media/data/evaluations.json", { headers: { "user-agent": UA } }),
  fetch("https://arcprize.org/media/data/models.json", { headers: { "user-agent": UA } }),
  fetch("https://openrouter.ai/api/v1/models", { headers: { "user-agent": UA } }),
]);
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
        dist: Math.abs(ORDERED.indexOf(e2) - ORDERED.indexOf(e1)),
        a1: effMap.get(e1),
        a2: effMap.get(e2),
        x1: arcEffs.get(e1),
        x2: arcEffs.get(e2),
      });
    }
  }
}

const arcLinErr = [], arcLogitErr = [], arcLinByD = { 1: [], 2: [], 3: [], 4: [] }, arcLogitByD = { 1: [], 2: [], 3: [], 4: [] };
for (const p of overlapPairs) {
  const train = overlapPairs.filter((t) => t.slug !== p.slug);
  // Linear
  const lNum = train.reduce((s, t) => s + (t.x2.score - t.x1.score) * (t.a2.intel - t.a1.intel), 0);
  const lDen = train.reduce((s, t) => s + (t.x2.score - t.x1.score) ** 2, 0);
  const pLin = Math.max(1, Math.min(95, p.a1.intel + (lNum / lDen) * (p.x2.score - p.x1.score)));
  const eLin = Math.abs(pLin - p.a2.intel);
  arcLinErr.push(eLin);
  arcLinByD[Math.min(4, p.dist)].push(eLin);

  // Logit-space (IRT)
  const gNum = train.reduce((s, t) => s + (logit(t.x2.score) - logit(t.x1.score)) * (logit(t.a2.intel / 100) - logit(t.a1.intel / 100)), 0);
  const gDen = train.reduce((s, t) => s + (logit(t.x2.score) - logit(t.x1.score)) ** 2, 0);
  const pLog = Math.max(1, Math.min(95, sigmoid(logit(p.a1.intel / 100) + (gNum / gDen) * (logit(p.x2.score) - logit(p.x1.score))) * 100));
  const eLog = Math.abs(pLog - p.a2.intel);
  arcLogitErr.push(eLog);
  arcLogitByD[Math.min(4, p.dist)].push(eLog);
}

console.log("\n=== EXPERIMENT 2: ARC-AGI-2 Transfer Linear vs Logit-IRT (n=" + overlapPairs.length + ") ===");
console.log(`  ARC linear      | 1-step: ±${fmt(median(arcLinByD[1]))} | 2-step: ±${fmt(median(arcLinByD[2]))} | 3-step: ±${fmt(median(arcLinByD[3]))} | 4+: ±${fmt(median(arcLinByD[4]))} | ALL: ±${fmt(median(arcLinErr))} (P75 ±${fmt(quantile(arcLinErr, 0.75))})`);
console.log(`  ARC logit_irt   | 1-step: ±${fmt(median(arcLogitByD[1]))} | 2-step: ±${fmt(median(arcLogitByD[2]))} | 3-step: ±${fmt(median(arcLogitByD[3]))} | 4+: ±${fmt(median(arcLogitByD[4]))} | ALL: ±${fmt(median(arcLogitErr))} (P75 ±${fmt(quantile(arcLogitErr, 0.75))})`);

// === EXPERIMENT 3: OpenRouter raw reasoning metadata for Qwen 3.8 / MiniMax / MiMo / Hy4 / Step ===
const orJson = await orRes.json();
const interestRe = /qwen.*(?:3\.8|4-max)|minimax-m3|mimo-v2|hy4|hunyuan-4|step-5|kimi-k3/i;
console.log("\n=== EXPERIMENT 3: OpenRouter Raw Reasoning Metadata ===");
for (const m of orJson.data || []) {
  if (!interestRe.test(`${m.id} ${m.name}`)) continue;
  console.log(`  ${m.id} | params=${JSON.stringify((m.supported_parameters || []).filter((p) => /reason/i.test(p)))} | reasoning=${JSON.stringify(m.reasoning ?? null)}`);
}
