#!/usr/bin/env node
/**
 * Fetches and merges live data from:
 *   1. Fei2411/real-api-pricing (derived/points.csv) — primary upstream source of mypriors.com/subsidies
 *   2. artificialanalysis.ai/models (#price-cost SSR payload, plus optional AA_API_KEY v2 API)
 *   3. mypriors.com/subsidies (preliminary community overrides)
 *
 * Writes normalized dataset to public/data/combined.json.
 * Zero external npm dependencies (requires Node.js >= 20).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT_DIR, "public", "data", "combined.json");

const SOURCES = {
  feiPointsCsv:
    "https://raw.githubusercontent.com/Fei2411/real-api-pricing/main/derived/points.csv",
  aaModelsPage: "https://artificialanalysis.ai/models",
  aaApiV2: "https://artificialanalysis.ai/api/v2/data/llms/models",
  mypriorsSubsidies: "https://mypriors.com/subsidies",
};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Verified exact slug aliases between Fei2411/MyPriors model IDs and Artificial Analysis slugs.
const MODEL_ALIASES = {
  hy4: "tencent-hy4",
  "hy-4": "tencent-hy4",
  "deepseek-v4-1-flash": "deepseek-v4-1-flash-1017",
  "ling-3-1-flash-1019": "ling-3-1-flash",
  "kimi-k3-1": "kimi-k3-1-pro",
  "qwen-4-max": "qwen4-max",
  "qwen-3-8-27b": "qwen3-8-27b",
  "aa-muse-wonder": "muse-wonder",
};

const VENDOR_COLORS = {
  Anthropic: "#C96A4A",
  OpenAI: "#1F2937",
  Google: "#2563EB",
  xAI: "#7C3AED",
  DeepSeek: "#1D4ED8",
  Alibaba: "#EA580C",
  Qwen: "#EA580C",
  Moonshot: "#0284C7",
  Kimi: "#0284C7",
  Zhipu: "#2563EB",
  "Z.ai": "#2563EB",
  Xiaomi: "#F97316",
  MiniMax: "#DB2777",
  Meta: "#0284C7",
  Mistral: "#D97706",
  Tencent: "#0D9488",
  Cursor: "#475569",
  Devin: "#059669",
  Ollama: "#334155",
  OpenCode: "#4F46E5",
  "Command Code": "#6D28D9",
  Factory: "#0F766E",
  StepFun: "#6366F1",
  NVIDIA: "#65A30D",
  "Thinking Machines": "#0891B2",
  "Ant Group": "#0284C7",
};

// Verified first-party subscription plan & API pricing URLs
const PLAN_URL_PATTERNS = [
  [/^claude\b/i, "https://claude.com/pricing"],
  [/^chatgpt\b/i, "https://openai.com/chatgpt/pricing/"],
  [/^google ai\b/i, "https://one.google.com/about/google-ai-plans/"],
  [/^supergrok\b/i, "https://grok.com"],
  [/^cursor\b/i, "https://cursor.com/pricing"],
  [/^devin\b/i, "https://devin.ai/pricing"],
  [/^droid\b/i, "https://factory.com/pricing"],
  [/^opencode\b/i, "https://opencode.ai/go"],
  [/^command code\b/i, "https://commandcode.ai/docs/pricing"],
  [/^ollama\b/i, "https://ollama.com/pricing"],
  [/^deeprelay\b/i, "https://deeprelay.ai/pricing"],
  [/^mistral\b/i, "https://mistral.ai/pricing"],
  [/^glm coding\b/i, "https://z.ai/subscribe"],
  [/qwen token plan|alibaba|阿里云百炼/i, "https://www.aliyun.com/product/bailian"],
  [/^minimax.*global/i, "https://platform.minimax.io/docs/pricing/overview"],
  [/^minimax\b/i, "https://platform.minimaxi.com"],
  [/^tencent token/i, "https://cloud.tencent.com/product/tokenhub"],
  [/^mimo token/i, "https://platform.xiaomimimo.com"],
  [/^step plan/i, "https://platform.stepfun.com/step-plan"],
  [/^kimi\b/i, "https://kimi.ai"],
];

const API_URL_BY_VENDOR = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  openai: "https://openai.com/api/pricing/",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  xai: "https://docs.x.ai/docs/models",
  spacexai: "https://docs.x.ai/docs/models",
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
  alibaba: "https://www.alibabacloud.com/help/en/model-studio/getting-started/model-inference-pricing",
  qwen: "https://www.alibabacloud.com/help/en/model-studio/getting-started/model-inference-pricing",
  moonshot: "https://platform.moonshot.ai/docs/pricing",
  kimi: "https://platform.moonshot.ai/docs/pricing",
  zhipu: "https://docs.z.ai",
  "z-ai": "https://docs.z.ai",
  "z ai": "https://docs.z.ai",
  minimax: "https://platform.minimax.io/docs/pricing/overview",
  mistral: "https://mistral.ai/pricing",
  xiaomi: "https://platform.xiaomimimo.com",
  tencent: "https://cloud.tencent.com/document/product/1729",
  stepfun: "https://platform.stepfun.com/docs",
  nvidia: "https://build.nvidia.com",
  meta: "https://llama.com",
};

function resolvePlanUrl(planName, vendor, billing) {
  if (billing === "metered") {
    const key = normSlug(vendor);
    return API_URL_BY_VENDOR[key] || API_URL_BY_VENDOR[String(vendor || "").toLowerCase()] || null;
  }
  const p = String(planName || "");
  for (const [re, url] of PLAN_URL_PATTERNS) {
    if (re.test(p)) return url;
  }
  const key = normSlug(vendor);
  return API_URL_BY_VENDOR[key] || null;
}

function pctFromFraction(v) {
  const n = toNum(v);
  if (n === null) return null;
  return Number((n <= 1.001 ? n * 100 : n).toFixed(1));
}

function round1(v) {
  const n = toNum(v);
  return n === null ? null : Number(n.toFixed(1));
}

function normSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * RFC-4180 compliant CSV parser supporting quoted commas, escaped quotes, and multiline cells.
 */
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      if (clean[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length < 2) return [];

  const headers = rows[0];
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const values = rows[r];
    if (values.length === 1 && values[0] === "") continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

/**
 * Extract decoded Next.js App Router RSC text from HTML.
 */
function extractNextRscText(html) {
  const regex = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/g;
  let out = "";
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      out += JSON.parse(`"${match[1]}"`);
    } catch {
      out += match[1];
    }
  }
  return out;
}

/**
 * Extract a balanced JSON object starting at openBraceIdx.
 */
function extractBalancedJson(text, openBraceIdx) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(openBraceIdx, i + 1));
      }
    }
  }
  throw new Error("Unbalanced JSON object while parsing RSC payload");
}

function findInitialModels(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node.initialModels) && node.initialModels.length > 0) {
    return node.initialModels;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findInitialModels(item);
      if (found) return found;
    }
    return null;
  }
  for (const val of Object.values(node)) {
    const found = findInitialModels(val);
    if (found) return found;
  }
  return null;
}

function parseAaModelsHtml(html) {
  const rsc = extractNextRscText(html);
  const lines = rsc.split("\n");
  for (const line of lines) {
    if (!line.includes('"initialModels"')) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(colonIdx + 1));
      const initialModels = findInitialModels(parsed);
      if (initialModels) {
        return initialModels.map(normalizeAaModel);
      }
    } catch {
      // Try next matching line
    }
  }
  throw new Error("Could not locate initialModels in Artificial Analysis HTML");
}

function normalizeAaModel(m) {
  const cptCost = m.intelligenceIndexCostPerTask?.cost || null;
  const totalCost = m.intelligenceIndexCost || null;
  const caps = m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {};
  return {
    slug: m.slug,
    name: m.name || m.shortName || m.slug,
    shortName: m.shortName || m.name || m.slug,
    creatorName: m.creator?.name || null,
    creatorSlug: m.creator?.slug || null,
    creatorColor: m.creator?.color || null,
    releaseDate: m.releaseDate || null,
    isOpenWeights: Boolean(m.isOpenWeights),
    contextWindowTokens: toNum(m.contextWindowTokens),
    intelligenceIndex: toNum(m.intelligenceIndex),
    benchmarks: {
      intelligenceIndex: round1(m.intelligenceIndex),
      engineering: round1(caps.engineering),
      financeAndAccounting: round1(caps.financeAndAccounting),
      strategyAndOps: round1(caps.strategyAndOps),
      legal: round1(caps.legal),
      healthcareAndMedical: round1(caps.healthcareAndMedical),
      economics: round1(caps.economics),
      frontierCode20: pctFromFraction(m.frontierCode20),
      terminalBench40: pctFromFraction(m.terminalBench40),
      terminalBenchScience: pctFromFraction(m.terminalBenchScience),
      hleDiamond: pctFromFraction(m.hleDiamond),
      critptAgenticHard: pctFromFraction(m.critptAgenticHard),
      automationBench: pctFromFraction(m.automationBenchPartialScore),
      omniscienceAccuracy: pctFromFraction(m.omniscienceAccuracy),
      gdpPdfAllPass: pctFromFraction(m.gdpPdfAllPass),
      lcr: pctFromFraction(m.lcr),
      scicode: pctFromFraction(m.scicode),
      gdpval: round1(m.gdpval),
    },
    costPerTaskUsd: toNum(cptCost?.total),
    costPerTaskBreakdown: cptCost
      ? {
          total: toNum(cptCost.total),
          input: toNum(cptCost.input),
          nonCacheInput: toNum(cptCost.nonCacheInput),
          cacheRead: toNum(cptCost.cacheRead),
          cacheWrite: toNum(cptCost.cacheWrite),
          output: toNum(cptCost.output),
          reasoning: toNum(cptCost.reasoning),
          answer: toNum(cptCost.answer),
        }
      : null,
    costPerTaskEvaluations: Array.isArray(m.intelligenceIndexCostPerTask?.evaluations)
      ? m.intelligenceIndexCostPerTask.evaluations.map((e) => ({
          slug: e.slug,
          weightedCostPerTask: toNum(e.weightedCostPerTask),
        }))
      : null,
    totalIndexCostUsd: toNum(totalCost?.total),
    totalIndexCostBreakdown: totalCost
      ? {
          total: toNum(totalCost.total),
          input: toNum(totalCost.input),
          output: toNum(totalCost.output),
          reasoning: toNum(totalCost.reasoning),
          answer: toNum(totalCost.answer),
          cacheRead: toNum(totalCost.cacheRead),
          cacheWrite: toNum(totalCost.cacheWrite),
          nonCacheInput: toNum(totalCost.nonCacheInput),
        }
      : null,
    pricing: {
      inputPer1M: toNum(m.price1mInputTokens),
      outputPer1M: toNum(m.price1mOutputTokens),
      cacheHitPer1M: toNum(m.cacheHitPrice),
      blended3to1Per1M: toNum(m.price1mBlended0To3To1),
      blended7to2to1Per1M: toNum(m.price1mBlended7To2To1),
    },
    speed: {
      outputTokPerSec: toNum(m.headline?.outputSpeed),
      ttftSec: toNum(m.headline?.timeToFirstToken),
      timePerTaskSec: toNum(m.intelligenceIndexTimePerTask),
    },
    outputTokensPerTask: m.intelligenceIndexOutputTokensPerTask
      ? {
          total: toNum(m.intelligenceIndexOutputTokensPerTask.output),
          reasoning: toNum(m.intelligenceIndexOutputTokensPerTask.reasoning),
          answer: toNum(m.intelligenceIndexOutputTokensPerTask.answer),
        }
      : null,
    sourceUrl: `https://artificialanalysis.ai/models/${m.slug}`,
  };
}

function parseAaApiV2(json) {
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.map((m) => ({
    slug: m.slug,
    name: m.name || m.slug,
    shortName: m.name || m.slug,
    creatorName: m.model_creator?.name || null,
    creatorSlug: m.model_creator?.slug || null,
    creatorColor: null,
    releaseDate: m.release_date || null,
    isOpenWeights: false,
    contextWindowTokens: null,
    intelligenceIndex: toNum(m.evaluations?.artificial_analysis_intelligence_index),
    costPerTaskUsd: null,
    costPerTaskBreakdown: null,
    costPerTaskEvaluations: null,
    totalIndexCostUsd: null,
    totalIndexCostBreakdown: null,
    pricing: {
      inputPer1M: toNum(m.pricing?.price_1m_input_tokens),
      outputPer1M: toNum(m.pricing?.price_1m_output_tokens),
      cacheHitPer1M: null,
      blended3to1Per1M: toNum(m.pricing?.price_1m_blended_3_to_1),
      blended7to2to1Per1M: null,
    },
    speed: {
      outputTokPerSec: toNum(m.median_output_tokens_per_second),
      ttftSec: toNum(m.median_time_to_first_token_seconds),
      timePerTaskSec: null,
    },
    outputTokensPerTask: null,
    sourceUrl: `https://artificialanalysis.ai/models/${m.slug}`,
  }));
}

function parseMyPriorsHtml(html) {
  const rsc = extractNextRscText(html);
  const idx = rsc.indexOf('"sellers":');
  if (idx === -1) {
    throw new Error("Could not locate sellers payload in mypriors.com/subsidies HTML");
  }
  const openBrace = rsc.lastIndexOf("{", idx);
  const payload = extractBalancedJson(rsc, openBrace);
  return {
    sellers: Array.isArray(payload.sellers) ? payload.sellers : [],
    labColors: payload.labColors || {},
  };
}

function parseListPriceDict(raw) {
  if (!raw) return null;
  try {
    const jsonish = raw.replace(/'/g, '"');
    const obj = JSON.parse(jsonish);
    return {
      inputPer1M: toNum(obj.input),
      outputPer1M: toNum(obj.output),
      cacheHitPer1M: toNum(obj.cached),
      currency: obj.currency || "USD",
    };
  } catch {
    return null;
  }
}

function normalizePlanName(name) {
  const s = String(name || "").trim();
  if (/^Claude Max 20x\b/i.test(s)) return "Claude Ultra";
  if (/^Claude Max 5x\b/i.test(s)) return "Claude Max";
  return s.replace(/\s*\(9\/14\+\)/, "");
}

function cleanVendorName(vendor, creatorName) {
  if (vendor) return vendor;
  if (creatorName) return creatorName;
  return "Other";
}

function vendorColor(vendor, aaModel) {
  if (aaModel?.creatorColor) return aaModel.creatorColor;
  if (VENDOR_COLORS[vendor]) return VENDOR_COLORS[vendor];
  for (const [k, v] of Object.entries(VENDOR_COLORS)) {
    if (vendor && vendor.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return "#64748B";
}

function resolveAaModel(modelId, aaByNorm) {
  const norm = normSlug(modelId);
  if (aaByNorm.has(norm)) return aaByNorm.get(norm);
  const alias = MODEL_ALIASES[norm];
  if (alias && aaByNorm.has(alias)) return aaByNorm.get(alias);
  return null;
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, ...headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshData({ fromLocal = false, silent = false } = {}) {
  const log = (...args) => {
    if (!silent) console.log("[refresh]", ...args);
  };

  const nowIso = new Date().toISOString();
  const sourceStatus = {
    fei2411: {
      name: "Fei2411/real-api-pricing",
      url: "https://github.com/Fei2411/real-api-pricing",
      rawUrl: SOURCES.feiPointsCsv,
      ok: false,
      fetchedAt: null,
      rowCount: 0,
      error: null,
    },
    artificialAnalysis: {
      name: "Artificial Analysis (#price-cost)",
      url: "https://artificialanalysis.ai/models#price-cost",
      ok: false,
      fetchedAt: null,
      modelCount: 0,
      usedApiV2: false,
      error: null,
    },
    mypriors: {
      name: "mypriors.com/subsidies",
      url: "https://mypriors.com/subsidies",
      ok: false,
      fetchedAt: null,
      sellerCount: 0,
      preliminaryCount: 0,
      error: null,
    },
  };

  let feiCsvText = null;
  let aaHtml = null;
  let aaV2Json = null;
  let mypriorsHtml = null;

  if (fromLocal) {
    log("Reading local fixture snapshots from /tmp ...");
    if (fs.existsSync("/tmp/fei_points.csv")) {
      feiCsvText = fs.readFileSync("/tmp/fei_points.csv", "utf8");
    }
    if (fs.existsSync("/tmp/aa_models.html")) {
      aaHtml = fs.readFileSync("/tmp/aa_models.html", "utf8");
    }
    if (fs.existsSync("/tmp/mypriors_subsidies.html")) {
      mypriorsHtml = fs.readFileSync("/tmp/mypriors_subsidies.html", "utf8");
    }
  } else {
    const tasks = [
      fetchText(SOURCES.feiPointsCsv)
        .then((t) => {
          feiCsvText = t;
        })
        .catch((err) => {
          sourceStatus.fei2411.error = err.message;
        }),
      fetchText(SOURCES.aaModelsPage)
        .then((t) => {
          aaHtml = t;
        })
        .catch((err) => {
          sourceStatus.artificialAnalysis.error = err.message;
        }),
      fetchText(SOURCES.mypriorsSubsidies)
        .then((t) => {
          mypriorsHtml = t;
        })
        .catch((err) => {
          sourceStatus.mypriors.error = err.message;
        }),
    ];

    if (process.env.AA_API_KEY) {
      tasks.push(
        fetchText(SOURCES.aaApiV2, { "x-api-key": process.env.AA_API_KEY })
          .then((t) => {
            aaV2Json = JSON.parse(t);
          })
          .catch((err) => {
            log("Optional AA_API_KEY fetch failed:", err.message);
          })
      );
    }

    await Promise.all(tasks);
  }

  // 1. Parse Artificial Analysis models
  const aaByNorm = new Map();
  if (aaHtml) {
    try {
      const models = parseAaModelsHtml(aaHtml);
      for (const m of models) {
        aaByNorm.set(normSlug(m.slug), m);
      }
      sourceStatus.artificialAnalysis.ok = true;
      sourceStatus.artificialAnalysis.fetchedAt = nowIso;
      sourceStatus.artificialAnalysis.modelCount = models.length;
      log(`Parsed ${models.length} live models from Artificial Analysis #price-cost`);
    } catch (err) {
      sourceStatus.artificialAnalysis.error = err.message;
      log("AA HTML parse error:", err.message);
    }
  }

  if (aaV2Json) {
    try {
      const v2Models = parseAaApiV2(aaV2Json);
      for (const m of v2Models) {
        const key = normSlug(m.slug);
        if (!aaByNorm.has(key)) {
          aaByNorm.set(key, m);
        }
      }
      sourceStatus.artificialAnalysis.usedApiV2 = true;
      sourceStatus.artificialAnalysis.modelCount = aaByNorm.size;
      log(`Enriched with ${v2Models.length} models from AA API v2`);
    } catch (err) {
      log("AA API v2 parse error:", err.message);
    }
  }

  // 2. Parse Fei2411 derived/points.csv
  let feiRows = [];
  if (feiCsvText) {
    try {
      feiRows = parseCsv(feiCsvText);
      sourceStatus.fei2411.ok = true;
      sourceStatus.fei2411.fetchedAt = nowIso;
      sourceStatus.fei2411.rowCount = feiRows.length;
      log(`Parsed ${feiRows.length} rows from Fei2411/real-api-pricing`);
    } catch (err) {
      sourceStatus.fei2411.error = err.message;
      log("Fei CSV parse error:", err.message);
    }
  }

  // 3. Parse MyPriors subsidies
  let mpPayload = { sellers: [], labColors: {} };
  if (mypriorsHtml) {
    try {
      mpPayload = parseMyPriorsHtml(mypriorsHtml);
      sourceStatus.mypriors.ok = true;
      sourceStatus.mypriors.fetchedAt = nowIso;
      sourceStatus.mypriors.sellerCount = mpPayload.sellers.length;
      log(`Parsed ${mpPayload.sellers.length} sellers from mypriors.com/subsidies`);
    } catch (err) {
      sourceStatus.mypriors.error = err.message;
      log("MyPriors HTML parse error:", err.message);
    }
  }

  if (!sourceStatus.fei2411.ok && !sourceStatus.artificialAnalysis.ok) {
    throw new Error(
      `All primary sources failed. Fei2411: ${sourceStatus.fei2411.error}; AA: ${sourceStatus.artificialAnalysis.error}`
    );
  }

  // Build unified records
  const entries = [];
  const coveredMeteredAaSlugs = new Set();
  const feiSubIndex = new Map(); // `${normPlan}::${aaSlug}` -> entry id
  const feiVendorFeeModelIndex = new Map(); // `${normVendor}::${roundFee}::${aaSlug}` -> entry id
  let latestFeiDate = "";

  for (const r of feiRows) {
    const modelId = r.model;
    const billing = r.billing === "metered" ? "metered" : "subscription";
    const aaModel = resolveAaModel(modelId, aaByNorm);

    const feiAaIntel = toNum(r.aa_intelligence_index__score);
    const feiAaCpt = toNum(r.aa_intelligence_index__mean_cost_usd_per_task);

    const intelligenceIndex = aaModel?.intelligenceIndex ?? feiAaIntel;
    const aaCostPerTaskUsd = aaModel?.costPerTaskUsd ?? feiAaCpt;

    // Only keep entries that have BOTH intelligence and cost-per-task so every point on the page is meaningful
    if (intelligenceIndex === null || aaCostPerTaskUsd === null || aaCostPerTaskUsd <= 0) {
      continue;
    }

    const unmetered = String(r.unmetered).toLowerCase() === "true";
    const priceUsd = toNum(r.price_usd);
    const monthlyYi = toNum(r.monthly_yi);
    const realUsdPerMtok = toNum(r.real_usd_per_mtok);
    const listBlendedUsdPerMtok = toNum(r.list_blended_usd_per_mtok);
    const discountRatio = toNum(r.d);

    let subsidyMultiple = null;
    if (billing === "metered") {
      subsidyMultiple = 1;
    } else if (unmetered) {
      subsidyMultiple = null; // handled as unmetered (~infinite)
    } else if (discountRatio && discountRatio > 0) {
      subsidyMultiple = 1 / discountRatio;
    } else if (
      listBlendedUsdPerMtok &&
      realUsdPerMtok &&
      listBlendedUsdPerMtok > 0 &&
      realUsdPerMtok > 0
    ) {
      subsidyMultiple = listBlendedUsdPerMtok / realUsdPerMtok;
    }

    if (billing === "subscription" && !unmetered && (!subsidyMultiple || subsidyMultiple <= 0)) {
      continue;
    }

    const aaSlug = aaModel?.slug || normSlug(modelId);
    if (billing === "metered") {
      coveredMeteredAaSlugs.add(aaSlug);
    }

    const planName = normalizePlanName(r.plan_en || r.plan || "");
    const vendor = cleanVendorName(r.vendor, aaModel?.creatorName);
    const feiListPrice = parseListPriceDict(r.list_price);
    const pricing = aaModel?.pricing?.inputPer1M !== null && aaModel?.pricing
      ? aaModel.pricing
      : {
          inputPer1M: feiListPrice?.inputPer1M ?? null,
          outputPer1M: feiListPrice?.outputPer1M ?? null,
          cacheHitPer1M: feiListPrice?.cacheHitPer1M ?? null,
          blended3to1Per1M:
            feiListPrice?.inputPer1M != null && feiListPrice?.outputPer1M != null
              ? (3 * feiListPrice.inputPer1M + feiListPrice.outputPer1M) / 4
              : null,
          blended7to2to1Per1M: null,
        };

    if (r.data_date && r.data_date > latestFeiDate) {
      latestFeiDate = r.data_date;
    }

    const entryId = r.id || `${normSlug(planName)}::${normSlug(modelId)}`;
    const isOffPeak = /off-?peak|非高峰|夜间/i.test(`${r.plan} ${r.plan_en} ${r.note}`);

    const entry = {
      id: entryId,
      origin: "fei2411",
      isPreliminary: false,
      replacesId: null,
      billing,
      vendor,
      modelCreator: aaModel?.creatorName || vendor,
      color: vendorColor(aaModel?.creatorName || vendor, aaModel),
      plan: billing === "metered" ? "Pay-as-you-go API" : planName,
      planLocal: r.plan || planName,
      planUrl: resolvePlanUrl(planName, aaModel?.creatorName || vendor, billing),
      isOffPeak,
      unmetered,
      modelId: aaSlug,
      modelDisplay: r.model_display || aaModel?.shortName || modelId,
      aaVariant: aaModel?.name || r.aa_intelligence_index__variant || null,
      aaLive: Boolean(aaModel && aaModel.costPerTaskUsd !== null),
      aaUrl: aaModel?.sourceUrl || "https://artificialanalysis.ai/models#price-cost",
      isOpenWeights: Boolean(aaModel?.isOpenWeights),
      contextWindowTokens: aaModel?.contextWindowTokens ?? null,
      priceUsd: billing === "metered" ? null : priceUsd,
      monthlyTokens: monthlyYi !== null ? Math.round(monthlyYi * 1e8) : null,
      realUsdPerMtok,
      listBlendedUsdPerMtok,
      subsidyMultiple: subsidyMultiple !== null ? Number(subsidyMultiple.toFixed(4)) : null,
      intelligenceIndex: Number(intelligenceIndex.toFixed(2)),
      benchmarks: aaModel?.benchmarks
        ? {
            ...aaModel.benchmarks,
            intelligenceIndex: round1(intelligenceIndex),
            terminalBench40:
              aaModel.benchmarks.terminalBench40 ?? round1(r.aa_terminal_bench_4__score),
          }
        : {
            intelligenceIndex: round1(intelligenceIndex),
            terminalBench40: round1(r.aa_terminal_bench_4__score),
          },
      aaCostPerTaskUsd: Number(aaCostPerTaskUsd.toFixed(4)),
      aaCostPerTaskBreakdown: aaModel?.costPerTaskBreakdown || null,
      aaTotalIndexCostUsd: aaModel?.totalIndexCostUsd ?? null,
      aaTotalIndexCostBreakdown: aaModel?.totalIndexCostBreakdown || null,
      aaPricing: pricing,
      aaSpeed: aaModel?.speed || null,
      aaOutputTokensPerTask: aaModel?.outputTokensPerTask || null,
      codingAgentScore: toNum(r.aa_coding_agent_index__score),
      terminalBench4Score: toNum(r.terminal_bench_4__score),
      confidence: (r.confidence || (billing === "metered" ? "high" : "medium")).toLowerCase(),
      workload: r.workload || null,
      dataDate: r.data_date || null,
      promoUntil: r.promo_until || null,
      sourceNote: r.source || null,
      decisionNote: r.note || null,
      preliminary: null,
    };

    entries.push(entry);
    if (billing === "subscription") {
      feiSubIndex.set(`${normSlug(planName)}::${aaSlug}`, entryId);
      if (priceUsd !== null) {
        feiVendorFeeModelIndex.set(
          `${normSlug(vendor)}::${Math.round(priceUsd)}::${aaSlug}`,
          entryId
        );
      }
    }
  }

  // 4. Ensure EVERY live Artificial Analysis flagship model with public costPerTask has a Metered API (1x) baseline row
  for (const aaModel of aaByNorm.values()) {
    if (
      aaModel.intelligenceIndex === null ||
      aaModel.costPerTaskUsd === null ||
      aaModel.costPerTaskUsd <= 0
    ) {
      continue;
    }
    if (coveredMeteredAaSlugs.has(aaModel.slug)) continue;

    const creator = aaModel.creatorName || "Other";
    entries.push({
      id: `aa-metered::${aaModel.slug}`,
      origin: "artificial-analysis",
      isPreliminary: false,
      replacesId: null,
      billing: "metered",
      vendor: creator,
      modelCreator: creator,
      color: vendorColor(creator, aaModel),
      plan: "Pay-as-you-go API",
      planLocal: "Pay-as-you-go API",
      planUrl: resolvePlanUrl("Pay-as-you-go API", creator, "metered"),
      isOffPeak: false,
      unmetered: false,
      modelId: aaModel.slug,
      modelDisplay: aaModel.shortName || aaModel.name,
      aaVariant: aaModel.name,
      aaLive: true,
      aaUrl: aaModel.sourceUrl,
      isOpenWeights: aaModel.isOpenWeights,
      contextWindowTokens: aaModel.contextWindowTokens,
      priceUsd: null,
      monthlyTokens: null,
      realUsdPerMtok: aaModel.pricing?.blended7to2to1Per1M ?? aaModel.pricing?.blended3to1Per1M ?? null,
      listBlendedUsdPerMtok:
        aaModel.pricing?.blended7to2to1Per1M ?? aaModel.pricing?.blended3to1Per1M ?? null,
      subsidyMultiple: 1,
      intelligenceIndex: Number(aaModel.intelligenceIndex.toFixed(2)),
      benchmarks: aaModel.benchmarks || { intelligenceIndex: round1(aaModel.intelligenceIndex) },
      aaCostPerTaskUsd: Number(aaModel.costPerTaskUsd.toFixed(4)),
      aaCostPerTaskBreakdown: aaModel.costPerTaskBreakdown,
      aaTotalIndexCostUsd: aaModel.totalIndexCostUsd,
      aaTotalIndexCostBreakdown: aaModel.totalIndexCostBreakdown,
      aaPricing: aaModel.pricing,
      aaSpeed: aaModel.speed,
      aaOutputTokensPerTask: aaModel.outputTokensPerTask,
      codingAgentScore: null,
      terminalBench4Score: null,
      confidence: "high",
      workload: "aa-benchmark",
      dataDate: aaModel.releaseDate || nowIso.slice(0, 10),
      promoUntil: null,
      sourceNote: "Artificial Analysis live #price-cost",
      decisionNote: "Direct first-party API list pricing (1.0× baseline).",
      preliminary: null,
    });
    coveredMeteredAaSlugs.add(aaModel.slug);
  }

  // 5. Layer MyPriors entries (preliminary community reports, assumed new-gen carryovers,
  //    and newly modeled rows like Gemini 4 Hydrogen / Claude Fable 5.2 not yet in Fei2411)
  let prelimCount = 0;
  let assumedCount = 0;
  let mypriorsExtraCount = 0;

  for (const seller of mpPayload.sellers) {
    for (const plan of seller.plans || []) {
      for (const m of plan.models || []) {
        if (!m.multiple || m.multiple <= 0) continue;
        const aaModel = resolveAaModel(m.id, aaByNorm);
        if (!aaModel || aaModel.intelligenceIndex === null || aaModel.costPerTaskUsd === null) {
          continue;
        }
        const normalizedMpPlan = normalizePlanName(plan.plan);
        const planSlug = normSlug(normalizedMpPlan);
        const aaSlug = aaModel.slug;
        const feeUsd = toNum(plan.feeUsd);
        const existingId =
          feiSubIndex.get(`${planSlug}::${aaSlug}`) ||
          (feeUsd !== null
            ? feiVendorFeeModelIndex.get(`${normSlug(seller.name)}::${Math.round(feeUsd)}::${aaSlug}`)
            : null);

        const isPrelim = Boolean(m.preliminary);
        const isAssumed = Boolean(m.assumed);

        // If Fei2411 already covers this (plan, model) and MyPriors has no newer preliminary override, skip duplicate
        if (existingId && !isPrelim) continue;

        let origin = "mypriors";
        let estimateType = null;
        if (isPrelim) {
          origin = "mypriors-preliminary";
          estimateType = "preliminary";
          prelimCount++;
        } else if (isAssumed) {
          origin = "mypriors-assumed";
          estimateType = "assumed";
          assumedCount++;
        } else {
          mypriorsExtraCount++;
        }

        const isEstimated = isPrelim || isAssumed;
        const replacesId = isPrelim ? existingId : null;

        entries.push({
          id: `${origin}::${normSlug(seller.id)}::${planSlug}::${aaSlug}`,
          origin,
          isPreliminary: isEstimated,
          estimateType,
          replacesId,
          billing: "subscription",
          vendor: seller.name,
          modelCreator: aaModel.creatorName || seller.name,
          color: vendorColor(aaModel.creatorName || seller.name, aaModel),
          plan: normalizedMpPlan,
          planLocal: plan.plan,
          planUrl: resolvePlanUrl(normalizedMpPlan, seller.name, "subscription"),
          isOffPeak: /off-?peak/i.test(plan.plan),
          unmetered: false,
          modelId: aaSlug,
          modelDisplay: m.name || aaModel.shortName,
          aaVariant: aaModel.name,
          aaLive: true,
          aaUrl: aaModel.sourceUrl,
          isOpenWeights: aaModel.isOpenWeights,
          contextWindowTokens: aaModel.contextWindowTokens,
          priceUsd: feeUsd,
          monthlyTokens: null,
          realUsdPerMtok:
            aaModel.pricing?.blended7to2to1Per1M != null
              ? aaModel.pricing.blended7to2to1Per1M / m.multiple
              : null,
          listBlendedUsdPerMtok: aaModel.pricing?.blended7to2to1Per1M ?? null,
          subsidyMultiple: Number(m.multiple.toFixed(4)),
          intelligenceIndex: Number(aaModel.intelligenceIndex.toFixed(2)),
          benchmarks: aaModel.benchmarks || { intelligenceIndex: round1(aaModel.intelligenceIndex) },
          aaCostPerTaskUsd: Number(aaModel.costPerTaskUsd.toFixed(4)),
          aaCostPerTaskBreakdown: aaModel.costPerTaskBreakdown,
          aaTotalIndexCostUsd: aaModel.totalIndexCostUsd,
          aaTotalIndexCostBreakdown: aaModel.totalIndexCostBreakdown,
          aaPricing: aaModel.pricing,
          aaSpeed: aaModel.speed,
          aaOutputTokensPerTask: aaModel.outputTokensPerTask,
          codingAgentScore: null,
          terminalBench4Score: null,
          confidence: isEstimated ? "low" : "medium",
          workload: isPrelim
            ? "community-report"
            : isAssumed
              ? "mypriors-assumed"
              : "mypriors-modeled",
          dataDate: nowIso.slice(0, 10),
          promoUntil: null,
          sourceNote: isPrelim
            ? m.preliminary.credit
              ? `mypriors.com/subsidies (${m.preliminary.credit})`
              : "mypriors.com/subsidies preliminary"
            : isAssumed
              ? "mypriors.com/subsidies (assumed from prior-gen quota)"
              : "mypriors.com/subsidies",
          decisionNote: isPrelim
            ? m.preliminary.note || m.preliminary.short || null
            : isAssumed
              ? "Assumed subsidy multiple carried over from the same plan's measured sibling/prior-generation model on mypriors.com/subsidies."
              : "Modeled subscription multiple from mypriors.com/subsidies.",
          preliminary: isPrelim
            ? {
                label: m.preliminary.label || "Preliminary",
                short: m.preliminary.short || "",
                note: m.preliminary.note || "",
                credit: m.preliminary.credit || "",
                sourceUrl: m.preliminary.source || "https://mypriors.com/subsidies",
                sources: Array.isArray(m.preliminary.sources) ? m.preliminary.sources : [],
              }
            : isAssumed
              ? {
                  label: "Assumed",
                  short: "Estimated from prior-generation quota on the same plan (mypriors.com/subsidies).",
                  note: "Pending direct saturation measurement on this model release.",
                  credit: "mypriors.com/subsidies",
                  sourceUrl: "https://mypriors.com/subsidies",
                  sources: [],
                }
              : null,
        });
      }
    }
  }
  sourceStatus.mypriors.preliminaryCount = prelimCount;
  sourceStatus.mypriors.assumedCount = assumedCount;
  sourceStatus.mypriors.extraMeasuredCount = mypriorsExtraCount;

  // Sort deterministically by effective cost per task at 100% utilization
  entries.sort((a, b) => {
    const effA = a.unmetered ? 0 : a.aaCostPerTaskUsd / (a.subsidyMultiple || 1);
    const effB = b.unmetered ? 0 : b.aaCostPerTaskUsd / (b.subsidyMultiple || 1);
    return effA - effB;
  });

  const payload = {
    schemaVersion: 1,
    generatedAt: nowIso,
    latestDataDate: latestFeiDate || nowIso.slice(0, 10),
    sources: sourceStatus,
    stats: {
      totalEntries: entries.length,
      subscriptions: entries.filter((e) => e.billing === "subscription" && !e.isPreliminary).length,
      meteredApis: entries.filter((e) => e.billing === "metered").length,
      mypriorsEstimates: prelimCount + assumedCount,
      mypriorsPreliminary: prelimCount,
      mypriorsAssumed: assumedCount,
      mypriorsExtraMeasured: mypriorsExtraCount,
      uniqueModels: new Set(entries.map((e) => e.modelId)).size,
      liveAaModels: aaByNorm.size,
    },
    entries,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const tmpPath = `${OUTPUT_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, OUTPUT_PATH);

  log(
    `Wrote ${OUTPUT_PATH} (${payload.stats.totalEntries} entries: ${payload.stats.subscriptions} subs, ${payload.stats.meteredApis} APIs, ${payload.stats.mypriorsPreliminary} MyPriors prelim across ${payload.stats.uniqueModels} models)`
  );
  return payload;
}

// Run directly from CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fromLocal = process.argv.includes("--from-local");
  refreshData({ fromLocal }).catch((err) => {
    console.error("[refresh] Fatal error:", err);
    process.exit(1);
  });
}
