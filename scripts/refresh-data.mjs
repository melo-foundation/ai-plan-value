#!/usr/bin/env node
/**
 * Fetches and merges live data from 7 upstream sources:
 *   1. Fei2411/real-api-pricing (derived/points.csv + benchmark-configurations.csv) — empirical subscription quotas & workloads
 *   2. adamholter/priors (data/snapshots/latest.json.gz) — clean raw-GitHub snapshot for secondary backfill
 *   3. artificialanalysis.ai/models (#price-cost SSR payload + optional AA_API_KEY v2 API)
 *   4. OpenRouter Models API (https://openrouter.ai/api/v1/models) — context window, open-weights, domain scores & gateway catalog
 *   5. GitHub Copilot Plans (https://github.com/features/copilot/plans) — live-verified AI Credit pools
 *   6. Ollama Pricing (https://ollama.com/pricing) — live-verified Ollama Cloud Team credit pool
 *   7. Kilo Pricing (https://kilo.ai/pricing) — live-verified Kilo Pass credit pools
 *
 * Writes normalized dataset to public/data/combined.json.
 * Zero external npm dependencies (requires Node.js >= 20).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as REL from "./reliability.mjs";
import { applyBillingPeriods } from "./billing-periods.mjs";
import { applyIncludedCredits } from "./included-credits.mjs";

// Claude quota token weighting (docs/QUOTA-WEIGHTS.md): a Claude first-party subsidy is rescaled from
// the sample's token mix to each cost metric's mix only when every quota-weight cell the row uses
// (model × bar × client class) is `validated` in data/quota-weights/fit.json. Other rows stay
// uncorrected and the mix term widens σ (it then also covers the uncorrected bias).
// Set true to keep the correction off whatever fit.json says.
const FORCE_CLAUDE_MIX_CORRECTION_OFF = false;
// Every Claude subsidy on the site is measured on the weekly bar (quota-weight-methodology.md §0.1).
const CLAUDE_SAMPLE_BAR = "7d";

// Agent SDK client weighting (REL.SDK_CLIENT; claude-code #97074, #111890): T3 Code reaches Claude
// through the Agent SDK, which burns the 5h window ≈2.1× faster per token. When true, Claude
// first-party rows in T3 turn mode get subsidy ÷ 2.1 and the step kind `sdkClient` in σ.
const APPLY_SDK_CLIENT_MULTIPLIER = false;

// Calibration ledger (docs/RELIABILITY.md § Calibration). Appended on CI runs (GITHUB_ACTIONS) or
// with --record-history; the deploy workflow commits it back to main. Local runs only read it.
const HISTORY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "reliability", "history.jsonl");
const RECORD_HISTORY = process.env.GITHUB_ACTIONS === "true" || process.argv.includes("--record-history");

// Promotions the upstream data does not expire itself. Rows are dropped after `until` (kept only as
// reference cells for ratio transfers).
const PROMO_EXPIRY = [
  // Fable 5.2 launch offer on Pro, Nov 9–16 (support.claude.com/en/articles/17506494); Pro limits exclude Fable.
  { plan: "Claude Pro", model: "claude-fable-5-2", until: "2026-11-16" },
];
// Quota changes after which older rows on that plan × model no longer describe the plan.
// action "drop" removes the row (a carry rule may refill it); otherwise the row is capped Speculative.
const QUOTA_CHANGES = [
  // Separate Argon bucket on Pro removed 2026-11-23; capacity moved into the general Gemini bucket.
  { plan: "Google AI Pro", model: "gemini-4-argon", date: "2026-11-23", action: "drop" },
];
// Models leaving the plans (antigravity.google/docs/models): rows dropped after the date.
const MODEL_RETIREMENTS = [
  { model: "gemini-4-argon", after: "2026-11-30" },
  { model: "gemini-3-8-flash", after: "2026-11-30" },
];
// Fable on Claude plans may use at most half the weekly limit (support.claude.com/en/articles/15424964).
const FABLE_CAP_SHARE = 0.5;
const isClaudeFirstParty = (plan) => /^Claude (Pro|Max|Ultra|Team)\b/.test(String(plan || ""));
const isFableOnClaude = (plan, model) => /^Claude (Pro|Max|Ultra)$/.test(String(plan || "")) && /^claude-fable-/.test(String(model || ""));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT_DIR, "public", "data", "combined.json");
const QUOTA_FIT_PATH = path.join(ROOT_DIR, "data", "quota-weights", "fit.json");
const QUOTA_PRICES_PATH = path.join(ROOT_DIR, "data", "quota-weights", "prices.json");

const SOURCES = {
  feiPointsCsv:
    "https://raw.githubusercontent.com/Fei2411/real-api-pricing/main/derived/points.csv",
  feiConventions:
    "https://raw.githubusercontent.com/Fei2411/real-api-pricing/main/data/conventions.json",
  fxUsdCny: "https://api.frankfurter.app/latest?from=USD&to=CNY",
  feiBenchConfigsCsv:
    "https://raw.githubusercontent.com/Fei2411/real-api-pricing/main/derived/benchmark-configurations.csv",
  priorsSnapshotGz:
    "https://raw.githubusercontent.com/adamholter/priors/main/data/snapshots/latest.json.gz",
  aaModelsPage: "https://artificialanalysis.ai/models",
  aaApiV2: "https://artificialanalysis.ai/api/v2/data/llms/models",
  openRouterModels: "https://openrouter.ai/api/v1/models",
  githubCopilotPlans: "https://github.com/features/copilot/plans",
  ollamaPricing: "https://ollama.com/pricing",
  kiloPricing: "https://kilo.ai/pricing",
  arcPrizeEvals: "https://arcprize.org/media/data/evaluations.json",
  arcPrizeModels: "https://arcprize.org/media/data/models.json",
  aaCodingAgents: "https://artificialanalysis.ai/agents/coding-agents",
};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Verified exact slug aliases between Fei2411/Priors/Copilot model IDs and Artificial Analysis slugs.
const MODEL_ALIASES = {
  hy4: "tencent-hy4",
  "hy-4": "tencent-hy4",
  "deepseek-v4-1-flash": "deepseek-v4-1-flash-1017",
  "deepseek-v4-pro": "deepseek-v4-pro-0813",
  "ling-3-1-flash-1019": "ling-3-1-flash",
  "kimi-k3-1": "kimi-k3-1-pro",
  "qwen-4-max": "qwen4-max",
  "qwen-3-8-27b": "qwen3-8-27b",
  "qwen3-8-max": "qwen-3-8-max",
  "qwen3-8-max-0902": "qwen-3-8-max",
  "qwen3-8-flash": "qwen-3-8-flash",
  "aa-muse-wonder": "muse-wonder",
  "aa-muse-ember": "muse-ember",
  "aa-step-5": "step-5-preview",
  "aa-reflection-beam": "reflection-beam",
  "minimax-m3-1": "minimax-m3-1-flash",
  "minimax-m3-1-flash-preview": "minimax-m3-1-flash",
  "gemini-4": "gemini-4-argon",
};

function compareVersions(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const PRIORS_BENCH_TO_KEY = {
  "aa-humanitys-last-exam": "hle",
  "aa-hle-diamond": "hleDiamond",
  "aa-frontiercode-2-0": "frontierCode20",
  "aa-terminalbench-v4-0": "terminalBench40",
  "aa-terminalbench-science": "terminalBenchScience",
  "aa-critpt-v2-hard": "critptAgenticHard",
  "aa-automationbench-aa": "automationBench",
  "aa-omniscience-v1-1-accuracy": "omniscienceAccuracy",
  "aa-gdp-pdf": "gdpPdfAllPass",
  "aa-artificial-analysis-long-context-reasoning": "lcr",
  "aa-scicode": "scicode",
  "aa-gdpval-aa": "gdpval",
};

const EFFORT_LABELS = {
  none: "non-reasoning",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  default: "",
};

function cleanEffort(rawEffort) {
  const base = String(rawEffort || "default").split("~")[0].toLowerCase().trim();
  return EFFORT_LABELS[base] !== undefined ? base : "default";
}

function canonicalBaseSlug(modelId, aaByNorm) {
  const norm = normSlug(modelId);
  if (aaByNorm.has(norm)) return aaByNorm.get(norm).slug;
  const alias = MODEL_ALIASES[norm];
  if (alias && aaByNorm.has(alias)) return aaByNorm.get(alias).slug;
  return alias || norm;
}

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
  Kilo: "#CA8A04",
};

// Verified first-party subscription plan & API pricing URLs
const PLAN_URL_PATTERNS = [
  [/^claude\b/i, "https://claude.com/pricing"],
  [/^chatgpt\b/i, "https://openai.com/chatgpt/pricing/"],
  [/^google ai\b/i, "https://one.google.com/about/google-ai-plans/"],
  [/^github copilot\b/i, "https://github.com/features/copilot/plans"],
  [/^kilo pass\b/i, "https://kilo.ai/pricing"],
  [/^(?:supergrok|x\s+(?:plus|premium|super|ultra))\b/i, "https://grok.com"],
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

function normPlanSlug(value) {
  return normSlug(String(value || "").replace(/\+/g, " plus "));
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

function normalizeBaseDisplay(name) {
  let s = String(name || "")
    .replace(/\s*\((?:max|xhigh|high|medium|low|non-reasoning|default fallback)[^)]*\)\s*$/i, "")
    .trim();
  if (/^(?:Opus|Sonnet|Haiku)\s+\d/i.test(s)) {
    s = `Claude ${s}`;
  }
  return s;
}

function normalizePlanName(name) {
  let s = String(name || "").trim();
  if (/^Claude Max 20x\b/i.test(s)) return "Claude Ultra";
  if (/^Claude Max 5x\b/i.test(s)) return "Claude Max";
  s = s.replace(/\s*\(9\/14\+\)/, "");
  // Unify Fei2411 Chinese GLM Coding labels with clean English labels to prevent Priors duplicates
  const glm = s.match(/^GLM Coding (Lite|Pro|Max)\s*\((老客|新客)\s*(¥\d+)\)\s*(闲时|忙时|中间值)$/);
  if (glm) {
    const [, tier, cust, rmb, window] = glm;
    const custText = cust === "老客" ? ", existing subscribers" : "";
    const winText = window === "闲时" ? "off-peak" : window === "忙时" ? "peak" : "mixed";
    return `GLM Coding ${tier} ${rmb}${custText} (${winText})`;
  }
  return s;
}

function detectPlanFlags(planName, planLocal = "") {
  const combined = `${planName || ""} ${planLocal || ""}`;
  const isOffPeak = /\boff-?peak\b|\bnight\b|闲时/i.test(combined);
  const isLegacy = /\blegacy\b|existing subscribers|老客/i.test(combined);
  const isCnPortal =
    /¥|\(CN\b|阿里云|闲时|忙时|中间值|老客|新客|^tencent token plan\b/i.test(combined) ||
    (/^minimax token plan\b/i.test(planName || "") && !/global/i.test(combined));
  return { isOffPeak, isLegacy, isCnPortal };
}

// Usage-limit reset windows per plan family, binding window first.
// Verified against official vendor pages on 2026-11-25:
//   Claude: claude.com/pricing, support.claude.com/en/articles/11647753 (Ultra: no 5h for verified accounts)
//   ChatGPT: help.openai.com/articles/9793128 (Plus 5h + weekly; Pro tiers weekly only)
//   Google AI: antigravity.google/docs/plans (5h refresh until weekly limit)
//   Grok: docs.x.ai/grok/faq, docs.x.ai/x-subscription/usage-limits (one weekly pool since 2026-06;
//     SuperGrok Lite/SuperGrok/Plus/Heavy are legacy since 2026-10-12; "X Plus"/"X Ultra" are
//     The X Subscription Plus $8 / Ultra $200, same weekly pool shared with Cursor)
//   Devin: docs.devin.ai/admin/billing/self-serve (Pro daily + weekly; Max weekly)
//   Mistral: docs.mistral.ai/admin/billing-usage/subscriptions (monthly)
//   Copilot: docs.github.com/.../usage-based-billing-for-individuals (monthly credits, resets on the 1st)
//   Cursor legacy Pro/Pro+/Ultra: cursor.com/docs/account/pricing/legacy-cursor-plans (Cursor Models + Other Models pools,
//     both reset monthly with billing cycle; new X Subscription plans use one weekly pool)
//   Command Code: commandcode.ai/docs/resources/pricing-limits (5h $20, 7d $50, monthly $100)
//   Factory Droid: docs.factory.com/pricing (rolling 5h, 7d, 30d)
//   OpenCode Go: opencode.ai/docs/go (5h 20%, weekly 50%, monthly)
//   Ollama: ollama.com/blog/transparent-pricing (monthly credits, no 5h/weekly since
//     2026-08-31; un-switched legacy subscribers keep 5h + weekly GPU-time limits)
//   Kilo Pass: kilo.ai/pricing/kilo-pass (credit balance, no time windows)
//   GLM Coding: docs.bigmodel.cn/cn/coding-plan/overview (5h + weekly; weekly = 5x 5h)
//   MiniMax: platform.minimax.io/docs/m-plan/usage-rules, platform.minimax.cn/docs/m-plan/faq
//     (M Plan 5h + weekly, fixed blocks from first use). Token Plan is legacy (m-plan/token-plan-notice):
//     also 5h + weekly; pre-2026-03-22 buyers have no weekly cap, 03-22..06-05 buyers get 150% weekly
//   Kimi: kimi.com/en/help/membership/membership-update-rules (new: monthly + 5h; legacy: weekly + 5h + monthly)
//   Alibaba / Tencent / MiMo / StepFun token plans: monthly credit pool only
const QUOTA_WINDOW_NAMES = { "5h": "5h", daily: "daily", weekly: "weekly", "7d": "7-day", "30d": "30-day", monthly: "monthly" };

function quotaWindowsForPlan(p) {
  if (/^kilo pass\b/i.test(p)) return [];
  if (/^ollama\b/i.test(p)) return ["monthly"];
  if (/^opencode\b/i.test(p)) return ["5h", "weekly", "monthly"];
  if (/^glm coding\b/i.test(p)) return ["weekly", "5h"];
  if (/^minimax\b/i.test(p)) return ["5h", "weekly"];
  if (/^kimi\s+(?:moderato|allegretto|allegro|andante)\b/i.test(p)) return ["weekly", "5h", "monthly"];
  if (/^kimi\b/i.test(p)) return ["monthly", "5h"];
  if (/qwen token plan|alibaba|阿里云百炼|^tencent token|^mimo token|^step plan|^deeprelay\b/i.test(p)) return ["monthly"];
  if (/^claude\s+ultra\b/i.test(p)) return ["weekly"];
  if (/^claude\b/i.test(p)) return ["5h", "weekly"];
  if (/^chatgpt\s+plus\b/i.test(p)) return ["5h", "weekly"];
  if (/^chatgpt\b/i.test(p)) return ["weekly"];
  if (/^devin\s+max\b/i.test(p)) return ["weekly"];
  if (/^devin\b/i.test(p)) return ["daily", "weekly"];
  if (/^github copilot\b/i.test(p)) return ["monthly"];
  if (/^cursor\b/i.test(p)) return ["monthly"];
  if (/^command code\b/i.test(p)) return ["5h", "weekly", "monthly"];
  if (/^droid\b/i.test(p)) return ["5h", "7d", "30d"];
  if (/^google ai\b/i.test(p)) return ["weekly", "5h"];
  if (/^(?:supergrok|x\s+(?:plus|premium|super|ultra))\b/i.test(p)) return ["weekly"];
  if (/^mistral\b/i.test(p)) return ["monthly"];
  return ["monthly"];
}

function quotaWindowMeta(windows, billing) {
  if (billing === "metered") return { quotaWindows: ["payg"], quotaWindow: "payg", quotaWindowLabel: "Pay-as-you-go" };
  if (!windows.length) return { quotaWindows: [], quotaWindow: "none", quotaWindowLabel: "Limits: none (credits)" };
  return {
    quotaWindows: windows,
    quotaWindow: windows[0],
    quotaWindowLabel: `Limits: ${windows.map((w) => QUOTA_WINDOW_NAMES[w] || w).join(", ")}`,
  };
}

function detectPlanAccessAndWindow(planName, billing) {
  const meta = detectPlanAccess(planName, billing);
  return { ...meta, ...quotaWindowMeta(quotaWindowsForPlan(String(planName || "")), billing) };
}

function detectPlanAccess(planName, billing) {
  if (billing === "metered") {
    return {
      openEndpoint: true,
      harness: "Any API / CLI",
    };
  }
  const p = String(planName || "");
  if (/^kilo pass\b/i.test(p)) {
    return { openEndpoint: true, harness: "Kilo / OpenAI API" };
  }
  if (/^ollama\s+team\b/i.test(p)) {
    return { openEndpoint: true, harness: "Any CLI / API" };
  }
  if (/^ollama\b/i.test(p)) {
    return { openEndpoint: true, harness: "Any CLI / API" };
  }
  if (/^opencode\b/i.test(p)) {
    return { openEndpoint: true, harness: "OpenCode / API" };
  }
  if (/^glm coding\b/i.test(p)) {
    return { openEndpoint: true, harness: "Any CLI / API" };
  }
  if (/^minimax\b/i.test(p)) {
    return { openEndpoint: true, harness: "Any CLI / API" };
  }
  if (/^kimi\b/i.test(p)) {
    return { openEndpoint: true, harness: "Any CLI / API" };
  }
  if (/qwen token plan|alibaba|阿里云百炼|^tencent token|^mimo token|^step plan|^deeprelay\b/i.test(p)) {
    return { openEndpoint: true, harness: "Any CLI / API" };
  }
  if (/^claude\b/i.test(p)) {
    return { openEndpoint: false, harness: "Claude Code / Web" };
  }
  if (/^chatgpt\b/i.test(p)) {
    return { openEndpoint: false, harness: "Codex / Web" };
  }
  if (/^devin\b/i.test(p)) {
    return { openEndpoint: false, harness: "Devin Agent" };
  }
  if (/^github copilot\b/i.test(p)) {
    return { openEndpoint: false, harness: "Copilot IDE / CLI" };
  }
  if (/^cursor\b/i.test(p)) {
    return { openEndpoint: false, harness: "Cursor IDE" };
  }
  if (/^command code\b/i.test(p)) {
    return { openEndpoint: false, harness: "Command Code CLI" };
  }
  if (/^droid\b/i.test(p)) {
    return { openEndpoint: false, harness: "Factory Droid CLI" };
  }
  if (/^google ai\b/i.test(p)) {
    return { openEndpoint: false, harness: "Gemini CLI / Web" };
  }
  if (/^(?:supergrok|x\s+(?:plus|premium|super|ultra))\b/i.test(p)) {
    return { openEndpoint: false, harness: "Grok Web / App" };
  }
  if (/^mistral\b/i.test(p)) {
    return { openEndpoint: false, harness: "Le Chat / Vibe", matched: true };
  }
  return { openEndpoint: false, harness: "First-party app", matched: false };
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
  if (/^kilo\b/i.test(p)) return "Kilo";
  if (/^(?:supergrok|x\s+(?:plus|premium|super|ultra))\b/i.test(p)) return "xAI";
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
  if (/^kimi\b/i.test(p)) return "Moonshot";
  return fallbackVendor || "Other";
}

function planVendorFeeKey(planName, fallbackVendor, feeUsd, aaSlug, flags) {
  const seller = vendorFromPlan(planName, fallbackVendor);
  const quals = [...String(planName || "").matchAll(/\(([^)]+)\)/g)]
    .map((m) => normSlug(m[1]))
    .filter((q) => q && q !== "cn" && q !== "global")
    .sort()
    .join("+");
  return `${normSlug(seller)}::${Math.round(feeUsd)}::${aaSlug}::${flags.isOffPeak ? "off" : "std"}::${flags.isLegacy ? "leg" : "cur"}::${quals}`;
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
      hle: pctFromFraction(m.hle),
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
 * Extracts:
 *   1. All `subscription-token-price` (model, plan) entries with exact blended multiples
 *      (properly applying `sameAs` listPrice and `poolRate` multipliers).
 *   2. All multi-effort Artificial Analysis `(model, effort)` variants with
 *      AA Intelligence Index v5.0.1, AA Cost per Task, and per-variant test scores.
 */
function parsePriorsSnapshot(snapshot, aaByNorm, openRouterIndex = null) {
  const modelsById = new Map();
  for (const m of snapshot.models || []) {
    modelsById.set(m.id, m);
  }
  const labsById = new Map();
  for (const l of snapshot.labs || []) {
    labsById.set(l.id, l);
  }
  const variantsById = new Map();
  for (const v of snapshot.variants || []) {
    variantsById.set(v.id, v);
  }

  // First pass: collect listPrice & mix by modelId so `sameAs` rows resolve accurately.
  // A free-tier record nests the paid one under `details.paid`; index the paid record (it carries the plans).
  const subDetailsByModel = new Map();
  for (const obs of snapshot.observations || []) {
    if (obs.benchmarkId !== "subscription-token-price") continue;
    const modelId = String(obs.variantId || "").split("@")[0];
    const top = obs.details || {};
    const det = top.free && top.paid ? top.paid : top;
    if (det.listPrice || (det.plans || []).length) {
      const prev = subDetailsByModel.get(modelId);
      if (!prev || (!prev.listPrice && det.listPrice) || (!(prev.plans || []).length && (det.plans || []).length)) {
        subDetailsByModel.set(modelId, det);
      }
    }
  }

  // Second pass: collect all AA multi-effort variants (intelligence + costPerTask + tests + 3:1 blended price)
  const variantObs = new Map(); // variantId -> { cpt, price3to1, benchmarks }
  const price3to1ByBase = new Map(); // baseSlug -> number
  for (const obs of snapshot.observations || []) {
    const bid = obs.benchmarkId;
    const vid = obs.variantId;
    if (!vid) continue;
    if (bid === "aa-price-blended") {
      const val = toNum(obs.value);
      if (val != null && val > 0) {
        const baseSlug = canonicalBaseSlug(vid.split("@")[0], aaByNorm);
        if (!price3to1ByBase.has(baseSlug)) price3to1ByBase.set(baseSlug, val);
      }
    }
    // Intelligence Index id carries a version (aa-intelligence-index-v5.0.1, -v5.0.2, …): take the highest per variant.
    const iiVer = /^aa-intelligence-index-v(\d+(?:\.\d+)*)$/.exec(bid)?.[1] || null;
    if (bid === "aa-cost-per-task-index" || bid === "aa-price-blended" || iiVer || PRIORS_BENCH_TO_KEY[bid]) {
      let rec = variantObs.get(vid);
      if (!rec) {
        rec = { cpt: null, price3to1: null, benchmarks: {}, iiVer: null, iiRaw: null, iiDate: null };
        variantObs.set(vid, rec);
      }
      if (bid === "aa-cost-per-task-index") {
        rec.cpt = toNum(obs.value);
      } else if (bid === "aa-price-blended") {
        rec.price3to1 = toNum(obs.value);
      } else if (iiVer) {
        if (rec.iiVer == null || compareVersions(iiVer, rec.iiVer) >= 0) {
          rec.iiVer = iiVer;
          rec.iiRaw = toNum(obs.value);
          rec.iiDate = obs.observedAt || null;
          rec.benchmarks.intelligenceIndex = round1(obs.value);
        }
      } else {
        const key = PRIORS_BENCH_TO_KEY[bid];
        rec.benchmarks[key] = round1(obs.value);
      }
    }
  }

  // Group multi-effort AA variants by canonical base model slug
  const aaVariantsByBase = new Map(); // baseSlug -> Map<effort, variantObj>
  for (const [vid, rec] of variantObs.entries()) {
    const intel = rec.iiRaw ?? rec.benchmarks.intelligenceIndex;
    if (intel == null || rec.cpt == null || rec.cpt <= 0) continue;

    const [rawModelId, rawEffort] = vid.split("@");
    const effort = cleanEffort(rawEffort);
    const baseSlug = canonicalBaseSlug(rawModelId, aaByNorm);
    const aaHeadline = resolveAaModel(rawModelId, aaByNorm);
    const modelMeta = modelsById.get(rawModelId);
    const labMeta = modelMeta?.labId ? labsById.get(modelMeta.labId) : null;
    const vMeta = variantsById.get(vid);

    let effortMap = aaVariantsByBase.get(baseSlug);
    if (!effortMap) {
      effortMap = new Map();
      aaVariantsByBase.set(baseSlug, effortMap);
    }
    // Avoid overwriting a cleaner variant with a ~hash duplicate, and drop obsolete -preview defaults
    if (effortMap.has(effort) && String(rawEffort || "").includes("~")) continue;
    if (effort === "default" && /~.*-preview-/i.test(String(rawEffort || "")) && !/preview/i.test(baseSlug)) {
      continue;
    }

    const baseDisplay = normalizeBaseDisplay(aaHeadline?.shortName || modelMeta?.name || rawModelId);
    const effortSuffix = EFFORT_LABELS[effort];
    const displayName = effortSuffix ? `${baseDisplay} (${effortSuffix})` : baseDisplay;

    // Attach live AA domain capabilities when this variant matches AA's headline variant
    const isHeadlineEffort =
      aaHeadline &&
      aaHeadline.intelligenceIndex != null &&
      Math.abs(aaHeadline.intelligenceIndex - intel) < 0.35 &&
      aaHeadline.costPerTaskUsd != null &&
      Math.abs(aaHeadline.costPerTaskUsd - rec.cpt) < 0.05;

    const mergedBenchmarks = isHeadlineEffort
      ? { ...rec.benchmarks, ...aaHeadline.benchmarks }
      : { ...rec.benchmarks };

    effortMap.set(effort, {
      variantKey: effortSuffix ? `${baseSlug}--${effort}` : baseSlug,
      baseSlug,
      effort,
      effortLabel: effortSuffix,
      displayName,
      baseDisplay,
      creatorName: aaHeadline?.creatorName || labMeta?.name || null,
      creatorColor: aaHeadline?.creatorColor || null,
      intelligenceIndex: intel,
      iiDate: rec.iiDate,
      costPerTaskUsd: rec.cpt,
      benchmarks: mergedBenchmarks,
      aaUrl: vMeta?.sourceModel?.url || aaHeadline?.sourceUrl || `https://artificialanalysis.ai/models/${baseSlug}`,
      aaLive: Boolean(aaHeadline),
      isHeadline: Boolean(isHeadlineEffort),
      pricing:
        aaHeadline?.pricing ||
        (rec.price3to1 || price3to1ByBase.get(baseSlug)
          ? {
              inputPer1M: null,
              outputPer1M: null,
              cacheHitPer1M: null,
              blended3to1Per1M: rec.price3to1 || price3to1ByBase.get(baseSlug),
              blended7to2to1Per1M: null,
            }
          : null),
      costPerTaskBreakdown: isHeadlineEffort ? aaHeadline.costPerTaskBreakdown : null,
      totalIndexCostUsd: isHeadlineEffort ? aaHeadline.totalIndexCostUsd : null,
      speed: isHeadlineEffort ? aaHeadline.speed : null,
      isOpenWeights: Boolean(aaHeadline?.isOpenWeights),
      contextWindowTokens: aaHeadline?.contextWindowTokens ?? null,
    });
  }

  // Ensure every live AA headline model is represented even if not yet in Priors snapshot
  for (const aaModel of aaByNorm.values()) {
    if (aaModel.intelligenceIndex == null || aaModel.costPerTaskUsd == null || aaModel.costPerTaskUsd <= 0) {
      continue;
    }
    let effortMap = aaVariantsByBase.get(aaModel.slug);
    if (!effortMap) {
      effortMap = new Map();
      aaVariantsByBase.set(aaModel.slug, effortMap);
    }
    const alreadyHasHeadline = [...effortMap.values()].some((v) => v.isHeadline);
    if (!alreadyHasHeadline) {
      const mEff = String(aaModel.name || "").match(/\((max|xhigh|high|medium|low)/i);
      const effort = mEff ? mEff[1].toLowerCase() : "default";
      const effortSuffix = EFFORT_LABELS[effort] || "";
      const baseDisplay = normalizeBaseDisplay(aaModel.shortName || aaModel.name);
      effortMap.set(effort, {
        variantKey: effortSuffix ? `${aaModel.slug}--${effort}` : aaModel.slug,
        baseSlug: aaModel.slug,
        effort,
        effortLabel: effortSuffix,
        displayName: effortSuffix ? `${baseDisplay} (${effortSuffix})` : baseDisplay,
        baseDisplay,
        creatorName: aaModel.creatorName,
        creatorColor: aaModel.creatorColor,
        intelligenceIndex: Number(aaModel.intelligenceIndex.toFixed(2)),
        costPerTaskUsd: aaModel.costPerTaskUsd,
        benchmarks: aaModel.benchmarks,
        aaUrl: aaModel.sourceUrl,
        aaLive: true,
        isHeadline: true,
        pricing: aaModel.pricing,
        costPerTaskBreakdown: aaModel.costPerTaskBreakdown,
        totalIndexCostUsd: aaModel.totalIndexCostUsd,
        speed: aaModel.speed,
        isOpenWeights: aaModel.isOpenWeights,
        contextWindowTokens: aaModel.contextWindowTokens,
      });
    }
  }

  // Third pass: extract subscription-token-price items with exact sameAs + poolRate math.
  // Records shapes: `plans: [...]` (per-plan $/Mtok), `plans: []` + `ratio` (fee $ per API $ on `plan`,
  // with optional `readings`), `plans: []` + `sameAs` (one row per plan of the sameAs model), and free
  // tiers (`free`, ratio 0) whose paid record sits under `paid`. Free tiers never become paid plans.
  const out = [];
  const skipped = [];
  const queue = [];
  for (const obs of snapshot.observations || []) {
    if (obs.benchmarkId !== "subscription-token-price") continue;
    queue.push({ modelId: String(obs.variantId || "").split("@")[0], det: obs.details || {} });
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const { modelId } = queue[qi];
    let det = queue[qi].det;
    if (det.free || (toNum(det.ratio) === 0 && !(det.plans || []).length)) {
      if (det.paid) {
        queue.push({ modelId, det: det.paid });
      } else {
        skipped.push({ modelId, plan: det.plan || null, reason: "free tier" });
      }
      continue;
    }
    const sameAsDet = det.sameAs ? subDetailsByModel.get(det.sameAs) : null;
    const modelMeta0 = modelsById.get(modelId);
    const ratio = toNum(det.ratio);
    if (!(det.plans || []).length && ratio > 0 && det.plan) {
      // Ratio record: fee dollars per API dollar on one plan.
      const readings = {};
      for (const rd of det.readings || []) {
        const r = toNum(rd.ratio);
        if (rd.id && r > 0) readings[rd.id] = 1 / r;
      }
      out.push({
        modelId,
        modelName: modelMeta0?.name || modelId,
        plan: normalizePlanName(det.plan),
        planRaw: det.plan,
        feeUsd: toNum(det.feeUsd),
        usdPerMtok: null,
        blendedList: null,
        multiple: 1 / ratio,
        confidence: det.confidence || "medium",
        isPrelim: false,
        isAssumed: false,
        preliminary: null,
        dataDate: det.dataDate || snapshot.date || null,
        kind: "ratio",
        source: det.source || null,
        readings: readings.shared && readings.own ? { shared: readings.shared, own: readings.own } : null,
      });
      continue;
    }
    if (!(det.plans || []).length && det.sameAs) {
      // sameAs record without plans: one assumed row per plan of the sameAs model, at its multiple.
      const src = sameAsDet;
      if (!src || !(src.plans || []).length) {
        skipped.push({ modelId, plan: det.plan || null, reason: `sameAs ${det.sameAs} has no plans` });
        continue;
      }
      queue.push({ modelId, det: { ...src, confidence: "assumed", sameAs: det.sameAs, dataDate: det.dataDate || src.dataDate, _sameAsAnchor: true } });
      continue;
    }
    if (!(det.plans || []).length) {
      skipped.push({ modelId, plan: det.plan || null, reason: "no plans, ratio or sameAs" });
      continue;
    }
    let lp = det.listPrice || sameAsDet?.listPrice || {};
    if (lp.input == null || lp.output == null) {
      // A sameAs-anchor record's $/Mtok are priced on the sameAs model, so its prices are the fallback.
      const priceModel = det._sameAsAnchor ? det.sameAs : modelId;
      const aaHead = resolveAaModel(priceModel, aaByNorm);
      const orMod = resolveOpenRouterModel(priceModel, openRouterIndex, aaByNorm);
      const pSrc = aaHead?.pricing?.inputPer1M != null ? aaHead.pricing : orMod?.pricing;
      if (pSrc && pSrc.inputPer1M != null && pSrc.outputPer1M != null) {
        lp = {
          input: pSrc.inputPer1M,
          output: pSrc.outputPer1M,
          cached: pSrc.cacheHitPer1M ?? pSrc.inputPer1M * 0.1,
        };
      }
    }
    const mix = det.mix || sameAsDet?.mix || { cache: 0.97, input: 0.025, output: 0.005 };
    const poolRate = toNum(det.poolRate) || 1;

    const cacheWritePrice =
      lp.cacheWrite != null ? Number(lp.cacheWrite) : Number(lp.input || 0) * 1.25;
    const blendedList =
      Number(mix.cache || 0) * Number(lp.cached || 0) +
      Number(mix.input || 0) * Number(lp.input || 0) +
      Number(mix.cacheWrite || 0) * cacheWritePrice +
      Number(mix.output || 0) * Number(lp.output || 0);

    if (!Number.isFinite(blendedList) || blendedList <= 0) {
      skipped.push({ modelId, plan: det.plan || null, reason: "no list price" });
      continue;
    }

    const topIsAssumed = det.confidence === "assumed";
    const modelMeta = modelsById.get(modelId);

    for (const p of det.plans || []) {
      const rawUsdPerMtok = toNum(p.usdPerMtok);
      const feeUsd = toNum(p.feeUsd);
      if (!rawUsdPerMtok || rawUsdPerMtok <= 0) continue;

      const usdPerMtok = rawUsdPerMtok * poolRate;
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
        kind: "plans",
        sameAs: isAssumed ? det.sameAs || null : null,
        anchorConfidence: isAssumed && p.confidence && p.confidence !== "assumed" ? p.confidence : null,
        source: det.source || null,
      });
    }
  }
  return { date: snapshot.date || null, items: out, skipped, aaVariantsByBase, t3Index: parseT3CodeTurns(snapshot, aaByNorm), cursorBenchIndex: parseCursorBench(snapshot, aaByNorm) };
}

function extractBalancedJsonObject(text, openBraceIdx) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(openBraceIdx, i + 1));
    }
  }
  throw new Error("Unbalanced JSON object");
}

/**
 * Parse Artificial Analysis Coding Agent Index configs (agent × model × effort) from the
 * /agents/coding-agents RSC payload. Each config is an independently measured run, so the
 * resulting index/cost are attached only on exact (agent?, base model, effort) matches.
 */
function parseAaCodingAgentsHtml(html) {
  const rsc = extractNextRscText(html);
  const configs = [];
  const seen = new Set();
  const re = /\{"id":"[0-9a-f]{32}","isDefault":/g;
  let m;
  while ((m = re.exec(rsc)) !== null) {
    let o;
    try {
      o = extractBalancedJsonObject(rsc, m.index);
    } catch {
      continue;
    }
    if (!o || seen.has(o.id) || !o.agentSlug) continue;
    seen.add(o.id);
    const key = o.agentRelease?.key || "";
    const sep = key.indexOf(":");
    let baseSlug = sep > 0 ? key.slice(sep + 1) : null;
    let effort = o.model?.effort?.slug || "default";
    // Harness-comparison rows (e.g. Devin CLI on Cognition hosting) carry model: null and no release key;
    // the model is only in display.model ("GLM-5.3-Flash", "GPT-6 Luna (Max)"). AA's methodology runs
    // these comparisons at maximum reasoning effort. Routers (Devin Fusion: two models) map to no single model.
    if (!baseSlug && !o.model && !o.isRouter && o.display?.model) {
      const dm = String(o.display.model).match(/^(.*?)\s*(?:\(([^)]+)\))?$/);
      baseSlug = normSlug(dm[1]);
      effort = dm[2] ? normSlug(dm[2]) : "max";
    }
    const index = Number(o.indexScore);
    const cost = Number(o.mean?.costUsd);
    if (!baseSlug || o.isUnavailable || !Number.isFinite(index) || !(cost > 0)) continue;
    configs.push({
      agentSlug: o.agentSlug,
      agentName: o.agentName || o.display?.agent || o.agentSlug,
      baseSlug: normSlug(MODEL_ALIASES[baseSlug] || baseSlug),
      effort,
      isDefault: Boolean(o.isDefault),
      index: round1(index * 100),
      costPerTaskUsd: Number(cost.toFixed(4)),
      wallTimeSec: Number.isFinite(Number(o.mean?.agentWallTimeSec)) ? Math.round(o.mean.agentWallTimeSec) : null,
    });
  }
  if (configs.length === 0) throw new Error("Could not locate coding-agent configs in Artificial Analysis HTML");
  // AA spells some agents inconsistently across rows (e.g. "Opencode" / "OpenCode"); keep one name per slug.
  const nameBySlug = new Map();
  for (const c of configs) {
    const prev = nameBySlug.get(c.agentSlug);
    // Prefer the most-capitalised spelling ("OpenCode" over "Opencode").
    const caps = (n) => (n.match(/[A-Z]/g) || []).length;
    if (!prev || caps(c.agentName) > caps(prev.agentName)) nameBySlug.set(c.agentSlug, c);
  }
  for (const c of configs) c.agentName = nameBySlug.get(c.agentSlug).agentName;
  return configs;
}

// Plan harness → AA coding agent that plan's quota is consumed through.
// Harnesses not listed here are either open endpoints (any agent) or unmeasured by AA.
const HARNESS_TO_AA_AGENT = {
  "Claude Code / Web": "claude-code",
  "Codex / Web": "codex",
  "Gemini CLI / Web": "antigravity-cli",
  "Le Chat / Vibe": "mistral-vibe",
  "Grok Web / App": "grok-build",
  "OpenCode / API": "opencode",
  "Devin Agent": "devin-cli",
  "Copilot IDE / CLI": "copilot-cli",
};
const UNMEASURED_HARNESSES = new Set(["Cursor IDE", "Command Code CLI", "Factory Droid CLI", "First-party app"]);

/**
 * T3 Code (t3.codes) usage telemetry carried in the Priors snapshot: mean API-list cost and wall time
 * of a real completed turn per model+effort over a 30-day window. Turns run in whichever harness
 * T3 Code drives (Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok), mostly first-party.
 */
function parseT3CodeTurns(snapshot, aaByNorm) {
  const index = new Map();
  for (const obs of snapshot.observations || []) {
    if (obs.benchmarkId !== "t3-cost-per-turn" && obs.benchmarkId !== "t3-turn-time") continue;
    const [rawModel, rawEffort] = String(obs.variantId || "").split("@");
    if (!rawModel) continue;
    const key = `${normSlug(canonicalBaseSlug(rawModel, aaByNorm))}|${cleanEffort(rawEffort)}`;
    const rec = index.get(key) || { costPerTurnUsd: null, minutesPerTurn: null, turns: null, users: null, window: null };
    const det = obs.details || {};
    if (obs.benchmarkId === "t3-cost-per-turn") {
      const v = toNum(obs.value);
      if (v != null && v > 0) rec.costPerTurnUsd = Number(v.toFixed(4));
    } else {
      rec.minutesPerTurn = toNum(obs.value);
    }
    rec.turns = Math.max(rec.turns || 0, toNum(det.turns) || 0) || null;
    rec.users = Math.max(rec.users || 0, toNum(det.users) || 0) || null;
    rec.window = rec.window || det.window || null;
    if (det.perTurn && !rec.perTurn) rec.perTurn = det.perTurn; // tokens by kind: fresh / cached / written / output
    index.set(key, rec);
  }
  for (const [k, r] of index) if (r.costPerTurnUsd == null) index.delete(k);
  return index;
}

/** CursorBench (cursor.com/cursorbench, via the Priors snapshot): score %, mean $/task, steps, tokens per model+effort. */
function parseCursorBench(snapshot, aaByNorm) {
  const index = new Map();
  for (const obs of snapshot.observations || []) {
    if (obs.benchmarkId !== "cursorbench") continue;
    const [rawModel, rawEffort] = String(obs.variantId || "").split("@");
    const score = toNum(obs.value);
    const cost = toNum(obs.costUsd);
    if (!rawModel || score == null || cost == null || cost <= 0) continue;
    index.set(`${normSlug(canonicalBaseSlug(rawModel, aaByNorm))}|${cleanEffort(rawEffort)}`, {
      score: round1(score),
      costPerTaskUsd: Number(cost.toFixed(4)),
      steps: toNum(obs.steps),
      tokensPerTask: toNum(obs.details?.tokensPerTask),
    });
  }
  return index;
}

function resolveCodingAgent(entry, agentIndex) {
  if (!agentIndex) return null;
  const pool = agentIndex.get(`${normSlug(entry.baseModelId)}|${entry.effort || "default"}`);
  if (!pool || pool.length === 0) return null;
  const pinned = HARNESS_TO_AA_AGENT[entry.harness];
  let pick = null;
  if (pinned) {
    pick = pool.find((c) => c.agentSlug === pinned) || null;
  } else if (!UNMEASURED_HARNESSES.has(entry.harness) && (entry.openEndpoint || entry.billing === "metered")) {
    // Open endpoint / API key: the model's AA default agent, else its median-scoring one (not the best).
    const byIndex = [...pool].sort((a, b) => a.index - b.index);
    pick = pool.find((c) => c.isDefault) || byIndex[Math.floor((byIndex.length - 1) / 2)];
  }
  if (!pick) return null;
  return {
    agent: pick.agentName,
    agentSlug: pick.agentSlug,
    index: pick.index,
    costPerTaskUsd: pick.costPerTaskUsd,
    wallTimeSec: pick.wallTimeSec,
  };
}

/**
 * Confidence tier for an estimate, graded by LOOCV median error (docs/EFFORT-ESTIMATES.md):
 *   high ≤1.5 pts, medium ≤3 pts, low >3 pts or outside validated range.
 */
const TIER_RANK = { high: 0, medium: 1, low: 2 };
// Live per-tier median error ranges for the methodology panel (pts and $/task %).
function buildEstimateTiers(effortAcc, agentAcc) {
  const x = effortAcc?.extrap || {};
  const range = (parts) => {
    const q = parts.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!q.length) return null;
    return {
      ptsLo: Math.min(...q.map((p) => p[0])), ptsHi: Math.max(...q.map((p) => p[0])),
      costLo: Math.min(...q.map((p) => p[1])), costHi: Math.max(...q.map((p) => p[1])),
    };
  };
  return {
    high: range([[effortAcc?.interp?.intelPts, effortAcc?.interp?.costPct], [x.intelPts1, x.costPct1],
      [agentAcc?.sameModel?.pts, agentAcc?.sameModel?.costPct]]),
    medium: range([[x.intelPts2, x.costPct2], [agentAcc?.crossAgent?.pts, agentAcc?.crossAgent?.costPct],
      [agentAcc?.model?.pts, agentAcc?.model?.costPct]]),
    low: range([[x.intelPts3, x.costPct3]]),
  };
}
function effortConfidence(e) {
  if (!e.effortEstimate) return null;
  if (e.effortEstimate === "interpolated") return "high"; // ±1.1
  if (e.effortEstimateSource === "arc-agi-2") return "medium"; // ±2.8–3.0
  const steps = e.effortEstimateSteps ?? 9;
  return steps <= 1 ? "high" : steps === 2 ? "medium" : "low"; // ±1.4 / ±2.5 / ±3.1–4.6
}
function agentConfidence(e) {
  const a = e.codingAgent;
  if (!a?.estimate) return null;
  const method =
    a.estimate === "same-model"
      ? a.crossAgent ? "medium" : "high" // ±1.4 same agent; ±2.7 copied from another harness
      : a.outOfRange ? "low" : "medium"; // fit ±2.8 in range; untested below it
  // Stacking: an agent estimate built on an estimated II / benchmark is no better than that input.
  const input = effortConfidence(e);
  return input && TIER_RANK[input] > TIER_RANK[method] ? input : method;
}

/**
 * Fill Coding Agent Index for rows AA has not run, as ‡ estimates.
 *  - same-model: nearest measured effort of the same base model (pinned agent first, else any agent),
 *    shifted 1:1 by the Intelligence Index gap (LOOCV beat ratio, 0.8 slope and Terminal-Bench shifts,
 *    also from the farthest effort: ±2.9 pts); $/task scaled by the AA Intelligence $/task ratio.
 *  - terminal-bench: no agent run for the model at all → OLS of agent index on Terminal-Bench 4.0
 *    (best single predictor in LOOCV, beats Intelligence Index); $/task = AA $/task × median agent/AA ratio.
 * Unmeasured harnesses (Cursor etc.) and pinned agents AA never ran stay empty.
 * Returns leak-free LOOCV accuracy for both methods (held-out base model excluded from training).
 */
function estimateCodingAgents(entries, agentIndex) {
  const agentNames = new Map();
  for (const pool of agentIndex.values()) for (const c of pool) agentNames.set(c.agentSlug, c.agentName);

  const seen = new Set();
  const points = [];
  for (const e of entries) {
    const a = e.codingAgent;
    if (!a || a.estimate || e.effortEstimate) continue;
    const key = `${e.modelId}|${a.agentSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(e.intelligenceIndex > 0) || !(e.aaCostPerTaskUsd > 0)) continue;
    points.push({
      base: normSlug(e.baseModelId),
      agentSlug: a.agentSlug,
      agent: a.agent,
      effort: e.effort || "default",
      y: a.index,
      ii: e.intelligenceIndex,
      tb: e.benchmarks?.terminalBench40 ?? null,
      cost: a.costPerTaskUsd,
      aac: e.aaCostPerTaskUsd,
    });
  }

  const fitLine = (pts, xKey) => {
    const q = pts.filter((p) => Number.isFinite(p[xKey]));
    if (q.length < 5) return null;
    const mx = q.reduce((s, p) => s + p[xKey], 0) / q.length;
    const my = q.reduce((s, p) => s + p.y, 0) / q.length;
    let sxy = 0, sxx = 0;
    for (const p of q) { sxy += (p[xKey] - mx) * (p.y - my); sxx += (p[xKey] - mx) ** 2; }
    if (!(sxx > 0)) return null;
    const b = sxy / sxx;
    return { a: my - b * mx, b };
  };
  const costRatio = (pts) => median(pts.map((p) => p.cost / p.aac));
  const clampIdx = (v) => Math.min(100, Math.max(0.1, v));

  const nearestSibling = (pool, base, agentSlug, ii) => {
    const sibs = pool.filter((p) => p.base === base && (!agentSlug || p.agentSlug === agentSlug));
    if (!sibs.length) return null;
    const dist = (p) => Math.abs(p.ii - ii);
    const dmin = Math.min(...sibs.map(dist));
    const tied = sibs.filter((p) => dist(p) === dmin);
    if (tied.length === 1) return tied[0];
    // Equally near runs (e.g. one model in several agents): average them instead of taking the best score.
    // Harness comparison: mean of the other agents 2.0 pts median error vs 2.7 for a single copy.
    const mean = (k) => tied.reduce((acc, p) => acc + p[k], 0) / tied.length;
    const agents = [...new Set(tied.map((p) => p.agent))];
    return {
      ...tied[0],
      agentSlug: agents.length === 1 ? tied[0].agentSlug : null,
      agent: agents.length === 1 ? tied[0].agent : `${agents.length} agents`,
      effort: [...new Set(tied.map((p) => p.effort))].join("/"),
      y: mean("y"),
      ii: mean("ii"),
      cost: mean("cost"),
      aac: mean("aac"),
    };
  };
  const fromSibling = (s, ii, aac) => ({
    index: round1(clampIdx(s.y + (ii - s.ii))),
    costPerTaskUsd: s.cost * (aac / s.aac),
  });
  const fromModel = (fit, xKey, x, ratio, aac) => ({
    index: round1(clampIdx(fit.a + fit.b * x)),
    costPerTaskUsd: aac * ratio,
  });

  // Cross-model fits use one point per model+effort (agents averaged), so a model AA ran in many
  // harnesses (GLM-5.3-Flash, GPT-6 Luna) is not counted several times. Prefer Terminal-Bench 4.0, else II.
  const fitGroups = new Map();
  for (const p of points) {
    const k = `${p.base}|${p.effort}`;
    if (!fitGroups.has(k)) fitGroups.set(k, []);
    fitGroups.get(k).push(p);
  }
  const fitPoints = [...fitGroups.values()].map((g) => ({
    ...g[0],
    y: g.reduce((acc, p) => acc + p.y, 0) / g.length,
    cost: g.reduce((acc, p) => acc + p.cost, 0) / g.length,
  }));
  const tbFit = fitLine(fitPoints, "tb");
  const iiFit = fitLine(fitPoints, "ii");
  const ratioAll = costRatio(fitPoints);

  let sameModel = 0, model = 0;
  for (const e of entries) {
    if (e.codingAgent || UNMEASURED_HARNESSES.has(e.harness)) continue;
    const pinned = HARNESS_TO_AA_AGENT[e.harness] || null;
    if (!pinned && !(e.openEndpoint || e.billing === "metered")) continue;
    // Pinned agent AA has never run: nothing to anchor on.
    if (pinned && !agentNames.has(pinned)) continue;
    const ii = e.intelligenceIndex;
    const aac = e.aaCostPerTaskUsd;
    if (!(ii > 0) || !(aac > 0)) continue;

    // Same agent first; else the same model in another agent (accuracy.crossAgent).
    const base = normSlug(e.baseModelId);
    const s = nearestSibling(points, base, pinned, ii) || (pinned ? nearestSibling(points, base, null, ii) : null);
    if (s) {
      e.codingAgent = {
        agent: pinned ? agentNames.get(pinned) || s.agent : s.agentSlug ? s.agent : null,
        agentSlug: pinned || s.agentSlug,
        ...fromSibling(s, ii, aac),
        wallTimeSec: null,
        estimate: "same-model",
        crossAgent: Boolean(pinned && s.agentSlug !== pinned),
        fromAgent: s.agent,
        fromEffort: s.effort,
      };
      sameModel++;
      continue;
    }
    const tb = e.benchmarks?.terminalBench40;
    const [fit, x] = tbFit && Number.isFinite(tb) ? [tbFit, tb] : iiFit ? [iiFit, ii] : [null, null];
    if (!fit) continue;
    const xKey = fit === tbFit ? "tb" : "ii";
    e.codingAgent = {
      outOfRange: x < Math.min(...fitPoints.filter((p) => Number.isFinite(p[xKey])).map((p) => p[xKey])),
      agent: pinned ? agentNames.get(pinned) || null : null,
      agentSlug: pinned,
      ...fromModel(fit, fit === tbFit ? "tb" : "ii", x, ratioAll, aac),
      wallTimeSec: null,
      estimate: "terminal-bench",
    };
    model++;
  }

  // LOOCV (hold out each measured point; its whole base model is excluded from training for the fit)
  const errS = [], costS = [], errM = [], costM = [];
  for (const p of points) {
    const others = points.filter((q) => q !== p);
    const s = nearestSibling(others, p.base, p.agentSlug, p.ii);
    if (s) {
      const r = fromSibling(s, p.ii, p.aac);
      errS.push(Math.abs(r.index - p.y));
      costS.push(Math.abs(r.costPerTaskUsd / p.cost - 1) * 100);
    }
  }
  for (const p of fitPoints) {
    const train = fitPoints.filter((q) => q.base !== p.base);
    const useTb = Number.isFinite(p.tb);
    const fit = fitLine(train, useTb ? "tb" : "ii");
    if (fit) {
      const r = fromModel(fit, useTb ? "tb" : "ii", useTb ? p.tb : p.ii, costRatio(train), p.aac);
      errM.push(Math.abs(r.index - p.y));
      costM.push(Math.abs(r.costPerTaskUsd / p.cost - 1) * 100);
    }
  }
  // Cross-agent transfer error: every ordered pair of agents run on the same model+effort
  // (AA's harness comparison: ~13 harnesses on GLM-5.3-Flash and GPT-6 Luna at max).
  // A fixed per-agent offset fitted on one model raised this error on the other (rank flips), so none is applied.
  const errX = [], costX = [];
  for (const pool of agentIndex.values()) {
    for (const t of pool) for (const s of pool) {
      if (t === s) continue;
      errX.push(Math.abs(s.index - t.index));
      costX.push(Math.abs(s.costPerTaskUsd / t.costPerTaskUsd - 1) * 100);
    }
  }
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const r0 = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return {
    sameModel,
    model,
    accuracy: {
      sameModel: { n: errS.length, pts: r1(median(errS)), costPct: r0(median(costS)) },
      crossAgent: { n: errX.length, pts: r1(median(errX)), costPct: r0(median(costX)) },
      model: { n: errM.length, pts: r1(median(errM)), costPct: r0(median(costM)) },
    },
  };
}

/**
 * Parse multi-effort Artificial Analysis Intelligence Index + Cost per Task directly
 * from upstream Fei2411/real-api-pricing (derived/benchmark-configurations.csv).
 */
function parseFeiBenchConfigs(csvText, aaByNorm) {
  const rows = parseCsv(csvText);
  const byBase = new Map(); // baseSlug -> Map<effort, variantObj>
  let count = 0;

  for (const r of rows) {
    if (r.board !== "aa_intelligence_index") continue;
    const score = toNum(r.score);
    const cpt = toNum(r.mean_cost_usd_per_task);
    if (score == null || cpt == null || cpt <= 0) continue;

    const baseSlug = canonicalBaseSlug(r.model, aaByNorm);
    const rawEff =
      r.reasoning_effort ||
      (/\(non-reasoning\)/i.test(r.variant || "") ? "none" : "default");
    const effort = cleanEffort(rawEff);
    const aaHeadline = resolveAaModel(r.model, aaByNorm);

    let effMap = byBase.get(baseSlug);
    if (!effMap) {
      effMap = new Map();
      byBase.set(baseSlug, effMap);
    }

    const effortSuffix = EFFORT_LABELS[effort];
    const baseDisplay = normalizeBaseDisplay(aaHeadline?.shortName || r.variant || r.model);
    const displayName = effortSuffix ? `${baseDisplay} (${effortSuffix})` : baseDisplay;

    const isHeadlineEffort =
      aaHeadline &&
      aaHeadline.intelligenceIndex != null &&
      Math.abs(aaHeadline.intelligenceIndex - score) < 0.35 &&
      aaHeadline.costPerTaskUsd != null &&
      Math.abs(aaHeadline.costPerTaskUsd - cpt) < 0.05;

    effMap.set(effort, {
      variantKey: effortSuffix ? `${baseSlug}--${effort}` : baseSlug,
      baseSlug,
      effort,
      effortLabel: effortSuffix,
      displayName,
      baseDisplay,
      creatorName: aaHeadline?.creatorName || null,
      creatorColor: aaHeadline?.creatorColor || null,
      intelligenceIndex: score,
      iiDate: r.checked_at || null,
      costPerTaskUsd: cpt,
      benchmarks: isHeadlineEffort
        ? { ...aaHeadline.benchmarks, intelligenceIndex: round1(score) }
        : { intelligenceIndex: round1(score) },
      aaUrl: aaHeadline?.sourceUrl || `https://artificialanalysis.ai/models/${baseSlug}`,
      aaLive: Boolean(aaHeadline),
      isHeadline: Boolean(isHeadlineEffort),
      pricing: aaHeadline?.pricing || null,
      costPerTaskBreakdown: isHeadlineEffort ? aaHeadline.costPerTaskBreakdown : null,
      totalIndexCostUsd: isHeadlineEffort ? aaHeadline.totalIndexCostUsd : null,
      speed: isHeadlineEffort ? aaHeadline.speed : null,
      isOpenWeights: Boolean(aaHeadline?.isOpenWeights),
      contextWindowTokens: aaHeadline?.contextWindowTokens ?? null,
    });
    count++;
  }
  return { count, byBase };
}

function extractCopilotAvailableModels(doc) {
  const available = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "text" && typeof node.value === "string") {
      const marks = Array.isArray(node.marks) ? node.marks.map((m) => m.type) : [];
      const val = node.value.trim();
      if (val && !marks.includes("strikethrough")) {
        // Strip leading vendor prefix ("Anthropic Claude Opus 5.5" -> "claude-opus-5-5")
        const stripped = val.replace(/^(Anthropic|OpenAI|Google|xAI|Microsoft|Moonshot(?:\s+AI)?)\s+/i, "");
        available.push(normSlug(stripped));
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else {
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(doc);
  return [...new Set(available)];
}

/**
 * Live-parse deterministic GitHub Copilot AI Credit tiers AND per-plan available models
 * directly from https://github.com/features/copilot/plans.
 * Throws if GitHub changes pricing/credit/model availability format so check-alerts.mjs opens a [Data Alert].
 */
function parseGithubCopilotPlansHtml(html) {
  const amIdx = html.indexOf('Available models","heading"');
  if (amIdx === -1) {
    throw new Error('Could not locate "Available models" matrix on github.com/features/copilot/plans');
  }

  const tiers = [
    {
      name: "GitHub Copilot Pro",
      availField: "customTextForPro",
      priceRe: /"id":"Pro","heading":"Pro","subheading":[\s\S]{0,220}?"value":"\$(\d+)"/,
      creditRe: /\$(\d+(?:,\d+)?)\s+monthly total credits for Pro\b/,
    },
    {
      name: "GitHub Copilot Pro+",
      availField: "customTextForProPlus",
      priceRe: /"id":"ProPlus","heading":"Pro\+","subheading":[\s\S]{0,220}?"value":"\$(\d+)"/,
      creditRe: /\$(\d+(?:,\d+)?)\s+monthly total credits for Pro\+/i,
    },
    {
      name: "GitHub Copilot Max",
      availField: "customTextForMax",
      priceRe: /"id":"Max","heading":"Max","subheading":[\s\S]{0,220}?"value":"\$(\d+)"/,
      creditRe: /\$(\d+(?:,\d+)?)\s+monthly total credits for Max\b/,
    },
  ];

  const parsed = [];
  const cumulativeModels = new Set();
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

    const fieldPos = html.indexOf(`"${t.availField}":`, amIdx);
    if (fieldPos === -1) {
      throw new Error(`Could not locate ${t.availField} model list for ${t.name}`);
    }
    const braceIdx = html.indexOf("{", fieldPos);
    const doc = extractBalancedJsonObject(html, braceIdx);
    const tierModels = extractCopilotAvailableModels(doc);
    if (tierModels.length === 0) {
      throw new Error(`Parsed 0 available models for ${t.name}`);
    }
    // Pro+ ("Everything in Pro, plus...") and Max inherit all lower-tier models
    for (const m of tierModels) cumulativeModels.add(m);

    parsed.push({
      plan: t.name,
      feeUsd,
      creditsUsd,
      multiple: creditsUsd / feeUsd,
      availableModels: [...cumulativeModels],
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

/**
 * Parse OpenRouter's free public catalog (https://openrouter.ai/api/v1/models)
 * to backfill context windows, open-weights status, missing API pricing,
 * AA domain indices, and confirm gateway model availability for Kilo Pass.
 */
function parseOpenRouterModels(json, aaByNorm) {
  const list = Array.isArray(json?.data) ? json.data : [];
  if (list.length === 0) {
    throw new Error("OpenRouter models API returned 0 models");
  }

  const bySlug = new Map();
  const byName = new Map();

  for (const m of list) {
    const rawId = String(m?.id || "").trim();
    if (!rawId || rawId.includes(":") || rawId.startsWith("~") || rawId.startsWith("openrouter/")) {
      continue;
    }

    const slugPart = rawId.includes("/") ? rawId.split("/").slice(1).join("/") : rawId;
    const prompt = toNum(m.pricing?.prompt);
    const completion = toNum(m.pricing?.completion);
    const cacheRead = toNum(m.pricing?.input_cache_read);
    const inputPer1M = prompt != null && prompt > 0 ? Number((prompt * 1e6).toFixed(4)) : null;
    const outputPer1M = completion != null && completion > 0 ? Number((completion * 1e6).toFixed(4)) : null;
    const cacheHitPer1M = cacheRead != null && cacheRead >= 0 ? Number((cacheRead * 1e6).toFixed(4)) : null;
    const blended3to1Per1M =
      inputPer1M != null && outputPer1M != null
        ? Number(((3 * inputPer1M + outputPer1M) / 4).toFixed(4))
        : null;

    const aa = m.benchmarks?.artificial_analysis;
    const domainBenchmarks = {};
    if (aa && typeof aa === "object") {
      if (toNum(aa.engineering_index) != null) domainBenchmarks.engineering = round1(aa.engineering_index);
      if (toNum(aa.finance_and_accounting_index) != null) {
        domainBenchmarks.financeAndAccounting = round1(aa.finance_and_accounting_index);
      }
      if (toNum(aa.strategy_and_ops_index) != null) {
        domainBenchmarks.strategyAndOps = round1(aa.strategy_and_ops_index);
      }
      if (toNum(aa.legal_index) != null) domainBenchmarks.legal = round1(aa.legal_index);
      if (toNum(aa.healthcare_and_medical_index) != null) {
        domainBenchmarks.healthcareAndMedical = round1(aa.healthcare_and_medical_index);
      }
      if (toNum(aa.economics_index) != null) domainBenchmarks.economics = round1(aa.economics_index);
    }

    const hasReasoningObj = Boolean(m.reasoning && typeof m.reasoning === "object");
    const mandatoryReasoning = Boolean(m.reasoning?.mandatory);
    let supportedEfforts = [];
    if (Array.isArray(m.reasoning?.supported_efforts)) {
      supportedEfforts = [
        ...new Set(
          m.reasoning.supported_efforts
            .map((e) => String(e || "").toLowerCase().trim())
            .filter((e) => ["none", "low", "medium", "high", "xhigh", "max"].includes(e))
            .filter((e) => !(mandatoryReasoning && e === "none"))
        ),
      ];
    } else if (hasReasoningObj && m.reasoning.supported_efforts === null) {
      // Per OpenRouter API spec: supported_efforts: null inside reasoning means all gateway effort levels are accepted
      supportedEfforts = mandatoryReasoning
        ? ["low", "medium", "high", "xhigh", "max"]
        : ["none", "low", "medium", "high", "xhigh", "max"];
    }
    const rawDefEff = String(m.reasoning?.default_effort || "").toLowerCase().trim();
    const defaultEffort = ["none", "low", "medium", "high", "xhigh", "max"].includes(rawDefEff)
      ? rawDefEff
      : null;

    const rec = {
      id: rawId,
      contextWindowTokens: toNum(m.context_length ?? m.top_provider?.context_length),
      isOpenWeights: Boolean(m.hugging_face_id),
      isPaid: inputPer1M != null && outputPer1M != null,
      aaIntelligenceIndex: aa && typeof aa === "object" ? toNum(aa.intelligence_index) : null,
      supportedEfforts: supportedEfforts.length > 0 ? supportedEfforts : null,
      defaultEffort,
      pricing:
        inputPer1M != null || outputPer1M != null
          ? {
              inputPer1M,
              outputPer1M,
              cacheHitPer1M,
              blended3to1Per1M,
              blended7to2to1Per1M: null,
            }
          : null,
      domainBenchmarks: Object.keys(domainBenchmarks).length > 0 ? domainBenchmarks : null,
    };

    const keys = [canonicalBaseSlug(slugPart, aaByNorm), normSlug(slugPart), normSlug(rawId)];
    for (const k of keys) {
      if (k && !bySlug.has(k)) bySlug.set(k, rec);
    }

    const nameNoVendor = String(m.name || "").replace(/^[^:]+:\s*/, "").trim();
    const nameKey = normSlug(nameNoVendor);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, rec);
  }

  return { totalCount: list.length, bySlug, byName };
}

function resolveOpenRouterModel(slug, openRouterIndex, aaByNorm) {
  if (!openRouterIndex) return null;
  const norm = normSlug(slug);
  const canon = canonicalBaseSlug(slug, aaByNorm);
  return (
    openRouterIndex.bySlug.get(slug) ||
    openRouterIndex.bySlug.get(canon) ||
    openRouterIndex.bySlug.get(norm) ||
    openRouterIndex.byName.get(canon) ||
    openRouterIndex.byName.get(norm) ||
    null
  );
}

/**
 * Live-parse deterministic Kilo Pass tiers, processing fee (5%), and annual bonus (50%)
 * directly from https://kilo.ai/pricing.
 * Throws if Kilo changes pricing, bonus, or fee structure so check-alerts.mjs opens a [Data Alert].
 */
function parseKiloPricingHtml(html) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  const annualBonusMatch = text.match(/Annual\s+(\d+(?:\.\d+)?)%\s+bonus/i);
  const feeMatch = text.match(/Credit purchase processing fee\s+(\d+(?:\.\d+)?)%/i);
  if (!annualBonusMatch || !feeMatch) {
    throw new Error("Could not verify Kilo Pass annual bonus and credit processing fee on kilo.ai/pricing");
  }

  const annualBonusPct = Number(annualBonusMatch[1]);
  const processingFeePct = Number(feeMatch[1]);
  if (
    !Number.isFinite(annualBonusPct) ||
    !Number.isFinite(processingFeePct) ||
    annualBonusPct <= 0 ||
    processingFeePct < 0
  ) {
    throw new Error("Invalid parsed bonus or processing fee percentages for Kilo Pass");
  }

  const parsed = [];
  for (const tierName of ["Starter", "Pro", "Expert"]) {
    const re = new RegExp(
      `\\b${tierName}\\s+\\$(\\d+(?:,\\d+)?)\\s*\\/\\s*mo\\s+Up to \\$(\\d+(?:,\\d+)?(?:\\.\\d+)?)\\s*\\/\\s*mo in credits`,
      "i"
    );
    const m = text.match(re);
    if (!m) {
      throw new Error(`Could not verify Kilo Pass ${tierName} fee/credits on kilo.ai/pricing`);
    }
    const baseFeeUsd = Number(m[1].replace(/,/g, ""));
    const monthlyMaxCreditsUsd = Number(m[2].replace(/,/g, ""));
    if (
      !Number.isFinite(baseFeeUsd) ||
      !Number.isFinite(monthlyMaxCreditsUsd) ||
      baseFeeUsd <= 0 ||
      monthlyMaxCreditsUsd <= 0
    ) {
      throw new Error(`Invalid parsed numbers for Kilo Pass ${tierName}`);
    }

    const effectiveFeeUsd = Number((baseFeeUsd * (1 + processingFeePct / 100)).toFixed(2));
    const annualCreditsUsd = Number((baseFeeUsd * (1 + annualBonusPct / 100)).toFixed(2));
    const multiple = annualCreditsUsd / effectiveFeeUsd;

    parsed.push({
      plan: `Kilo Pass ${tierName} (Annual)`,
      tierName,
      baseFeeUsd,
      effectiveFeeUsd,
      annualCreditsUsd,
      monthlyMaxCreditsUsd,
      annualBonusPct,
      processingFeePct,
      multiple,
    });
  }
  return parsed;
}

const ORDERED_NAMED_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function logitProb(p) {
  const c = Math.max(0.005, Math.min(0.995, p));
  return Math.log(c / (1 - c));
}

function sigmoidProb(x) {
  return 1 / (1 + Math.exp(-x));
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

/**
 * Fill missing intermediate reasoning effort levels strictly bracketed between
 * a lower and higher measured effort on the SAME model.
 * Uses empirical median step curves fitted from measured multi-effort models
 * (linear on Intelligence/test scores, log-linear on Cost/Task) and gates on
 * OpenRouter's supported_efforts whenever available.
 */
function interpolateMissingEfforts(aaVariantsByBase, openRouterIndex, aaByNorm) {
  const stepIntelDeltas = Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []);
  const stepLogCostDeltas = Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []);

  for (const effMap of aaVariantsByBase.values()) {
    for (let i = 0; i < ORDERED_NAMED_EFFORTS.length - 1; i++) {
      const a = effMap.get(ORDERED_NAMED_EFFORTS[i]);
      const b = effMap.get(ORDERED_NAMED_EFFORTS[i + 1]);
      if (!a || !b || a.effortEstimate || b.effortEstimate) continue;
      if (a.intelligenceIndex != null && b.intelligenceIndex != null) {
        const dIntel = b.intelligenceIndex - a.intelligenceIndex;
        if (dIntel > 0) stepIntelDeltas[i].push(dIntel);
      }
      if (a.costPerTaskUsd > 0 && b.costPerTaskUsd > 0) {
        const dLog = Math.log(b.costPerTaskUsd / a.costPerTaskUsd);
        if (dLog > 0) stepLogCostDeltas[i].push(dLog);
      }
    }
  }

  const defaultIntelSteps = [6.0, 5.0, 4.0, 2.5, 1.5];
  const defaultLogCostSteps = [0.6, 0.55, 0.5, 0.45, 0.45];
  const cumIntel = [0];
  const cumLogCost = [0];
  for (let i = 0; i < ORDERED_NAMED_EFFORTS.length - 1; i++) {
    const dI = median(stepIntelDeltas[i]) ?? defaultIntelSteps[i];
    const dC = median(stepLogCostDeltas[i]) ?? defaultLogCostSteps[i];
    cumIntel.push(cumIntel[i] + Math.max(0.5, dI));
    cumLogCost.push(cumLogCost[i] + Math.max(0.1, dC));
  }

  let interpolatedCount = 0;
  for (const [baseSlug, effMap] of aaVariantsByBase.entries()) {
    const measuredRanks = ORDERED_NAMED_EFFORTS.map((eff, idx) => ({
      eff,
      idx,
      v: effMap.get(eff),
    })).filter((x) => x.v && !x.v.effortEstimate);

    if (measuredRanks.length < 2) continue;

    const orModel = resolveOpenRouterModel(baseSlug, openRouterIndex, aaByNorm);
    const allowedSet = orModel?.supportedEfforts
      ? new Set(orModel.supportedEfforts)
      : new Set(["low", "medium", "high", "xhigh"]);

    for (let idx = 1; idx < ORDERED_NAMED_EFFORTS.length - 1; idx++) {
      const eff = ORDERED_NAMED_EFFORTS[idx];
      if (effMap.has(eff) || !allowedSet.has(eff)) continue;

      const loEntry = [...measuredRanks].reverse().find((x) => x.idx < idx);
      const hiEntry = measuredRanks.find((x) => x.idx > idx);
      if (!loEntry || !hiEntry) continue;

      const lo = loEntry.v;
      const hi = hiEntry.v;
      if (
        lo.intelligenceIndex == null ||
        hi.intelligenceIndex == null ||
        !(lo.costPerTaskUsd > 0) ||
        !(hi.costPerTaskUsd > 0)
      ) {
        continue;
      }

      const denomI = cumIntel[hiEntry.idx] - cumIntel[loEntry.idx];
      const denomC = cumLogCost[hiEntry.idx] - cumLogCost[loEntry.idx];
      const rawTI = denomI > 0 ? (cumIntel[idx] - cumIntel[loEntry.idx]) / denomI : (idx - loEntry.idx) / (hiEntry.idx - loEntry.idx);
      const rawTC = denomC > 0 ? (cumLogCost[idx] - cumLogCost[loEntry.idx]) / denomC : (idx - loEntry.idx) / (hiEntry.idx - loEntry.idx);
      const tI = Math.max(0.15, Math.min(0.85, rawTI));
      const tC = Math.max(0.15, Math.min(0.85, rawTC));

      const estIntel = Number((lo.intelligenceIndex + tI * (hi.intelligenceIndex - lo.intelligenceIndex)).toFixed(2));
      const estCpt = Number(
        Math.exp(Math.log(lo.costPerTaskUsd) + tC * (Math.log(hi.costPerTaskUsd) - Math.log(lo.costPerTaskUsd))).toFixed(4)
      );

      const benchmarks = { intelligenceIndex: round1(estIntel) };
      for (const [k, loVal] of Object.entries(lo.benchmarks || {})) {
        if (k === "intelligenceIndex") continue;
        const hiVal = hi.benchmarks?.[k];
        if (toNum(loVal) != null && toNum(hiVal) != null) {
          benchmarks[k] = round1(loVal + tI * (hiVal - loVal));
        }
      }

      const effortSuffix = EFFORT_LABELS[eff];
      const baseDisplay = hi.baseDisplay || lo.baseDisplay || baseSlug;

      effMap.set(eff, {
        variantKey: `${baseSlug}--${eff}`,
        baseSlug,
        effort: eff,
        effortLabel: effortSuffix,
        effortEstimate: "interpolated",
        displayName: `${baseDisplay} (${effortSuffix})`,
        baseDisplay,
        creatorName: hi.creatorName || lo.creatorName || null,
        creatorColor: hi.creatorColor || lo.creatorColor || null,
        intelligenceIndex: estIntel,
        costPerTaskUsd: estCpt,
        benchmarks,
        aaUrl: hi.aaUrl || lo.aaUrl || `https://artificialanalysis.ai/models/${baseSlug}`,
        aaLive: Boolean(hi.aaLive || lo.aaLive),
        isHeadline: false,
        pricing: hi.pricing || lo.pricing || null,
        costPerTaskBreakdown: null,
        totalIndexCostUsd: null,
        speed: hi.speed || lo.speed || null,
        isOpenWeights: Boolean(hi.isOpenWeights || lo.isOpenWeights),
        contextWindowTokens: hi.contextWindowTokens ?? lo.contextWindowTokens ?? null,
      });
      interpolatedCount++;
    }
  }
  return interpolatedCount;
}

/**
 * Parse ARC Prize ARC-AGI-2 (v2_Semi_Private) multi-effort evaluations as a
 * secondary fallback for extrapolating effort ratios on model families that
 * have no multi-effort Artificial Analysis measurements.
 */
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

function parseArcPrizeV2(evalsJson, modelsJson, aaByNorm) {
  const evalArr = Array.isArray(evalsJson) ? evalsJson : Object.values(evalsJson || {});
  const modelArr = Array.isArray(modelsJson) ? modelsJson : Object.values(modelsJson || {});
  const modelMap = new Map(modelArr.map((m) => [m.id || m.modelId || m.slug, m]));
  const byBase = new Map();

  for (const r of evalArr) {
    if ((r.datasetId || r.dataset) !== "v2_Semi_Private") continue;
    const m = modelMap.get(r.modelId) || {};
    const label = m.displayName || m.name || r.modelId || "";
    const eff = extractArcEffort(r.modelId) || extractArcEffort(label) || extractArcEffort(m.reasoningEffort);
    if (!eff) continue;
    const stripped = String(label || r.modelId)
      .replace(/\([^)]*(?:reasoning|thinking|effort|low|medium|high|xhigh|max|none|minimal|default)[^)]*\)/gi, " ")
      .replace(/[-_\s]+(?:xhigh|extra[-_\s]?high|high|medium|med|low|minimal|max|none|non[-_\s]?reasoning|thinking[-_\s]?\d+k?)\b/gi, " ")
      .replace(/\b202\d[-_]?\d{2}[-_]?\d{2}\b/g, " ");
    const baseSlug = canonicalBaseSlug(stripped, aaByNorm);
    const score = toNum(r.score ?? r.accuracy);
    const cost = toNum(r.costPerTask ?? r.cost_per_task ?? r.cost);
    if (!baseSlug || score == null) continue;
    if (!byBase.has(baseSlug)) byBase.set(baseSlug, new Map());
    byBase.get(baseSlug).set(eff, {
      score,
      cost: cost != null && cost > 0 ? cost : null,
    });
  }

  let multiCount = 0;
  for (const effMap of byBase.values()) {
    if (effMap.size >= 2) multiCount++;
  }
  return { byBase, multiCount };
}

/**
 * Option B (OFF by default in UI):
 * Extrapolate remaining supported reasoning efforts (gated strictly by OpenRouter's
 * reasoning.supported_efforts) from the nearest measured effort on the same model
 * using strictly same-family measured step scaling ratios, with ARC-AGI-2
 * (v2_Semi_Private) effort ratios as fallback for families without multi-effort AA data.
 */
function extrapolateMissingEfforts(aaVariantsByBase, openRouterIndex, aaByNorm, arcByBase = null) {
  if (!openRouterIndex) return { total: 0, arcCount: 0 };

  // Additive Intelligence deltas (+pts) and multiplicative Cost/Task ratios per same-family step
  const familyIntelDeltas = new Map();
  const familyCostRatios = new Map();
  const familyAllIntel = new Map();
  const familyAllCost = new Map();

  for (const [baseSlug, effMap] of aaVariantsByBase.entries()) {
    for (let i = 0; i < ORDERED_NAMED_EFFORTS.length - 1; i++) {
      const a = effMap.get(ORDERED_NAMED_EFFORTS[i]);
      const b = effMap.get(ORDERED_NAMED_EFFORTS[i + 1]);
      if (!a || !b || a.effortEstimate || b.effortEstimate) continue;
      const family = canonicalModelFamily(baseSlug, b.creatorName || a.creatorName);
      if (!family) continue;
      if (a.intelligenceIndex > 1 && b.intelligenceIndex > 1) {
        const dI = b.intelligenceIndex - a.intelligenceIndex;
        if (dI >= 0 && dI <= 25) {
          if (!familyIntelDeltas.has(family)) {
            familyIntelDeltas.set(family, Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []));
            familyAllIntel.set(family, []);
          }
          familyIntelDeltas.get(family)[i].push(dI);
          familyAllIntel.get(family).push(dI);
        }
      }
      if (a.costPerTaskUsd > 0 && b.costPerTaskUsd > 0) {
        const rC = b.costPerTaskUsd / a.costPerTaskUsd;
        if (rC >= 1.0 && rC <= 8.0) {
          if (!familyCostRatios.has(family)) {
            familyCostRatios.set(family, Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []));
            familyAllCost.set(family, []);
          }
          familyCostRatios.get(family)[i].push(rC);
          familyAllCost.get(family).push(rC);
        }
      }
    }
  }

  function stepDeltaOrRatio(family, idx, kind) {
    if (!family) return null;
    const fMap = kind === "intel" ? familyIntelDeltas : familyCostRatios;
    const fAll = kind === "intel" ? familyAllIntel : familyAllCost;
    const stepVals = fMap.has(family) ? fMap.get(family)[idx] : [];
    const anyVals = fAll.get(family) || [];
    const raw = stepVals.length >= 1 ? median(stepVals) : anyVals.length >= 1 ? median(anyVals) : null;
    if (raw == null) return null;
    return kind === "intel"
      ? Math.max(0.2, Math.min(15, raw))
      : Math.max(1.1, Math.min(4.0, raw));
  }

  // Fit live ARC-AGI-2 -> AA Intelligence IRT logit-space slope (Truong et al., arXiv:2606.07616)
  // AND per-family ARC-AGI-2 step curves in logit space
  let arcLogitSlope = null;
  const arcFamLogitDeltas = new Map();
  const arcFamCostRatios = new Map();
  const arcFamAllLogit = new Map();
  const arcFamAllCost = new Map();

  if (arcByBase && arcByBase.size > 0) {
    let num = 0;
    let den = 0;
    let pairCount = 0;
    for (const [baseSlug, effMap] of aaVariantsByBase.entries()) {
      const arcEffs = arcByBase.get(baseSlug);
      if (!arcEffs || arcEffs.size < 2) continue;
      const common = ORDERED_NAMED_EFFORTS.filter((e) => {
        const av = effMap.get(e);
        return av && !av.effortEstimate && av.intelligenceIndex > 0 && arcEffs.has(e);
      });
      for (let i = 0; i < common.length; i++) {
        for (let j = i + 1; j < common.length; j++) {
          const dArcLogit = logitProb(arcEffs.get(common[j]).score) - logitProb(arcEffs.get(common[i]).score);
          const dAaLogit =
            logitProb(effMap.get(common[j]).intelligenceIndex / 100) -
            logitProb(effMap.get(common[i]).intelligenceIndex / 100);
          num += dArcLogit * dAaLogit;
          den += dArcLogit * dArcLogit;
          pairCount++;
        }
      }
    }
    if (pairCount >= 5 && den > 1e-9 && num / den > 0) {
      arcLogitSlope = num / den;
    }

    if (arcLogitSlope != null) {
      for (const [arcSlug, arcEffs] of arcByBase.entries()) {
        const fam = canonicalModelFamily(arcSlug, null);
        if (!fam) continue;
        const pts = ORDERED_NAMED_EFFORTS.map((e, idx) => ({ idx, v: arcEffs.get(e) }))
          .filter((p) => p.v && p.v.cost > 0);
        if (pts.length < 2) continue;
        for (let p = 0; p < pts.length - 1; p++) {
          const a = pts[p];
          const b = pts[p + 1];
          const steps = b.idx - a.idx;
          if (steps <= 0) continue;
          const perStepCost = Math.pow(b.v.cost / a.v.cost, 1 / steps);
          const perStepLogit = (arcLogitSlope * (logitProb(b.v.score) - logitProb(a.v.score))) / steps;
          if (!arcFamLogitDeltas.has(fam)) {
            arcFamLogitDeltas.set(fam, Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []));
            arcFamCostRatios.set(fam, Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []));
            arcFamAllLogit.set(fam, []);
            arcFamAllCost.set(fam, []);
          }
          if (perStepCost >= 1.0 && perStepCost <= 6.0) {
            for (let i = a.idx; i < b.idx; i++) arcFamCostRatios.get(fam)[i].push(perStepCost);
            arcFamAllCost.get(fam).push(perStepCost);
          }
          if (perStepLogit >= 0 && perStepLogit <= 1.5) {
            for (let i = a.idx; i < b.idx; i++) arcFamLogitDeltas.get(fam)[i].push(perStepLogit);
            arcFamAllLogit.get(fam).push(perStepLogit);
          }
        }
      }
    }
  }

  function arcFamilyStep(family, idx, kind) {
    if (!family) return null;
    const fMap = kind === "intel" ? arcFamLogitDeltas : arcFamCostRatios;
    const fAll = kind === "intel" ? arcFamAllLogit : arcFamAllCost;
    const stepVals = fMap.has(family) ? fMap.get(family)[idx] : [];
    const anyVals = fAll.get(family) || [];
    const raw = stepVals.length >= 1 ? median(stepVals) : anyVals.length >= 1 ? median(anyVals) : null;
    if (raw == null) return null;
    return kind === "intel"
      ? Math.max(0.02, Math.min(0.8, raw))
      : Math.max(1.1, Math.min(4.0, raw));
  }

  let extrapolatedCount = 0;
  let arcExtrapCount = 0;
  for (const [baseSlug, effMap] of aaVariantsByBase.entries()) {
    const orModel = resolveOpenRouterModel(baseSlug, openRouterIndex, aaByNorm);
    const arcEffs = arcByBase?.get(baseSlug) || null;
    const targetEfforts = orModel?.supportedEfforts?.length
      ? orModel.supportedEfforts
      : arcEffs
        ? [...arcEffs.keys()]
        : [];
    if (!targetEfforts.length) continue;

    // Gather real measured anchors (named efforts, or "default" anchored via OpenRouter default_effort)
    const anchors = [];
    for (let idx = 0; idx < ORDERED_NAMED_EFFORTS.length; idx++) {
      const v = effMap.get(ORDERED_NAMED_EFFORTS[idx]);
      if (v && !v.effortEstimate && v.intelligenceIndex > 0 && v.costPerTaskUsd > 0) {
        anchors.push({ idx, v });
      }
    }
    if (anchors.length === 0 && effMap.has("default") && orModel?.defaultEffort) {
      const defV = effMap.get("default");
      const defIdx = ORDERED_NAMED_EFFORTS.indexOf(orModel.defaultEffort);
      if (defIdx !== -1 && defV && defV.intelligenceIndex > 0 && defV.costPerTaskUsd > 0) {
        anchors.push({ idx: defIdx, v: defV, isDefaultAnchor: true });
      }
    }
    if (anchors.length === 0) continue;

    const family = canonicalModelFamily(baseSlug, anchors[0].v.creatorName);
    const hasSameFamily = Boolean(family && familyAllIntel.has(family) && familyAllCost.has(family));
    const hasArcFamily = Boolean(family && arcFamAllLogit.has(family) && arcFamAllCost.has(family));
    if (!hasSameFamily && (!arcEffs || arcLogitSlope == null) && !hasArcFamily) continue;

    for (const targetEff of targetEfforts) {
      const targetIdx = ORDERED_NAMED_EFFORTS.indexOf(targetEff);
      if (targetIdx === -1 || effMap.has(targetEff)) continue;
      // Don't duplicate a single default-anchored effort under its own default_effort name
      if (anchors.length === 1 && anchors[0].isDefaultAnchor && anchors[0].idx === targetIdx) continue;

      // Pick nearest real measured anchor
      let anchor = anchors[0];
      for (const a of anchors) {
        if (Math.abs(a.idx - targetIdx) < Math.abs(anchor.idx - targetIdx)) anchor = a;
      }

      let estIntel = null;
      let estCpt = null;
      let intelMult = 1;
      let estimateSource = "same-family";

      if (hasSameFamily) {
        let intelDelta = 0;
        let costMult = 1;
        let missingRatio = false;
        if (targetIdx > anchor.idx) {
          for (let i = anchor.idx; i < targetIdx; i++) {
            const dI = stepDeltaOrRatio(family, i, "intel");
            const rC = stepDeltaOrRatio(family, i, "cost");
            if (dI == null || rC == null) { missingRatio = true; break; }
            intelDelta += dI;
            costMult *= rC;
          }
        } else {
          for (let i = targetIdx; i < anchor.idx; i++) {
            const dI = stepDeltaOrRatio(family, i, "intel");
            const rC = stepDeltaOrRatio(family, i, "cost");
            if (dI == null || rC == null) { missingRatio = true; break; }
            intelDelta -= dI;
            costMult /= rC;
          }
        }
        if (!missingRatio) {
          estIntel = Number(Math.max(1, Math.min(95, anchor.v.intelligenceIndex + intelDelta)).toFixed(2));
          intelMult = anchor.v.intelligenceIndex > 0 ? estIntel / anchor.v.intelligenceIndex : 1;
          estCpt = Number(Math.max(0.001, anchor.v.costPerTaskUsd * costMult).toFixed(4));
        }
      } else {
        // Fallback 2a: exact-model ARC-AGI-2 (v2_Semi_Private) IRT logit-space transfer
        if (arcEffs && arcLogitSlope != null) {
          const arcAnchorEff = ORDERED_NAMED_EFFORTS[anchor.idx];
          const arcA = arcEffs.get(arcAnchorEff);
          const arcT = arcEffs.get(targetEff);
          if (arcA && arcT && arcA.cost > 0 && arcT.cost > 0) {
            const rawLogit =
              logitProb(anchor.v.intelligenceIndex / 100) +
              arcLogitSlope * (logitProb(arcT.score) - logitProb(arcA.score));
            estIntel = Number(Math.max(1, Math.min(95, sigmoidProb(rawLogit) * 100)).toFixed(2));
            intelMult = anchor.v.intelligenceIndex > 0 ? estIntel / anchor.v.intelligenceIndex : 1;
            const costRatio = Math.max(0.15, Math.min(6.0, arcT.cost / arcA.cost));
            estCpt = Number(Math.max(0.001, anchor.v.costPerTaskUsd * costRatio).toFixed(4));
            estimateSource = "arc-agi-2";
            arcExtrapCount++;
          }
        }
        // Fallback 2b: same-family ARC-AGI-2 logit-space step curve (e.g. Kimi K3.1 Pro from Kimi K3)
        if (estIntel == null && hasArcFamily) {
          let logitDelta = 0;
          let costMult = 1;
          let missingRatio = false;
          if (targetIdx > anchor.idx) {
            for (let i = anchor.idx; i < targetIdx; i++) {
              const dL = arcFamilyStep(family, i, "intel");
              const rC = arcFamilyStep(family, i, "cost");
              if (dL == null || rC == null) { missingRatio = true; break; }
              logitDelta += dL;
              costMult *= rC;
            }
          } else {
            for (let i = targetIdx; i < anchor.idx; i++) {
              const dL = arcFamilyStep(family, i, "intel");
              const rC = arcFamilyStep(family, i, "cost");
              if (dL == null || rC == null) { missingRatio = true; break; }
              logitDelta -= dL;
              costMult /= rC;
            }
          }
          if (!missingRatio) {
            const rawLogit = logitProb(anchor.v.intelligenceIndex / 100) + logitDelta;
            estIntel = Number(Math.max(1, Math.min(95, sigmoidProb(rawLogit) * 100)).toFixed(2));
            intelMult = anchor.v.intelligenceIndex > 0 ? estIntel / anchor.v.intelligenceIndex : 1;
            estCpt = Number(Math.max(0.001, anchor.v.costPerTaskUsd * costMult).toFixed(4));
            estimateSource = "arc-agi-2";
            arcExtrapCount++;
          }
        }
      }
      if (estIntel == null || estCpt == null) continue;

      const benchmarks = { intelligenceIndex: round1(estIntel) };
      for (const [k, baseVal] of Object.entries(anchor.v.benchmarks || {})) {
        if (k === "intelligenceIndex" || toNum(baseVal) == null) continue;
        if (k === "gdpval") {
          const delta = (estIntel - anchor.v.intelligenceIndex) * 10;
          benchmarks[k] = round1(Math.max(200, Math.min(2200, baseVal + delta)));
        } else {
          benchmarks[k] = round1(Math.max(0, Math.min(100, baseVal * intelMult)));
        }
      }

      const effortSuffix = EFFORT_LABELS[targetEff];
      const baseDisplay = anchor.v.baseDisplay || baseSlug;

      effMap.set(targetEff, {
        variantKey: `${baseSlug}--${targetEff}`,
        baseSlug,
        effort: targetEff,
        effortLabel: effortSuffix,
        effortEstimate: "extrapolated",
        effortEstimateSource: estimateSource,
        effortEstimateSteps: Math.abs(targetIdx - anchor.idx),
        displayName: `${baseDisplay} (${effortSuffix})`,
        baseDisplay,
        creatorName: anchor.v.creatorName || null,
        creatorColor: anchor.v.creatorColor || null,
        intelligenceIndex: estIntel,
        costPerTaskUsd: estCpt,
        benchmarks,
        aaUrl: anchor.v.aaUrl || `https://artificialanalysis.ai/models/${baseSlug}`,
        aaLive: Boolean(anchor.v.aaLive),
        isHeadline: false,
        pricing: anchor.v.pricing || null,
        costPerTaskBreakdown: null,
        totalIndexCostUsd: null,
        speed: anchor.v.speed || null,
        isOpenWeights: Boolean(anchor.v.isOpenWeights),
        contextWindowTokens: anchor.v.contextWindowTokens ?? null,
      });
      extrapolatedCount++;
    }
  }

  // Pass 2: Fill any remaining intermediate effort gaps between the lowest and highest
  // present effort on a model (including extrapolated endpoints), tagged "extrapolated".
  for (const [baseSlug, effMap] of aaVariantsByBase.entries()) {
    const positioned = [];
    for (let idx = 0; idx < ORDERED_NAMED_EFFORTS.length; idx++) {
      const v = effMap.get(ORDERED_NAMED_EFFORTS[idx]);
      if (v && v.intelligenceIndex > 0 && v.costPerTaskUsd > 0) {
        positioned.push({ idx, v });
      }
    }
    const orModel = resolveOpenRouterModel(baseSlug, openRouterIndex, aaByNorm);
    if (effMap.has("default") && orModel?.defaultEffort) {
      const defV = effMap.get("default");
      const defIdx = ORDERED_NAMED_EFFORTS.indexOf(orModel.defaultEffort);
      if (
        defIdx !== -1 &&
        !positioned.some((p) => p.idx === defIdx) &&
        defV &&
        defV.intelligenceIndex > 0 &&
        defV.costPerTaskUsd > 0
      ) {
        positioned.push({ idx: defIdx, v: defV, isDefaultAnchor: true });
      }
    }
    if (positioned.length < 2) continue;
    positioned.sort((a, b) => a.idx - b.idx);

    const family = canonicalModelFamily(baseSlug, positioned[0].v.creatorName);
    const cumIntelW = [0];
    const cumCostW = [0];
    for (let i = 0; i < ORDERED_NAMED_EFFORTS.length - 1; i++) {
      cumIntelW.push(cumIntelW[i] + (stepDeltaOrRatio(family, i, "intel") ?? 3.5));
      cumCostW.push(cumCostW[i] + Math.log(stepDeltaOrRatio(family, i, "cost") ?? 1.65));
    }

    const minIdx = positioned[0].idx;
    const maxIdx = positioned[positioned.length - 1].idx;
    for (let idx = minIdx + 1; idx < maxIdx; idx++) {
      const eff = ORDERED_NAMED_EFFORTS[idx];
      if (effMap.has(eff) || positioned.some((p) => p.idx === idx)) continue;

      const loEntry = [...positioned].reverse().find((p) => p.idx < idx);
      const hiEntry = positioned.find((p) => p.idx > idx);
      if (!loEntry || !hiEntry) continue;

      const lo = loEntry.v;
      const hi = hiEntry.v;
      const dI = cumIntelW[hiEntry.idx] - cumIntelW[loEntry.idx];
      const dC = cumCostW[hiEntry.idx] - cumCostW[loEntry.idx];
      const rawTI = dI > 0 ? (cumIntelW[idx] - cumIntelW[loEntry.idx]) / dI : (idx - loEntry.idx) / (hiEntry.idx - loEntry.idx);
      const rawTC = dC > 0 ? (cumCostW[idx] - cumCostW[loEntry.idx]) / dC : (idx - loEntry.idx) / (hiEntry.idx - loEntry.idx);
      const tI = Math.max(0.15, Math.min(0.85, rawTI));
      const tC = Math.max(0.15, Math.min(0.85, rawTC));

      const estIntel = Number(
        Math.max(1, Math.min(95, lo.intelligenceIndex + tI * (hi.intelligenceIndex - lo.intelligenceIndex))).toFixed(2)
      );
      const estCpt = Number(
        Math.max(
          0.001,
          Math.exp(Math.log(lo.costPerTaskUsd) + tC * (Math.log(hi.costPerTaskUsd) - Math.log(lo.costPerTaskUsd)))
        ).toFixed(4)
      );

      const benchmarks = { intelligenceIndex: round1(estIntel) };
      for (const [k, loVal] of Object.entries(lo.benchmarks || {})) {
        if (k === "intelligenceIndex") continue;
        const hiVal = hi.benchmarks?.[k];
        if (toNum(loVal) != null && toNum(hiVal) != null) {
          benchmarks[k] = round1(loVal + tI * (hiVal - loVal));
        }
      }

      const effortSuffix = EFFORT_LABELS[eff];
      const baseDisplay = hi.baseDisplay || lo.baseDisplay || baseSlug;

      // Effort steps to the nearest real measurement (neighbours here may themselves be extrapolated)
      const realIdx = positioned.filter((p) => !p.v.effortEstimate).map((p) => p.idx);
      const gapSteps = realIdx.length ? Math.min(...realIdx.map((r) => Math.abs(r - idx))) : 9;
      effMap.set(eff, {
        variantKey: `${baseSlug}--${eff}`,
        baseSlug,
        effort: eff,
        effortLabel: effortSuffix,
        effortEstimate: "extrapolated",
        effortEstimateSource:
          lo.effortEstimateSource === "arc-agi-2" || hi.effortEstimateSource === "arc-agi-2"
            ? "arc-agi-2"
            : "same-family",
        effortEstimateSteps: gapSteps,
        displayName: `${baseDisplay} (${effortSuffix})`,
        baseDisplay,
        creatorName: hi.creatorName || lo.creatorName || null,
        creatorColor: hi.creatorColor || lo.creatorColor || null,
        intelligenceIndex: estIntel,
        costPerTaskUsd: estCpt,
        benchmarks,
        aaUrl: hi.aaUrl || lo.aaUrl || `https://artificialanalysis.ai/models/${baseSlug}`,
        aaLive: Boolean(hi.aaLive || lo.aaLive),
        isHeadline: false,
        pricing: hi.pricing || lo.pricing || null,
        costPerTaskBreakdown: null,
        totalIndexCostUsd: null,
        speed: hi.speed || lo.speed || null,
        isOpenWeights: Boolean(hi.isOpenWeights || lo.isOpenWeights),
        contextWindowTokens: hi.contextWindowTokens ?? lo.contextWindowTokens ?? null,
      });
      extrapolatedCount++;
    }
  }

  return { total: extrapolatedCount, arcCount: arcExtrapCount };
}

/**
 * Leak-free leave-one-out cross-validation (LOOCV) on all real measured multi-effort
 * models to report empirical median error bands for interpolation (†) and same-family
 * extrapolation (‡) in the Methodology dialog.
 */
function computeEffortAccuracy(aaVariantsByBase) {
  const realByModel = new Map();
  for (const [slug, effMap] of aaVariantsByBase.entries()) {
    const pts = [];
    for (let idx = 0; idx < ORDERED_NAMED_EFFORTS.length; idx++) {
      const v = effMap.get(ORDERED_NAMED_EFFORTS[idx]);
      if (v && !v.effortEstimate && v.intelligenceIndex > 1 && v.costPerTaskUsd > 0) {
        pts.push({
          idx,
          family: canonicalModelFamily(slug, v.creatorName),
          intel: v.intelligenceIndex,
          cost: v.costPerTaskUsd,
        });
      }
    }
    if (pts.length >= 2) realByModel.set(slug, pts);
  }

  const interpIntelAbs = [];
  const interpCostPct = [];
  const extrap1IntelAbs = [];
  const extrap1CostPct = [];
  const extrap2IntelAbs = [], extrap2CostPct = [], extrap3IntelAbs = [], extrap3CostPct = [];
  const extrapAllIntelAbs = [];
  const extrapAllCostPct = [];

  for (const [heldSlug, pts] of realByModel.entries()) {
    // Fit curves excluding heldSlug
    const stepI = Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []);
    const stepLogC = Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []);
    const famI = new Map();
    const famC = new Map();
    const famAllI = new Map();
    const famAllC = new Map();

    for (const [s, otherPts] of realByModel.entries()) {
      if (s === heldSlug) continue;
      const byIdx = new Map(otherPts.map((p) => [p.idx, p]));
      for (let i = 0; i < ORDERED_NAMED_EFFORTS.length - 1; i++) {
        const a = byIdx.get(i);
        const b = byIdx.get(i + 1);
        if (!a || !b) continue;
        if (b.intel > a.intel) stepI[i].push(b.intel - a.intel);
        if (b.cost > a.cost) stepLogC[i].push(Math.log(b.cost / a.cost));
        const f = b.family || a.family;
        if (f) {
          const dI = b.intel - a.intel;
          const rC = b.cost / a.cost;
          if (dI >= 0 && dI <= 25) {
            if (!famI.has(f)) {
              famI.set(f, Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []));
              famAllI.set(f, []);
            }
            famI.get(f)[i].push(dI);
            famAllI.get(f).push(dI);
          }
          if (rC >= 1.0 && rC <= 8.0) {
            if (!famC.has(f)) {
              famC.set(f, Array.from({ length: ORDERED_NAMED_EFFORTS.length - 1 }, () => []));
              famAllC.set(f, []);
            }
            famC.get(f)[i].push(rC);
            famAllC.get(f).push(rC);
          }
        }
      }
    }

    const defI = [6.0, 5.0, 4.0, 2.5, 1.5];
    const defC = [0.6, 0.55, 0.5, 0.45, 0.45];
    const cumI = [0];
    const cumC = [0];
    for (let i = 0; i < ORDERED_NAMED_EFFORTS.length - 1; i++) {
      cumI.push(cumI[i] + Math.max(0.5, median(stepI[i]) ?? defI[i]));
      cumC.push(cumC[i] + Math.max(0.1, median(stepLogC[i]) ?? defC[i]));
    }

    // Interpolation LOOCV
    if (pts.length >= 3) {
      for (let p = 1; p < pts.length - 1; p++) {
        const target = pts[p];
        const lo = pts[p - 1];
        const hi = pts[p + 1];
        const tI = Math.max(0.15, Math.min(0.85, (cumI[target.idx] - cumI[lo.idx]) / (cumI[hi.idx] - cumI[lo.idx])));
        const tC = Math.max(0.15, Math.min(0.85, (cumC[target.idx] - cumC[lo.idx]) / (cumC[hi.idx] - cumC[lo.idx])));
        const predI = lo.intel + tI * (hi.intel - lo.intel);
        const predC = Math.exp(Math.log(lo.cost) + tC * (Math.log(hi.cost) - Math.log(lo.cost)));
        interpIntelAbs.push(Math.abs(predI - target.intel));
        interpCostPct.push((Math.abs(predC - target.cost) / target.cost) * 100);
      }
    }

    // Same-family extrapolation LOOCV
    const f = pts[0].family;
    if (!f || !famAllI.has(f) || !famAllC.has(f)) continue;
    const fStep = (i, kind) => {
      const m = kind === "intel" ? famI : famC;
      const all = kind === "intel" ? famAllI : famAllC;
      const vals = m.get(f)[i];
      const raw = vals.length >= 1 ? median(vals) : median(all.get(f));
      if (raw == null) return null;
      return kind === "intel" ? Math.max(0.2, Math.min(15, raw)) : Math.max(1.1, Math.min(4.0, raw));
    };

    for (const target of pts) {
      for (const anchor of pts) {
        if (anchor.idx === target.idx) continue;
        let deltaI = 0;
        let multC = 1;
        let bad = false;
        const lo = Math.min(anchor.idx, target.idx);
        const hi = Math.max(anchor.idx, target.idx);
        for (let i = lo; i < hi; i++) {
          const dI = fStep(i, "intel");
          const rC = fStep(i, "cost");
          if (dI == null || rC == null) { bad = true; break; }
          if (target.idx > anchor.idx) { deltaI += dI; multC *= rC; }
          else { deltaI -= dI; multC /= rC; }
        }
        if (bad) continue;
        const predI = Math.max(1, Math.min(95, anchor.intel + deltaI));
        const predC = Math.max(0.001, anchor.cost * multC);
        const errI = Math.abs(predI - target.intel);
        const errC = (Math.abs(predC - target.cost) / target.cost) * 100;
        extrapAllIntelAbs.push(errI);
        extrapAllCostPct.push(errC);
        const stepDist = Math.abs(target.idx - anchor.idx);
        if (stepDist === 1) {
          extrap1IntelAbs.push(errI);
          extrap1CostPct.push(errC);
        } else if (stepDist === 2) {
          extrap2IntelAbs.push(errI);
          extrap2CostPct.push(errC);
        } else {
          extrap3IntelAbs.push(errI);
          extrap3CostPct.push(errC);
        }
      }
    }
  }

  return {
    interp: {
      n: interpIntelAbs.length,
      intelPts: interpIntelAbs.length ? round1(median(interpIntelAbs)) : null,
      costPct: interpCostPct.length ? Math.round(median(interpCostPct)) : null,
    },
    extrap: {
      n1: extrap1IntelAbs.length,
      intelPts1: extrap1IntelAbs.length ? round1(median(extrap1IntelAbs)) : null,
      costPct1: extrap1CostPct.length ? Math.round(median(extrap1CostPct)) : null,
      nAll: extrapAllIntelAbs.length,
      intelPtsAll: extrapAllIntelAbs.length ? round1(median(extrapAllIntelAbs)) : null,
      costPctAll: extrapAllCostPct.length ? Math.round(median(extrapAllCostPct)) : null,
      n2: extrap2IntelAbs.length,
      intelPts2: extrap2IntelAbs.length ? round1(median(extrap2IntelAbs)) : null,
      costPct2: extrap2CostPct.length ? Math.round(median(extrap2CostPct)) : null,
      n3: extrap3IntelAbs.length,
      intelPts3: extrap3IntelAbs.length ? round1(median(extrap3IntelAbs)) : null,
      costPct3: extrap3CostPct.length ? Math.round(median(extrap3CostPct)) : null,
    },
  };
}

// Fei2411 data/conventions.json fallbacks (used only if that file cannot be fetched).
const DEFAULT_FEI_CONVENTIONS = {
  cnyPerUsd: 6.7787,
  mixes: {
    standard: { cache: 0.97, input: 0.025, cacheWrite: 0, output: 0.005 },
    lowCache: { cache: 0.85, input: 0.145, cacheWrite: 0, output: 0.005 },
    gemini: { cache: 0.9, input: 0.095, cacheWrite: 0, output: 0.005 },
    anthropic: { cache: 0.97, input: 0, cacheWrite: 0.025, output: 0.005 },
  },
};
// Anthropic 5-minute cache writes are billed at 1.25x base input.
const ANTHROPIC_CACHE_WRITE_MULT = 1.25;

function parseFeiConventions(json) {
  const out = { cnyPerUsd: DEFAULT_FEI_CONVENTIONS.cnyPerUsd, mixes: { ...DEFAULT_FEI_CONVENTIONS.mixes } };
  // Legacy field name: `usdPerCny` actually stores CNY per USD (see exchangeRate.units).
  const fx = toNum(json?.usdPerCny);
  if (fx && fx > 1) out.cnyPerUsd = fx;
  for (const [key, field] of [["standard", "standardTokenMix"], ["lowCache", "lowCacheTokenMix"], ["gemini", "geminiTokenMix"], ["anthropic", "anthropicTokenMix"]]) {
    const m = json?.[field];
    if (!m || toNum(m.cache) == null || toNum(m.output) == null) continue;
    out.mixes[key] = { cache: toNum(m.cache), input: toNum(m.input) ?? 0, cacheWrite: toNum(m.cacheWrite) ?? 0, output: toNum(m.output) };
  }
  return out;
}

function blendedForMix(p, mix) {
  if (!p || p.inputPer1M == null || p.outputPer1M == null || !mix) return null;
  const cached = p.cacheHitPer1M ?? p.inputPer1M * 0.1;
  return mix.cache * cached + mix.input * p.inputPer1M + mix.cacheWrite * p.inputPer1M * ANTHROPIC_CACHE_WRITE_MULT + mix.output * p.outputPer1M;
}

function parseListPriceDict(raw, cnyPerUsd = DEFAULT_FEI_CONVENTIONS.cnyPerUsd) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw.replace(/'/g, '"'));
    const currency = String(obj.currency || "USD").toUpperCase();
    // Normalize CN-portal list prices to USD so blends compare against USD fees / real $/Mtok.
    const fx = currency === "CNY" ? 1 / cnyPerUsd : 1;
    const conv = (v) => (toNum(v) == null ? null : toNum(v) * fx);
    return {
      inputPer1M: conv(obj.input),
      outputPer1M: conv(obj.output),
      cacheHitPer1M: conv(obj.cached),
      currency: "USD",
      sourceCurrency: currency,
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
      name: "adamholter/priors (backfill only)",
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
    openRouter: {
      name: "OpenRouter Models API",
      url: SOURCES.openRouterModels,
      ok: false,
      fetchedAt: null,
      modelCount: 0,
      backfilledContextCount: 0,
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
    kiloPass: {
      name: "Kilo Pass Pricing",
      url: SOURCES.kiloPricing,
      ok: false,
      fetchedAt: null,
      tierCount: 0,
      error: null,
    },
    arcPrize: {
      name: "ARC Prize (ARC-AGI-2)",
      url: "https://arcprize.org/leaderboard",
      ok: false,
      fetchedAt: null,
      multiEffortModelCount: 0,
      error: null,
    },
    fxUsdCny: {
      name: "Frankfurter (ECB) USD/CNY",
      url: SOURCES.fxUsdCny,
      ok: false,
      fetchedAt: null,
      cnyPerUsd: null,
      rateDate: null,
      usedFallback: true,
      error: null,
    },
    aaCodingAgents: {
      name: "Artificial Analysis (Coding Agents)",
      url: SOURCES.aaCodingAgents,
      ok: false,
      fetchedAt: null,
      configCount: 0,
      matchedEntries: 0,
      error: null,
    },
  };

  let feiCsvText = null;
  let feiConventionsJson = null;
  let fxJson = null;
  let feiBenchCsvText = null;
  let priorsGzBuf = null;
  let aaHtml = null;
  let aaV2Json = null;
  let openRouterJson = null;
  let copilotHtml = null;
  let ollamaHtml = null;
  let kiloHtml = null;
  let arcEvalsJson = null;
  let arcModelsJson = null;
  let aaAgentsHtml = null;

  if (fromLocal) {
    log("Reading local fixture snapshots from /tmp ...");
    if (fs.existsSync("/tmp/fei_points.csv")) feiCsvText = fs.readFileSync("/tmp/fei_points.csv", "utf8");
    if (fs.existsSync("/tmp/fei_bench_configs.csv")) feiBenchCsvText = fs.readFileSync("/tmp/fei_bench_configs.csv", "utf8");
    if (fs.existsSync("/tmp/priors_latest.json.gz")) priorsGzBuf = fs.readFileSync("/tmp/priors_latest.json.gz");
    if (fs.existsSync("/tmp/aa_models.html")) aaHtml = fs.readFileSync("/tmp/aa_models.html", "utf8");
    if (fs.existsSync("/tmp/openrouter_models.json")) {
      openRouterJson = JSON.parse(fs.readFileSync("/tmp/openrouter_models.json", "utf8"));
    }
    if (fs.existsSync("/tmp/copilot_plans.html")) copilotHtml = fs.readFileSync("/tmp/copilot_plans.html", "utf8");
    if (fs.existsSync("/tmp/ollama_pricing.html")) ollamaHtml = fs.readFileSync("/tmp/ollama_pricing.html", "utf8");
    if (fs.existsSync("/tmp/kilo_pricing.html")) kiloHtml = fs.readFileSync("/tmp/kilo_pricing.html", "utf8");
    if (fs.existsSync("/tmp/aa_coding_agents.html")) aaAgentsHtml = fs.readFileSync("/tmp/aa_coding_agents.html", "utf8");
  } else {
    const tasks = [
      fetchText(SOURCES.feiPointsCsv)
        .then((t) => { feiCsvText = t; })
        .catch((err) => { sourceStatus.fei2411.error = err.message; }),
      fetchText(SOURCES.fxUsdCny)
        .then((t) => { fxJson = JSON.parse(t); })
        .catch((err) => { sourceStatus.fxUsdCny.error = err.message; }),
      fetchText(SOURCES.feiConventions)
        .then((t) => { feiConventionsJson = JSON.parse(t); })
        .catch((err) => { log("Fei conventions.json fetch failed (using defaults):", err.message); }),
      fetchText(SOURCES.feiBenchConfigsCsv)
        .then((t) => { feiBenchCsvText = t; })
        .catch((err) => { log("Fei benchmark-configurations fetch failed:", err.message); }),
      fetchBuffer(SOURCES.priorsSnapshotGz)
        .then((b) => { priorsGzBuf = b; })
        .catch((err) => { sourceStatus.priorsRepo.error = err.message; }),
      fetchText(SOURCES.aaModelsPage)
        .then((t) => { aaHtml = t; })
        .catch((err) => { sourceStatus.artificialAnalysis.error = err.message; }),
      fetchText(SOURCES.openRouterModels)
        .then((t) => { openRouterJson = JSON.parse(t); })
        .catch((err) => { sourceStatus.openRouter.error = err.message; }),
      fetchText(SOURCES.githubCopilotPlans)
        .then((t) => { copilotHtml = t; })
        .catch((err) => { sourceStatus.githubCopilot.error = err.message; }),
      fetchText(SOURCES.ollamaPricing)
        .then((t) => { ollamaHtml = t; })
        .catch((err) => { sourceStatus.ollamaCloud.error = err.message; }),
      fetchText(SOURCES.kiloPricing)
        .then((t) => { kiloHtml = t; })
        .catch((err) => { sourceStatus.kiloPass.error = err.message; }),
      fetchText(SOURCES.arcPrizeEvals)
        .then((t) => { arcEvalsJson = JSON.parse(t); })
        .catch((err) => { sourceStatus.arcPrize.error = err.message; }),
      fetchText(SOURCES.arcPrizeModels)
        .then((t) => { arcModelsJson = JSON.parse(t); })
        .catch((err) => { sourceStatus.arcPrize.error = sourceStatus.arcPrize.error || err.message; }),
      fetchText(SOURCES.aaCodingAgents)
        .then((t) => { aaAgentsHtml = t; })
        .catch((err) => { sourceStatus.aaCodingAgents.error = err.message; }),
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

  // 1b. Parse OpenRouter public model catalog (context window, open-weights, AA domain backfill & gateway catalog)
  let openRouterIndex = null;
  if (openRouterJson) {
    try {
      openRouterIndex = parseOpenRouterModels(openRouterJson, aaByNorm);
      sourceStatus.openRouter.ok = true;
      sourceStatus.openRouter.fetchedAt = nowIso;
      sourceStatus.openRouter.modelCount = openRouterIndex.totalCount;
      log(`Parsed ${openRouterIndex.totalCount} models from OpenRouter public catalog`);
    } catch (err) {
      sourceStatus.openRouter.error = err.message;
      log("OpenRouter parse error:", err.message);
    }
  }

  // 1c. Parse optional ARC Prize ARC-AGI-2 (v2_Semi_Private) multi-effort fallback
  let arcByBase = null;
  if (arcEvalsJson && arcModelsJson) {
    try {
      const arcParsed = parseArcPrizeV2(arcEvalsJson, arcModelsJson, aaByNorm);
      arcByBase = arcParsed.byBase;
      sourceStatus.arcPrize.ok = true;
      sourceStatus.arcPrize.fetchedAt = nowIso;
      sourceStatus.arcPrize.multiEffortModelCount = arcParsed.multiCount;
      log(`Parsed ${arcParsed.multiCount} multi-effort models from ARC Prize (v2_Semi_Private)`);
    } catch (err) {
      sourceStatus.arcPrize.error = err.message;
      log("ARC Prize parse error:", err.message);
    }
  }

  // 1d. Parse AA Coding Agent Index configs, keyed by base model + effort
  let agentIndex = null;
  if (aaAgentsHtml) {
    try {
      const configs = parseAaCodingAgentsHtml(aaAgentsHtml);
      agentIndex = new Map();
      for (const c of configs) {
        const k = `${c.baseSlug}|${c.effort}`;
        if (!agentIndex.has(k)) agentIndex.set(k, []);
        agentIndex.get(k).push(c);
      }
      sourceStatus.aaCodingAgents.ok = true;
      sourceStatus.aaCodingAgents.fetchedAt = nowIso;
      sourceStatus.aaCodingAgents.configCount = configs.length;
      log(`Parsed ${configs.length} agent×model configs from Artificial Analysis Coding Agents`);
    } catch (err) {
      sourceStatus.aaCodingAgents.error = err.message;
      log("AA Coding Agents parse error:", err.message);
    }
  }

  // 1e. Fei2411 workload mixes + CNY/USD rate
  const feiConventions = feiConventionsJson ? parseFeiConventions(feiConventionsJson) : DEFAULT_FEI_CONVENTIONS;
  log(`Fei2411 conventions: ${feiConventionsJson ? "fetched" : "defaults"} (CNY/USD ${feiConventions.cnyPerUsd}, mixes: ${Object.keys(feiConventions.mixes).join("/")})`);

  // 1f. Live USD/CNY (ECB via Frankfurter); falls back to Fei2411's published rate.
  let liveCnyPerUsd = feiConventions.cnyPerUsd;
  const fxRate = toNum(fxJson?.rates?.CNY);
  if (fxRate && fxRate > 3 && fxRate < 15) {
    liveCnyPerUsd = fxRate;
    Object.assign(sourceStatus.fxUsdCny, { ok: true, fetchedAt: nowIso, cnyPerUsd: fxRate, rateDate: fxJson.date || null, usedFallback: false });
  } else {
    sourceStatus.fxUsdCny.cnyPerUsd = liveCnyPerUsd;
    sourceStatus.fxUsdCny.error = sourceStatus.fxUsdCny.error || (fxJson ? "No CNY rate in response" : "Not fetched");
  }
  log(`USD/CNY: ${liveCnyPerUsd}${sourceStatus.fxUsdCny.usedFallback ? " (Fei2411 fallback)" : ` (ECB ${sourceStatus.fxUsdCny.rateDate})`}`);
  let fxRescaledRows = 0;

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

  // 2b. Parse upstream multi-effort AA Intelligence & Cost/Task configs from Fei2411
  let feiMultiEffort = { count: 0, byBase: new Map() };
  if (feiBenchCsvText) {
    try {
      feiMultiEffort = parseFeiBenchConfigs(feiBenchCsvText, aaByNorm);
      log(`Parsed ${feiMultiEffort.count} multi-effort AA configs from Fei2411/benchmark-configurations.csv`);
    } catch (err) {
      log("Fei benchmark-configurations parse error:", err.message);
    }
  }

  // 3. Parse adamholter/priors raw-GitHub gzip snapshot ONLY as secondary backfill
  //    (per-effort sub-test scores like HLE/FrontierCode + few unmeasured new-model carryovers)
  let priorsParsed = { date: null, items: [], aaVariantsByBase: new Map(), t3Index: new Map(), cursorBenchIndex: new Map() };
  if (priorsGzBuf) {
    try {
      const rawJson = zlib.gunzipSync(priorsGzBuf).toString("utf8");
      priorsParsed = parsePriorsSnapshot(JSON.parse(rawJson), aaByNorm, openRouterIndex);
      sourceStatus.priorsRepo.ok = true;
      sourceStatus.priorsRepo.fetchedAt = nowIso;
      sourceStatus.priorsRepo.itemCount = priorsParsed.items.length;
      sourceStatus.priorsRepo.snapshotDate = priorsParsed.date;
      log(`Loaded optional backfill from adamholter/priors (${priorsParsed.date})`);
      log(`T3 Code turn costs: ${priorsParsed.t3Index.size} variant(s); CursorBench: ${priorsParsed.cursorBenchIndex.size} variant(s)`);
    } catch (err) {
      sourceStatus.priorsRepo.error = err.message;
      log("Priors snapshot parse error:", err.message);
    }
  }

  // Merge multi-effort AA variants: upstream Fei2411 + live AA first, backfilled with Priors per-effort sub-tests
  const aaVariantsByBase = new Map();
  let newerPriorsScores = 0;
  const keptNewerScores = []; // { key, kept, dropped, keptDate, droppedDate } for the data tests
  for (const [baseSlug, effMap] of priorsParsed.aaVariantsByBase.entries()) {
    aaVariantsByBase.set(baseSlug, new Map(effMap));
  }
  for (const [baseSlug, effMap] of feiMultiEffort.byBase.entries()) {
    let target = aaVariantsByBase.get(baseSlug);
    if (!target) {
      target = new Map();
      aaVariantsByBase.set(baseSlug, target);
    }
    for (const [eff, fv] of effMap.entries()) {
      let targetEff = eff;
      if (eff === "default" && !target.has("default") && target.size > 0) {
        for (const [existingEff, pv] of target.entries()) {
          if (
            Math.abs((pv.intelligenceIndex ?? 0) - fv.intelligenceIndex) < 0.35 &&
            Math.abs((pv.costPerTaskUsd ?? 0) - fv.costPerTaskUsd) < 0.02
          ) {
            targetEff = existingEff;
            break;
          }
        }
      }
      const pv = target.get(targetEff);
      const effSuffix = EFFORT_LABELS[targetEff] || "";
      // Fei2411 lags AA by days; keep Priors' score when its AA observation is newer.
      const priorsNewer = pv?.iiDate && fv.iiDate && pv.iiDate > fv.iiDate && pv.intelligenceIndex != null;
      if (priorsNewer) {
        newerPriorsScores++;
        keptNewerScores.push({
          key: `${baseSlug}|${targetEff}`,
          kept: Number(pv.intelligenceIndex.toFixed(2)),
          dropped: Number(fv.intelligenceIndex.toFixed(2)),
          keptDate: pv.iiDate,
          droppedDate: fv.iiDate,
        });
      }
      target.set(targetEff, {
        ...pv,
        ...fv,
        effort: targetEff,
        effortLabel: effSuffix,
        variantKey: effSuffix ? `${baseSlug}--${targetEff}` : baseSlug,
        displayName: effSuffix ? `${fv.baseDisplay} (${effSuffix})` : fv.baseDisplay,
        pricing: fv.pricing || pv?.pricing || null,
        benchmarks: { ...(pv?.benchmarks || {}), ...(fv.benchmarks || {}) },
        ...(priorsNewer
          ? {
              intelligenceIndex: pv.intelligenceIndex,
              costPerTaskUsd: pv.costPerTaskUsd ?? fv.costPerTaskUsd,
              iiDate: pv.iiDate,
              benchmarks: { ...(pv.benchmarks || {}), ...(fv.benchmarks || {}), intelligenceIndex: round1(pv.intelligenceIndex) },
            }
          : {}),
      });
    }
  }

  if (newerPriorsScores) log(`Kept ${newerPriorsScores} newer Priors Intelligence Index score(s) over Fei2411`);

  // Fill strictly bracketed missing intermediate efforts (Option A: interpolated between lower & higher measured efforts)
  const interpolatedEffortVariants = interpolateMissingEfforts(aaVariantsByBase, openRouterIndex, aaByNorm);
  if (interpolatedEffortVariants > 0) {
    log(`Interpolated ${interpolatedEffortVariants} bracketed intermediate reasoning effort variant(s)`);
  }

  // Option B (OFF by default in UI): extrapolate remaining OpenRouter-supported efforts (same-family AA, ARC-AGI-2 fallback)
  const extrapResult = extrapolateMissingEfforts(aaVariantsByBase, openRouterIndex, aaByNorm, arcByBase);
  const extrapolatedEffortVariants = extrapResult.total;
  const arcExtrapolatedVariants = extrapResult.arcCount;
  if (extrapolatedEffortVariants > 0) {
    log(
      `Extrapolated ${extrapolatedEffortVariants} reasoning effort variant(s) ` +
        `(${extrapolatedEffortVariants - arcExtrapolatedVariants} same-family, ${arcExtrapolatedVariants} ARC-AGI-2 fallback)`
    );
  }

  const effortAccuracy = computeEffortAccuracy(aaVariantsByBase);
  log(
    `LOOCV accuracy — Interp (†, n=${effortAccuracy.interp.n}): ±${effortAccuracy.interp.intelPts} pts / ±${effortAccuracy.interp.costPct}% $/task; ` +
      `Extrap (‡, n=${effortAccuracy.extrap.n1}/${effortAccuracy.extrap.nAll}): ±${effortAccuracy.extrap.intelPts1}–${effortAccuracy.extrap.intelPtsAll} pts / ±${effortAccuracy.extrap.costPct1}–${effortAccuracy.extrap.costPctAll}% $/task`
  );

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

  // 6. Live-parse Kilo Pass pricing (Starter/Pro/Expert annual 50% bonus net of 5% fee)
  let kiloTiers = [];
  if (kiloHtml) {
    try {
      kiloTiers = parseKiloPricingHtml(kiloHtml);
      sourceStatus.kiloPass.ok = true;
      sourceStatus.kiloPass.fetchedAt = nowIso;
      sourceStatus.kiloPass.tierCount = kiloTiers.length;
      log(
        `Verified ${kiloTiers.length} Kilo Pass tiers: ` +
          kiloTiers
            .map((t) => `${t.plan} ($${t.effectiveFeeUsd}→$${t.annualCreditsUsd} = ${t.multiple.toFixed(2)}×)`)
            .join(", ")
      );
    } catch (err) {
      sourceStatus.kiloPass.error = err.message;
      log("Kilo Pass parse error:", err.message);
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
  const feiSeenPlanModel = new Set(); // `${billing}::${planSlug}::${aaSlug}::${offpeak}`
  const feiSubIndex = new Map(); // `${normPlan}::${aaSlug}` -> entry id
  const feiVendorFeeModelIndex = new Map(); // `${normVendor}::${roundFee}::${aaSlug}` -> entry id
  const modelInfoBySlug = new Map(); // track model metadata (for adding Ollama Team / Copilot cleanly)
  const ollamaHostedSlugs = new Set();
  let latestFeiDate = "";

  function bestPriorsVariantFor(modelId) {
    const base = canonicalBaseSlug(modelId, aaByNorm);
    const effMap = aaVariantsByBase.get(base);
    if (!effMap || effMap.size === 0) return null;
    let best = null;
    for (const v of effMap.values()) {
      if (!best || (v.intelligenceIndex ?? 0) > (best.intelligenceIndex ?? 0)) best = v;
    }
    return best;
  }

  for (const r of feiRows) {
    const modelId = r.model;
    const billing = r.billing === "metered" ? "metered" : "subscription";
    const aaModel = resolveAaModel(modelId, aaByNorm);
    const priorsVar = !aaModel ? bestPriorsVariantFor(modelId) : null;

    const feiAaIntel = toNum(r.aa_intelligence_index__score);
    const feiAaCpt = toNum(r.aa_intelligence_index__mean_cost_usd_per_task);

    const intelligenceIndex = aaModel?.intelligenceIndex ?? priorsVar?.intelligenceIndex ?? feiAaIntel;
    const aaCostPerTaskUsd = aaModel?.costPerTaskUsd ?? priorsVar?.costPerTaskUsd ?? feiAaCpt;

    if (intelligenceIndex === null || aaCostPerTaskUsd === null || aaCostPerTaskUsd <= 0) {
      continue;
    }

    const unmetered = String(r.unmetered).toLowerCase() === "true";
    let priceUsd = toNum(r.price_usd);
    const monthlyYi = toNum(r.monthly_yi);
    let realUsdPerMtok = toNum(r.real_usd_per_mtok);
    const orModel = resolveOpenRouterModel(modelId, openRouterIndex, aaByNorm);
    const feiListPrice = parseListPriceDict(r.list_price, liveCnyPerUsd);
    const aaP = aaModel?.pricing?.inputPer1M != null ? aaModel.pricing : orModel?.pricing;
    const rateP = feiListPrice?.inputPer1M != null ? feiListPrice : aaP;
    // Fei2411 converts each row's API-worth into monthly tokens with that row's workload mix
    // (data/conventions.json), but its list_blended_usd_per_mtok / d columns always use the standard
    // 97%-cache mix. On lowCache / gemini / anthropic rows that understates the subsidy
    // (e.g. Google AI Pro Argon: 85M tok x $0.33 gemini blend / $19.99 = 1.40x, not 0.84x).
    const workloadKey = Object.keys(feiConventions.mixes).find((k) => k.toLowerCase() === String(r.workload || "").toLowerCase());
    const hasOwnMix = workloadKey != null && workloadKey !== "standard";
    const ownMixBlended = hasOwnMix ? blendedForMix(rateP, feiConventions.mixes[workloadKey]) : null;
    const standardBlended = blendedForMix(rateP, feiConventions.mixes.standard);
    const listBlendedUsdPerMtok = ownMixBlended ?? toNum(r.list_blended_usd_per_mtok) ?? standardBlended;
    const usesOwnMix = ownMixBlended != null;
    let discountRatio = toNum(r.d);
    // Re-price CNY fees that Fei2411 converted at its own (dated) rate onto today's rate.
    // Fees Fei2411 priced in USD separately (e.g. Kimi CN, MiMo) don't match its rate and are left as-is.
    const cnyFee = toNum(String(`${r.local_price || ""} ${r.plan || ""} ${r.plan_en || ""}`).match(/¥\s*([\d,]+(?:\.\d+)?)/)?.[1]?.replace(/,/g, ""));
    if (cnyFee && priceUsd > 0 && Math.abs(cnyFee / feiConventions.cnyPerUsd - priceUsd) / priceUsd < 0.01 && liveCnyPerUsd !== feiConventions.cnyPerUsd) {
      const scale = cnyFee / liveCnyPerUsd / priceUsd;
      priceUsd = Number((cnyFee / liveCnyPerUsd).toFixed(4));
      if (realUsdPerMtok) realUsdPerMtok *= scale;
      // d = real / standard-blended list: CNY list prices move with the fee (cancels), USD list prices don't.
      if (discountRatio && feiListPrice?.sourceCurrency !== "CNY") discountRatio *= scale;
      fxRescaledRows++;
    }

    let subsidyMultiple = null;
    if (billing === "metered") {
      subsidyMultiple = 1;
    } else if (unmetered) {
      subsidyMultiple = null;
    } else if (usesOwnMix && listBlendedUsdPerMtok && realUsdPerMtok && listBlendedUsdPerMtok > 0 && realUsdPerMtok > 0) {
      subsidyMultiple = listBlendedUsdPerMtok / realUsdPerMtok;
    } else if (discountRatio && discountRatio > 0) {
      subsidyMultiple = 1 / discountRatio;
    } else if (listBlendedUsdPerMtok && realUsdPerMtok && listBlendedUsdPerMtok > 0 && realUsdPerMtok > 0) {
      subsidyMultiple = listBlendedUsdPerMtok / realUsdPerMtok;
    }

    if (billing === "subscription" && !unmetered && (!subsidyMultiple || subsidyMultiple <= 0)) {
      continue;
    }

    const aaSlug = aaModel?.slug || priorsVar?.baseSlug || canonicalBaseSlug(modelId, aaByNorm);
    if (billing === "metered") coveredMeteredAaSlugs.add(aaSlug);

    const planName = normalizePlanName(r.plan_en || r.plan || "");
    const vendor = cleanVendorName(r.vendor, aaModel?.creatorName);
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

    const entryId = r.id || `${normPlanSlug(planName)}::${normSlug(modelId)}`;
    const { isOffPeak, isLegacy, isCnPortal } = detectPlanFlags(planName, r.plan || "");
    const feiDedupeKey = `${billing}::${normPlanSlug(billing === "metered" ? "Pay-as-you-go API" : planName)}::${aaSlug}::${isOffPeak ? "offpeak" : "std"}`;
    if (feiSeenPlanModel.has(feiDedupeKey)) continue;
    feiSeenPlanModel.add(feiDedupeKey);
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
      isLegacy,
      isCnPortal,
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
      feiWorkload: workloadKey || null,
      upstreamSubsidyMultiple: discountRatio > 0 ? Number((1 / discountRatio).toFixed(4)) : null,
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
      _feiRow: r,
    };

    entries.push(entry);
    if (!modelInfoBySlug.has(aaSlug)) modelInfoBySlug.set(aaSlug, entry);
    if (/^ollama\b/i.test(planName)) ollamaHostedSlugs.add(aaSlug);

    if (billing === "subscription") {
      feiSubIndex.set(`${normPlanSlug(planName)}::${aaSlug}`, entryId);
      if (priceUsd !== null) {
        feiVendorFeeModelIndex.set(
          planVendorFeeKey(planName, vendor, priceUsd, aaSlug, { isOffPeak, isLegacy }),
          entryId
        );
      }
    }
  }

  // Reliability chains for Fei2411 rows (σ per derivation step; docs/RELIABILITY.md)
  const today = nowIso.slice(0, 10);
  const feiById = new Map(feiRows.map((r) => [r.id, r]));
  const feiByLabel = new Map();
  for (const r of feiRows) {
    for (const p of [r.plan_en, r.plan]) if (p) feiByLabel.set(`${p} · ${r.model}`, r);
  }
  const feiCtx = {
    byId: feiById,
    byLabel: feiByLabel,
    today,
    memo: new Map(),
    modelName: (r) => r.model_display || r.model,
    cellName: (r) => `${REL.shortModel(r.model_display || r.model)} ${REL.shortPlan(normalizePlanName(r.plan_en || r.plan || ""))}`,
    subsidyOf: (r) => (toNum(r.monthly_yi) || NaN) / (toNum(r.price_usd) || NaN),
  };
  const feiSampleMixMemo = new Map();
  const feiSampleMix = (r, depth = 0) => {
    if (!r) return null;
    if (feiSampleMixMemo.has(r.id)) return feiSampleMixMemo.get(r.id);
    let m = REL.parseFeiSampleMix(r.note);
    if (!m && depth < 5) {
      const ch = feiCtx.memo.get(r.id);
      const a = ch?.anchors?.[0] ? feiById.get(ch.anchors[0]) : null;
      m = a ? feiSampleMix(a, depth + 1) : null;
    }
    feiSampleMixMemo.set(r.id, m);
    return m;
  };
  for (const e of entries) {
    if (!e._feiRow) continue;
    e._chain = structuredClone(REL.feiChain(e._feiRow, feiCtx));
  }
  for (const e of entries) {
    if (!e._feiRow) continue;
    e._sampleMix = feiSampleMix(e._feiRow);
    // Fable rows on Claude plans: Fei's Fable 5 / 5.1 values are "Fable only" readings (pool × 50% ÷ weight);
    // a row Fei marks "50% 周帽不套" (cap not applied) is a "Shared" reading.
    if (isFableOnClaude(e.plan, e.modelId) && e.subsidyMultiple > 0) {
      const shared = /周帽不套|不套帽/.test(e.decisionNote || "");
      const S = e.subsidyMultiple;
      e.subsidyReadings = shared
        ? { shared: S, own: REL.r4(S * FABLE_CAP_SHARE) }
        : { shared: REL.r4(S / FABLE_CAP_SHARE), own: S };
      e.subsidyMultiple = e.subsidyReadings.shared;
      e.capShare = FABLE_CAP_SHARE;
      if (!shared) e._chain.lines.unshift(`Fable only ÷ ${FABLE_CAP_SHARE} (50% cap)`);
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
      isLegacy: false,
      isCnPortal: false,
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

  // Also ensure every multi-effort AA model with AA Cost/Task has a Metered API (1x) baseline
  for (const [baseSlug] of aaVariantsByBase.entries()) {
    if (coveredMeteredAaSlugs.has(baseSlug)) continue;
    const best = bestPriorsVariantFor(baseSlug);
    if (!best || best.intelligenceIndex == null || best.costPerTaskUsd == null || best.costPerTaskUsd <= 0) {
      continue;
    }
    const creator = best.creatorName || "Other";
    const entry = {
      id: `aa-metered::${baseSlug}`,
      origin: "artificial-analysis",
      isPreliminary: false,
      estimateType: null,
      replacesId: null,
      billing: "metered",
      vendor: creator,
      modelCreator: creator,
      color: vendorColor(creator, best),
      plan: "Pay-as-you-go API",
      planLocal: "Pay-as-you-go API",
      planUrl: resolvePlanUrl("Pay-as-you-go API", creator, "metered"),
      isOffPeak: false,
      isLegacy: false,
      isCnPortal: false,
      unmetered: false,
      modelId: baseSlug,
      modelDisplay: best.baseDisplay || baseSlug,
      aaVariant: best.displayName,
      aaLive: best.aaLive,
      aaUrl: best.aaUrl,
      isOpenWeights: best.isOpenWeights,
      contextWindowTokens: best.contextWindowTokens,
      priceUsd: null,
      monthlyTokens: null,
      realUsdPerMtok: null,
      listBlendedUsdPerMtok: null,
      subsidyMultiple: 1,
      intelligenceIndex: Number(best.intelligenceIndex.toFixed(2)),
      benchmarks: best.benchmarks || { intelligenceIndex: round1(best.intelligenceIndex) },
      aaCostPerTaskUsd: Number(best.costPerTaskUsd.toFixed(4)),
      aaCostPerTaskBreakdown: best.costPerTaskBreakdown,
      aaTotalIndexCostUsd: best.totalIndexCostUsd,
      aaPricing: best.pricing,
      aaSpeed: best.speed,
      confidence: "high",
      dataDate: priorsParsed.date || nowIso.slice(0, 10),
      sourceNote: "Artificial Analysis (via Priors snapshot)",
      decisionNote: "Direct first-party API list pricing (1.0× baseline).",
      preliminary: null,
    };
    entries.push(entry);
    if (!modelInfoBySlug.has(baseSlug)) modelInfoBySlug.set(baseSlug, entry);
    coveredMeteredAaSlugs.add(baseSlug);
  }

  // Layer entries from adamholter/priors raw-GitHub snapshot (preliminary, assumed, and extra modeled plans)
  let prelimCount = 0;
  let assumedCount = 0;
  let priorsExtraCount = 0;
  const priorsSeen = new Set();

  // Carryover rules for sibling models in one quota pool. Each names its mechanism (docs/RELIABILITY.md):
  //   "same-pool": price-proportional draw stated by the vendor (M1): S(m, p) = S(anchor, p)
  //   "token":     token-denominated pool: S(m, p) = S(anchor, p) × blend(m) / blend(anchor), no model step
  // Rows are skipped whenever a direct measurement of the cell exists.
  const sharedPoolRules = [
    {
      plans: ["Google AI Pro", "Google AI Ultra 5x", "Google AI Ultra 20x"],
      anchorModel: "gemini-4-neon",
      targets: ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon"],
      mechanism: "same-pool",
      vendor: "Google",
      fallbackUrl: "https://one.google.com/about/google-ai-plans/",
    },
    {
      // Fei's Kimi pool samples were K3.1 Pro traffic; K3.1 Pro list price is 2/3 of K3's.
      plans: ["Kimi Plus", "Kimi Pro", "Kimi Max", "Kimi Ultra"],
      anchorModel: "kimi-k3",
      targets: ["kimi-k3-1-pro"],
      mechanism: "token",
      vendor: "Moonshot",
      fallbackUrl: "https://kimi.ai",
    },
  ];
  // Ratio transfer (X1): S(m, p) = S(anchor, p) × S(m, q) / S(anchor, q), pooled over reference plans q by 1/σ².
  const ratioTransferRules = [
    { plans: ["Claude Max"], model: "claude-fable-5-2", anchorModel: "claude-opus-5-5", refPlans: ["Claude Pro", "Claude Ultra"], vendor: "Anthropic" },
  ];

  const PRIORS_GRADE_SIGMA = { high: 0.1, medium: 0.22, low: 0.45 };
  function priorsChain(item, sameAsEntry) {
    const date = REL.lastDate(item.dataDate) || priorsParsed.date;
    const conf = String(item.confidence || "medium").toLowerCase();
    if (item.kind === "ratio") {
      const tweet = /x\.com|twitter\.com/i.test(item.source || "");
      // Known account, large sample, figures in text (Theo, 1.1M requests): between S4 and S5.
      const k = tweet ? (conf === "high" || conf === "medium" ? "T" : "S6") : "S2";
      const label = tweet ? (k === "T" ? "tweet, large sample" : "tweet") : "official";
      return REL.applyFloor(REL.makeChain({ steps: [{ k, s: REL.STEP_SIGMA[k], t: label }], lines: [`Priors, ${label}, ${date}`] }), conf, "Priors");
    }
    if (item.isPrelim) {
      const lab = item.preliminary?.label || "";
      let steps;
      let line;
      if (/extrapolated/i.test(lab)) {
        steps = [{ k: "prelim", s: 0.4, t: "1 user" }, { k: "P1", s: REL.STEP_SIGMA.P1, t: "plan ratio" }];
        line = `Priors, ${lab.replace(/^Extrapolated from/i, "from")}, ${date}`;
      } else if (/promotion/i.test(lab)) {
        steps = [{ k: "S1", s: 0.05, t: "official promotion" }];
        line = `Priors, official promotion, ${date}`;
      } else {
        const n = Number(/(\d+)\s+users?/i.exec(lab)?.[1] || 1);
        steps = [{ k: "prelim", s: REL.r4(0.4 / Math.sqrt(n)), t: `${n} user${n === 1 ? "" : "s"}` }];
        line = `Priors, ${n} user${n === 1 ? "" : "s"}, ${date}`;
      }
      return REL.makeChain({ steps, lines: [line], cap: "medium" });
    }
    if (item.isAssumed) {
      const seller = item.plan;
      const step = /^Google AI\b/.test(seller)
        ? { k: "M1", s: REL.STEP_SIGMA.M1, t: "same pool, price-proportional" }
        : /^ChatGPT\b/.test(seller)
          ? { k: "M2", s: REL.STEP_SIGMA.M2, t: "same pool, rate card" }
          : { k: "M4", s: REL.STEP_SIGMA.M4, t: "assumed equal" };
      const sameName = REL.shortModel(sameAsEntry?.modelDisplay || item.sameAs || "anchor");
      if (sameAsEntry?._chain) {
        return REL.extendChain(structuredClone(sameAsEntry._chain), step, `= ${sameName} (${step.t})`, {
          at: `${sameName} ${REL.shortPlan(seller)}`,
          anchorId: sameAsEntry.id,
        });
      }
      const g = item.anchorConfidence || "medium";
      const base = REL.makeChain({
        steps: [{ k: "priors", s: PRIORS_GRADE_SIGMA[g] ?? 0.22, t: `Priors ${g}` }],
        lines: [`Priors ${g}, ${date}`],
        cap: g,
      });
      return REL.extendChain(base, step, `= ${sameName} (${step.t})`, { at: `${sameName} ${REL.shortPlan(seller)}` });
    }
    const s = PRIORS_GRADE_SIGMA[conf] ?? 0.22;
    return REL.applyFloor(
      REL.makeChain({ steps: [{ k: "priors", s, t: `Priors ${conf}` }], lines: [`Priors ${conf}, ${date}`] }),
      conf,
      "Priors"
    );
  }

  for (const item of priorsParsed.items) {
    const aaModel = resolveAaModel(item.modelId, aaByNorm);
    const priorsVar = !aaModel ? bestPriorsVariantFor(item.modelId) : null;
    const fallbackModel = !aaModel && !priorsVar ? modelInfoBySlug.get(canonicalBaseSlug(item.modelId, aaByNorm)) : null;
    const intel = aaModel?.intelligenceIndex ?? priorsVar?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
    const cpt = aaModel?.costPerTaskUsd ?? priorsVar?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
    if (intel === null || cpt === null || cpt <= 0) continue;

    const aaSlug = aaModel?.slug || priorsVar?.baseSlug || fallbackModel.modelId;
    const planSlug = normPlanSlug(item.plan);
    const dedupeKey = `${planSlug}::${aaSlug}`;
    if (priorsSeen.has(dedupeKey)) continue;
    priorsSeen.add(dedupeKey);

    if (/^ollama\b/i.test(item.plan)) ollamaHostedSlugs.add(aaSlug);

    const sellerVendor = vendorFromPlan(item.plan, aaModel?.creatorName || priorsVar?.creatorName || fallbackModel?.modelCreator);
    const priorsFlags = detectPlanFlags(item.plan, item.planRaw);
    const existingId =
      feiSubIndex.get(dedupeKey) ||
      (item.feeUsd !== null
        ? feiVendorFeeModelIndex.get(planVendorFeeKey(item.plan, sellerVendor, item.feeUsd, aaSlug, priorsFlags))
        : null);

    // Skip duplicates already covered by Fei2411 unless Priors has a preliminary measurement (pooled below)
    if (existingId && !item.isPrelim) continue;
    // Google pool members are carried from the (pooled) Neon anchor by the shared-pool rule, not from Flash.
    if (item.isAssumed && sharedPoolRules.some((r) => r.plans.includes(item.plan) && r.targets.includes(aaSlug))) {
      priorsParsed.skipped.push({ modelId: item.modelId, plan: item.plan, reason: "carried by shared-pool rule" });
      continue;
    }

    const sameAsEntry = item.sameAs
      ? entries.find((x) => x.plan === item.plan && x.modelId === canonicalBaseSlug(item.sameAs, aaByNorm) && x._chain)
      : null;
    const chain = priorsChain(item, sameAsEntry);

    // A preliminary Priors reading and a Fei2411 measurement of the same cell: pool by 1/σ² when they
    // agree within 2σ; otherwise keep the lower-σ source and widen it by half the log gap.
    if (existingId && item.isPrelim) {
      const fe = entries.find((x) => x.id === existingId);
      if (fe && /promotion/i.test(item.preliminary?.label || "")) {
        // An official promotion is the current offer for that cell: it replaces the regular-rate row.
        fe._drop = true;
      } else if (fe && fe._chain && fe.subsidyMultiple > 0) {
        const s1 = fe._chain.s, s2 = chain.s;
        const d = Math.abs(Math.log(fe.subsidyMultiple / item.multiple));
        prelimCount++;
        if (d <= 2 * REL.qsum(s1, s2)) {
          const w1 = 1 / (s1 * s1), w2 = 1 / (s2 * s2);
          const pooled = Math.exp((w1 * Math.log(fe.subsidyMultiple) + w2 * Math.log(item.multiple)) / (w1 + w2));
          const sp = 1 / Math.sqrt(w1 + w2);
          const scale = pooled / fe.subsidyMultiple;
          fe.pooled = { fei: fe.subsidyMultiple, priors: REL.r4(item.multiple), weightFei: REL.r4(w1 / (w1 + w2)) };
          if (fe.monthlyTokens) fe.monthlyTokens = Math.round(fe.monthlyTokens * scale);
          if (fe.realUsdPerMtok) fe.realUsdPerMtok = fe.realUsdPerMtok / scale;
          fe.subsidyMultiple = REL.r4(pooled);
          fe._chain = REL.makeChain({
            steps: [{ k: "pooled", s: REL.r4(sp), t: "Fei + Priors" }],
            lines: [
              `pooled ${fe.pooled.fei.toFixed(1)}× Fei + ${item.multiple.toFixed(1)}× Priors`,
              `Fei: ${fe._chain.lines[0]}`,
              `Priors: ${chain.lines[0]}`,
            ],
            cap: fe._chain.cap,
            flags: ["pooled"],
          });
          fe._pooledParts = [fe._sampleMix];
          continue;
        }
        const widen = d / 2;
        if (s1 <= s2) {
          REL.addPenalty(fe._chain, widen, `disagrees with Priors ${item.multiple.toFixed(1)}×`, "inconsistent");
          continue;
        }
        fe._drop = true;
        REL.addPenalty(chain, widen, `disagrees with Fei ${fe.subsidyMultiple.toFixed(1)}×`, "inconsistent");
      }
    }

    let origin = "priors-repo";
    let estimateType = null;
    if (item.isPrelim) {
      origin = "priors-preliminary";
      estimateType = "preliminary";
      if (!existingId) prelimCount++;
    } else if (item.isAssumed) {
      origin = "priors-assumed";
      estimateType = "assumed";
      assumedCount++;
    } else {
      priorsExtraCount++;
    }

    const isEstimated = item.isPrelim || item.isAssumed;
    const replacesId = null; // a losing Fei row is dropped (`_drop`), not hidden client-side
    const creator = aaModel?.creatorName || priorsVar?.creatorName || fallbackModel?.modelCreator || sellerVendor;

    entries.push({
      id: `${origin}::${planSlug}::${aaSlug}`,
      origin,
      isPreliminary: isEstimated,
      estimateType,
      replacesId,
      billing: "subscription",
      vendor: sellerVendor,
      modelCreator: creator,
      color: vendorColor(creator, aaModel || priorsVar),
      plan: item.plan,
      planLocal: item.planRaw,
      planUrl: resolvePlanUrl(item.plan, sellerVendor, "subscription"),
      isOffPeak: priorsFlags.isOffPeak,
      isLegacy: priorsFlags.isLegacy,
      isCnPortal: priorsFlags.isCnPortal,
      unmetered: false,
      modelId: aaSlug,
      modelDisplay: aaModel?.shortName || priorsVar?.baseDisplay || fallbackModel?.modelDisplay || item.modelName,
      aaVariant: aaModel?.name || priorsVar?.displayName || fallbackModel?.aaVariant || null,
      aaLive: Boolean(aaModel),
      aaUrl: aaModel?.sourceUrl || priorsVar?.aaUrl || fallbackModel?.aaUrl || "https://artificialanalysis.ai/models#price-cost",
      isOpenWeights: Boolean(aaModel?.isOpenWeights ?? fallbackModel?.isOpenWeights),
      contextWindowTokens: aaModel?.contextWindowTokens ?? fallbackModel?.contextWindowTokens ?? null,
      priceUsd: item.feeUsd,
      monthlyTokens: null,
      realUsdPerMtok: item.usdPerMtok,
      listBlendedUsdPerMtok: item.blendedList,
      subsidyMultiple: Number(item.multiple.toFixed(4)),
      intelligenceIndex: Number(intel.toFixed(2)),
      benchmarks: aaModel?.benchmarks || priorsVar?.benchmarks || fallbackModel?.benchmarks || { intelligenceIndex: round1(intel) },
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
      ...(item.readings ? { subsidyReadings: { shared: REL.r4(item.readings.shared), own: REL.r4(item.readings.own) } } : {}),
      ...(isFableOnClaude(item.plan, aaSlug) ? { capShare: FABLE_CAP_SHARE } : {}),
      _chain: chain,
      _sampleKind: item.kind === "ratio" ? "t3" : null,
    });
    const pe = entries[entries.length - 1];
    if (isFableOnClaude(pe.plan, pe.modelId) && !pe.subsidyReadings) {
      pe.subsidyReadings = { shared: pe.subsidyMultiple, own: REL.r4(pe.subsidyMultiple * FABLE_CAP_SHARE) };
    }
    if (pe.subsidyReadings) pe.subsidyMultiple = pe.subsidyReadings.shared;
  }

  // Layer live-verified first-party GitHub Copilot AI Credits tiers (respecting per-plan Available Models matrix)
  let copilotEntryCount = 0;
  for (const tier of copilotTiers) {
    const seenSlugs = new Set();
    for (const modelSlug of tier.availableModels) {
      const aaModel = resolveAaModel(modelSlug, aaByNorm);
      const priorsVar = !aaModel ? bestPriorsVariantFor(modelSlug) : null;
      const fallbackModel = !aaModel && !priorsVar ? modelInfoBySlug.get(canonicalBaseSlug(modelSlug, aaByNorm)) : null;
      const intel = aaModel?.intelligenceIndex ?? priorsVar?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
      const cpt = aaModel?.costPerTaskUsd ?? priorsVar?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
      if (intel === null || cpt === null || cpt <= 0) continue;

      const aaSlug = aaModel?.slug || priorsVar?.baseSlug || fallbackModel.modelId;
      if (seenSlugs.has(aaSlug)) continue;
      seenSlugs.add(aaSlug);
      const creator = aaModel?.creatorName || priorsVar?.creatorName || fallbackModel?.modelCreator || "GitHub";

      copilotEntryCount++;
      entries.push({
        id: `first-party::${normPlanSlug(tier.plan)}::${aaSlug}`,
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
        isLegacy: false,
        isCnPortal: false,
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
      const priorsVar = !aaModel ? bestPriorsVariantFor(aaSlug) : null;
      const fallbackModel = !aaModel && !priorsVar ? modelInfoBySlug.get(aaSlug) : null;
      const intel = aaModel?.intelligenceIndex ?? priorsVar?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
      const cpt = aaModel?.costPerTaskUsd ?? priorsVar?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
      if (intel === null || cpt === null || cpt <= 0) continue;

      const creator = aaModel?.creatorName || priorsVar?.creatorName || fallbackModel?.modelCreator || "Ollama";
      ollamaTeamEntryCount++;
      entries.push({
        id: `first-party::${normPlanSlug(tier.plan)}::${aaSlug}`,
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
        isLegacy: false,
        isCnPortal: false,
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

  // Layer live-verified first-party Kilo Pass annual tiers across models confirmed on OpenRouter/Kilo Gateway
  let kiloPassEntryCount = 0;
  if (kiloTiers.length > 0 && openRouterIndex) {
    for (const tier of kiloTiers) {
      for (const [aaSlug, fallbackModel] of modelInfoBySlug.entries()) {
        const orModel = resolveOpenRouterModel(aaSlug, openRouterIndex, aaByNorm);
        if (!orModel || !orModel.isPaid) continue;

        const aaModel = aaByNorm.get(aaSlug);
        const priorsVar = !aaModel ? bestPriorsVariantFor(aaSlug) : null;
        const intel = aaModel?.intelligenceIndex ?? priorsVar?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
        const cpt = aaModel?.costPerTaskUsd ?? priorsVar?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
        if (intel === null || cpt === null || cpt <= 0) continue;

        const creator = aaModel?.creatorName || priorsVar?.creatorName || fallbackModel?.modelCreator || "Kilo";
        kiloPassEntryCount++;
        entries.push({
          id: `first-party::${normPlanSlug(tier.plan)}::${aaSlug}`,
          origin: "kilo-pass",
          isPreliminary: false,
          estimateType: null,
          replacesId: null,
          billing: "subscription",
          vendor: "Kilo",
          modelCreator: creator,
          color: vendorColor(creator, aaModel),
          plan: tier.plan,
          planLocal: tier.plan,
          planUrl: SOURCES.kiloPricing,
          isOffPeak: false,
          isLegacy: false,
          isCnPortal: false,
          unmetered: false,
          modelId: aaSlug,
          modelDisplay: aaModel?.shortName || fallbackModel?.modelDisplay || aaSlug,
          aaVariant: aaModel?.name || fallbackModel?.aaVariant || null,
          aaLive: Boolean(aaModel),
          aaUrl: aaModel?.sourceUrl || fallbackModel?.aaUrl || "https://artificialanalysis.ai/models#price-cost",
          isOpenWeights: Boolean(aaModel?.isOpenWeights ?? fallbackModel?.isOpenWeights ?? orModel.isOpenWeights),
          contextWindowTokens:
            aaModel?.contextWindowTokens ?? fallbackModel?.contextWindowTokens ?? orModel.contextWindowTokens ?? null,
          priceUsd: tier.effectiveFeeUsd,
          monthlyTokens: null,
          realUsdPerMtok: null,
          listBlendedUsdPerMtok: aaModel?.pricing?.blended7to2to1Per1M ?? null,
          subsidyMultiple: Number(tier.multiple.toFixed(4)),
          intelligenceIndex: Number(intel.toFixed(2)),
          benchmarks: aaModel?.benchmarks || fallbackModel?.benchmarks || { intelligenceIndex: round1(intel) },
          aaCostPerTaskUsd: Number(cpt.toFixed(4)),
          aaCostPerTaskBreakdown: aaModel?.costPerTaskBreakdown || fallbackModel?.aaCostPerTaskBreakdown || null,
          aaTotalIndexCostUsd: aaModel?.totalIndexCostUsd ?? fallbackModel?.aaTotalIndexCostUsd ?? null,
          aaPricing: aaModel?.pricing || fallbackModel?.aaPricing || orModel.pricing || null,
          aaSpeed: aaModel?.speed || fallbackModel?.aaSpeed || null,
          confidence: "high",
          dataDate: nowIso.slice(0, 10),
          sourceNote: `Kilo Pass Pricing ($${tier.baseFeeUsd}/mo + ${tier.processingFeePct}% fee = $${tier.effectiveFeeUsd}/mo → $${tier.annualCreditsUsd} credits)`,
          decisionNote: `Deterministic first-party credit pool on Annual billing (${tier.annualBonusPct}% bonus net of ${tier.processingFeePct}% processing fee = ${tier.multiple.toFixed(2)}× across provider-rate gateway models; monthly billing ramps 10%→40% = 1.33× steady state).`,
          preliminary: null,
        });
      }
    }
  }

  // ---- Reliability: deterministic sources (API list price, published credit pools) ----
  for (const e of entries) {
    if (e._chain) continue;
    const label = e.billing === "metered" ? "list price" : "official credits";
    e._chain = REL.makeChain({ steps: [{ k: "S1", s: REL.STEP_SIGMA.S1, t: label }], lines: [label] });
  }

  // ---- Expired promotions, quota changes, retired models ----
  const refOnlyRows = []; // expired rows kept only as reference cells for ratio transfers
  const droppedRows = [];
  for (const e of entries) {
    if (e._drop) {
      droppedRows.push({ id: e.id, reason: "lost to a lower-σ source" });
      continue;
    }
    const promo = PROMO_EXPIRY.find((p) => p.plan === e.plan && p.model === e.modelId);
    const until = promo?.until || REL.lastDate(e._feiRow?.promo_until);
    if (until && today > until) {
      e._drop = true;
      refOnlyRows.push(e);
      droppedRows.push({ id: e.id, reason: `promotion ended ${until}` });
      continue;
    }
    const qc = QUOTA_CHANGES.find((c) => c.plan === e.plan && (!c.model || c.model === e.modelId));
    const dd = REL.lastDate(e.dataDate);
    if (qc && dd && dd < qc.date) {
      if (qc.action === "drop") {
        e._drop = true;
        droppedRows.push({ id: e.id, reason: `quota change ${qc.date}` });
        continue;
      }
      e._chain.flags.push("stale");
      e._chain.lines.push(`quota change ${qc.date}`);
    }
    const ret = MODEL_RETIREMENTS.find((r) => r.model === e.modelId && today > r.after);
    if (ret) {
      e._drop = true;
      droppedRows.push({ id: e.id, reason: `model retired ${ret.after}` });
    }
  }
  entries.splice(0, entries.length, ...entries.filter((e) => !e._drop));

  const liveCell = (plan, model) =>
    entries.find((e) => e.billing === "subscription" && e.plan === plan && e.modelId === model && e.subsidyMultiple > 0 && !e.unmetered);
  const cellName = (e) => `${REL.shortModel(e.modelDisplay)} ${REL.shortPlan(e.plan)}`;

  // ---- Cross-plan consistency (T-quad) and price proportionality (T-pool) ----
  const CONSISTENCY_FAMILIES = [
    { name: "Claude", plans: ["Claude Pro", "Claude Max", "Claude Ultra"], pool: /^claude-(opus|sonnet)-/ },
    { name: "ChatGPT", plans: ["ChatGPT Plus", "ChatGPT Pro 10x", "ChatGPT Pro 20x", "ChatGPT Pro 500"] },
    { name: "Google AI", plans: ["Google AI Pro", "Google AI Ultra 5x", "Google AI Ultra 20x"], pool: /^gemini-/ },
    { name: "Kimi", plans: ["Kimi Plus", "Kimi Pro", "Kimi Max", "Kimi Ultra"] },
    { name: "SuperGrok", plans: ["SuperGrok Lite", "SuperGrok", "SuperGrok Plus", "SuperGrok Heavy"] },
    { name: "Cursor", plans: ["Cursor Pro", "Cursor Pro+", "Cursor Ultra"] },
  ];
  const LN13 = Math.log(1.3);
  const LN16 = Math.log(1.6);
  const consistency = [];
  const penalties = new Map(); // entry -> { sigma, line }
  const penalize = (cells, D, line) => {
    const pick = [...cells].sort((a, b) => b._chain.s - a._chain.s || String(REL.lastDate(a.dataDate)).localeCompare(String(REL.lastDate(b.dataDate))))[0];
    const sig = Math.abs(D) / 2;
    const prev = penalties.get(pick);
    if (!prev || prev.sigma < sig) penalties.set(pick, { sigma: sig, line });
    return pick.id;
  };
  for (const fam of CONSISTENCY_FAMILIES) {
    const cells = new Map();
    for (const e of entries) if (fam.plans.includes(e.plan) && e.subsidyMultiple > 0 && !e.unmetered && !e.isOffPeak) cells.set(`${e.plan}|${e.modelId}`, e);
    const models = [...new Set([...cells.values()].map((e) => e.modelId))].sort();
    for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) {
      for (let pi = 0; pi < fam.plans.length; pi++) for (let qi = pi + 1; qi < fam.plans.length; qi++) {
        const [a, b, p, q] = [models[i], models[j], fam.plans[pi], fam.plans[qi]];
        const quad = [cells.get(`${p}|${a}`), cells.get(`${p}|${b}`), cells.get(`${q}|${a}`), cells.get(`${q}|${b}`)];
        if (quad.some((x) => !x)) continue;
        const ids = new Set(quad.map((x) => x.id));
        const nonDerived = quad.filter((x) => !REL.chainDerived(x._chain) && !x._chain.anchors.some((id) => ids.has(id) && id !== x.id)).length;
        if (nonDerived < 3) continue;
        const D = Math.log(quad[0].subsidyMultiple / quad[1].subsidyMultiple) - Math.log(quad[2].subsidyMultiple / quad[3].subsidyMultiple);
        const z = Math.abs(D) / REL.qsum(...quad.map((x) => x._chain.s));
        const verdict = Math.abs(D) <= LN13 ? "pass" : Math.abs(D) > LN16 || z > 2 ? "fail" : "warn";
        const rec = { type: "quad", family: fam.name, a, b, p, q, D: REL.r4(D), ratio: REL.r4(Math.exp(Math.abs(D))), z: REL.r4(z), verdict, flagged: null };
        if (verdict === "fail") {
          rec.flagged = penalize(quad, D, `inconsistent ×${Math.exp(Math.abs(D)).toFixed(2)} (${REL.shortModel(quad[0].modelDisplay)} / ${REL.shortModel(quad[1].modelDisplay)}, ${REL.shortPlan(p)} vs ${REL.shortPlan(q)})`);
        }
        consistency.push(rec);
      }
    }
    if (!fam.pool) continue;
    for (const p of fam.plans) {
      const measured = [...cells.values()].filter((e) => e.plan === p && fam.pool.test(e.modelId) && !REL.chainDerived(e._chain));
      for (let i = 0; i < measured.length; i++) for (let j = i + 1; j < measured.length; j++) {
        const [x, y] = [measured[i], measured[j]];
        const D = Math.log(x.subsidyMultiple / y.subsidyMultiple);
        const verdict = Math.abs(D) <= LN13 ? "pass" : "fail";
        const rec = { type: "pool", family: fam.name, a: x.modelId, b: y.modelId, p, D: REL.r4(D), ratio: REL.r4(Math.exp(Math.abs(D))), verdict, flagged: null };
        if (verdict === "fail") {
          rec.flagged = penalize([x, y], D, `inconsistent ×${Math.exp(Math.abs(D)).toFixed(2)} (${REL.shortModel(x.modelDisplay)} vs ${REL.shortModel(y.modelDisplay)}, same pool)`);
        }
        consistency.push(rec);
      }
    }
  }
  for (const [e, pen] of penalties) REL.addPenalty(e._chain, pen.sigma, pen.line);

  // ---- Carryover rows ----
  function makeCarryEntry({ planName, targetSlug, anchor, origin, estimateType, subsidy, chain, rule, sourceNote, decisionNote }) {
    const aaModel = aaByNorm.get(targetSlug);
    const priorsVar = !aaModel ? bestPriorsVariantFor(targetSlug) : null;
    const fallbackModel = !aaModel && !priorsVar ? modelInfoBySlug.get(targetSlug) : null;
    const intel = aaModel?.intelligenceIndex ?? priorsVar?.intelligenceIndex ?? fallbackModel?.intelligenceIndex ?? null;
    const cpt = aaModel?.costPerTaskUsd ?? priorsVar?.costPerTaskUsd ?? fallbackModel?.aaCostPerTaskUsd ?? null;
    if (intel === null || cpt === null || cpt <= 0) return null;
    return {
      id: `${origin === "ratio-transfer" ? "ratio-transfer" : "shared-pool"}::${normPlanSlug(planName)}::${targetSlug}`,
      origin,
      isPreliminary: true,
      estimateType,
      replacesId: null,
      billing: "subscription",
      vendor: rule.vendor,
      modelCreator: aaModel?.creatorName || priorsVar?.creatorName || fallbackModel?.modelCreator || rule.vendor,
      color: vendorColor(rule.vendor, aaModel),
      plan: planName,
      planLocal: planName,
      planUrl: anchor.planUrl || rule.fallbackUrl || null,
      isOffPeak: false,
      isLegacy: false,
      isCnPortal: false,
      unmetered: false,
      modelId: targetSlug,
      modelDisplay: aaModel?.shortName || priorsVar?.baseDisplay || fallbackModel?.modelDisplay || targetSlug,
      aaVariant: aaModel?.name || priorsVar?.displayName || fallbackModel?.aaVariant || null,
      aaLive: Boolean(aaModel),
      aaUrl: aaModel?.sourceUrl || priorsVar?.aaUrl || fallbackModel?.aaUrl || `https://artificialanalysis.ai/models/${targetSlug}`,
      isOpenWeights: Boolean(aaModel?.isOpenWeights ?? fallbackModel?.isOpenWeights),
      contextWindowTokens: aaModel?.contextWindowTokens ?? fallbackModel?.contextWindowTokens ?? null,
      priceUsd: anchor.priceUsd,
      monthlyTokens: null,
      realUsdPerMtok: null,
      listBlendedUsdPerMtok: aaModel?.pricing?.blended7to2to1Per1M ?? fallbackModel?.listBlendedUsdPerMtok ?? null,
      subsidyMultiple: REL.r4(subsidy),
      intelligenceIndex: Number(intel.toFixed(2)),
      benchmarks: aaModel?.benchmarks || priorsVar?.benchmarks || fallbackModel?.benchmarks || { intelligenceIndex: round1(intel) },
      aaCostPerTaskUsd: Number(cpt.toFixed(4)),
      aaCostPerTaskBreakdown: aaModel?.costPerTaskBreakdown || fallbackModel?.aaCostPerTaskBreakdown || null,
      aaTotalIndexCostUsd: aaModel?.totalIndexCostUsd ?? fallbackModel?.aaTotalIndexCostUsd ?? null,
      aaPricing: aaModel?.pricing || fallbackModel?.aaPricing || null,
      aaSpeed: aaModel?.speed || fallbackModel?.aaSpeed || null,
      confidence: "low",
      dataDate: anchor.dataDate || today,
      sourceNote,
      decisionNote,
      preliminary: null,
      _chain: chain,
    };
  }

  let sharedPoolCount = 0;
  for (const rule of ratioTransferRules) {
    for (const planName of rule.plans) {
      if (liveCell(planName, rule.model)) continue;
      const anchor = liveCell(planName, rule.anchorModel);
      if (!anchor) continue;
      const refs = [];
      for (const q of rule.refPlans) {
        const t = liveCell(q, rule.model) || refOnlyRows.find((e) => e.plan === q && e.modelId === rule.model);
        const a = liveCell(q, rule.anchorModel);
        if (!t || !a) continue;
        const r = t.subsidyMultiple / a.subsidyMultiple;
        const s = REL.qsum(t._chain.s, a._chain.s);
        refs.push({ t, a, q, lr: Math.log(r), w: 1 / (s * s) });
      }
      if (!refs.length) continue;
      const wSum = refs.reduce((acc, x) => acc + x.w, 0);
      const ratio = Math.exp(refs.reduce((acc, x) => acc + x.w * x.lr, 0) / wSum);
      const sRatio = 1 / Math.sqrt(wSum);
      const fam = (m) => REL.shortModel(m.modelDisplay).replace(/\s+[\d.]+$/, "");
      const line = `${cellName(anchor)} ÷ ${(1 / ratio).toFixed(2)} (${fam(refs[0].t)}/${fam(anchor)}, ${refs.map((x) => REL.shortPlan(x.q)).join(" + ")})`;
      const chain = REL.extendChain(
        structuredClone(anchor._chain),
        [
          { k: "ratio", s: REL.r4(sRatio), t: "measured model ratio" },
          { k: "X1", s: REL.STEP_SIGMA.X1, t: "ratio transfer" },
        ],
        line,
        { at: cellName(anchor), anchorId: anchor.id }
      );
      chain.anchors = [...new Set([...chain.anchors, ...refs.flatMap((x) => [x.t.id, x.a.id])])];
      const e = makeCarryEntry({
        planName,
        targetSlug: rule.model,
        anchor,
        origin: "ratio-transfer",
        estimateType: "derived",
        subsidy: anchor.subsidyMultiple * ratio,
        chain,
        rule,
        sourceNote: `Ratio transfer: ${planName} ${anchor.modelDisplay} ${anchor.subsidyMultiple.toFixed(1)}× × measured ${rule.model}/${rule.anchorModel} ratio ${ratio.toFixed(3)}`,
        decisionNote: `S = S(${rule.anchorModel}, ${planName}) × S(${rule.model}, q) / S(${rule.anchorModel}, q), q = ${refs.map((x) => x.q).join(", ")}`,
      });
      if (!e) continue;
      e._x1 = { anchor, refs: refs.map((x) => ({ t: x.t, a: x.a, w: x.w })) };
      if (isFableOnClaude(planName, rule.model)) {
        e.capShare = FABLE_CAP_SHARE;
        e.subsidyReadings = { shared: e.subsidyMultiple, own: REL.r4(e.subsidyMultiple * FABLE_CAP_SHARE) };
      }
      entries.push(e);
      sharedPoolCount++;
    }
  }

  for (const rule of sharedPoolRules) {
    for (const planName of rule.plans) {
      const anchor = liveCell(planName, rule.anchorModel);
      if (!anchor) continue;
      for (const targetSlug of rule.targets) {
        if (entries.some((e) => e.billing === "subscription" && e.plan === planName && e.modelId === targetSlug)) continue;
        let factor = 1;
        let step;
        let line;
        if (rule.mechanism === "token") {
          const tp = (aaByNorm.get(targetSlug) || modelInfoBySlug.get(targetSlug))?.aaPricing || aaByNorm.get(targetSlug)?.pricing;
          const ap = anchor.aaPricing;
          const mix = feiConventions.mixes.standard;
          const bt = blendedForMix(tp, mix);
          const ba = blendedForMix(ap, mix);
          factor = bt > 0 && ba > 0 ? bt / ba : 2 / 3;
          step = { k: "token", s: 0, t: "token pool" };
          line = `${REL.shortModel(anchor.modelDisplay)} × ${factor.toFixed(3)} (token pool)`;
        } else {
          step = { k: "M1", s: REL.STEP_SIGMA.M1, t: "same pool, price-proportional" };
          line = `= ${REL.shortModel(anchor.modelDisplay)} (same pool)`;
        }
        const chain = REL.extendChain(structuredClone(anchor._chain), step, line, {
          at: cellName(anchor),
          anchorId: anchor.id,
          dropKinds: rule.mechanism === "token" ? ["M3proxy"] : [],
        });
        const e = makeCarryEntry({
          planName,
          targetSlug,
          anchor,
          origin: "shared-pool-assumed",
          estimateType: "assumed",
          subsidy: anchor.subsidyMultiple * factor,
          chain,
          rule,
          sourceNote: `Shared quota pool carryover from ${planName} ${anchor.modelDisplay} (${anchor.subsidyMultiple.toFixed(2)}×${factor !== 1 ? ` × ${factor.toFixed(3)}` : ""})`,
          decisionNote: rule.mechanism === "token"
            ? `Token-denominated pool measured on ${targetSlug} traffic: ${anchor.modelDisplay} multiple × list-price blend ratio ${factor.toFixed(3)}.`
            : `Same pool, drawn down at API price: ${anchor.modelDisplay} multiple on ${planName}.`,
        });
        if (!e) continue;
        e._sampleMix = anchor._sampleMix || null;
        entries.push(e);
        sharedPoolCount++;
      }
    }
  }
  if (sharedPoolCount > 0) {
    log(`Added ${sharedPoolCount} carryover entries (shared pool, token pool, ratio transfer)`);
  }

  // Helper to apply OpenRouter model-level backfill + plan access/window metadata
  const backfilledContextSlugs = new Set();
  const unclassifiedPlans = new Set();
  function applyOpenRouterBackfill(entry, allowDomainBackfill) {
    if (/^(?:Opus|Sonnet|Haiku)\s+\d/i.test(String(entry.modelDisplay || ""))) {
      entry.modelDisplay = `Claude ${entry.modelDisplay}`;
    }
    const accessMeta = detectPlanAccessAndWindow(entry.plan, entry.billing);
    entry.openEndpoint = accessMeta.openEndpoint;
    entry.harness = accessMeta.harness;
    entry.quotaWindows = accessMeta.quotaWindows;
    entry.quotaWindow = accessMeta.quotaWindow;
    entry.quotaWindowLabel = accessMeta.quotaWindowLabel;
    if (accessMeta.matched === false) {
      unclassifiedPlans.add(entry.plan);
    }
    entry.codingAgent = resolveCodingAgent(entry, agentIndex);
    const variantKey = `${normSlug(entry.baseModelId)}|${entry.effort || "default"}`;
    entry.t3Turn = priorsParsed.t3Index?.get(variantKey) || null;
    entry.cursorBench = priorsParsed.cursorBenchIndex?.get(variantKey) || null;

    if (!openRouterIndex) return entry;
    const orModel = resolveOpenRouterModel(entry.baseModelId, openRouterIndex, aaByNorm);
    if (!orModel) return entry;

    if ((entry.contextWindowTokens == null || entry.contextWindowTokens <= 0) && orModel.contextWindowTokens > 0) {
      entry.contextWindowTokens = orModel.contextWindowTokens;
      backfilledContextSlugs.add(entry.baseModelId);
    }
    if (!entry.isOpenWeights && orModel.isOpenWeights) {
      entry.isOpenWeights = true;
    }
    if (orModel.pricing) {
      if (!entry.aaPricing) {
        entry.aaPricing = { ...orModel.pricing };
      } else {
        entry.aaPricing = {
          ...entry.aaPricing,
          inputPer1M: entry.aaPricing.inputPer1M ?? orModel.pricing.inputPer1M,
          outputPer1M: entry.aaPricing.outputPer1M ?? orModel.pricing.outputPer1M,
          cacheHitPer1M: entry.aaPricing.cacheHitPer1M ?? orModel.pricing.cacheHitPer1M,
          blended3to1Per1M: entry.aaPricing.blended3to1Per1M ?? orModel.pricing.blended3to1Per1M,
        };
      }
    }
    const matchesOrHeadline =
      allowDomainBackfill ||
      (orModel.aaIntelligenceIndex != null &&
        entry.intelligenceIndex != null &&
        Math.abs(orModel.aaIntelligenceIndex - entry.intelligenceIndex) < 0.35);
    if (matchesOrHeadline && orModel.domainBenchmarks) {
      const merged = { ...(entry.benchmarks || {}) };
      for (const [k, v] of Object.entries(orModel.domainBenchmarks)) {
        if (merged[k] == null && v != null) merged[k] = v;
      }
      entry.benchmarks = merged;
    }
    return entry;
  }

  // Expand base-model entries across all Artificial Analysis reasoning effort variants (low/medium/high/xhigh/max)
  const expandedEntries = [];
  const seenExpandedIds = new Set();
  for (const baseEntry of entries) {
    const effortMap = aaVariantsByBase.get(baseEntry.modelId);
    if (!effortMap || effortMap.size === 0) {
      const e = applyOpenRouterBackfill(
        {
          ...baseEntry,
          baseModelId: baseEntry.modelId,
          effort: "default",
        },
        true
      );
      if (!seenExpandedIds.has(e.id)) {
        seenExpandedIds.add(e.id);
        expandedEntries.push(e);
      }
      continue;
    }

    const allowSingleVariantDomain = effortMap.size === 1;
    for (const v of effortMap.values()) {
      const effId = v.effortLabel ? `${baseEntry.id}@${v.effort}` : baseEntry.id;
      if (seenExpandedIds.has(effId)) continue;
      seenExpandedIds.add(effId);

      const replacesId =
        baseEntry.replacesId && v.effortLabel
          ? `${baseEntry.replacesId}@${v.effort}`
          : baseEntry.replacesId;

      expandedEntries.push(
        applyOpenRouterBackfill(
          {
            ...baseEntry,
            id: effId,
            replacesId,
            baseModelId: baseEntry.modelId,
            modelId: v.variantKey,
            effort: v.effort,
            effortEstimate: v.effortEstimate || null,
            effortEstimateSource: v.effortEstimateSource || null,
            effortEstimateSteps: v.effortEstimateSteps ?? null,
            modelDisplay: v.displayName,
            aaUrl: v.aaUrl || baseEntry.aaUrl,
            aaLive: v.aaLive || baseEntry.aaLive,
            intelligenceIndex: Number(v.intelligenceIndex.toFixed(2)),
            benchmarks: {
              ...(baseEntry.benchmarks && v.isHeadline ? baseEntry.benchmarks : {}),
              ...v.benchmarks,
            },
            aaCostPerTaskUsd: Number(v.costPerTaskUsd.toFixed(4)),
            aaCostPerTaskBreakdown: v.costPerTaskBreakdown || null,
            aaTotalIndexCostUsd: v.totalIndexCostUsd ?? null,
            aaPricing:
              baseEntry.aaPricing?.blended3to1Per1M != null
                ? baseEntry.aaPricing
                : v.pricing || baseEntry.aaPricing || null,
          },
          Boolean(v.isHeadline || allowSingleVariantDomain)
        )
      );
    }
  }

  if (fxRescaledRows > 0) log(`Re-priced ${fxRescaledRows} CNY-fee Fei2411 rows at USD/CNY ${liveCnyPerUsd}`);

  sourceStatus.aaCodingAgents.matchedEntries = expandedEntries.filter((e) => e.codingAgent).length;
  let codingAgentEstimates = null;
  if (agentIndex) {
    log(`Matched Coding Agent Index onto ${sourceStatus.aaCodingAgents.matchedEntries} entries`);
    codingAgentEstimates = estimateCodingAgents(expandedEntries, agentIndex);
    const acc = codingAgentEstimates.accuracy;
    log(
      `Estimated Coding Agent Index on ${codingAgentEstimates.sameModel} rows from same-model runs ` +
        `(LOOCV n=${acc.sameModel.n}: ±${acc.sameModel.pts} pts / ±${acc.sameModel.costPct}% $/task; ` +
        `cross-agent pairs n=${acc.crossAgent.n}: ±${acc.crossAgent.pts} pts / ±${acc.crossAgent.costPct}%) and ` +
        `${codingAgentEstimates.model} rows from Terminal-Bench 4.0 (LOOCV n=${acc.model.n}: ±${acc.model.pts} pts / ±${acc.model.costPct}% $/task)`
    );
  }

  const tierCounts = { effort: {}, agent: {} };
  for (const e of expandedEntries) {
    e.estimateConfidence = effortConfidence(e);
    if (e.estimateConfidence) tierCounts.effort[e.estimateConfidence] = (tierCounts.effort[e.estimateConfidence] || 0) + 1;
    if (e.codingAgent?.estimate) {
      e.codingAgent.confidence = agentConfidence(e);
      tierCounts.agent[e.codingAgent.confidence] = (tierCounts.agent[e.codingAgent.confidence] || 0) + 1;
    }
  }
  log(`Estimate confidence — effort: ${JSON.stringify(tierCounts.effort)}, agent: ${JSON.stringify(tierCounts.agent)}`);

  sourceStatus.openRouter.backfilledContextCount = backfilledContextSlugs.size;
  if (backfilledContextSlugs.size > 0) {
    log(`Backfilled contextWindowTokens for ${backfilledContextSlugs.size} models from OpenRouter`);
  }

  // ---- Reliability per entry: σ of ln real cost = subsidy chain ⊕ token mix ⊕ cost metric ----
  // T3 $/turn vs AA Coding Agent $/task by harness (measured agent runs only)
  const t3Harness = {};
  {
    const seen = new Set();
    const groups = new Map();
    for (const e of expandedEntries) {
      const a = e.codingAgent;
      if (!a || a.estimate || !(e.t3Turn?.costPerTurnUsd > 0) || !(a.costPerTaskUsd > 0)) continue;
      const k = `${e.modelId}|${a.agentSlug}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!groups.has(a.agentSlug)) groups.set(a.agentSlug, []);
      groups.get(a.agentSlug).push({ r: e.t3Turn.costPerTurnUsd / a.costPerTaskUsd, min: e.t3Turn.minutesPerTurn });
    }
    for (const [slug, g] of groups) {
      const lns = g.map((x) => Math.log(x.r));
      const mu = lns.reduce((s, x) => s + x, 0) / lns.length;
      const sd = Math.sqrt(lns.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, lns.length - 1));
      const mins = g.map((x) => x.min).filter((x) => x > 0);
      t3Harness[slug] = { n: g.length, ratio: REL.r4(median(g.map((x) => x.r))), sdLn: REL.r4(sd), minPerTurn: mins.length ? REL.r4(median(mins)) : null };
    }
  }
  const t3HarnessFit = REL.t3HarnessSigma(t3Harness);
  const CS = REL.costSteps(effortAccuracy, codingAgentEstimates?.accuracy, t3HarnessFit.sigma);
  const breakdownByVariant = new Map();
  const breakdownByBase = new Map();
  const t3ByVariant = new Map();
  const t3ByBase = new Map();
  const EFF_RANK = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, default: 6 };
  for (const e of expandedEntries) {
    if (e.aaCostPerTaskBreakdown?.total > 0) {
      breakdownByVariant.set(e.modelId, e.aaCostPerTaskBreakdown);
      if (!breakdownByBase.has(e.baseModelId)) breakdownByBase.set(e.baseModelId, e.aaCostPerTaskBreakdown);
    }
    if (e.t3Turn?.perTurn) {
      t3ByVariant.set(e.modelId, { perTurn: e.t3Turn.perTurn, pricing: e.aaPricing });
      const prev = t3ByBase.get(e.baseModelId);
      if (!prev || (EFF_RANK[e.effort] ?? 0) > prev.rank) t3ByBase.set(e.baseModelId, { perTurn: e.t3Turn.perTurn, pricing: e.aaPricing, rank: EFF_RANK[e.effort] ?? 0 });
    }
  }
  const anthropicConvention = feiConventions.mixes.anthropic;
  const phiSampleMemo = new Map();
  function phiSample(base) {
    if (phiSampleMemo.has(base.id)) return phiSampleMemo.get(base.id);
    phiSampleMemo.set(base.id, null);
    let v = null;
    if (base._x1) {
      // φ of a ratio-transferred cell: φ(target, q) × φ(anchor, p) / φ(anchor, q), geometric mean over q.
      const pa = phiSample(base._x1.anchor);
      const parts = base._x1.refs.map((r) => ({ t: phiSample(r.t), a: phiSample(r.a), w: r.w })).filter((r) => r.t && r.a && pa);
      if (parts.length) {
        const W = parts.reduce((s, r) => s + r.w, 0);
        v = REL.MIX_SCENARIOS.map((_, i) => Math.exp(parts.reduce((s, r) => s + r.w * Math.log((r.t[i] * pa[i]) / r.a[i]), 0) / W));
      }
    } else if (base._sampleKind === "t3") {
      const t = t3ByBase.get(base.modelId);
      v = t ? REL.phiVector(REL.dollarMixFromTokens(t.perTurn, t.pricing || base.aaPricing)) : null;
    } else if (base._sampleMix) {
      v = REL.phiVector(base._sampleMix);
    }
    if (!v) v = REL.phiVector(REL.conventionMix(anthropicConvention, base.aaPricing));
    phiSampleMemo.set(base.id, v);
    return v;
  }
  const baseById = new Map(entries.map((e) => [e.id, e]));
  const sampleKnown = (b) => Boolean(b._sampleMix || b._sampleKind === "t3" || (b._x1 && b._x1.refs.every((r) => sampleKnown(r.t) && sampleKnown(r.a))));
  const vendorMixSigma = (e) => {
    if (e.billing === "metered" || ["kilo-pass", "ollama-cloud", "artificial-analysis"].includes(e.origin)) return 0;
    if (/^(ChatGPT|Cursor|GitHub Copilot|GLM)\b/.test(e.plan)) return 0.05;
    if (/^(Google AI|SuperGrok|Kimi|MiniMax)\b/.test(e.plan)) return 0.15;
    return 0.1;
  };
  const modes = ["task", "agent", "cursor", "turn", "tokens"];
  const effortCost = (e) => {
    if (!e.effortEstimate) return { s: CS.aa, t: "AA measured", pts: 0 };
    if (e.effortEstimate === "interpolated") return { s: CS.interp, t: "interpolated effort", pts: CS.pts.interp };
    if (e.effortEstimateSource === "arc-agi-2") return { s: CS.arc, t: "ARC-AGI-2 effort ratio", pts: CS.pts.arc };
    const n = Math.max(1, Math.min(4, e.effortEstimateSteps ?? 4));
    return { s: CS.extrap[n - 1], t: `${e.effortEstimateSteps ?? "4+"} effort step${n === 1 ? "" : "s"}`, pts: CS.pts.extrap[n - 1] };
  };
  // Quota-weight cells (data/quota-weights/fit.json); missing or unreadable → every cell unmeasured.
  const quotaFit = REL.parseQuotaFit(fs.existsSync(QUOTA_FIT_PATH) ? fs.readFileSync(QUOTA_FIT_PATH, "utf8") : "");
  if (!quotaFit.present) log(`Quota-weight fit: ${fs.existsSync(QUOTA_FIT_PATH) ? `unreadable (${quotaFit.error})` : "absent"}; every Claude cell unmeasured`);
  const quotaPrices = (() => {
    try {
      return JSON.parse(fs.readFileSync(QUOTA_PRICES_PATH, "utf8")).models || {};
    } catch {
      return {};
    }
  })();
  const quotaCell = (key) => quotaFit.cells.get(key) || { key, status: "unmeasured" };
  const p1hOver5m = (model) => {
    const p = quotaPrices[model];
    return p?.cacheWrite1h > 0 && p?.cacheWrite5m > 0 ? p.cacheWrite1h / p.cacheWrite5m : 1.6;
  };
  // Cells a Claude row uses: φ(sample) from the measured sample's model (the chain's anchors for a
  // derived row), φ(metric) from the row's own model; weekly bar; client class from the sample notes.
  const quotaCellsOf = (e, base, ch) => {
    const anchorRows = (ch.anchors || []).map((id) => baseById.get(id)).filter(Boolean);
    const sampleRows = anchorRows.length ? anchorRows : [base];
    const sampleModels = [...new Set(sampleRows.map((r) => String(r.baseModelId || r.modelId || "").replace(/--.*$/, "")))];
    const cls = REL.sampleClientClass(sampleRows.map((r) => `${r.sourceNote || ""} ${r.decisionNote || ""}`).join(" "));
    const sampleKeys = sampleModels.map((m) => REL.quotaCellKey(m, CLAUDE_SAMPLE_BAR, cls));
    const metricKey = REL.quotaCellKey(e.baseModelId, CLAUDE_SAMPLE_BAR, cls);
    return { sampleModels, sampleKeys, metricKey, keys: [...new Set([...sampleKeys, metricKey])] };
  };
  const quotaRowStatus = { validated: 0, provisional: 0, unmeasured: 0 };
  let quotaRowsApplied = 0;
  const chains = {};
  const chainKeyById = new Map();
  let chainSeq = 0;
  const levelCounts = { high: 0, medium: 0, low: 0, speculative: 0 };
  const mixSamples = [];
  const historyCells = [];
  const historyDate = nowIso.slice(0, 10);
  let sdkClientRows = 0;
  const levelCountsByMode = {};
  for (const e of expandedEntries) {
    const baseId = e.id.split("@")[0];
    const base = baseById.get(baseId) || e;
    const ch = e._chain || REL.makeChain({ steps: [{ k: "unknown", s: 0.5, t: "unknown" }], lines: ["unknown"] });
    let key = chainKeyById.get(baseId);
    if (!key) {
      key = `c${(chainSeq++).toString(36)}`;
      chainKeyById.set(baseId, key);
      chains[key] = {
        entity: baseId,
        value: e.subsidyMultiple,
        steps: ch.steps,
        lines: ch.lines,
        anchors: ch.anchors,
        flags: ch.flags,
        ...(ch.drop ? { drop: REL.r4(ch.drop) } : {}),
      };
      // Ledger cell: one per plan × model subscription row.
      if (e.billing === "subscription" && !e.unmetered && e.subsidyMultiple > 0) {
        const cellId = `${e.plan}|${e.baseModelId}${e.isOffPeak ? "|offpeak" : ""}`;
        historyCells.push(REL.historyCell(cellId, e.subsidyMultiple, ch.s, ch.steps.map((x) => x.k), REL.chainDerived(ch), historyDate));
      }
    }
    const eff = effortCost(e);
    const c = {};
    const cl = {};
    const ce = [];
    c.task = REL.r4(eff.s);
    cl.task = eff.t;
    if (e.effortEstimate) ce.push("task");
    const a = e.codingAgent;
    let agentPts = null;
    if (a) {
      let s, t, pts;
      if (!a.estimate) [s, t, pts] = [CS.aa, `AA agent run, ${a.agent}`, 0];
      else if (a.estimate === "same-model") {
        [s, t, pts] = a.crossAgent
          ? [CS.agentCross, `from ${a.fromAgent} run`, CS.pts.agentCross]
          : [CS.agentSame, `from ${a.fromEffort} effort run`, CS.pts.agentSame];
      } else {
        [s, t, pts] = a.outOfRange
          ? [CS.agentFitBelow, "Terminal-Bench fit, below range", CS.pts.agentFitBelow]
          : [CS.agentFit, "Terminal-Bench fit", CS.pts.agentFit];
      }
      // An agent estimate built on an effort estimate counts that effort step once.
      if (a.estimate && e.effortEstimate) {
        s = REL.qsum(s, eff.s);
        pts = REL.qsum(pts, eff.pts);
      }
      c.agent = REL.r4(s);
      cl.agent = t;
      agentPts = REL.r4(pts);
      if (a.estimate) ce.push("agent");
    }
    if (e.t3Turn?.costPerTurnUsd > 0) {
      c.turn = REL.r4(REL.qsum(CS.t3(e.t3Turn.turns || 0), CS.t3Harness));
      cl.turn = `T3, ${(e.t3Turn.turns || 0).toLocaleString("en-US")} turns`;
    }
    if (e.cursorBench?.costPerTaskUsd > 0) {
      c.cursor = CS.cursor;
      cl.cursor = "CursorBench";
    }
    c.tokens = CS.tokens;
    cl.tokens = "list price";

    // Token-mix term (W1). Claude first-party: φ(sample) / φ(metric) with the cache-read weight range.
    const w = {};
    let quotaMix = null;
    let quotaCellRef = null;
    if (isClaudeFirstParty(e.plan) && e.billing === "subscription" && !e.unmetered) {
      const ps = phiSample(base);
      const aaMix = REL.dollarMixFromAa(breakdownByVariant.get(e.modelId) || breakdownByBase.get(e.baseModelId));
      const t3 = t3ByVariant.get(e.modelId) || t3ByBase.get(e.baseModelId);
      const t3Mix = t3 ? REL.dollarMixFromTokens(t3.perTurn, t3.pricing || e.aaPricing) : null;
      const metricPhi = {
        task: REL.phiVector(aaMix),
        agent: REL.phiVector(t3Mix), // AA Coding Agent mix unpublished: T3 mix of the same model as proxy
        turn: REL.phiVector(t3Mix),
        tokens: REL.MIX_SCENARIOS.map(() => 1), // 3:1 input:output blend, no cache
      };
      const metricPhiAlt = {
        task: REL.phiVector(REL.asHourWrites(aaMix)),
        agent: REL.phiVector(REL.asHourWrites(t3Mix)),
        turn: REL.phiVector(REL.asHourWrites(t3Mix)),
        tokens: null,
      };
      // Fitted quota weights: only when every cell the row uses is validated.
      const qc = quotaCellsOf(e, base, ch);
      const decision = REL.quotaMixDecision({
        forcedOff: FORCE_CLAUDE_MIX_CORRECTION_OFF,
        cells: qc.keys.map(quotaCell),
        sampleKnown: Boolean(base._sampleMix) && !base._x1,
        singleSampleModel: qc.sampleModels.length === 1,
      });
      quotaRowStatus[decision.status]++;
      const sampleCell = quotaCell(qc.sampleKeys[0]);
      const metricCell = quotaCell(qc.metricKey);
      const p = e.aaPricing || {};
      const metricMixes = {
        task: aaMix,
        agent: t3Mix,
        turn: t3Mix,
        tokens: p.inputPer1M > 0 && p.outputPer1M > 0 ? { input: 3 * p.inputPer1M, output: p.outputPer1M } : null,
      };
      let appliedAny = false;
      for (const m of modes) {
        if (m === "cursor") {
          w.cursor = 0.15;
          continue;
        }
        const fitted = decision.apply
          ? REL.quotaMixFromCells({ sampleMix: base._sampleMix, metricMix: metricMixes[m], sampleCell, metricCell, p1hOver5m: p1hOver5m(e.baseModelId) })
          : null;
        if (fitted) {
          (quotaMix ||= {})[m] = { f: fitted.f, lo: fitted.lo, hi: fitted.hi, status: "validated" };
          w[m] = fitted.sigma;
          appliedAny = true;
          if (m === "task") mixSamples.push({ id: e.id, f: fitted.f, lo: fitted.lo, hi: fitted.hi, status: "validated" });
          continue;
        }
        const mf = REL.mixFactor(ps, metricPhi[m], metricPhiAlt[m]);
        if (!mf) {
          w[m] = 0.12;
          continue;
        }
        // Sample mix not recorded: the row's mix is Fei's workload convention, so keep the full W1 term.
        if (!sampleKnown(base)) mf.sigma = Math.max(mf.sigma, 0.12);
        // Not applied: the range also covers the uncorrected bias.
        w[m] = REL.r4(REL.qsum(mf.sigma, Math.log(mf.f)));
        if (m === "task") mixSamples.push({ id: e.id, f: mf.f, lo: mf.lo, hi: mf.hi, status: decision.status });
      }
      if (appliedAny) quotaRowsApplied++;
      quotaCellRef = { cells: qc.keys, status: decision.status, applied: appliedAny };
    } else {
      const ws = vendorMixSigma(e);
      for (const m of modes) w[m] = ws;
    }
    if (quotaMix) e.quotaMix = quotaMix;

    // Subsidy steps that apply to one cost metric only (`x`): Agent SDK client weighting in T3 mode.
    let x = null;
    if (APPLY_SDK_CLIENT_MULTIPLIER && c.turn && isClaudeFirstParty(e.plan) && e.billing === "subscription" && !e.unmetered) {
      const k = REL.SDK_CLIENT;
      e.clientFactor = { turn: { f: REL.r4(1 / k.central), lo: REL.r4(1 / k.hi), hi: REL.r4(1 / k.lo), k: "sdkClient" } };
      x = { turn: REL.r4(REL.SDK_CLIENT_SIGMA) };
      sdkClientRows++;
    }

    const capped = REL.chainCapped(ch);
    const rel = {
      s: REL.r4(ch.s),
      w,
      c,
      ...(x ? { x } : {}),
      score: { ii: REL.r4(eff.pts), ...(agentPts != null ? { agent: agentPts } : {}) },
      cap: capped ? "speculative" : ch.cap || null,
      chain: key,
      flags: ch.flags,
      sd: REL.chainDerived(ch),
      ce,
      cl,
      ...(quotaCellRef ? { mix: quotaCellRef } : {}),
    };
    // Default view: AA Intelligence task cost, Intelligence Index score, Shared reading.
    const sigma = REL.qsum(rel.s, w.task, c.task);
    const level = REL.worseLevel(REL.levelFromSigma(sigma), REL.levelFromScore(rel.score.ii), rel.cap);
    const S = e.billing === "metered" ? 1 : (e.subsidyMultiple || 0) * (quotaMix?.task?.f ?? 1);
    const real = e.unmetered ? 0 : S > 0 ? e.aaCostPerTaskUsd / S : null;
    rel.level = level;
    rel.sigma = REL.r4(sigma);
    if (real != null) {
      rel.lo = Number((real * Math.exp(-REL.Z80 * sigma)).toPrecision(4));
      rel.hi = Number((real * Math.exp(REL.Z80 * sigma)).toPrecision(4));
    }
    e.rel = rel;
    levelCounts[level]++;
    for (const m of modes) {
      // Same rule as the page with the default benchmark (Intelligence Index score error).
      if (!(c[m] > 0)) continue;
      const lv = REL.worseLevel(REL.levelFromSigma(REL.qsum(rel.s, w[m], c[m], x?.[m])), REL.levelFromScore(rel.score.ii), rel.cap);
      (levelCountsByMode[m] ||= { high: 0, medium: 0, low: 0, speculative: 0 })[lv]++;
    }
  }

  // Calibration ledger: read, append this run's cells, score old ranges against new direct values.
  let historyLines = [];
  try {
    historyLines = fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code !== "ENOENT") log(`History unreadable (${err.message}); calibration starts empty`);
  }
  const lastDeploy = [...historyLines].reverse().find((l) => l.t === "deploy") || null;
  const newCells = REL.historyAppend(historyLines, historyCells);
  const quadFails = consistency.filter((q) => q.type === "quad" && q.verdict === "fail").length;
  const deployLine = {
    t: "deploy",
    d: nowIso,
    counts: levelCounts,
    quadFails,
    t3: Object.fromEntries(Object.entries(t3Harness).filter(([, v]) => v.n >= 3).map(([k, v]) => [k, v.ratio])),
    t3Sigma: REL.r4(CS.t3Harness),
  };
  const ledger = [...historyLines, ...newCells, deployLine];
  const calibration = REL.calibrate(ledger);
  if (RECORD_HISTORY) {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.appendFileSync(HISTORY_PATH, [...newCells, deployLine].map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }
  log(
    `History: ${historyLines.length} lines read, ${newCells.length} cells + 1 deploy ${RECORD_HISTORY ? "appended" : "not recorded (local run)"}; calibration cases ${calibration.cases}${calibration.refitDue.length ? `, refit due: ${calibration.refitDue.join(", ")}` : ""}`
  );

  log(`Reliability levels (AA task, Intelligence Index): ${JSON.stringify(levelCounts)}; T3 turn: ${JSON.stringify(levelCountsByMode.turn)}; SDK client ÷${REL.SDK_CLIENT.central} ${APPLY_SDK_CLIENT_MULTIPLIER ? `on (${sdkClientRows} rows)` : "off"}; T3 cross-harness σ ${CS.t3Harness} (raw ${t3HarnessFit.raw})`);
  const quotaCellStatus = Object.fromEntries([...quotaFit.cells.values()].filter((c) => c.vendor === "anthropic" || /^anthropic\//.test(c.key)).map((c) => [c.key, c.status]));
  const quotaCellCounts = { validated: 0, provisional: 0, unmeasured: 0 };
  for (const st of Object.values(quotaCellStatus)) quotaCellCounts[st] = (quotaCellCounts[st] || 0) + 1;
  const claudeMixCorrection = {
    forcedOff: FORCE_CLAUDE_MIX_CORRECTION_OFF,
    fit: { present: quotaFit.present, generatedAt: quotaFit.generatedAt || null, path: "data/quota-weights/fit.json" },
    bar: CLAUDE_SAMPLE_BAR,
    cells: quotaCellStatus,
    cellCounts: quotaCellCounts,
    rows: { applied: quotaRowsApplied, byStatus: quotaRowStatus },
  };
  log(
    `Reliability levels (AA task, Intelligence Index): ${JSON.stringify(levelCounts)}; Claude mix correction: ${quotaRowsApplied} rows applied, rows by cell status ${JSON.stringify(quotaRowStatus)}, cells ${JSON.stringify(quotaCellCounts)}${FORCE_CLAUDE_MIX_CORRECTION_OFF ? " (forced off)" : ""}`
  );
  const consFails = consistency.filter((x) => x.verdict === "fail");
  if (consFails.length) log(`Consistency fails: ${consFails.map((x) => `${x.type}:${x.family}:${x.a}/${x.b}:${x.p}${x.q ? `/${x.q}` : ""} ×${x.ratio}`).join("; ")}`);
  const feiDerivedRows = feiRows.filter((r) => r.data_date_kind === "derived");
  const unresolved = feiDerivedRows.filter((r) => feiCtx.memo.get(r.id)?.flags.includes("unresolved")).map((r) => r.id);
  const reliabilityStats = {
    claudeMixCorrection,
    levels: REL.LEVELS,
    levelSigma: REL.LEVEL_SIGMA,
    levelScorePts: REL.LEVEL_SCORE_PTS,
    z80: REL.Z80,
    steps: REL.STEP_SIGMA,
    sigmaBuckets: REL.SIGMA_BUCKETS,
    upstreamFloor: REL.UPSTREAM_FLOOR,
    costSteps: { ...CS, t3: { ge1000: CS.t3(1000), ge100: CS.t3(100), lt100: CS.t3(0) } },
    t3HarnessFit,
    sdkClient: {
      on: APPLY_SDK_CLIENT_MULTIPLIER,
      ...REL.SDK_CLIENT,
      sigma: REL.r4(REL.SDK_CLIENT_SIGMA),
      rows: sdkClientRows,
      sources: ["https://github.com/anthropics/claude-code/issues/97074", "https://github.com/anthropics/claude-code/issues/111890"],
    },
    mixScenarios: REL.MIX_SCENARIOS,
    counts: levelCounts,
    countsByMode: levelCountsByMode,
    calibration,
    lastDeploy,
    history: { path: "data/reliability/history.jsonl", lines: ledger.length, deploys: ledger.filter((l) => l.t === "deploy").length, recorded: RECORD_HISTORY },
    consistency,
    feiDerived: feiDerivedRows.length,
    unresolved,
    priorsSkipped: priorsParsed.skipped || [],
    droppedRows,
    promoExpiry: PROMO_EXPIRY,
    quotaChanges: QUOTA_CHANGES,
    modelRetirements: MODEL_RETIREMENTS,
    t3Harness,
    mixSamples: mixSamples.slice(0, 400),
  };
  // Monthly / yearly billing prices (scripts/billing-periods.mjs); the page picks one per the Billing setting.
  const billingStats = applyBillingPeriods(expandedEntries, { yearlySigma: REL.BILLING_STEP_SIGMA, log });
  log(`Billing: ${billingStats.official} rows with an official annual price, ${billingStats.none} monthly-only, ${billingStats.unknown} unknown, ${billingStats.variant} annual-variant rows (${billingStats.linkedTwins} linked to a monthly twin)`);
  // Bundled credits outside the quota (scripts/included-credits.mjs): recorded per plan, never counted in the subsidy.
  const creditStats = applyIncludedCredits(expandedEntries, { log });
  log(`Included credits: ${creditStats.listed} rows listed, ${creditStats.none} none, ${creditStats.unknown} unknown`);
  // One creator per model and one colour per creator. Rows built from seller data (Copilot, Droid,
  // Command Code…) sometimes carry the seller as creator; colour came from whichever path built the row.
  {
    const creatorVotes = new Map(); // baseModelId → Map(creator → votes)
    for (const e of expandedEntries) {
      const c = e.modelCreator;
      if (!c || !e.baseModelId || c === e.vendor) continue; // seller-as-creator rows don't vote
      const m = creatorVotes.get(e.baseModelId) || new Map();
      m.set(c, (m.get(c) || 0) + (e.aaLive ? 3 : 1));
      creatorVotes.set(e.baseModelId, m);
    }
    const colorByCreator = new Map();
    for (const m of aaByNorm.values()) {
      if (m.creatorName && m.creatorColor && !colorByCreator.has(m.creatorName)) colorByCreator.set(m.creatorName, m.creatorColor);
    }
    let creatorFixed = 0, colorFixed = 0;
    for (const e of expandedEntries) {
      const votes = creatorVotes.get(e.baseModelId);
      if (votes && votes.size) {
        const best = [...votes].sort((a, b) => b[1] - a[1])[0][0];
        if (e.modelCreator !== best) { e.modelCreator = best; creatorFixed++; }
      }
      const color = colorByCreator.get(e.modelCreator) || vendorColor(e.modelCreator, null);
      if (e.color !== color) { e.color = color; colorFixed++; }
    }
    log(`Model creator fixed on ${creatorFixed} row(s); colour unified on ${colorFixed} row(s)`);
  }

  for (const e of expandedEntries) for (const k of Object.keys(e)) if (k.startsWith("_")) delete e[k];

  expandedEntries.sort((a, b) => {
    const effA = a.unmetered ? 0 : a.aaCostPerTaskUsd / (a.subsidyMultiple || 1);
    const effB = b.unmetered ? 0 : b.aaCostPerTaskUsd / (b.subsidyMultiple || 1);
    return effA - effB;
  });

  const payload = {
    schemaVersion: 3,
    generatedAt: nowIso,
    latestDataDate: latestFeiDate || priorsParsed.date || nowIso.slice(0, 10),
    sources: sourceStatus,
    stats: {
      totalEntries: expandedEntries.length,
      subscriptions: expandedEntries.filter((e) => e.billing === "subscription").length,
      meteredApis: expandedEntries.filter((e) => e.billing === "metered").length,
      priorsPreliminary: prelimCount,
      priorsAssumed: assumedCount,
      priorsExtraMeasured: priorsExtraCount,
      githubCopilotEntries: copilotEntryCount,
      ollamaTeamEntries: ollamaTeamEntryCount,
      kiloPassEntries: kiloPassEntryCount,
      uniqueModels: new Set(expandedEntries.map((e) => e.baseModelId)).size,
      uniqueVariants: new Set(expandedEntries.map((e) => e.modelId)).size,
      liveAaModels: aaByNorm.size,
      openRouterBackfilledContext: backfilledContextSlugs.size,
      interpolatedEffortVariants,
      extrapolatedEffortVariants,
      arcExtrapolatedVariants,
      effortAccuracy,
      codingAgentEstimates,
      estimateTiers: buildEstimateTiers(effortAccuracy, codingAgentEstimates?.accuracy),
      aaIndexFreshness: { keptNewerPriors: keptNewerScores.length, variants: keptNewerScores },
      t3CodeTurns: { variants: priorsParsed.t3Index.size, entries: expandedEntries.filter((e) => e.t3Turn).length },
      cursorBench: { variants: priorsParsed.cursorBenchIndex.size, entries: expandedEntries.filter((e) => e.cursorBench).length },
      unclassifiedPlans: [...unclassifiedPlans].sort(),
      billing: billingStats,
      includedCredits: creditStats,
      reliability: reliabilityStats,
      chains,
    },
    entries: expandedEntries,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const tmpPath = `${OUTPUT_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
  fs.renameSync(tmpPath, OUTPUT_PATH);

  log(
    `Wrote ${OUTPUT_PATH} (${payload.stats.totalEntries} entries across ${payload.stats.uniqueVariants} effort variants / ${payload.stats.uniqueModels} base models)`
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
