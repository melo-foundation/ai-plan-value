#!/usr/bin/env node
/**
 * Fetches and merges live data from 5 upstream sources:
 *   1. Fei2411/real-api-pricing (derived/points.csv) — empirical subscription quotas & workloads
 *   2. adamholter/priors (data/snapshots/latest.json.gz) — clean raw-GitHub snapshot for Priors subsidies
 *   3. artificialanalysis.ai/models (#price-cost SSR payload + optional AA_API_KEY v2 API)
 *   4. GitHub Copilot Plans (https://github.com/features/copilot/plans) — live-verified AI Credit pools
 *   5. Ollama Pricing (https://ollama.com/pricing) — live-verified Ollama Cloud Team credit pool
 *
 * Writes normalized dataset to public/data/combined.json.
 * Zero external npm dependencies (requires Node.js >= 20).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT_DIR, "public", "data", "combined.json");

const SOURCES = {
  feiPointsCsv:
    "https://raw.githubusercontent.com/Fei2411/real-api-pricing/main/derived/points.csv",
  priorsSnapshotGz:
    "https://raw.githubusercontent.com/adamholter/priors/main/data/snapshots/latest.json.gz",
  aaModelsPage: "https://artificialanalysis.ai/models",
  aaApiV2: "https://artificialanalysis.ai/api/v2/data/llms/models",
  githubCopilotPlans: "https://github.com/features/copilot/plans",
  ollamaPricing: "https://ollama.com/pricing",
};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Verified exact slug aliases between Fei2411/Priors model IDs and Artificial Analysis slugs.
const MODEL_ALIASES = {
  hy4: "tencent-hy4",
  "hy-4": "tencent-hy4",
  "deepseek-v4-1-flash": "deepseek-v4-1-flash-1017",
  "ling-3-1-flash-1019": "ling-3-1-flash",
  "kimi-k3-1": "kimi-k3-1-pro",
  "qwen-4-max": "qwen4-max",
  "qwen-3-8-27b": "qwen3-8-27b",
  "aa-muse-wonder": "muse-wonder",
  "gemini-4": "gemini-4-argon",
};

// Officially documented GitHub Copilot AI-credit models (docs.github.com/en/copilot)
const GITHUB_COPILOT_MODELS = [
  "gpt-6-luna",
  "gpt-6-1-terra",
  "gpt-6-2-sol",
  "gpt-6-2-astra",
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-2",
  "gemini-4-hydrogen",
  "gemini-4-carbon",
  "gemini-4-neon",
  "gemini-4-argon",
];

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
  GitHub: "#24292F",
};

// Verified first-party subscription plan & API pricing URLs
const PLAN_URL_PATTERNS = [
  [/^claude\b/i, "https://claude.com/pricing"],
  [/^chatgpt\b/i, "https://openai.com/chatgpt/pricing/"],
  [/^google ai\b/i, "https://one.google.com/about/google-ai-plans/"],
  [/^github copilot\b/i, "https://github.com/features/copilot/plans"],
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

function pctFromFraction(v) {
  const n = toNum(v);
  if (n === null) return null;
  return Number((n <= 1.001 ? n * 100 : n).toFixed(1));
}

function round1(v) {
  const n = toNum(v);
  return n === null ? null : Number(n.toFixed(1));
}

function normalizePlanName(name) {
  const s = String(name || "").trim();
  if (/^Claude Max 20x\b/i.test(s)) return "Claude Ultra";
  if (/^Claude Max 5x\b/i.test(s)) return "Claude Max";
  return s.replace(/\s*\(9\/14\+\)/, "");
}

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

function vendorFromPlan(planName, fallbackVendor) {
  const p = String(planName || "");
  if (/^claude\b/i.test(p)) return "Anthropic";
  if (/^chatgpt\b/i.test(p)) return "OpenAI";
  if (/^google ai\b/i.test(p)) return "Google";
  if (/^github copilot\b/i.test(p)) return "GitHub";
  if (/^supergrok\b/i.test(p)) return "xAI";
  if (/^cursor\b/i.test(p)) return "Cursor";
  if (/^devin\b/i.test(p)) return "Devin";
  if (/^droid\b/i.test(p)) return "Factory";
  if (/^opencode\b/i.test(p)) return "OpenCode";
  if (/^command code\b/i.test(p)) return "Command Code";
  if (/^ollama\b/i.test(p)) return "Ollama";
  if (/^deeprelay\b/i.test(p)) return "DeepRelay";
  if (/^mistral\b/i.test(p)) return "Mistral";
  if (/^glm coding\b/i.test(p)) return "Z.ai";
  if (/qwen|alibaba|阿里云百炼/i.test(p)) return "Alibaba";
  if (/^minimax\b/i.test(p)) return "MiniMax";
  if (/^tencent\b/i.test(p)) return "Tencent";
  if (/^mimo\b/i.test(p)) return "Xiaomi";
  if (/^step plan/i.test(p)) return "StepFun";
  return fallbackVendor || "Other";
}

function cleanVendorName(vendor, creatorName) {
  return vendor || creatorName || "Other";
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

/**
 * RFC-4180 compliant CSV parser.
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
  for (const line of rsc.split("\n")) {
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
      // try next line
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
    totalIndexCostUsd: toNum(totalCost?.total),
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
    benchmarks: {
      intelligenceIndex: round1(m.evaluations?.artificial_analysis_intelligence_index),
    },
    costPerTaskUsd: null,
    costPerTaskBreakdown: null,
    totalIndexCostUsd: null,
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
    sourceUrl: `https://artificialanalysis.ai/models/${m.slug}`,
  }));
}

/**
 * Parse adamholter/priors raw-GitHub snapshot (latest.json.gz).
 * Extracts all `subscription-token-price` (model, plan) entries with exact blended multiples.
 */
function parsePriorsSnapshot(snapshot) {
  const modelsById = new Map();
  for (const m of snapshot.models || []) {
    modelsById.set(m.id, m);
  }

  const out = [];
  for (const obs of snapshot.observations || []) {
    if (obs.benchmarkId !== "subscription-token-price") continue;
    const modelId = String(obs.variantId || "").split("@")[0];
    const det = obs.details || {};
    const lp = det.listPrice || {};
    const mix = det.mix || { cache: 0.97, input: 0.025, output: 0.005 };

    const cacheWritePrice =
      lp.cacheWrite != null ? Number(lp.cacheWrite) : Number(lp.input || 0) * 1.25;
    const blendedList =
      Number(mix.cache || 0) * Number(lp.cached || 0) +
      Number(mix.input || 0) * Number(lp.input || 0) +
      Number(mix.cacheWrite || 0) * cacheWritePrice +
      Number(mix.output || 0) * Number(lp.output || 0);

    if (!Number.isFinite(blendedList) || blendedList <= 0) continue;

    const topIsAssumed = det.confidence === "assumed";
    const modelMeta = modelsById.get(modelId);

    for (const p of det.plans || []) {
      const usdPerMtok = toNum(p.usdPerMtok);
      const feeUsd = toNum(p.feeUsd);
      if (!usdPerMtok || usdPerMtok <= 0) continue;

      const multiple = blendedList / usdPerMtok;
      if (!Number.isFinite(multiple) || multiple <= 0) continue;

      const isPrelim = Boolean(p.preliminary) || p.confidence === "preliminary";
      const isAssumed = !isPrelim && (topIsAssumed || p.confidence === "assumed");

      out.push({
        modelId,
        modelName: modelMeta?.name || modelId,
        plan: normalizePlanName(p.plan),
        planRaw: p.plan,
        feeUsd,
        usdPerMtok,
        blendedList,
        multiple,
        confidence: p.confidence || det.confidence || "medium",
        isPrelim,
        isAssumed,
        preliminary: p.preliminary || null,
        dataDate: det.dataDate || snapshot.date || null,
      });
    }
  }
  return { date: snapshot.date || null, items: out };
}

/**
 * Live-parse deterministic GitHub Copilot AI Credit tiers from https://github.com/features/copilot/plans.
 * Throws if GitHub changes the pricing/credit page structure so check-alerts.mjs opens a [Data Alert].
 */
function parseGithubCopilotPlansHtml(html) {
  const tiers = [
    {
      name: "GitHub Copilot Pro",
      priceRe: /"id":"Pro","heading":"Pro","subheading":[\s\S]{0,220}?"value":"\$(\d+)"/,
      creditRe: /\$(\d+(?:,\d+)?)\s+monthly total credits for Pro\b/,
    },
    {
      name: "GitHub Copilot Pro+",
      priceRe: /"id":"ProPlus","heading":"Pro\+","subheading":[\s\S]{0,220}?"value":"\$(\d+)"/,
      creditRe: /\$(\d+(?:,\d+)?)\s+monthly total credits for Pro\+/i,
    },
    {
      name: "GitHub Copilot Max",
      priceRe: /"id":"Max","heading":"Max","subheading":[\s\S]{0,220}?"value":"\$(\d+)"/,
      creditRe: /\$(\d+(?:,\d+)?)\s+monthly total credits for Max\b/,
    },
  ];

  const parsed = [];
  for (const t of tiers) {
    const pm = html.match(t.priceRe);
    const cm = html.match(t.creditRe);
    if (!pm || !cm) {
      throw new Error(`Could not verify ${t.name} fee/credits on github.com/features/copilot/plans`);
    }
    const feeUsd = Number(pm[1].replace(/,/g, ""));
    const creditsUsd = Number(cm[1].replace(/,/g, ""));
    if (!Number.isFinite(feeUsd) || !Number.isFinite(creditsUsd) || feeUsd <= 0 || creditsUsd <= 0) {
      throw new Error(`Invalid parsed numbers for ${t.name}`);
    }
    parsed.push({
      plan: t.name,
      feeUsd,
      creditsUsd,
      multiple: creditsUsd / feeUsd,
    });
  }
  return parsed;
}

/**
 * Live-parse deterministic Ollama Cloud pricing from https://ollama.com/pricing.
 * Verifies Team ($500 -> $1,000 credits = 2.0x) and throws on structural/price-parse failure.
 */
function parseOllamaPricingHtml(html) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const teamPriceMatch = text.match(/Team\s+(?:Early access\s+)?\$(\d+(?:,\d+)?)\s*\/\s*mo/i);
  const teamCreditsMatch = text.match(/\$(\d+(?:,\d+)?)\s+of usage credits per month,\s+shared across the team/i);

  if (!teamPriceMatch || !teamCreditsMatch) {
    throw new Error("Could not verify Ollama Team monthly fee and credit pool on ollama.com/pricing");
  }

  const feeUsd = Number(teamPriceMatch[1].replace(/,/g, ""));
  const creditsUsd = Number(teamCreditsMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(feeUsd) || !Number.isFinite(creditsUsd) || feeUsd <= 0 || creditsUsd <= 0) {
    throw new Error("Invalid parsed numbers for Ollama Team");
  }

  return [
    {
      plan: "Ollama Team",
      feeUsd,
      creditsUsd,
      multiple: creditsUsd / feeUsd,
    },
  ];
}

function parseListPriceDict(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw.replace(/'/g, '"'));
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

async function fetchBuffer(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, ...headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, headers = {}) {
  return (await fetchBuffer(url, headers)).toString("utf8");
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
    priorsRepo: {
      name: "adamholter/priors (latest.json.gz)",
      url: "https://github.com/adamholter/priors",
      rawUrl: SOURCES.priorsSnapshotGz,
      ok: false,
      fetchedAt: null,
      itemCount: 0,
      snapshotDate: null,
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
    githubCopilot: {
      name: "GitHub Copilot Plans",
      url: SOURCES.githubCopilotPlans,
      ok: false,
      fetchedAt: null,
      tierCount: 0,
      error: null,
    },
    ollamaCloud: {
      name: "Ollama Cloud Pricing",
      url: SOURCES.ollamaPricing,
      ok: false,
      fetchedAt: null,
      tierCount: 0,
      error: null,
    },
  };

  let feiCsvText = null;
  let priorsGzBuf = null;
  let aaHtml = null;
  let aaV2Json = null;
  let copilotHtml = null;
  let ollamaHtml = null;

  if (fromLocal) {
    log("Reading local fixture snapshots from /tmp ...");
    if (fs.existsSync("/tmp/fei_points.csv")) feiCsvText = fs.readFileSync("/tmp/fei_points.csv", "utf8");
    if (fs.existsSync("/tmp/priors_latest.json.gz")) priorsGzBuf = fs.readFileSync("/tmp/priors_latest.json.gz");
    if (fs.existsSync("/tmp/aa_models.html")) aaHtml = fs.readFileSync("/tmp/aa_models.html", "utf8");
    if (fs.existsSync("/tmp/copilot_plans.html")) copilotHtml = fs.readFileSync("/tmp/copilot_plans.html", "utf8");
    if (fs.existsSync("/tmp/ollama_pricing.html")) ollamaHtml = fs.readFileSync("/tmp/ollama_pricing.html", "utf8");
  } else {
    const tasks = [
      fetchText(SOURCES.feiPointsCsv)
        .then((t) => { feiCsvText = t; })
        .catch((err) => { sourceStatus.fei2411.error = err.message; }),
      fetchBuffer(SOURCES.priorsSnapshotGz)
        .then((b) => { priorsGzBuf = b; })
        .catch((err) => { sourceStatus.priorsRepo.error = err.message; }),
      fetchText(SOURCES.aaModelsPage)
        .then((t) => { aaHtml = t; })
        .catch((err) => { sourceStatus.artificialAnalysis.error = err.message; }),
      fetchText(SOURCES.githubCopilotPlans)
        .then((t) => { copilotHtml = t; })
        .catch((err) => { sourceStatus.githubCopilot.error = err.message; }),
      fetchText(SOURCES.ollamaPricing)
        .then((t) => { ollamaHtml = t; })
        .catch((err) => { sourceStatus.ollamaCloud.error = err.message; }),
    ];

    if (process.env.AA_API_KEY) {
      tasks.push(
        fetchText(SOURCES.aaApiV2, { "x-api-key": process.env.AA_API_KEY })
          .then((t) => { aaV2Json = JSON.parse(t); })
          .catch((err) => { log("Optional AA_API_KEY fetch failed:", err.message); })
      );
    }

    await Promise.all(tasks);
  }

  // 1. Parse Artificial Analysis models
  const aaByNorm = new Map();
  if (aaHtml) {
    try {
      const models = parseAaModelsHtml(aaHtml);
      for (const m of models) aaByNorm.set(normSlug(m.slug), m);
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
        if (!aaByNorm.has(key)) aaByNorm.set(key, m);
      }
      sourceStatus.artificialAnalysis.usedApiV2 = true;
      sourceStatus.artificialAnalysis.modelCount = aaByNorm.size;
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

  // 3. Parse adamholter/priors raw-GitHub gzip snapshot
  let priorsParsed = { date: null, items: [] };
  if (priorsGzBuf) {
    try {
      const rawJson = zlib.gunzipSync(priorsGzBuf).toString("utf8");
      priorsParsed = parsePriorsSnapshot(JSON.parse(rawJson));
      sourceStatus.priorsRepo.ok = true;
      sourceStatus.priorsRepo.fetchedAt = nowIso;
      sourceStatus.priorsRepo.itemCount = priorsParsed.items.length;
      sourceStatus.priorsRepo.snapshotDate = priorsParsed.date;
      log(`Parsed ${priorsParsed.items.length} plan×model entries from adamholter/priors (${priorsParsed.date})`);
    } catch (err) {
      sourceStatus.priorsRepo.error = err.message;
      log("Priors snapshot parse error:", err.message);
    }
  }

  // 4. Live-parse GitHub Copilot AI Credits tiers
  let copilotTiers = [];
  if (copilotHtml) {
    try {
      copilotTiers = parseGithubCopilotPlansHtml(copilotHtml);
      sourceStatus.githubCopilot.ok = true;
      sourceStatus.githubCopilot.fetchedAt = nowIso;
      sourceStatus.githubCopilot.tierCount = copilotTiers.length;
      log(
        `Verified ${copilotTiers.length} GitHub Copilot tiers: ` +
          copilotTiers.map((t) => `${t.plan} ($${t.feeUsd}→$${t.creditsUsd} = ${t.multiple.toFixed(2)}×)`).join(", ")
      );
    } catch (err) {
      sourceStatus.githubCopilot.error = err.message;
      log("GitHub Copilot parse error:", err.message);
    }
  }

  // 5. Live-parse Ollama Cloud Team pricing
  let ollamaTiers = [];
  if (ollamaHtml) {
    try {
      ollamaTiers = parseOllamaPricingHtml(ollamaHtml);
      sourceStatus.ollamaCloud.ok = true;
      sourceStatus.ollamaCloud.fetchedAt = nowIso;
      sourceStatus.ollamaCloud.tierCount = ollamaTiers.length;
      log(
        `Verified ${ollamaTiers.length} Ollama Cloud tier(s): ` +
          ollamaTiers.map((t) => `${t.plan} ($${t.feeUsd}→$${t.creditsUsd} = ${t.multiple.toFixed(2)}×)`).join(", ")
      );
    } catch (err) {
      sourceStatus.ollamaCloud.error = err.message;
      log("Ollama Cloud parse error:", err.message);
    }
  }

  if (!sourceStatus.fei2411.ok && !sourceStatus.priorsRepo.ok && !sourceStatus.artificialAnalysis.ok) {
    throw new Error(
      `All primary sources failed. Fei2411: ${sourceStatus.fei2411.error}; Priors: ${sourceStatus.priorsRepo.error}; AA: ${sourceStatus.artificialAnalysis.error}`
    );
  }

  // Build unified records
  const entries = [];
  const coveredMeteredAaSlugs = new Set();
  const feiSubIndex = new Map(); // `${normPlan}::${aaSlug}` -> entry id
  const feiVendorFeeModelIndex = new Map(); // `${normVendor}::${roundFee}::${aaSlug}` -> entry id
  const modelInfoBySlug = new Map(); // track model metadata (for adding Ollama Team / Copilot cleanly)
  const ollamaHostedSlugs = new Set();
  let latestFeiDate = "";

  for (const r of feiRows) {
    const modelId = r.model;
    const billing = r.billing === "metered" ? "metered" : "subscription";
    const aaModel = resolveAaModel(modelId, aaByNorm);

    const feiAaIntel = toNum(r.aa_intelligence_index__score);
    const feiAaCpt = toNum(r.aa_intelligence_index__mean_cost_usd_per_task);

    const intelligenceIndex = aaModel?.intelligenceIndex ?? feiAaIntel;
    const aaCostPerTaskUsd = aaModel?.costPerTaskUsd ?? feiAaCpt;

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
      subsidyMultiple = null;
    } else if (discountRatio && discountRatio > 0) {
      subsidyMultiple = 1 / discountRatio;
    } else if (listBlendedUsdPerMtok && realUsdPerMtok && listBlendedUsdPerMtok > 0 && realUsdPerMtok > 0) {
      subsidyMultiple = listBlendedUsdPerMtok / realUsdPerMtok;
    }

    if (billing === "subscription" && !unmetered && (!subsidyMultiple || subsidyMultiple <= 0)) {
      continue;
    }

    const aaSlug = aaModel?.slug || normSlug(modelId);
    if (billing === "metered") coveredMeteredAaSlugs.add(aaSlug);

    const planName = normalizePlanName(r.plan_en || r.plan || "");
    const vendor = cleanVendorName(r.vendor, aaModel?.creatorName);
    const feiListPrice = parseListPriceDict(r.list_price);
    const pricing =
      aaModel?.pricing?.inputPer1M !== null && aaModel?.pricing
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

    if (r.data_date && r.data_date > latestFeiDate) latestFeiDate = r.data_date;

    const entryId = r.id || `${normSlug(planName)}::${normSlug(modelId)}`;
    const isOffPeak = /off-?peak|非高峰|夜间/i.test(`${r.plan} ${r.plan_en} ${r.note}`);
    const benchmarks = aaModel?.benchmarks
      ? {
          ...aaModel.benchmarks,
          intelligenceIndex: round1(intelligenceIndex),
          terminalBench40: aaModel.benchmarks.terminalBench40 ?? round1(r.aa_terminal_bench_4__score),
        }
      : {
          intelligenceIndex: round1(intelligenceIndex),
          terminalBench40: round1(r.aa_terminal_bench_4__score),
        };

    const entry = {
      id: entryId,
      origin: "fei2411",
      isPreliminary: false,
      estimateType: null,
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
      benchmarks,
      aaCostPerTaskUsd: Number(aaCostPerTaskUsd.toFixed(4)),
      aaCostPerTaskBreakdown: aaModel?.costPerTaskBreakdown || null,
      aaTotalIndexCostUsd: aaModel?.totalIndexCostUsd ?? null,
      aaPricing: pricing,
      aaSpeed: aaModel?.speed || null,
      confidence: (r.confidence || (billing === "metered" ? "high" : "medium")).toLowerCase(),
      dataDate: r.data_date || null,
      sourceNote: r.source || null,
      decisionNote: r.note || null,
      preliminary: null,
    };

    entries.push(entry);
    if (!modelInfoBySlug.has(aaSlug)) modelInfoBySlug.set(aaSlug, entry);
    if (/^ollama\b/i.test(planName)) ollamaHostedSlugs.add(aaSlug);

    if (billing === "subscription") {
      feiSubIndex.set(`${normSlug(planName)}::${aaSlug}`, entryId);
      if (priceUsd !== null) {
        feiVendorFeeModelIndex.set(`${normSlug(vendor)}::${Math.round(priceUsd)}::${aaSlug}`, entryId);
      }
    }
  }

  // Ensure EVERY live Artificial Analysis flagship model has a Metered API (1x) baseline row
  for (const aaModel of aaByNorm.values()) {
    if (aaModel.intelligenceIndex === null || aaModel.costPerTaskUsd === null || aaModel.costPerTaskUsd <= 0) {
      continue;
    }
    if (coveredMeteredAaSlugs.has(aaModel.slug)) continue;

    const creator = aaModel.creatorName || "Other";
    const entry = {
      id: `aa-metered::${aaModel.slug}`,
      origin: "artificial-analysis",
      isPreliminary: false,
      estimateType: null,
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
      listBlendedUsdPerMtok: aaModel.pricing?.blended7to2to1Per1M ?? aaModel.pricing?.blended3to1Per1M ?? null,
      subsidyMultiple: 1,
      intelligenceIndex: Number(aaModel.intelligenceIndex.toFixed(2)),
      benchmarks: aaModel.benchmarks || { intelligenceIndex: round1(aaModel.intelligenceIndex) },
      aaCostPerTaskUsd: Number(aaModel.costPerTaskUsd.toFixed(4)),
      aaCostPerTaskBreakdown: aaModel.costPerTaskBreakdown,
      aaTotalIndexCostUsd: aaModel.totalIndexCostUsd,
      aaPricing: aaModel.pricing,
      aaSpeed: aaModel.speed,
      confidence: "high",
      dataDate: aaModel.releaseDate || nowIso.slice(0, 10),
      sourceNote: "Artificial Analysis live #price-cost",
      decisionNote: "Direct first-party API list pricing (1.0× baseline).",
      preliminary: null,
    };

    entries.push(entry);
    if (!modelInfoBySlug.has(aaModel.slug)) modelInfoBySlug.set(aaModel.slug, entry);
    coveredMeteredAaSlugs.add(aaModel.slug);
  }

  // Layer entries from adamholter/priors raw-GitHub snapshot (preliminary, assumed, and extra modeled plans)
  let prelimCount = 0;
  let assumedCount = 0;
  let priorsExtraCount = 0;
  const priorsSeen = new Set();

  for (const item of priorsParsed.items) {
    const aaModel = resolveAaModel(item.modelId, aaByNorm);
    const fallbackModel = !aaModel ? modelInfoBySlug.get(normSlug(item.modelId)) : null;
    const intel = aaModel?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
    const cpt = aaModel?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
    if (intel === null || cpt === null || cpt <= 0) continue;

    const aaSlug = aaModel?.slug || fallbackModel.modelId;
    const planSlug = normSlug(item.plan);
    const dedupeKey = `${planSlug}::${aaSlug}`;
    if (priorsSeen.has(dedupeKey)) continue;
    priorsSeen.add(dedupeKey);

    if (/^ollama\b/i.test(item.plan)) ollamaHostedSlugs.add(aaSlug);

    const sellerVendor = vendorFromPlan(item.plan, aaModel?.creatorName || fallbackModel?.modelCreator);
    const existingId =
      feiSubIndex.get(dedupeKey) ||
      (item.feeUsd !== null
        ? feiVendorFeeModelIndex.get(`${normSlug(sellerVendor)}::${Math.round(item.feeUsd)}::${aaSlug}`)
        : null);

    // Skip duplicates already covered by Fei2411 unless Priors has a newer preliminary measurement
    if (existingId && !item.isPrelim) continue;

    let origin = "priors-repo";
    let estimateType = null;
    if (item.isPrelim) {
      origin = "priors-preliminary";
      estimateType = "preliminary";
      prelimCount++;
    } else if (item.isAssumed) {
      origin = "priors-assumed";
      estimateType = "assumed";
      assumedCount++;
    } else {
      priorsExtraCount++;
    }

    const isEstimated = item.isPrelim || item.isAssumed;
    const replacesId = item.isPrelim ? existingId : null;
    const creator = aaModel?.creatorName || fallbackModel?.modelCreator || sellerVendor;

    entries.push({
      id: `${origin}::${planSlug}::${aaSlug}`,
      origin,
      isPreliminary: isEstimated,
      estimateType,
      replacesId,
      billing: "subscription",
      vendor: sellerVendor,
      modelCreator: creator,
      color: vendorColor(creator, aaModel),
      plan: item.plan,
      planLocal: item.planRaw,
      planUrl: resolvePlanUrl(item.plan, sellerVendor, "subscription"),
      isOffPeak: /off-?peak/i.test(item.plan),
      unmetered: false,
      modelId: aaSlug,
      modelDisplay: aaModel?.shortName || fallbackModel?.modelDisplay || item.modelName,
      aaVariant: aaModel?.name || fallbackModel?.aaVariant || null,
      aaLive: Boolean(aaModel),
      aaUrl: aaModel?.sourceUrl || fallbackModel?.aaUrl || "https://artificialanalysis.ai/models#price-cost",
      isOpenWeights: Boolean(aaModel?.isOpenWeights ?? fallbackModel?.isOpenWeights),
      contextWindowTokens: aaModel?.contextWindowTokens ?? fallbackModel?.contextWindowTokens ?? null,
      priceUsd: item.feeUsd,
      monthlyTokens: null,
      realUsdPerMtok: item.usdPerMtok,
      listBlendedUsdPerMtok: item.blendedList,
      subsidyMultiple: Number(item.multiple.toFixed(4)),
      intelligenceIndex: Number(intel.toFixed(2)),
      benchmarks: aaModel?.benchmarks || fallbackModel?.benchmarks || { intelligenceIndex: round1(intel) },
      aaCostPerTaskUsd: Number(cpt.toFixed(4)),
      aaCostPerTaskBreakdown: aaModel?.costPerTaskBreakdown || fallbackModel?.aaCostPerTaskBreakdown || null,
      aaTotalIndexCostUsd: aaModel?.totalIndexCostUsd ?? fallbackModel?.aaTotalIndexCostUsd ?? null,
      aaPricing: aaModel?.pricing || fallbackModel?.aaPricing || null,
      aaSpeed: aaModel?.speed || fallbackModel?.aaSpeed || null,
      confidence: isEstimated ? "low" : item.confidence || "medium",
      dataDate: item.dataDate || nowIso.slice(0, 10),
      sourceNote: "adamholter/priors (latest.json.gz)",
      decisionNote: item.preliminary?.note || item.preliminary?.short || null,
      preliminary: item.preliminary,
    });
  }

  // Layer live-verified first-party GitHub Copilot AI Credits tiers
  let copilotEntryCount = 0;
  for (const tier of copilotTiers) {
    for (const modelSlug of GITHUB_COPILOT_MODELS) {
      const aaModel = resolveAaModel(modelSlug, aaByNorm);
      const fallbackModel = !aaModel ? modelInfoBySlug.get(normSlug(modelSlug)) : null;
      const intel = aaModel?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
      const cpt = aaModel?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
      if (intel === null || cpt === null || cpt <= 0) continue;

      const aaSlug = aaModel?.slug || fallbackModel.modelId;
      const creator = aaModel?.creatorName || fallbackModel?.modelCreator || "GitHub";

      copilotEntryCount++;
      entries.push({
        id: `first-party::${normSlug(tier.plan)}::${aaSlug}`,
        origin: "github-copilot",
        isPreliminary: false,
        estimateType: null,
        replacesId: null,
        billing: "subscription",
        vendor: "GitHub",
        modelCreator: creator,
        color: vendorColor(creator, aaModel),
        plan: tier.plan,
        planLocal: tier.plan,
        planUrl: SOURCES.githubCopilotPlans,
        isOffPeak: false,
        unmetered: false,
        modelId: aaSlug,
        modelDisplay: aaModel?.shortName || fallbackModel?.modelDisplay || modelSlug,
        aaVariant: aaModel?.name || fallbackModel?.aaVariant || null,
        aaLive: Boolean(aaModel),
        aaUrl: aaModel?.sourceUrl || fallbackModel?.aaUrl || "https://artificialanalysis.ai/models#price-cost",
        isOpenWeights: Boolean(aaModel?.isOpenWeights ?? fallbackModel?.isOpenWeights),
        contextWindowTokens: aaModel?.contextWindowTokens ?? fallbackModel?.contextWindowTokens ?? null,
        priceUsd: tier.feeUsd,
        monthlyTokens: null,
        realUsdPerMtok: null,
        listBlendedUsdPerMtok: aaModel?.pricing?.blended7to2to1Per1M ?? null,
        subsidyMultiple: Number(tier.multiple.toFixed(4)),
        intelligenceIndex: Number(intel.toFixed(2)),
        benchmarks: aaModel?.benchmarks || fallbackModel?.benchmarks || { intelligenceIndex: round1(intel) },
        aaCostPerTaskUsd: Number(cpt.toFixed(4)),
        aaCostPerTaskBreakdown: aaModel?.costPerTaskBreakdown || fallbackModel?.aaCostPerTaskBreakdown || null,
        aaTotalIndexCostUsd: aaModel?.totalIndexCostUsd ?? fallbackModel?.aaTotalIndexCostUsd ?? null,
        aaPricing: aaModel?.pricing || fallbackModel?.aaPricing || null,
        aaSpeed: aaModel?.speed || fallbackModel?.aaSpeed || null,
        confidence: "high",
        dataDate: nowIso.slice(0, 10),
        sourceNote: `GitHub Copilot Plans ($${tier.feeUsd}/mo → $${tier.creditsUsd} AI credits)`,
        decisionNote: `Deterministic first-party AI Credits pool ($${tier.creditsUsd} monthly credits for $${tier.feeUsd}/mo = ${tier.multiple.toFixed(2)}×).`,
        preliminary: null,
      });
    }
  }

  // Layer live-verified first-party Ollama Cloud Team ($500 -> $1,000 shared credits = 2.0x)
  let ollamaTeamEntryCount = 0;
  for (const tier of ollamaTiers) {
    for (const aaSlug of ollamaHostedSlugs) {
      const aaModel = aaByNorm.get(aaSlug);
      const fallbackModel = !aaModel ? modelInfoBySlug.get(aaSlug) : null;
      const intel = aaModel?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
      const cpt = aaModel?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
      if (intel === null || cpt === null || cpt <= 0) continue;

      const creator = aaModel?.creatorName || fallbackModel?.modelCreator || "Ollama";
      ollamaTeamEntryCount++;
      entries.push({
        id: `first-party::${normSlug(tier.plan)}::${aaSlug}`,
        origin: "ollama-cloud",
        isPreliminary: false,
        estimateType: null,
        replacesId: null,
        billing: "subscription",
        vendor: "Ollama",
        modelCreator: creator,
        color: vendorColor(creator, aaModel),
        plan: tier.plan,
        planLocal: tier.plan,
        planUrl: SOURCES.ollamaPricing,
        isOffPeak: false,
        unmetered: false,
        modelId: aaSlug,
        modelDisplay: aaModel?.shortName || fallbackModel?.modelDisplay || aaSlug,
        aaVariant: aaModel?.name || fallbackModel?.aaVariant || null,
        aaLive: Boolean(aaModel),
        aaUrl: aaModel?.sourceUrl || fallbackModel?.aaUrl || "https://artificialanalysis.ai/models#price-cost",
        isOpenWeights: Boolean(aaModel?.isOpenWeights ?? fallbackModel?.isOpenWeights),
        contextWindowTokens: aaModel?.contextWindowTokens ?? fallbackModel?.contextWindowTokens ?? null,
        priceUsd: tier.feeUsd,
        monthlyTokens: null,
        realUsdPerMtok: null,
        listBlendedUsdPerMtok: aaModel?.pricing?.blended7to2to1Per1M ?? null,
        subsidyMultiple: Number(tier.multiple.toFixed(4)),
        intelligenceIndex: Number(intel.toFixed(2)),
        benchmarks: aaModel?.benchmarks || fallbackModel?.benchmarks || { intelligenceIndex: round1(intel) },
        aaCostPerTaskUsd: Number(cpt.toFixed(4)),
        aaCostPerTaskBreakdown: aaModel?.costPerTaskBreakdown || fallbackModel?.aaCostPerTaskBreakdown || null,
        aaTotalIndexCostUsd: aaModel?.totalIndexCostUsd ?? fallbackModel?.aaTotalIndexCostUsd ?? null,
        aaPricing: aaModel?.pricing || fallbackModel?.aaPricing || null,
        aaSpeed: aaModel?.speed || fallbackModel?.aaSpeed || null,
        confidence: "high",
        dataDate: nowIso.slice(0, 10),
        sourceNote: `Ollama Cloud Pricing ($${tier.feeUsd}/mo → $${tier.creditsUsd} credits)`,
        decisionNote: `Deterministic first-party credit pool ($${tier.creditsUsd} monthly credits for $${tier.feeUsd}/mo = ${tier.multiple.toFixed(2)}×).`,
        preliminary: null,
      });
    }
  }

  entries.sort((a, b) => {
    const effA = a.unmetered ? 0 : a.aaCostPerTaskUsd / (a.subsidyMultiple || 1);
    const effB = b.unmetered ? 0 : b.aaCostPerTaskUsd / (b.subsidyMultiple || 1);
    return effA - effB;
  });

  const payload = {
    schemaVersion: 2,
    generatedAt: nowIso,
    latestDataDate: latestFeiDate || priorsParsed.date || nowIso.slice(0, 10),
    sources: sourceStatus,
    stats: {
      totalEntries: entries.length,
      subscriptions: entries.filter((e) => e.billing === "subscription").length,
      meteredApis: entries.filter((e) => e.billing === "metered").length,
      priorsPreliminary: prelimCount,
      priorsAssumed: assumedCount,
      priorsExtraMeasured: priorsExtraCount,
      githubCopilotEntries: copilotEntryCount,
      ollamaTeamEntries: ollamaTeamEntryCount,
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
    `Wrote ${OUTPUT_PATH} (${payload.stats.totalEntries} entries: ${payload.stats.subscriptions} subs [incl. ${copilotEntryCount} Copilot + ${ollamaTeamEntryCount} Ollama Team], ${payload.stats.meteredApis} APIs across ${payload.stats.uniqueModels} models)`
  );
  return payload;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fromLocal = process.argv.includes("--from-local");
  refreshData({ fromLocal }).catch((err) => {
    console.error("[refresh] Fatal error:", err);
    process.exit(1);
  });
}
