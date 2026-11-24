#!/usr/bin/env node
/**
 * Leave-one-out cross-validation (LOOCV) of effort interpolation (†) and
 * extrapolation (‡) accuracy against real Artificial Analysis measurements
 * in public/data/combined.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, "..", "public", "data", "combined.json");
const ORDERED = ["none", "low", "medium", "high", "xhigh", "max"];

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

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (pos - lo) * (s[hi] - s[lo]);
}
const median = (arr) => quantile(arr, 0.5);

const dataset = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));

// Deduplicate real measured variants by (baseModelId, effort)
const byModel = new Map();
for (const e of dataset.entries || []) {
  if (e.effortEstimate) continue; // real measured only
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
      creator: canonicalModelFamily(e.baseModelId, e.modelCreator) || "unknown",
      intel: e.intelligenceIndex,
      cost: e.aaCostPerTaskUsd,
      display: e.modelDisplay,
    });
  }
}

function fitInterpCurves(excludeModel) {
  const stepIntel = Array.from({ length: ORDERED.length - 1 }, () => []);
  const stepLogCost = Array.from({ length: ORDERED.length - 1 }, () => []);
  for (const [slug, effMap] of byModel.entries()) {
    if (slug === excludeModel) continue;
    for (let i = 0; i < ORDERED.length - 1; i++) {
      const a = effMap.get(ORDERED[i]);
      const b = effMap.get(ORDERED[i + 1]);
      if (!a || !b) continue;
      if (b.intel - a.intel > 0) stepIntel[i].push(b.intel - a.intel);
      if (b.cost > a.cost) stepLogCost[i].push(Math.log(b.cost / a.cost));
    }
  }
  const defI = [6.0, 5.0, 4.0, 2.5, 1.5];
  const defC = [0.6, 0.55, 0.5, 0.45, 0.45];
  const cumI = [0];
  const cumC = [0];
  for (let i = 0; i < ORDERED.length - 1; i++) {
    cumI.push(cumI[i] + Math.max(0.5, median(stepIntel[i]) ?? defI[i]));
    cumC.push(cumC[i] + Math.max(0.1, median(stepLogCost[i]) ?? defC[i]));
  }
  return { cumI, cumC };
}

function fitExtrapRatios(excludeModel) {
  const gI = Array.from({ length: ORDERED.length - 1 }, () => []);
  const gC = Array.from({ length: ORDERED.length - 1 }, () => []);
  const cI = new Map();
  const cC = new Map();
  for (const [slug, effMap] of byModel.entries()) {
    if (slug === excludeModel) continue;
    for (let i = 0; i < ORDERED.length - 1; i++) {
      const a = effMap.get(ORDERED[i]);
      const b = effMap.get(ORDERED[i + 1]);
      if (!a || !b) continue;
      const rI = b.intel / a.intel;
      const rC = b.cost / a.cost;
      if (rI >= 1.0 && rI <= 2.5) {
        gI[i].push(rI);
        if (b.creator) {
          if (!cI.has(b.creator)) cI.set(b.creator, Array.from({ length: ORDERED.length - 1 }, () => []));
          cI.get(b.creator)[i].push(rI);
        }
      }
      if (rC >= 1.0 && rC <= 8.0) {
        gC[i].push(rC);
        if (b.creator) {
          if (!cC.has(b.creator)) cC.set(b.creator, Array.from({ length: ORDERED.length - 1 }, () => []));
          cC.get(b.creator)[i].push(rC);
        }
      }
    }
  }
  const defI = [1.22, 1.15, 1.11, 1.06, 1.04];
  const defC = [1.85, 1.75, 1.65, 1.55, 1.55];
  return (creator, i, kind, sameFamilyOnly = false) => {
    const cMap = kind === "intel" ? cI : cC;
    const gArr = kind === "intel" ? gI : gC;
    const defArr = kind === "intel" ? defI : defC;
    const cVals = creator && cMap.has(creator) ? cMap.get(creator)[i] : [];
    if (sameFamilyOnly) {
      if (!cVals.length) return null;
      const raw = median(cVals);
      return kind === "intel" ? Math.max(1.01, Math.min(1.6, raw)) : Math.max(1.1, Math.min(4.0, raw));
    }
    const raw = cVals.length >= 1 ? median(cVals) : median(gArr[i]) ?? defArr[i];
    return kind === "intel" ? Math.max(1.01, Math.min(1.6, raw)) : Math.max(1.1, Math.min(4.0, raw));
  };
}

// 1. LOOCV for Interpolation (†)
const interpIntelAbs = [];
const interpIntelPct = [];
const interpCostPct = [];

for (const [slug, effMap] of byModel.entries()) {
  const pts = [...effMap.values()].sort((a, b) => a.idx - b.idx);
  if (pts.length < 3) continue;
  const { cumI, cumC } = fitInterpCurves(slug);
  for (let p = 1; p < pts.length - 1; p++) {
    const target = pts[p];
    const lo = pts[p - 1];
    const hi = pts[p + 1];
    const tI = Math.max(0.15, Math.min(0.85, (cumI[target.idx] - cumI[lo.idx]) / (cumI[hi.idx] - cumI[lo.idx])));
    const tC = Math.max(0.15, Math.min(0.85, (cumC[target.idx] - cumC[lo.idx]) / (cumC[hi.idx] - cumC[lo.idx])));
    const predI = lo.intel + tI * (hi.intel - lo.intel);
    const predC = Math.exp(Math.log(lo.cost) + tC * (Math.log(hi.cost) - Math.log(lo.cost)));
    interpIntelAbs.push(Math.abs(predI - target.intel));
    interpIntelPct.push((Math.abs(predI - target.intel) / target.intel) * 100);
    interpCostPct.push((Math.abs(predC - target.cost) / target.cost) * 100);
  }
}

// 2. LOOCV for Extrapolation (‡): hold out endpoints (min & max) or every point from nearest neighbor
function evalExtrap(sameFamilyOnly) {
  const step1I = [], step1C = [], allI = [], allC = [];
  for (const [slug, effMap] of byModel.entries()) {
    const pts = [...effMap.values()].sort((a, b) => a.idx - b.idx);
    if (pts.length < 2) continue;
    const stepRatio = fitExtrapRatios(slug);
    for (const target of pts) {
      for (const anchor of pts) {
        if (anchor.idx === target.idx) continue;
        // Only evaluate pure extrapolation (anchor on one side, no closer anchor)
        const dist = Math.abs(target.idx - anchor.idx);
        let multI = 1, multC = 1, missing = false;
        const lo = Math.min(anchor.idx, target.idx);
        const hi = Math.max(anchor.idx, target.idx);
        for (let i = lo; i < hi; i++) {
          const rI = stepRatio(target.creator, i, "intel", sameFamilyOnly);
          const rC = stepRatio(target.creator, i, "cost", sameFamilyOnly);
          if (rI == null || rC == null) { missing = true; break; }
          if (target.idx > anchor.idx) { multI *= rI; multC *= rC; }
          else { multI /= rI; multC /= rC; }
        }
        if (missing) continue;
        const predI = Math.max(1, Math.min(95, anchor.intel * multI));
        const predC = Math.max(0.001, anchor.cost * multC);
        const errI = Math.abs(predI - target.intel);
        const errC = (Math.abs(predC - target.cost) / target.cost) * 100;
        allI.push(errI);
        allC.push(errC);
        if (dist === 1) {
          step1I.push(errI);
          step1C.push(errC);
        }
      }
    }
  }
  return { step1I, step1C, allI, allC };
}

const exFam = evalExtrap(true);
const exAll = evalExtrap(false);

// 3. Check how many currently-extrapolated models have same-creator measured transitions
const creatorsWithMulti = new Set();
for (const effMap of byModel.values()) {
  if (effMap.size >= 2) {
    for (const v of effMap.values()) if (v.creator) creatorsWithMulti.add(v.creator);
  }
}
const extrapModelsByCreator = new Map();
for (const e of dataset.entries || []) {
  if (e.effortEstimate !== "extrapolated") continue;
  const c = canonicalModelFamily(e.baseModelId, e.modelCreator) || "unknown";
  if (!extrapModelsByCreator.has(c)) extrapModelsByCreator.set(c, new Set());
  extrapModelsByCreator.get(c).add(e.baseModelId);
}

const fmt = (n, d = 1) => (n == null ? "n/a" : n.toFixed(d));
console.log("=== Interpolation (†) LOOCV (n=" + interpIntelAbs.length + " held-out bracketed points) ===");
console.log(`  Intelligence abs err: median ±${fmt(median(interpIntelAbs))} pts (P75 ±${fmt(quantile(interpIntelAbs, 0.75))} pts, median ${fmt(median(interpIntelPct))}%)`);
console.log(`  Cost/task rel err:    median ±${fmt(median(interpCostPct))}% (P75 ±${fmt(quantile(interpCostPct, 0.75))}%)`);

console.log("\n=== Extrapolation (‡) LOOCV — Same-creator only ===");
console.log(`  1-step (n=${exFam.step1I.length}): Intel median ±${fmt(median(exFam.step1I))} pts (P75 ±${fmt(quantile(exFam.step1I, 0.75))}), Cost median ±${fmt(median(exFam.step1C))}% (P75 ±${fmt(quantile(exFam.step1C, 0.75))}%)`);
console.log(`  All-step (n=${exFam.allI.length}): Intel median ±${fmt(median(exFam.allI))} pts (P75 ±${fmt(quantile(exFam.allI, 0.75))}), Cost median ±${fmt(median(exFam.allC))}% (P75 ±${fmt(quantile(exFam.allC, 0.75))}%)`);

console.log("\n=== Extrapolation (‡) LOOCV — Same-creator + global fallback ===");
console.log(`  1-step (n=${exAll.step1I.length}): Intel median ±${fmt(median(exAll.step1I))} pts (P75 ±${fmt(quantile(exAll.step1I, 0.75))}), Cost median ±${fmt(median(exAll.step1C))}% (P75 ±${fmt(quantile(exAll.step1C, 0.75))}%)`);
console.log(`  All-step (n=${exAll.allI.length}): Intel median ±${fmt(median(exAll.allI))} pts (P75 ±${fmt(quantile(exAll.allI, 0.75))}), Cost median ±${fmt(median(exAll.allC))}% (P75 ±${fmt(quantile(exAll.allC, 0.75))}%)`);

console.log("\n=== Creators with extrapolated models ===");
for (const [c, models] of [...extrapModelsByCreator.entries()].sort()) {
  console.log(`  ${c}: ${models.size} models (has multi-effort data: ${creatorsWithMulti.has(c) ? "YES" : "NO — uses global fallback"})`);
}
