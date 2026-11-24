#!/usr/bin/env node
/**
 * Empirical test: can external multi-effort datasets (ARC Prize, Aider Polyglot,
 * Epoch AI) improve coverage or accuracy for extrapolating Artificial Analysis
 * Intelligence Index and $/task across reasoning efforts?
 */

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, "..", "public", "data", "combined.json");
const ORDERED = ["none", "low", "medium", "high", "xhigh", "max"];
const UA = "ai-plan-value-eval/1.0";

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function normSlug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^[a-z0-9_-]+\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractEffort(rawName) {
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

function stripEffort(rawName) {
  return normSlug(
    String(rawName || "")
      .replace(/\([^)]*(?:reasoning|thinking|effort|low|medium|high|xhigh|max|none|minimal|default)[^)]*\)/gi, " ")
      .replace(/[-_\s]+(?:xhigh|extra[-_\s]?high|high|medium|med|low|minimal|max|none|non[-_\s]?reasoning|thinking[-_\s]?\d+k?)\b/gi, " ")
      .replace(/\b202\d[-_]?\d{2}[-_]?\d{2}\b/g, " ")
  );
}

async function fetchBuf(url) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Minimal pure-JS ZIP extractor (stored + deflate entries)
function readZipEntries(buf) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("ZIP EOCD not found");
  const cdCount = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data = null;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    if (data) entries.set(name, data);
  }
  return entries;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const headers = rows[0] || [];
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = r[idx] ?? ""));
    return obj;
  });
}

// 0. Load our real measured AA data from public/data/combined.json
const dataset = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
const aaReal = new Map(); // normBase -> Map<effort, { baseModelId, intel, cost }>
const allBaseModels = new Set();
const singleEffortModels = new Set();
for (const e of dataset.entries || []) {
  allBaseModels.add(e.baseModelId);
  if (e.effortEstimate) continue;
  const key = normSlug(e.baseModelId);
  if (!aaReal.has(key)) aaReal.set(key, new Map());
  if (!aaReal.get(key).has(e.effort)) {
    aaReal.get(key).set(e.effort, {
      baseModelId: e.baseModelId,
      effort: e.effort,
      intel: e.intelligenceIndex,
      cost: e.aaCostPerTaskUsd,
    });
  }
}
for (const [k, m] of aaReal.entries()) {
  const named = [...m.keys()].filter((e) => ORDERED.includes(e));
  if (named.length < 2) singleEffortModels.add(k);
}

function matchAaSlug(rawBase) {
  const s = normSlug(rawBase);
  if (aaReal.has(s)) return s;
  // Fuzzy prefix/exact token match without date suffixes
  const noDate = s.replace(/-202\d\d{4}$/, "");
  if (aaReal.has(noDate)) return noDate;
  for (const k of aaReal.keys()) {
    if (k === noDate || k.replace(/-/g, "") === noDate.replace(/-/g, "")) return k;
  }
  return null;
}

function evaluateExternal(label, extByModel) {
  // extByModel: Map<baseKey, Map<effort, { score, cost }>>
  let multiModels = 0;
  let matchedMultiToAa = 0;
  let fillsMissingAaEffort = 0;
  const filledExamples = [];
  const costPairErrs = [];
  const scorePairs = []; // { dExt, dAa, rExt, rAa, base, eff1, eff2, aaI1, aaI2 }

  for (const [rawBase, extEffs] of extByModel.entries()) {
    const namedEffs = [...extEffs.keys()].filter((e) => ORDERED.includes(e));
    if (namedEffs.length < 2) continue;
    multiModels++;

    const aaKey = matchAaSlug(rawBase);
    if (!aaKey) continue;
    const aaEffs = aaReal.get(aaKey);

    // Does external have multi-effort for a model missing efforts in AA?
    let added = 0;
    for (const eff of namedEffs) {
      if (!aaEffs.has(eff)) added++;
    }
    if (added > 0) {
      fillsMissingAaEffort += added;
      if (filledExamples.length < 8) {
        filledExamples.push(`${aaKey} (+${namedEffs.filter((e) => !aaEffs.has(e)).join(",")})`);
      }
    }

    // Overlap pairs where BOTH AA and external have 2+ matching named efforts
    const common = namedEffs.filter((e) => aaEffs.has(e));
    if (common.length >= 2) {
      matchedMultiToAa++;
      for (let i = 0; i < common.length; i++) {
        for (let j = 0; j < common.length; j++) {
          if (i === j) continue;
          const e1 = common[i];
          const e2 = common[j];
          const a1 = aaEffs.get(e1);
          const a2 = aaEffs.get(e2);
          const x1 = extEffs.get(e1);
          const x2 = extEffs.get(e2);
          if (x1.cost > 0 && x2.cost > 0 && a1.cost > 0 && a2.cost > 0) {
            const predCost = a1.cost * (x2.cost / x1.cost);
            costPairErrs.push((Math.abs(predCost - a2.cost) / a2.cost) * 100);
          }
          if (x1.score != null && x2.score != null && a1.intel > 0 && a2.intel > 0) {
            scorePairs.push({
              base: aaKey,
              dExt: x2.score - x1.score,
              dAa: a2.intel - a1.intel,
              aaI1: a1.intel,
              aaI2: a2.intel,
            });
          }
        }
      }
    }
  }

  // LOOCV linear regression for score delta: dAa = slope * dExt (no intercept since 0 delta -> 0 delta)
  const scoreAbsErrs = [];
  for (const p of scorePairs) {
    const train = scorePairs.filter((t) => t.base !== p.base);
    const num = train.reduce((s, t) => s + t.dExt * t.dAa, 0);
    const den = train.reduce((s, t) => s + t.dExt * t.dExt, 0);
    if (den <= 1e-9) continue;
    const slope = num / den;
    const predI2 = Math.max(1, Math.min(95, p.aaI1 + slope * p.dExt));
    scoreAbsErrs.push(Math.abs(predI2 - p.aaI2));
  }

  console.log(`\n=== ${label} ===`);
  console.log(`  Multi-effort models in dataset:      ${multiModels}`);
  console.log(`  Overlapping multi-effort with AA:    ${matchedMultiToAa} (${scorePairs.length} ordered pairs)`);
  console.log(`  Missing AA efforts it could fill:    ${fillsMissingAaEffort}${filledExamples.length ? " — e.g. " + filledExamples.join("; ") : ""}`);
  if (costPairErrs.length) {
    console.log(`  Cost/task transfer error (n=${costPairErrs.length}): median ±${median(costPairErrs).toFixed(1)}%`);
  } else {
    console.log("  Cost/task transfer error:            n/a (no overlapping cost pairs)");
  }
  if (scoreAbsErrs.length) {
    console.log(`  Intel score transfer error (n=${scoreAbsErrs.length}): median ±${median(scoreAbsErrs).toFixed(1)} pts`);
  } else {
    console.log("  Intel score transfer error:          n/a (no overlapping score pairs)");
  }
}

// 1. ARC Prize
try {
  const [evalsBuf, modelsBuf] = await Promise.all([
    fetchBuf("https://arcprize.org/media/data/evaluations.json"),
    fetchBuf("https://arcprize.org/media/data/models.json"),
  ]);
  const evals = JSON.parse(evalsBuf.toString("utf8"));
  const models = JSON.parse(modelsBuf.toString("utf8"));
  const modelMap = new Map(
    (Array.isArray(models) ? models : Object.values(models)).map((m) => [m.id || m.modelId || m.slug, m])
  );
  const evalArr = Array.isArray(evals) ? evals : Object.values(evals);
  const arcByModel = new Map();
  // Group by datasetId (prefer arc-agi-2 or largest dataset)
  const dsCounts = new Map();
  for (const r of evalArr) {
    const ds = r.datasetId || r.dataset || "default";
    dsCounts.set(ds, (dsCounts.get(ds) || 0) + 1);
  }
  const topDatasets = [...dsCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`[ARC Prize] Loaded ${evalArr.length} eval rows, ${modelMap.size} models (datasets: ${topDatasets.map(([k, v]) => `${k}=${v}`).join(", ")})`);

  for (const [dsName] of topDatasets) {
    const arcByModel = new Map();
    for (const r of evalArr) {
      if ((r.datasetId || r.dataset || "default") !== dsName) continue;
      const m = modelMap.get(r.modelId) || {};
      const label = m.displayName || m.name || r.modelId || "";
      const eff = extractEffort(r.modelId) || extractEffort(label) || extractEffort(m.reasoningEffort);
      if (!eff) continue;
      const base = stripEffort(label || r.modelId);
      const score = Number(r.score ?? r.accuracy);
      const cost = Number(r.costPerTask ?? r.cost_per_task ?? r.cost);
      if (!base || !Number.isFinite(score)) continue;
      if (!arcByModel.has(base)) arcByModel.set(base, new Map());
      arcByModel.get(base).set(eff, { score, cost: Number.isFinite(cost) && cost > 0 ? cost : null });
    }
    evaluateExternal(`ARC Prize (${dsName})`, arcByModel);
  }
} catch (err) {
  console.log(`\n[ARC Prize] Failed: ${err.message}`);
}

// 2. Aider Polyglot
try {
  const yml = (await fetchBuf("https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml")).toString("utf8");
  const blocks = yml.split(/\n(?=- )/);
  const aiderByModel = new Map();
  for (const b of blocks) {
    const nameM = b.match(/^\s*-?\s*model:\s*(.+)$/m);
    const scoreM = b.match(/^\s*pass_rate_2:\s*([0-9.]+)/m);
    const costM = b.match(/^\s*total_cost:\s*([0-9.]+)/m);
    if (!nameM || !scoreM) continue;
    const rawName = nameM[1].trim().replace(/^["']|["']$/g, "");
    const eff = extractEffort(rawName);
    if (!eff) continue;
    const base = stripEffort(rawName);
    const score = Number(scoreM[1]);
    const cost = costM ? Number(costM[1]) : null;
    if (!aiderByModel.has(base)) aiderByModel.set(base, new Map());
    aiderByModel.get(base).set(eff, { score, cost: cost > 0 ? cost : null });
  }
  console.log(`\n[Aider Polyglot] Parsed ${blocks.length} entries`);
  evaluateExternal("Aider Polyglot", aiderByModel);
} catch (err) {
  console.log(`\n[Aider Polyglot] Failed: ${err.message}`);
}

// 3. Epoch AI benchmark_data.zip
try {
  const zipBuf = await fetchBuf("https://epoch.ai/data/benchmark_data.zip");
  const files = readZipEntries(zipBuf);
  console.log(`\n[Epoch AI] ZIP files: ${[...files.keys()].join(", ")}`);
  const eciKey = [...files.keys()].find((k) => /eci/i.test(k) && k.endsWith(".csv"))
    || [...files.keys()].find((k) => k.endsWith(".csv"));
  if (eciKey) {
    const rows = parseCsv(files.get(eciKey).toString("utf8"));
    console.log(`[Epoch AI] Using "${eciKey}" (${rows.length} rows, cols: ${Object.keys(rows[0] || {}).slice(0, 8).join(", ")})`);
    const epochByModel = new Map();
    for (const r of rows) {
      const modelName = r["Display name"] || r["Model"] || r["Model version"] || r["model"] || "";
      const rawId = r["Model"] || "";
      const eff = extractEffort(modelName) || extractEffort(rawId) || extractEffort(r["Reasoning effort"] || r["effort"] || "");
      if (!eff) continue;
      const base = stripEffort(modelName || rawId);
      const scoreRaw = r["eci"] ?? r["ECI Score"] ?? r["eci_score"] ?? r["Score"];
      const score = Number(scoreRaw);
      if (!base || !Number.isFinite(score)) continue;
      if (!epochByModel.has(base)) epochByModel.set(base, new Map());
      epochByModel.get(base).set(eff, { score, cost: null });
    }
    console.log(`[Epoch AI] Sample rows: ${rows.slice(0, 4).map((r) => `${r["Model"]} (${r["Display name"]})=${r["eci"]}`).join(" | ")}`);
    evaluateExternal(`Epoch AI (${eciKey})`, epochByModel);
  }
} catch (err) {
  console.log(`\n[Epoch AI] Failed: ${err.message}`);
}
