// AI Plan Value — 2003 SaaS edition with Artificial Analysis domains/tests & official plan links

const BUDGET_STOPS = [
  { label: "≤ $10/mo", max: 10 },
  { label: "≤ $20/mo", max: 20 },
  { label: "≤ $50/mo", max: 50 },
  { label: "≤ $100/mo", max: 100 },
  { label: "≤ $200/mo", max: 200 },
  { label: "Any", max: Infinity },
];

const COST_STOPS_TASK = [
  { label: "≤ $0.25", max: 0.25 },
  { label: "≤ $0.50", max: 0.5 },
  { label: "≤ $1", max: 1 },
  { label: "≤ $2", max: 2 },
  { label: "≤ $5", max: 5 },
  { label: "≤ $10", max: 10 },
  { label: "Any", max: Infinity },
];

const COST_STOPS_TOKENS = [
  { label: "≤ $0.10", max: 0.1 },
  { label: "≤ $0.25", max: 0.25 },
  { label: "≤ $0.50", max: 0.5 },
  { label: "≤ $1", max: 1 },
  { label: "≤ $5", max: 5 },
  { label: "≤ $10", max: 10 },
  { label: "Any", max: Infinity },
];

const BENCHMARKS = {
  intelligenceIndex: { label: "Intelligence", unit: "", min: 0, max: 64, step: 1, def: 45 },
  codingAgentIndex: { label: "Coding Agent", unit: "", min: 0, max: 60, step: 1, def: 40 },
  cursorBench: { label: "CursorBench", unit: "%", min: 0, max: 66, step: 1, def: 40 },
  engineering: { label: "Engineering", unit: "", min: 20, max: 72, step: 1, def: 50 },
  financeAndAccounting: { label: "Finance & Accounting", unit: "", min: 25, max: 65, step: 1, def: 48 },
  strategyAndOps: { label: "Strategy & Ops", unit: "", min: 20, max: 67, step: 1, def: 50 },
  legal: { label: "Legal", unit: "", min: 25, max: 63, step: 1, def: 45 },
  healthcareAndMedical: { label: "Healthcare & Medical", unit: "", min: 20, max: 65, step: 1, def: 45 },
  economics: { label: "Economics", unit: "", min: 25, max: 66, step: 1, def: 48 },
  frontierCode20: { label: "FrontierCode 2.0", unit: "%", min: 0, max: 48, step: 1, def: 25 },
  terminalBench40: { label: "Terminal-Bench 4.0", unit: "%", min: 0, max: 67, step: 1, def: 35 },
  terminalBenchScience: { label: "TB Science", unit: "%", min: 0, max: 78, step: 1, def: 40 },
  hle: { label: "Humanity's Last Exam", unit: "%", min: 0, max: 75, step: 1, def: 45 },
  hleDiamond: { label: "HLE (Diamond)", unit: "%", min: 0, max: 80, step: 1, def: 40 },
  critptAgenticHard: { label: "CritPt Hard", unit: "%", min: 0, max: 76, step: 1, def: 35 },
  automationBench: { label: "AutomationBench", unit: "%", min: 0, max: 79, step: 1, def: 45 },
  omniscienceAccuracy: { label: "Omniscience", unit: "%", min: 0, max: 79, step: 1, def: 45 },
  gdpPdfAllPass: { label: "GDP PDF", unit: "%", min: 0, max: 32, step: 1, def: 15 },
  lcr: { label: "AA-LCR", unit: "%", min: 65, max: 86, step: 1, def: 75 },
  scicode: { label: "SciCode", unit: "%", min: 40, max: 67, step: 1, def: 50 },
  gdpval: { label: "GDPval", unit: " Elo", min: 1150, max: 1860, step: 10, def: 1500 },
  contextWindow: { label: "Context Window", unit: "K", min: 0, max: 1000, step: 50, def: 200 },
  outputSpeed: { label: "Output Speed", unit: " tok/s", min: 0, max: 350, step: 10, def: 80 },
};

const ACCESS_FILTERS = new Set(["any", "open", "locked"]);
const TOP_N_MAX = 20;

const state = {
  dataset: null,
  benchKey: "intelligenceIndex",
  costMode: "task", // COST_MODES key
  minEffort: "any", // "any" | "none" | "low" | "medium" | "high" | "xhigh" | "max"
  maxEffort: "any",
  accessFilter: "any", // "any" | "open" | "locked"
  no5h: false, // hide plans with a 5h or daily limit
  noWeekly: false, // hide plans with a weekly / 7-day limit
  minScore: 45,
  rankMode: "min", // "min" (score threshold) | "top" (N highest-scoring models)
  topN: 5,
  budgetIdx: 5,
  maxCostIdx: 4,
  hideLegacy: true,
  hideOffPeak: true,
  minConf: "medium", // lowest reliability level shown: high | medium | low | speculative
  costView: "point", // "point" | "range" (80% band in Real cost cells)
  fableCap: "shared", // "shared" | "own" (Fable only) reading for Fable on Claude plans
  billing: "monthly", // "monthly" | "yearly" (annual fee / 12 where an official annual price exists)
  hideCnPortal: false,
  showApi: false,
  openWeightsOnly: false,
  extraCriteria: [], // [{ benchKey, minScore }]
  tableQuery: "",
  tableLimit: 50, // phone card view: rows rendered before "Show 50 more"
  groupByPlan: false,
  expandedTableGroups: new Set(),
  cheapestPlanOnly: true,
  cheapestEffortOnly: true,
  expandedPlans: new Set(),
  sortKey: "effectiveCost",
  sortDir: "asc",
};

// Cost metric is independent of the Min benchmark: any score filter pairs with any cost basis.
const COST_MODES = {
  task: { unit: "task", heading: "Best Real Cost per Task", maxLabel: "Max cost/task:", vol: "Tasks/mo" },
  agent: { unit: "task", heading: "Best Real Cost per Agent Task", maxLabel: "Max cost/task:", vol: "Tasks/mo" },
  cursor: { unit: "task", heading: "Best Real Cost per CursorBench Task", maxLabel: "Max cost/task:", vol: "Tasks/mo" },
  turn: { unit: "turn", heading: "Best Real Cost per T3 Code Turn", maxLabel: "Max cost/turn:", vol: "Turns/mo" },
  tokens: { unit: "1M", heading: "Best Real Cost per 1M Tokens", maxLabel: "Max $/1M tokens:", vol: "Mtok/mo" },
};

// Reliability levels (docs/RELIABILITY.md): σ = sd of ln(real cost); level from the 80% band.
const LEVELS = ["high", "medium", "low", "speculative"];
const LEVEL_RANK = { high: 0, medium: 1, low: 2, speculative: 3 };
const LEVEL_LABEL = { high: "High", medium: "Medium", low: "Low", speculative: "Speculative" };
const LEVEL_GLYPH = { high: "●", medium: "◐", low: "○", speculative: "◌" };
const LEVEL_PARAM = { high: "h", medium: "m", low: "l", speculative: "s" };
const LEVEL_SIGMA = { high: 0.18, medium: 0.4, low: 0.7 };
const LEVEL_SCORE_PTS = { high: 1.5, medium: 3, low: 5 };
const Z80 = 1.2816;
const qsum = (...xs) => Math.sqrt(xs.reduce((a, x) => a + (Number.isFinite(x) ? x * x : 0), 0));
const levelFromSigma = (s) =>
  s <= LEVEL_SIGMA.high + 1e-9 ? "high" : s <= LEVEL_SIGMA.medium + 1e-9 ? "medium" : s <= LEVEL_SIGMA.low + 1e-9 ? "low" : "speculative";
const levelFromScore = (p) =>
  !(p > 0) || p <= LEVEL_SCORE_PTS.high ? "high" : p <= LEVEL_SCORE_PTS.medium ? "medium" : p <= LEVEL_SCORE_PTS.low ? "low" : "speculative";
const worseLevel = (...ls) => ls.filter(Boolean).reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), "high");
// "Best" picks in the bar chart never rest on a Low or Speculative row.

function currentCostStops() {
  return state.costMode === "tokens" ? COST_STOPS_TOKENS : COST_STOPS_TASK;
}

const $ = (id) => document.getElementById(id);

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

function fmtMult(n) {
  if (n == null || !Number.isFinite(n)) return "∞";
  return n >= 10 ? `${n.toFixed(1)}×` : `${n.toFixed(2)}×`;
}

function activeScoreKey() {
  return state.benchKey;
}

function activeBenchMeta() {
  return BENCHMARKS[state.benchKey] || BENCHMARKS.intelligenceIndex;
}

function fmtScore(val, key) {
  if (val == null || !Number.isFinite(val)) return "—";
  if (key === "contextWindow") {
    return val >= 1000 ? `${(val / 1000).toFixed(val % 1000 < 50 ? 0 : 1)}M` : `${Math.round(val)}K`;
  }
  if (key === "outputSpeed") {
    return `${Math.round(val)} tok/s`;
  }
  const meta = BENCHMARKS[key] || BENCHMARKS.intelligenceIndex;
  const num = key === "gdpval" ? Math.round(val) : val.toFixed(1);
  return `${num}${meta.unit}`;
}

function fmtThreshold(val, key) {
  if (key === "contextWindow") {
    return val >= 1000 ? `${(val / 1000).toFixed(val % 1000 === 0 ? 0 : 1)}M` : `${val}K`;
  }
  const meta = BENCHMARKS[key] || BENCHMARKS.intelligenceIndex;
  return `${val}${meta.unit}`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanPlan(r) {
  return r.isApi ? "Pay-as-you-go API" : r.plan.replace(/\s*\(9\/14\+\)/, "");
}

function fmtFee(n) {
  return n >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString("en-US") : n.toFixed(2);
}

// Billing period: fee per month and the subsidy factor for one entry (scripts/billing-periods.mjs).
// subsidyMultiple is per $ of priceUsd, so subsidy at a fee = subsidyMultiple × priceUsd ÷ fee.
const parseBillingParam = (v) => (v === "yearly" ? "yearly" : "monthly");
function billingView(e, billing) {
  const base = e.priceUsd;
  if (e.billing !== "subscription" || !(base > 0)) return { fee: base, scale: 1, hidden: false, yearly: false, mark: "" };
  const monthly = e.priceUsdMonthly ?? base;
  if (billing !== "yearly") return { fee: monthly, scale: base / monthly, hidden: e.billingOnly === "yearly", yearly: false, mark: "" };
  const y = e.priceUsdYearly;
  if (y > 0) return { fee: y, scale: base / y, hidden: Boolean(e.hideYearly), yearly: true, mark: "" };
  return { fee: monthly, scale: base / monthly, hidden: false, yearly: false, mark: e.billingYearly === "none" ? "no annual" : "annual ?" };
}

function feeText(r) {
  if (r.isApi) return "API";
  if (r.priceUsd == null || !Number.isFinite(r.priceUsd)) return "—";
  if (r.feeYearly) return `$${fmtFee(r.priceUsd * 12)}/yr`;
  return `$${fmtFee(r.priceUsd)}/mo${r.feeMark ? ` (${r.feeMark})` : ""}`;
}

// Bundled credits outside the quota (scripts/included-credits.mjs): shown, never counted in the subsidy.
const creditItemText = (c) => (c.usdPerMonth > 0 ? `+$${fmtFee(c.usdPerMonth)}/mo ${c.kind}` : `+${c.kind}`);
function creditsText(r) {
  const list = r.isApi ? [] : r.includedCredits || [];
  if (!list.length) return "";
  const rest = list.length - 1;
  return `${creditItemText(list[0])}${rest ? ` and ${rest} other bundled ${rest === 1 ? "extra" : "extras"}` : ""} (not counted)`;
}
// Every bundled item, one per line (tooltips)
const creditsFullText = (r) => (r.isApi ? [] : r.includedCredits || []).map(creditItemText).join("\n");
const creditsDiv = (r) => {
  const t = creditsText(r);
  return t ? `<div class="plan credits-note" title="${esc(creditsFullText(r))}">${esc(t)}</div>` : "";
};

function getPlanAccessMeta(r) {
  if (r.billing === "metered" || r.isApi) {
    return { openEndpoint: true, harness: r.harness || "Any API / CLI", quotaWindows: ["payg"], quotaWindowLabel: "Pay-as-you-go" };
  }
  return {
    openEndpoint: Boolean(r.openEndpoint),
    harness: r.harness || "First-party app",
    quotaWindows: Array.isArray(r.quotaWindows) ? r.quotaWindows : [],
    quotaWindowLabel: r.quotaWindowLabel || "",
  };
}

function passesAccessAndWindow(r) {
  if (state.accessFilter === "open" && !r.openEndpoint) return false;
  if (state.accessFilter === "locked" && r.openEndpoint) return false;
  const w = r.quotaWindows || [];
  if (state.no5h && !r.isApi && (w.includes("5h") || w.includes("daily"))) return false;
  if (state.noWeekly && !r.isApi && (w.includes("weekly") || w.includes("7d"))) return false;
  return true;
}

function getScore(entry, benchKey) {
  if (benchKey === "contextWindow") {
    return entry.contextWindowTokens > 0 ? entry.contextWindowTokens / 1000 : null;
  }
  if (benchKey === "outputSpeed") {
    return entry.aaSpeed?.outputTokPerSec > 0 ? entry.aaSpeed.outputTokPerSec : null;
  }
  if (benchKey === "codingAgentIndex") {
    return entry.codingAgent?.index ?? null;
  }
  if (benchKey === "cursorBench") {
    return entry.cursorBench?.score ?? null;
  }
  const b = entry.benchmarks;
  if (b && b[benchKey] != null) return b[benchKey];
  if (benchKey === "intelligenceIndex") return entry.intelligenceIndex;
  return null;
}

function renderLink(text, url) {
  const safe = esc(text);
  if (!url) return safe;
  return `<a class="row-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
}

// "~" prefix on a derived (not measured) cell value
const tilde = (on) => (on ? "~" : "");

function fmtUsdShort(n) {
  return fmtUsd(n).replace(/^\$/, "");
}

// Real cost cell value: point, or the 80% band in Range mode (High rows stay a point).
function realCostText(r, cost = r.effectiveCost, lo = r.relLo, hi = r.relHi) {
  if (state.costView === "range" && r.level !== "high" && Number.isFinite(lo) && Number.isFinite(hi) && cost > 0) {
    return `${fmtUsd(lo)}–${fmtUsdShort(hi)}`;
  }
  // Costs carry no "~": every real cost is approximate and the trust mark says how much.
  return fmtUsd(cost);
}

// Source lines behind a row's subsidy: cap reading, token-mix factor, then the chain's own lines.
function subsidySources(r) {
  const chain = state.dataset?.stats?.chains?.[r.rel?.chain];
  const sub = [];
  const mix = r.quotaMix?.[state.costMode];
  if (state.fableCap === "own" && r.subsidyReadings) sub.push(`Fable-only use: counts Fable's half of the weekly limit; the other half is for other Claude models`);
  // Shown only when applied; when not applied its uncertainty is already in the range.
  if (mix) sub.push(`Adjusted ×${mix.f.toFixed(2)} for how Claude's limit counts cached tokens (${mix.lo.toFixed(2)}–${mix.hi.toFixed(2)})`);
  const client = r.clientFactor?.[state.costMode];
  if (client) sub.push(`Adjusted ÷${(1 / client.f).toFixed(1)}: T3 Code's SDK client uses the limit faster (${(1 / client.hi).toFixed(1)}–${(1 / client.lo).toFixed(1)})`);
  sub.push(...(chain?.lines || []).map(plainSource));
  return sub;
}

const subsidyText = (r) => (r.isApi ? "1×" : r.unmetered ? "∞" : fmtMult(r.subsidy));

function relTooltip(r) {
  const rl = r.rel || {};
  const pad = (s) => s.padEnd(9, " ");
  const lines = [`${LEVEL_LABEL[r.level]} confidence`];
  if (Number.isFinite(r.relLo) && Number.isFinite(r.relHi)) {
    lines.push(`Real cost is likely ${fmtUsd(r.relLo)} to ${fmtUsd(r.relHi)} (80% chance)`, "");
  }
  const sub = subsidySources(r);
  const subVal = subsidyText(r);
  lines.push(`${pad("Subsidy")}${subVal}  ${sub[0] || ""}`);
  for (const l of sub.slice(1)) lines.push(`${pad("")}${l}`);
  lines.push(`${pad("Cost")}${fmtUsd(r.apiMetric)}  ${rl.cl?.[state.costMode] || ""}`);
  if (r.scorePts > 0) lines.push(`${pad("Score")}~${fmtScore(r.score, state.benchKey)}  ±${r.scorePts.toFixed(1)} pts`);
  const items = (r.isApi ? [] : r.includedCredits || []).map(creditItemText);
  if (items.length) {
    lines.push(`${pad("Bundled")}${items[0]}`);
    for (const t of items.slice(1)) lines.push(`${pad("")}${t}`);
    lines.push(`${pad("")}(not counted in the subsidy)`);
  }
  return lines.join("\n");
}

// Reliability tooltip on the whole model name, not only the glyph
const relTitle = (r) => (r.level ? ` title="${esc(relTooltip(r))}"` : "");

// One graded glyph per row, after the model name
const SUB_DERIVED_TIP = "Subsidy worked out from a related plan or model, not measured on this plan";
function relGlyph(r) {
  if (!r.level) return "";
  const dagger = r.subDerived ? `<span class="sub-derived" title="${SUB_DERIVED_TIP}">†</span>` : "";
  return `<span class="tier-glyph rel-glyph rel-${r.level}" title="${esc(relTooltip(r))}">${LEVEL_GLYPH[r.level]}</span>${dagger}`;
}

// Escape, then wrap level glyphs so they render in a symbol font
function glyphHtml(text) {
  return esc(text).replace(/[●◐○◌]/g, (g) => `<span class="tier-glyph">${g}</span>`);
}

const passesConf = (r, min = state.minConf) => LEVEL_RANK[r.level] <= LEVEL_RANK[min];
const isFaded = (r) => r.level === "low" || r.level === "speculative";
const stricterLevel = (a, b) => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);

function isLegacyEntry(r) {
  if (typeof r.isLegacy === "boolean") return r.isLegacy;
  return /\blegacy\b|existing subscribers|老客/i.test(`${r.plan || ""} ${r.planLocal || ""}`);
}

function isOffPeakEntry(r) {
  if (typeof r.isOffPeak === "boolean") return r.isOffPeak;
  return /\boff-?peak\b|\bnight\b|闲时/i.test(`${r.plan || ""} ${r.planLocal || ""}`);
}

function isCnPortalEntry(r) {
  if (typeof r.isCnPortal === "boolean") return r.isCnPortal;
  const combined = `${r.plan || ""} ${r.planLocal || ""}`;
  return (
    /¥|\(CN\b|阿里云|闲时|忙时|中间值|老客|新客|^tencent token plan\b/i.test(combined) ||
    (/^minimax token plan\b/i.test(r.plan || "") && !/global/i.test(combined))
  );
}

function passesExtraCriteria(entry) {
  for (const c of state.extraCriteria) {
    const val = getScore(entry, c.benchKey);
    if (val == null || val < c.minScore) return false;
  }
  return true;
}

function passesModelSpecs(entry) {
  if (state.openWeightsOnly && !entry.isOpenWeights) return false;
  return true;
}

const EFFORT_ORDER = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, default: 6 };
const NAMED_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_COL_TITLE = {
  none: "Non-reasoning",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  default: "Default",
};

function passesEffortBounds(entry) {
  if (state.minEffort === "any" && state.maxEffort === "any") return true;
  const eff = entry.effort || "default";
  if (!NAMED_EFFORTS.has(eff)) return false;
  const rank = EFFORT_ORDER[eff];
  if (state.minEffort !== "any" && rank < EFFORT_ORDER[state.minEffort]) return false;
  if (state.maxEffort !== "any" && rank > EFFORT_ORDER[state.maxEffort]) return false;
  return true;
}

function getAllEntriesResolved() {
  if (!state.dataset) return [];
  const raw = state.dataset.entries || [];
  const replaced = new Set();
  for (const e of raw) {
    if (e.isPreliminary && e.replacesId) replaced.add(e.replacesId);
  }
  const mode = state.costMode;
  const benchAgent = state.benchKey === "codingAgentIndex";
  const agentInvolved = benchAgent || mode === "agent";

  const NO_SCORE_ERR = new Set(["cursorBench", "contextWindow", "outputSpeed"]);
  return raw
    .filter((e) => !replaced.has(e.id))
    .map((e) => {
      const isApi = e.billing === "metered";
      const bill = billingView(e, state.billing);
      const reading = (state.fableCap === "own" && e.subsidyReadings ? e.subsidyReadings.own : e.subsidyMultiple) * bill.scale;
      // Per-metric subsidy factors: Claude token mix; Agent SDK client weighting (T3 turn).
      const mixF = (m) => (e.quotaMix?.[m]?.f ?? 1) * (e.clientFactor?.[m]?.f ?? 1);
      const subFor = (m) => (isApi ? 1 : e.unmetered ? Infinity : reading * mixF(m));
      const subsidy = subFor(mode);
      const accessMeta = getPlanAccessMeta(e);
      const score = getScore(e, state.benchKey);
      const unmeteredFree = Boolean(e.unmetered);
      const real = (v, m = mode) => (v == null ? null : unmeteredFree ? 0 : v / (subFor(m) || 1));

      const p = e.aaPricing || {};
      const apiMtok = p.blended3to1Per1M ?? p.blended7to2to1Per1M ?? e.listBlendedUsdPerMtok ?? null;
      const subTok = subFor("tokens");
      const realMtok = unmeteredFree
        ? 0
        : apiMtok != null && subTok > 0
          ? apiMtok / subTok
          : e.realUsdPerMtok ?? null;

      const API_COST = {
        task: e.aaCostPerTaskUsd ?? null,
        agent: e.codingAgent?.costPerTaskUsd ?? null,
        cursor: e.cursorBench?.costPerTaskUsd ?? null,
        turn: e.t3Turn?.costPerTurnUsd ?? null,
        tokens: apiMtok,
      };
      const apiMetric = API_COST[mode] ?? null;
      const effectiveCost = mode === "tokens" ? realMtok : real(apiMetric);
      const realTaskCost = real(API_COST.task, "task");

      // Reliability: σ of ln real cost = subsidy chain ⊕ token mix ⊕ cost metric; level also bounded by the score error.
      const rl = e.rel || {};
      const sigma = qsum(rl.s, rl.w?.[mode], rl.c?.[mode], rl.x?.[mode], bill.yearly ? rl.y : 0);
      const scorePts = benchAgent ? rl.score?.agent ?? 0 : NO_SCORE_ERR.has(state.benchKey) ? 0 : rl.score?.ii ?? 0;
      const level = e.rel ? worseLevel(levelFromSigma(sigma), levelFromScore(scorePts), rl.cap) : "speculative";
      const costDerived = Boolean(rl.ce?.includes(mode));
      const subDerived = Boolean(rl.sd);
      const relLo = effectiveCost > 0 ? effectiveCost * Math.exp(-Z80 * sigma) : null;
      const relHi = effectiveCost > 0 ? effectiveCost * Math.exp(Z80 * sigma) : null;

      // Volume uses the model's share of the pool (Fable: half the weekly limit) in both readings.
      const capShare = state.fableCap === "own" ? 1 : e.capShare ?? 1;
      const volumePerMonth =
        !isApi && bill.fee && !e.unmetered && effectiveCost != null && effectiveCost > 0
          ? (bill.fee / effectiveCost) * capShare
          : null;
      // T3 turn mode: hours of agent time the quota buys (turns/mo × minutes per turn)
      const minPerTurn = e.t3Turn?.minutesPerTurn;
      const hoursPerMonth =
        mode === "turn" && minPerTurn > 0
          ? e.unmetered
            ? Infinity
            : volumePerMonth != null
              ? (volumePerMonth * minPerTurn) / 60
              : null
          : null;

      return {
        ...e,
        ...accessMeta,
        level,
        sigma,
        scorePts,
        relLo,
        relHi,
        scoreDerived: scorePts > 0,
        subDerived,
        costDerived,
        costDerivedReal: costDerived || subDerived,
        altDerived: (mode === "tokens" ? Boolean(rl.ce?.includes("task")) : false) || subDerived,
        ...(agentInvolved ? { harness: e.codingAgent?.agent ?? accessMeta.harness ?? e.harness } : {}),
        isApi,
        priceUsd: isApi ? e.priceUsd : bill.fee,
        feeYearly: bill.yearly,
        feeMark: bill.mark,
        billingHidden: bill.hidden,
        score,
        subsidy,
        apiMetric,
        effectiveCost,
        realTaskCost,
        realMtok,
        tasksPerMonth: volumePerMonth,
        hoursPerMonth,
      };
    });
}

function getFilteredRows(allResolved, minConf = state.minConf) {
  const maxBudget = BUDGET_STOPS[state.budgetIdx].max;
  const maxCost = currentCostStops()[state.maxCostIdx].max;

  const out = [];
  for (const r of allResolved) {
    if (r.score == null || (state.rankMode !== "top" && r.score < state.minScore)) continue;
    if (!passesExtraCriteria(r)) continue;
    if (!passesModelSpecs(r)) continue;
    if (!passesEffortBounds(r)) continue;
    if (!passesAccessAndWindow(r)) continue;
    if (r.effectiveCost == null || !Number.isFinite(r.effectiveCost)) continue;
    if (r.isApi && !state.showApi) continue;
    if (r.billingHidden) continue;
    if (!r.isApi && state.hideLegacy && isLegacyEntry(r)) continue;
    if (!r.isApi && state.hideOffPeak && isOffPeakEntry(r)) continue;
    if (!r.isApi && state.hideCnPortal && isCnPortalEntry(r)) continue;
    if (!passesConf(r, minConf)) continue;
    if (!r.isApi && Number.isFinite(maxBudget) && (r.priceUsd == null || r.priceUsd > maxBudget + 0.5)) {
      continue;
    }
    if (Number.isFinite(maxCost) && r.effectiveCost > maxCost) continue;
    out.push(r);
  }
  return state.rankMode === "top" ? pickTopModels(out, state.topN) : out;
}

// Top-N mode: rank base models by their best score among the rows that passed every other
// filter, keep the N best, and keep only each one's highest-scoring reasoning level.
function pickTopModels(rows, n) {
  const best = new Map();
  for (const r of rows) {
    const key = r.baseModelId || r.modelId;
    if (!best.has(key) || r.score > best.get(key)) best.set(key, r.score);
  }
  const keep = new Set([...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k));
  return rows.filter((r) => {
    const key = r.baseModelId || r.modelId;
    return keep.has(key) && r.score === best.get(key);
  });
}

function renderPlanDrawer(planName, allResolved) {
  const maxCost = currentCostStops()[state.maxCostIdx].max;
  const planEntries = allResolved.filter(
    (e) =>
      !e.isApi &&
      cleanPlan(e) === planName &&
      e.effectiveCost != null &&
      passesConf(e)
  );

  // Collect effort columns actually present in this plan, ordered low -> max
  const effortSet = new Set();
  const byModel = new Map();
  for (const e of planEntries) {
    const eff = e.effort || "default";
    effortSet.add(eff);
    const key = e.baseModelId || e.modelId;
    if (!byModel.has(key)) {
      const baseName = String(e.modelDisplay || key).replace(
        /\s*\((?:max|xhigh|high|medium|low|non-reasoning)\)\s*$/i,
        ""
      );
      byModel.set(key, { baseName, aaUrl: e.aaUrl, byEffort: new Map(), maxScore: -1 });
    }
    const m = byModel.get(key);
    m.byEffort.set(eff, e);
    const s = e.score ?? e.intelligenceIndex ?? 0;
    if (s > m.maxScore) m.maxScore = s;
  }

  const efforts = [...effortSet].sort((a, b) => (EFFORT_ORDER[a] ?? 9) - (EFFORT_ORDER[b] ?? 9));
  const models = [...byModel.values()].sort((a, b) => b.maxScore - a.maxScore);

  const headCols = efforts
    .map((eff) => `<th class="num-col">${esc(EFFORT_COL_TITLE[eff] || eff)}</th>`)
    .join("");

  const bodyRows = models
    .map((m) => {
      const cells = efforts
        .map((eff) => {
          const e = m.byEffort.get(eff);
          if (!e) return `<td class="pm-cell empty-cell">—</td>`;
          const passes =
            e.score != null &&
            e.score >= state.minScore &&
            passesExtraCriteria(e) &&
            passesModelSpecs(e) &&
            passesEffortBounds(e) &&
            (!Number.isFinite(maxCost) || e.effectiveCost <= maxCost);
          const scoreStr =
            e.score != null
              ? fmtScore(e.score, activeScoreKey())
              : e.intelligenceIndex != null && state.benchKey !== "codingAgentIndex"
                ? `II ${e.intelligenceIndex.toFixed(1)}`
                : "—";
          return `<td class="pm-cell${passes ? "" : " dim"}${isFaded(e) ? " is-extrapolated" : ""}"><span class="pm-cost">${realCostText(e)}${relGlyph(e)}</span><span class="pm-score">${tilde(e.scoreDerived)}${esc(scoreStr)}</span></td>`;
        })
        .join("");

      return `
        <tr>
          <td class="pm-model">${renderLink(m.baseName, m.aaUrl)}</td>
          ${cells}
        </tr>
      `;
    })
    .join("");

  return `
    <div class="plan-drawer">
      <div class="plan-matrix-wrap">
        <table class="plan-matrix">
          <thead>
            <tr>
              <th>Model</th>
              ${headCols}
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      ${renderProvenance(planEntries, models)}
    </div>
  `;
}

// Pipeline shorthand → plain words (drawer and tooltips)
function plainSource(line) {
  const pre = /^([^:]{2,60}): (.+)$/.exec(String(line));
  if (pre && !/^(Fei|Priors)$/.test(pre[1])) return `${pre[1]}: ${plainSource(pre[2])}`;
  let t = String(line);
  const pp = (x) => x.replace(/(\d+(?:\.\d+)?) pp\b/g, "$1% of the limit");
  t = t.replace(/^= (.+?) \(same pool, rate card\)$/, "estimated from $1 (same quota, priced by rate card)")
    .replace(/^= (.+?) \(same pool\)$/, "estimated from $1 (same quota)")
    .replace(/^= (.+?) \(assumed equal\)$/, "assumed the same as $1")
    .replace(/^(.+?) × ([\d.]+) \(ruled plan ratio\)$/, "estimated from $1 (×$2, Fei's plan ratio)")
    .replace(/^(.+?) × ([\d.]+) \(official plan ratio\)$/, "estimated from $1 (×$2, official plan ratio)")
    .replace(/^(.+?) × ([\d.]+) \(shared \$ pool\)$/, "estimated from $1 (×$2, shared dollar pool)")
    .replace(/^(.+?) × ([\d.]+) \(token pool\)$/, "estimated from $1 (×$2, same token pool)")
    .replace(/^(.+?) ÷ ([\d.]+) \(Fable\/Opus, Pro \+ Ultra\)$/, "estimated from $1 (÷$2: Fable uses the limit about 2.5× faster)")
    .replace(/^Fable only ÷ 0\.5 \(50% cap\)$/, "Fable-only use: counts Fable's half of the weekly limit; the other half is for other Claude models")
    .replace(/^pooled ([\d.]+)× Fei \+ ([\d.]+)× Priors$/, "average of Fei ($1×) and Priors ($2×)")
    .replace(/^inconsistent ×([\d.]+) \((.+?) vs (.+?), same pool\)$/, "disagrees ×$1 with other plans ($2 vs $3)")
    .replace(/^derived \(official plan ratio\)$/, "estimated from a sibling plan (official plan ratio)")
    .replace(/^(.+?) tokens × 1 \(price ratio\)$/, "same quota as $1")
    .replace(/^(.+?) tokens × ([\d.]+) \(price ratio\)$/, (_, m, r) => {
      const x = Number(r);
      return x >= 1
        ? `same quota as ${m}: ${r}× the tokens, since each costs 1/${r} as much`
        : `same quota as ${m}: ${r}× the tokens, since each costs ${Number((1 / x).toFixed(2))}× as much`;
    })
    .replace(/^(.+?) × ([\d.]+)$/, "estimated from $1 (×$2)");
  t = t.replace(/Priors: Priors, /g, "Priors dataset, ").replace(/\bPriors (high|medium|low)\b/g, "Priors dataset ($1)").replace(/\bPriors, /g, "Priors dataset, ")
    .replace(/\b1 screenshot\b/g, "one user's screenshot").replace(/\bscreenshot\b(?!s)/g, "screenshot").replace(/\btweet\b/g, "a tweet")
    .replace(/\bgateway panel\b/g, "third-party gateway's usage panel").replace(/^official credits$/, "official credit amount")
    .replace(/^list price$/, "API list price").replace(/^official, /, "official figure, ");
  return pp(t);
}

// One line per source in the plan's subsidy chains: models · subsidy · source (as in the glyph tooltip).
function renderProvenance(planEntries, models) {
  const order = new Map(models.map((m, i) => [m.baseName, i]));
  const groups = new Map();
  for (const e of planEntries) {
    const val = subsidyText(e);
    const sources = subsidySources(e);
    const key = `${e.rel?.chain}|${val}|${sources.join("|")}`;
    const baseName = String(e.modelDisplay || e.baseModelId).replace(/\s*\((?:max|xhigh|high|medium|low|non-reasoning)\)\s*$/i, "");
    if (!groups.has(key)) groups.set(key, { val, sources, names: new Set(), rank: Infinity });
    const g = groups.get(key);
    g.names.add(baseName);
    g.rank = Math.min(g.rank, order.get(baseName) ?? Infinity);
  }
  if (!groups.size) return "";
  // Source page and check date; the page's own wording is on hover (it can be a raw table cell).
  const creditSrc = (c) => {
    let host = "";
    try { host = new URL(c.url).hostname.replace(/^www\./, ""); } catch {}
    const s = esc(host || "source");
    return c.url ? `<a class="row-link" href="${esc(c.url)}" title="${esc(c.text || "")}" target="_blank" rel="noopener noreferrer">${s}</a>` : s;
  };
  // Split a trailing ", YYYY-MM-DD" into its own column
  const splitDate = (t) => {
    const m = /^(.*?),?\s*(\d{4}-\d{2}-\d{2})$/.exec(String(t));
    return m ? [m[1], m[2]] : [String(t), ""];
  };
  const rows = [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((g, gi) => {
      const src = g.sources.length ? g.sources : ["—"];
      const zebra = gi % 2 ? " prov-alt" : "";
      return src
        .map((raw, i) => {
          const [text, date] = splitDate(plainSource(raw));
          return i === 0
            ? `<tr class="prov-row${zebra}"><td class="prov-model">${esc([...g.names].join(", "))}</td><td class="prov-num">${esc(g.val)}</td><td class="prov-src">${esc(text)}${date ? `<span class="prov-date-inline">${esc(date)}</span>` : ""}</td><td class="prov-date">${esc(date)}</td></tr>`
            : `<tr class="prov-row prov-step${zebra}"><td class="prov-model"></td><td class="prov-num"></td><td class="prov-src"><span class="prov-arrow">↳</span>${esc(text)}${date ? `<span class="prov-date-inline">${esc(date)}</span>` : ""}</td><td class="prov-date">${esc(date)}</td></tr>`;
        })
        .join("");
    })
    .join("");
  const credits = planEntries[0].includedCredits || [];
  const creditRows = credits.length
    ? `<tr><th colspan="4" class="prov-sub">Bundled extras, not counted in the subsidy</th></tr>` +
      credits
        .map(
          (c, i) =>
            `<tr class="prov-row${i % 2 ? " prov-alt" : ""}"><td class="prov-model" colspan="2">${esc(creditItemText(c).replace(/^\+/, ""))}</td><td class="prov-src">${creditSrc(c)}${c.checked ? `<span class="prov-date-inline">${esc(c.checked)}</span>` : ""}</td><td class="prov-date">${esc(c.checked || "")}</td></tr>`
        )
        .join("")
    : "";
  return `<details class="prov-details"><summary>Where the subsidy numbers come from</summary><table class="prov-table" aria-label="Subsidy sources">
    <thead><tr><th>Model</th><th class="prov-num">Subsidy</th><th>Source</th><th>Data date</th></tr></thead>
    <tbody>${rows}${creditRows}</tbody>
  </table></details>`;
}

// The bars the chart shows for a set of rows: deduplicated by the cheapest-plan / cheapest-effort toggles, cheapest first.
function chartBars(rows) {
  // Deduplicate bar chart according to cheapestPlanOnly & cheapestEffortOnly toggles:
  // - both checked (default): 1 bar per base model (cheapest plan + cheapest qualifying effort)
  // - cheapestPlanOnly only:  1 bar per (model, effort) variant (cheapest plan for each effort)
  // - cheapestEffortOnly only: 1 bar per (plan, base model) (every plan, at its cheapest qualifying effort)
  // - neither checked:        every qualifying (plan, model, effort) bar
  let bars;
  if (!state.cheapestPlanOnly && !state.cheapestEffortOnly) {
    bars = [...rows];
  } else {
    const bestByKey = new Map();
    for (const r of rows) {
      const modelPart = state.cheapestEffortOnly ? (r.baseModelId || r.modelId) : r.modelId;
      const planPart = state.cheapestPlanOnly ? "" : `${r.isApi ? "__api__" : r.plan}::`;
      const groupKey = `${planPart}${modelPart}`;
      const prev = bestByKey.get(groupKey);
      const isBetter =
        !prev ||
        r.effectiveCost < prev.effectiveCost - 1e-9 ||
        (Math.abs(r.effectiveCost - prev.effectiveCost) <= 1e-9 && (r.score ?? 0) > (prev.score ?? 0));
      if (isBetter) {
        bestByKey.set(groupKey, r);
      }
    }
    bars = [...bestByKey.values()];
  }

  bars.sort((a, b) => a.effectiveCost - b.effectiveCost || (b.score ?? 0) - (a.score ?? 0));
  return bars;
}

function renderBarChart(allRows, allResolved) {
  const host = $("barChart");
  const bars = chartBars(allRows.filter((r) => passesConf(r, state.minConf)));

  if (!bars.length) {
    host.innerHTML = `<div class="empty">No plans match these limits.</div>`;
    return;
  }

  const maxCost = Math.max(...bars.map((b) => b.effectiveCost), 0.01);
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const benchMeta = activeBenchMeta();
  const scoreKey = activeScoreKey();

  host.innerHTML = bars
    .map((r) => {
      const widthPct = Math.max(1.2, (r.effectiveCost / maxCost) * 68);
      const barColor =
        isDark && (r.color === "#1F2937" || r.color === "#1f1f1f" || r.color === "#334155")
          ? "#8fa3b8"
          : r.color || "#3a6ea5";

      const planName = cleanPlan(r);
      const credits = creditsText(r);
      // Inside a popup nothing can be hovered further, so bundled items are listed in full here.
      const creditItems = creditsFullText(r);
      const planText = [planName, r.isApi ? null : feeText(r), r.harness, r.quotaWindowLabel].filter(Boolean).join(" · ") +
        (creditItems ? `\nBundled (not counted in the subsidy):\n${creditItems}` : "");
      const planHtml = renderLink(planName, r.planUrl);
      const note = `${benchMeta.label} ${fmtScore(r.score, scoreKey)}`;
      const expKey = `${r.id}`;
      const isExpanded = !r.isApi && state.expandedPlans.has(expKey);
      const expBtn = r.isApi
        ? ""
        : `<button class="plan-exp-btn" type="button" data-exp="${esc(expKey)}" title="Show all models on ${esc(planName)}">${isExpanded ? "▾" : "▸"}</button>`;

      const isExtrap = isFaded(r);

      return `
        <div class="bar-row${isExtrap ? " is-extrapolated" : ""}">
          <div class="bar-label">
            <div class="bar-model"${relTitle(r)}>${renderLink(r.modelDisplay, r.aaUrl)}${relGlyph(r)}</div>
            <div class="bar-plan"><span class="plan-text" title="${esc(planText)}">${planHtml}</span>${expBtn}</div>
            <div class="bar-meta">${esc([r.isApi ? null : feeText(r), r.harness, r.quotaWindowLabel].filter(Boolean).join(" · "))}${credits ? `<span class="credits-note" title="${esc(creditsFullText(r))}"> · ${esc(credits)}</span>` : ""}</div>
          </div>
          <div class="bar-track-wrap">
            <span class="bar-fill${isExtrap ? " is-extrapolated" : ""}" style="width:${widthPct.toFixed(2)}%; --bar-ratio:${(r.effectiveCost / maxCost).toFixed(4)}; background-color:${barColor}"></span>
            <span class="bar-val">${realCostText(r)}</span>
            <span class="bar-note">${r.scoreDerived ? `${esc(benchMeta.label)} ~${esc(fmtScore(r.score, scoreKey))}` : esc(note)}</span>
          </div>
          ${isExpanded ? renderPlanDrawer(planName, allResolved) : ""}
        </div>
      `;
    })
    .join("");

  host.querySelectorAll(".plan-exp-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.exp;
      if (state.expandedPlans.has(key)) state.expandedPlans.delete(key);
      else state.expandedPlans.add(key);
      render();
    });
  });
}

const DESC_SORT_KEYS = new Set(["score", "subsidy", "tasksPerMonth", "hoursPerMonth", "context", "speed"]);
const TABLE_PAGE = 50;
const phoneMq = window.matchMedia("(max-width: 600px)");

function setSort(key, dir) {
  if (dir) {
    state.sortDir = dir;
  } else if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortDir = DESC_SORT_KEYS.has(key) || key.startsWith("extra:") ? "desc" : "asc";
  }
  state.sortKey = key;
  state.tableLimit = TABLE_PAGE;
  render();
}

const fmtHours = (h) =>
  h === Infinity ? "∞" : !Number.isFinite(h) ? "—" : h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString();

function renderTable(rows) {
  const q = state.tableQuery.trim().toLowerCase();
  const visible = q
    ? rows.filter((r) =>
        `${r.modelDisplay} ${cleanPlan(r)} ${r.vendor || ""} ${r.harness || ""} ${r.quotaWindowLabel || ""}`
          .toLowerCase()
          .includes(q)
      )
    : rows;

  const benchMeta = activeBenchMeta();
  const scoreKey = activeScoreKey();
  const isTokens = state.costMode === "tokens";
  const isTurn = state.costMode === "turn";
  const modeMeta = COST_MODES[state.costMode] || COST_MODES.task;
  const unit = modeMeta.unit;
  const volLabel = modeMeta.vol;

  const cols = [
    { key: "model", label: state.groupByPlan ? "Plan / Model" : "Model & Plan", cls: "" },
    { key: "score", label: benchMeta.label, cls: "num-col" },
    ...state.extraCriteria.map((c) => ({
      key: `extra:${c.benchKey}`,
      label: (BENCHMARKS[c.benchKey] || BENCHMARKS.intelligenceIndex).label,
      cls: "num-col col-hide-sm",
      benchKey: c.benchKey,
    })),
    { key: "access", label: "Harness / Reset", cls: "col-hide-sm col-hide-md" },
    { key: "fee", label: "Fee", cls: "num-col" },
    { key: "subsidy", label: "Subsidy", cls: "num-col col-hide-sm" },
    { key: "apiCost", label: `API $/${unit}`, cls: "num-col col-hide-sm col-hide-md" },
    { key: "effectiveCost", label: `Real $/${unit}`, cls: "num-col" },
    { key: "altCost", label: isTokens ? "Real $/task" : "Real $/1M", cls: "num-col col-hide-sm" },
    { key: "tasksPerMonth", label: volLabel, cls: "num-col col-hide-sm" },
    ...(isTurn ? [{ key: "hoursPerMonth", label: "Hours/mo", cls: "num-col col-hide-sm" }] : []),
  ];
  const labelOf = Object.fromEntries(cols.map((c) => [c.key, c.label]));
  const dl = (key) => ` data-label="${esc(labelOf[key])}"`;

  if (!cols.some((c) => c.key === state.sortKey)) {
    state.sortKey = "effectiveCost";
    state.sortDir = "asc";
  }

  // Mobile Sort select (headers are hidden in card view)
  const sortSel = $("tableSort");
  sortSel.innerHTML = cols.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join("");
  sortSel.value = state.sortKey;
  $("tableSortDir").textContent = state.sortDir === "asc" ? "▲" : "▼";

  const thead = $("tableHead");
  thead.innerHTML = `<tr>${cols
    .map((c) => {
      const active = c.key === state.sortKey ? ` active ${state.sortDir}` : "";
      return `<th data-sort="${esc(c.key)}" class="${c.cls}${active}">${esc(c.label)}</th>`;
    })
    .join("")}</tr>`;

  thead.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => setSort(th.dataset.sort));
  });

  const dir = state.sortDir === "asc" ? 1 : -1;
  const sorted = [...visible].sort((a, b) => {
    if (state.sortKey === "model") {
      return dir * `${a.modelDisplay} ${a.plan}`.localeCompare(`${b.modelDisplay} ${b.plan}`);
    }
    if (state.sortKey === "access") {
      return dir * `${a.quotaWindowLabel} ${a.harness}`.localeCompare(`${b.quotaWindowLabel} ${b.harness}`);
    }
    const val = (r) => {
      if (state.sortKey.startsWith("extra:")) {
        return getScore(r, state.sortKey.slice(6)) ?? -1;
      }
      switch (state.sortKey) {
        case "score": return r.score ?? -1;
        case "context": return r.contextWindowTokens ?? -1;
        case "speed": return r.aaSpeed?.outputTokPerSec ?? -1;
        case "fee": return r.isApi ? 0 : (r.priceUsd ?? 1e9);
        case "subsidy": return Number.isFinite(r.subsidy) ? r.subsidy : 1e9;
        case "apiCost": return r.apiMetric ?? 1e9;
        case "altCost": return altCost(r) ?? 1e9;
        case "tasksPerMonth": return r.unmetered ? 1e12 : r.tasksPerMonth ?? -1;
        case "hoursPerMonth": return Number.isFinite(r.hoursPerMonth) ? r.hoursPerMonth : r.hoursPerMonth === Infinity ? 1e12 : -1;
        default: return r.effectiveCost ?? 1e9;
      }
    };
    return dir * (val(a) - val(b));
  });

  const tbody = $("rows");
  function altCost(r) {
    return isTokens ? r.realTaskCost : r.realMtok;
  }
  const limit = phoneMq.matches ? state.tableLimit : Infinity;
  const setMore = (shown, total) => {
    $("tableMore").hidden = shown >= total;
    $("tableMoreCount").textContent = `${shown.toLocaleString()} / ${total.toLocaleString()}`;
  };
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">No plans match these limits.</td></tr>`;
    setMore(0, 0);
    return;
  }

  const fmtCount = (n, unmetered) => (unmetered ? "∞" : n > 0 ? Math.round(n).toLocaleString() : "—");
  const scoreLabel = (v) => `${benchMeta.label} ${v}`;
  // Phone card line 2 (hidden on wider screens, where fee and score have their own columns)
  const cardSub = (parts) => `<td class="card-sub">${parts.filter(Boolean).map((p) => `<span>${p}</span>`).join("")}</td>`;

  const renderRow = (r, grouped) => {
    const extraCells = state.extraCriteria
      .map((c) => `<td class="num-col col-hide-sm"${dl(`extra:${c.benchKey}`)}>${fmtScore(getScore(r, c.benchKey), c.benchKey)}</td>`)
      .join("");

    const nameCell = grouped
      ? `<div class="model"${relTitle(r)}>${renderLink(r.modelDisplay, r.aaUrl)}${relGlyph(r)}</div>`
      : `<div class="model"${relTitle(r)}>${renderLink(r.modelDisplay, r.aaUrl)}${relGlyph(r)}</div><div class="plan">${renderLink(cleanPlan(r), r.planUrl)}</div>${creditsDiv(r)}`;

    const accessCell = grouped
      ? `<td class="meta-cell col-hide-sm col-hide-md card-empty"${dl("access")}></td>`
      : `<td class="meta-cell col-hide-sm col-hide-md"${dl("access")}><div>${esc(r.harness)}</div><div class="plan">${esc(r.quotaWindowLabel)}</div></td>`;

    const rowCls = [grouped ? "grouped-item" : "", isFaded(r) ? "is-extrapolated" : ""].filter(Boolean).join(" ");
    const scoreText = `${tilde(r.scoreDerived)}${fmtScore(r.score, scoreKey)}`;

    return `
      <tr${rowCls ? ` class="${rowCls}"` : ""}>
        <td class="name-cell"${dl("model")}>${nameCell}</td>
        <td class="num-col score-cell"${dl("score")}>${scoreText}</td>
        ${extraCells}
        ${accessCell}
        <td class="num-col fee-cell"${dl("fee")}>${feeText(r)}</td>
        <td class="num-col col-hide-sm"${dl("subsidy")}>${r.unmetered ? "∞" : fmtMult(r.subsidy)}</td>
        <td class="num-col col-hide-sm col-hide-md"${dl("apiCost")}>${fmtUsd(r.apiMetric)}</td>
        <td class="num-col real-cell"${dl("effectiveCost")}>${realCostText(r)}</td>
        <td class="num-col col-hide-sm"${dl("altCost")}>${fmtUsd(altCost(r))}</td>
        <td class="num-col col-hide-sm"${dl("tasksPerMonth")}>${fmtCount(r.tasksPerMonth, r.unmetered)}</td>
        ${isTurn ? `<td class="num-col col-hide-sm"${dl("hoursPerMonth")}>${fmtHours(r.hoursPerMonth)}</td>` : ""}
        ${cardSub([grouped ? null : esc(cleanPlan(r)), feeText(r), scoreLabel(scoreText)])}
      </tr>
    `;
  };

  if (state.groupByPlan) {
    const groups = new Map();
    for (const r of sorted) {
      const pName = cleanPlan(r);
      if (!groups.has(pName)) groups.set(pName, { sample: r, rows: [] });
      groups.get(pName).rows.push(r);
    }
    const html = [];
    const groupList = [...groups.entries()];
    for (const [pName, g] of groupList.slice(0, limit)) {
      const isOpen = state.expandedTableGroups.has(pName);
      const maxScore = Math.max(...g.rows.map((r) => r.score ?? -Infinity));
      const minCost = Math.min(...g.rows.map((r) => r.effectiveCost ?? Infinity));
      const minAlt = Math.min(...g.rows.map((r) => altCost(r) ?? Infinity));
      const maxTasks = Math.max(...g.rows.map((r) => r.tasksPerMonth ?? -1));
      const hours = g.rows.map((r) => r.hoursPerMonth).filter((h) => h != null);
      const maxHours = hours.length ? Math.max(...hours) : null;
      const hasUnmetered = g.rows.some((r) => r.unmetered);
      const finiteSubs = g.rows.map((r) => r.subsidy).filter((s) => Number.isFinite(s));
      let subText = hasUnmetered ? "∞" : "—";
      if (!hasUnmetered && finiteSubs.length) {
        const lo = Math.min(...finiteSubs);
        const hi = Math.max(...finiteSubs);
        subText = Math.abs(hi - lo) < 0.05 ? fmtMult(hi) : `${fmtMult(lo)}–${fmtMult(hi)}`;
      }
      const extraSummary = state.extraCriteria
        .map((c) => {
          const vals = g.rows.map((r) => getScore(r, c.benchKey)).filter((v) => v != null);
          const bestVal = vals.length ? Math.max(...vals) : null;
          return `<td class="num-col col-hide-sm"${dl(`extra:${c.benchKey}`)}>${fmtScore(bestVal, c.benchKey)}</td>`;
        })
        .join("");

      const groupFeeText = feeText(g.sample);
      const groupScore = fmtScore(Number.isFinite(maxScore) ? maxScore : null, scoreKey);

      html.push(`
        <tr class="group-row" data-group="${esc(pName)}">
          <td class="name-cell"${dl("model")}><span class="group-caret">${isOpen ? "▾" : "▸"}</span>${renderLink(pName, g.sample.planUrl)}${creditsDiv(g.sample)}</td>
          <td class="num-col score-cell"${dl("score")}>${groupScore}</td>
          ${extraSummary}
          <td class="meta-cell col-hide-sm col-hide-md"${dl("access")}>${esc(g.sample.harness)} · ${esc(g.sample.quotaWindowLabel)}</td>
          <td class="num-col fee-cell"${dl("fee")}>${groupFeeText}</td>
          <td class="num-col col-hide-sm"${dl("subsidy")}>${subText}</td>
          <td class="num-col col-hide-sm col-hide-md card-empty"${dl("apiCost")}>—</td>
          <td class="num-col real-cell"${dl("effectiveCost")}>${fmtUsd(Number.isFinite(minCost) ? minCost : null)}</td>
          <td class="num-col col-hide-sm"${dl("altCost")}>${fmtUsd(Number.isFinite(minAlt) ? minAlt : null)}</td>
          <td class="num-col col-hide-sm"${dl("tasksPerMonth")}>${fmtCount(maxTasks, hasUnmetered)}</td>
          ${isTurn ? `<td class="num-col col-hide-sm"${dl("hoursPerMonth")}>${fmtHours(maxHours)}</td>` : ""}
          ${cardSub([groupFeeText, scoreLabel(groupScore), `${g.rows.length} ${g.rows.length === 1 ? "row" : "rows"}`])}
        </tr>
      `);
      if (isOpen) {
        for (const r of g.rows) html.push(renderRow(r, true));
      }
    }
    tbody.innerHTML = html.join("");
    setMore(Math.min(limit, groupList.length), groupList.length);

    tbody.querySelectorAll("tr.group-row").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        const name = tr.dataset.group;
        if (state.expandedTableGroups.has(name)) state.expandedTableGroups.delete(name);
        else state.expandedTableGroups.add(name);
        render();
      });
    });
  } else {
    tbody.innerHTML = sorted.slice(0, limit).map((r) => renderRow(r, false)).join("");
    setMore(Math.min(limit, sorted.length), sorted.length);
  }
}

function syncBenchSlider(resetDefault = false) {
  const meta = activeBenchMeta();
  const slider = $("minScore");
  $("rankMode").value = state.rankMode;
  if (state.rankMode === "top") {
    if (resetDefault) state.minScore = meta.def;
    slider.min = "1";
    slider.max = String(TOP_N_MAX);
    slider.step = "1";
    slider.value = String(state.topN);
    return;
  }
  slider.min = String(meta.min);
  slider.max = String(meta.max);
  slider.step = String(meta.step);
  if (resetDefault) {
    state.minScore = meta.def;
  } else {
    state.minScore = Math.max(meta.min, Math.min(meta.max, state.minScore));
  }
  slider.value = String(state.minScore);
}

function updateSettingsBadge() {}

const DEFAULT_EXTRA_ORDER = [
  "frontierCode20",
  "contextWindow",
  "outputSpeed",
  "engineering",
  "terminalBench40",
  "hle",
  "lcr",
  ...Object.keys(BENCHMARKS),
];

function nextUnusedBenchKey() {
  const used = new Set([state.benchKey, ...state.extraCriteria.map((c) => c.benchKey)]);
  return DEFAULT_EXTRA_ORDER.find((k) => !used.has(k)) || "frontierCode20";
}

function renderExtraCriteria() {
  const barHost = $("extraCriteria");
  const listHost = $("settingsCriteriaList");
  const selectOptionsHtml = $("benchSelect").innerHTML;

  if (!state.extraCriteria.length) {
    barHost.hidden = true;
    barHost.innerHTML = "";
    listHost.innerHTML = "";
    updateSettingsBadge();
    return;
  }

  barHost.hidden = false;
  barHost.innerHTML = state.extraCriteria
    .map((c, idx) => {
      const meta = BENCHMARKS[c.benchKey] || BENCHMARKS.intelligenceIndex;
      const valText = fmtThreshold(c.minScore, c.benchKey);
      return `
        <div class="extra-criterion">
          <div class="extra-criterion-head">
            <span class="bench-pick">
              <span>Min</span>
              <select class="select" data-crit-select="${idx}" aria-label="Additional minimum metric">${selectOptionsHtml}</select>
            </span>
            <span class="extra-criterion-right">
              <strong class="num" data-crit-out="${idx}">≥ ${esc(valText)}</strong>
              <button class="remove-btn" type="button" data-remove-crit="${idx}" title="Remove filter">×</button>
            </span>
          </div>
          <input type="range" data-crit-slider="${idx}" min="${meta.min}" max="${meta.max}" step="${meta.step}" value="${c.minScore}" aria-label="Minimum ${esc(meta.label)}" />
        </div>
      `;
    })
    .join("");

  listHost.innerHTML = state.extraCriteria
    .map((c, idx) => {
      const valText = fmtThreshold(c.minScore, c.benchKey);
      return `
        <div class="settings-crit-item">
          <span class="bench-pick">
            <span>Min</span>
            <select class="select" data-crit-select="${idx}" aria-label="Additional minimum metric">${selectOptionsHtml}</select>
            <span>≥ <strong class="num" data-crit-list-out="${idx}">${esc(valText)}</strong></span>
          </span>
          <button class="remove-btn" type="button" data-remove-crit="${idx}" title="Remove filter">×</button>
        </div>
      `;
    })
    .join("");

  // Sync each <select> to its current benchKey and bind changes
  const bindSelects = (container) => {
    container.querySelectorAll("select[data-crit-select]").forEach((sel) => {
      const idx = Number(sel.dataset.critSelect);
      const crit = state.extraCriteria[idx];
      if (!crit) return;
      sel.value = crit.benchKey;
      sel.addEventListener("change", () => {
        const nextKey = sel.value;
        if (!BENCHMARKS[nextKey]) return;
        crit.benchKey = nextKey;
        crit.minScore = BENCHMARKS[nextKey].def;
        renderExtraCriteria();
        render();
      });
    });
  };
  bindSelects(barHost);
  bindSelects(listHost);

  barHost.querySelectorAll("input[data-crit-slider]").forEach((slider) => {
    slider.addEventListener("input", () => {
      const idx = Number(slider.dataset.critSlider);
      const crit = state.extraCriteria[idx];
      if (!crit) return;
      crit.minScore = Number(slider.value);
      const text = fmtThreshold(crit.minScore, crit.benchKey);
      const outEl = barHost.querySelector(`[data-crit-out="${idx}"]`);
      if (outEl) outEl.textContent = `≥ ${text}`;
      const listOutEl = listHost.querySelector(`[data-crit-list-out="${idx}"]`);
      if (listOutEl) listOutEl.textContent = text;
      render();
    });
  });

  const bindRemove = (container) => {
    container.querySelectorAll("[data-remove-crit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.removeCrit);
        state.extraCriteria.splice(idx, 1);
        renderExtraCriteria();
        render();
      });
    });
  };
  bindRemove(barHost);
  bindRemove(listHost);
  updateSettingsBadge();
}

function stopIdxFromParam(raw, stops, defaultIdx) {
  if (raw == null || raw === "") return defaultIdx;
  if (String(raw).toLowerCase() === "any") return stops.length - 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultIdx;
  const exact = stops.findIndex((s) => Number.isFinite(s.max) && Math.abs(s.max - n) < 1e-6);
  if (exact !== -1) return exact;
  const next = stops.findIndex((s) => s.max >= n);
  return next !== -1 ? next : stops.length - 1;
}

function loadStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const bench = params.get("bench");
  if (bench && BENCHMARKS[bench]) {
    state.benchKey = bench;
    state.minScore = BENCHMARKS[bench].def;
  }

  const meta = activeBenchMeta();
  const minRaw = params.get("min");
  if (minRaw !== null && minRaw !== "") {
    const n = Number(minRaw);
    if (Number.isFinite(n)) {
      state.minScore = Math.max(meta.min, Math.min(meta.max, n));
    }
  }

  const topRaw = params.get("top");
  if (topRaw !== null && topRaw !== "") {
    const n = Math.round(Number(topRaw));
    if (Number.isFinite(n) && n >= 1) {
      state.rankMode = "top";
      state.topN = Math.min(TOP_N_MAX, n);
    }
  }

  const modeRaw = params.get("mode");
  if (modeRaw && COST_MODES[modeRaw]) {
    state.costMode = modeRaw;
  } else if (state.benchKey === "codingAgentIndex") {
    state.costMode = "agent"; // links from before the cost metric was split from the benchmark
  } else if (state.benchKey === "cursorBench") {
    state.costMode = "cursor";
  }

  const accessRaw = params.get("access");
  if (accessRaw && ACCESS_FILTERS.has(accessRaw)) state.accessFilter = accessRaw;

  if (params.get("no5h") === "1") state.no5h = true;
  if (params.get("noweekly") === "1") state.noWeekly = true;

  const minEff = params.get("minEffort");
  if (minEff && NAMED_EFFORTS.has(minEff)) state.minEffort = minEff;
  const maxEff = params.get("maxEffort");
  if (maxEff && NAMED_EFFORTS.has(maxEff)) state.maxEffort = maxEff;
  if (
    state.minEffort !== "any" &&
    state.maxEffort !== "any" &&
    EFFORT_ORDER[state.minEffort] > EFFORT_ORDER[state.maxEffort]
  ) {
    state.maxEffort = state.minEffort;
  }

  state.budgetIdx = stopIdxFromParam(params.get("budget"), BUDGET_STOPS, 5);
  // cost = max cost stop and/or "range" (comma-separated, e.g. cost=2,range)
  const costParts = String(params.get("cost") || "").split(",").filter(Boolean);
  if (costParts.includes("range")) state.costView = "range";
  state.maxCostIdx = stopIdxFromParam(costParts.find((x) => x !== "range") ?? null, currentCostStops(), 4);

  if (params.get("plans") === "all") state.cheapestPlanOnly = false;
  if (params.get("efforts") === "all") state.cheapestEffortOnly = false;
  if (params.get("legacy") === "1") state.hideLegacy = false;
  if (params.get("offpeak") === "1") state.hideOffPeak = false;
  // conf = lowest level shown (h/m/l/s). Legacy estimate-tier params map onto it:
  // est=0 → h, est=h → m, est=hm → l, est=hml → s; nointerp=1 → h; extrap=1 → s; noest=1 caps at m.
  const LEGACY_EST = { 0: "high", h: "medium", hm: "low", hml: "speculative" };
  if (params.get("extrap") === "1") state.minConf = "speculative";
  if (params.get("nointerp") === "1") state.minConf = "high";
  const estParam = params.get("est");
  if (estParam != null && /^(0|[hml]+)$/.test(estParam)) {
    const key = estParam === "0" ? "0" : ["h", "m", "l"].filter((t) => estParam.includes(t)).join("");
    state.minConf = LEGACY_EST[key] || (estParam.includes("l") ? "speculative" : estParam.includes("m") ? "low" : "medium");
  }
  if (params.get("noest") === "1") state.minConf = stricterLevel(state.minConf, "medium");
  const confParam = params.get("conf");
  const confLevel = LEVELS.find((l) => LEVEL_PARAM[l] === confParam);
  if (confLevel) state.minConf = confLevel;
  if (params.get("fable") === "own") state.fableCap = "own";
  state.billing = parseBillingParam(params.get("billing"));
  if (params.get("nocn") === "1") state.hideCnPortal = true;
  if (params.get("api") === "1") state.showApi = true;
  if (params.get("open") === "1") state.openWeightsOnly = true;

  const extraRaw = params.get("extra");
  if (extraRaw) {
    const parsed = [];
    for (const token of extraRaw.split(",")) {
      const [key, valStr] = token.split(":");
      const m = BENCHMARKS[key];
      const val = Number(valStr);
      if (m && Number.isFinite(val)) {
        parsed.push({ benchKey: key, minScore: Math.max(m.min, Math.min(m.max, val)) });
      }
    }
    state.extraCriteria = parsed;
  }

  const q = params.get("q");
  const group = params.get("group");
  if (q) state.tableQuery = q;
  if (group === "1") state.groupByPlan = true;
  if ((q || group === "1") && $("tableDetails")) {
    $("tableDetails").open = true;
  }

  const sortRaw = params.get("sort");
  if (sortRaw) {
    const splitIdx = sortRaw.lastIndexOf(":");
    if (splitIdx > 0) {
      const key = sortRaw.slice(0, splitIdx);
      const dir = sortRaw.slice(splitIdx + 1);
      if (key && (dir === "asc" || dir === "desc")) {
        state.sortKey = key;
        state.sortDir = dir;
      }
    }
  }
}

function syncControlsFromState() {
  $("benchSelect").value = state.benchKey;
  syncBenchSlider(false);
  $("maxBudget").value = String(state.budgetIdx);
  $("costMode").value = state.costMode;
  if ($("accessFilter")) $("accessFilter").value = state.accessFilter;
  if ($("no5h")) $("no5h").checked = state.no5h;
  if ($("noWeekly")) $("noWeekly").checked = state.noWeekly;
  if ($("minEffort")) $("minEffort").value = state.minEffort;
  if ($("maxEffort")) $("maxEffort").value = state.maxEffort;
  $("maxCost").value = String(state.maxCostIdx);
  if ($("cheapestPlanOnly")) $("cheapestPlanOnly").checked = state.cheapestPlanOnly;
  $("cheapestEffortOnly").checked = state.cheapestEffortOnly;
  $("hideLegacy").checked = state.hideLegacy;
  $("hideOffPeak").checked = state.hideOffPeak;
  $("minConf").value = state.minConf;
  $("costView").value = state.costView;
  $("fableCap").value = state.fableCap;
  $("billing").value = state.billing;
  $("hideCnPortal").checked = state.hideCnPortal;
  $("showApi").checked = state.showApi;
  $("openWeightsOnly").checked = state.openWeightsOnly;
  $("tableSearch").value = state.tableQuery;
  $("groupByPlan").checked = state.groupByPlan;
  renderExtraCriteria();
}

function syncUrlFromState() {
  try {
    const params = new URLSearchParams();
    const meta = activeBenchMeta();
    if (state.benchKey !== "intelligenceIndex") params.set("bench", state.benchKey);
    if (state.rankMode === "top") params.set("top", String(state.topN));
    else if (state.minScore !== meta.def) params.set("min", String(state.minScore));
    // Explicit mode=task when the benchmark alone would imply another cost metric (legacy links)
    const impliedMode = state.benchKey === "codingAgentIndex" ? "agent" : state.benchKey === "cursorBench" ? "cursor" : "task";
    if (state.costMode !== impliedMode) params.set("mode", state.costMode);
    if (state.accessFilter !== "any") params.set("access", state.accessFilter);
    if (state.no5h) params.set("no5h", "1");
    if (state.noWeekly) params.set("noweekly", "1");
    if (state.minEffort !== "any") params.set("minEffort", state.minEffort);
    if (state.maxEffort !== "any") params.set("maxEffort", state.maxEffort);
    if (state.budgetIdx !== 5) {
      const stop = BUDGET_STOPS[state.budgetIdx];
      params.set("budget", Number.isFinite(stop.max) ? String(stop.max) : "any");
    }
    const costParts = [];
    if (state.maxCostIdx !== 4) {
      const stop = currentCostStops()[state.maxCostIdx];
      costParts.push(Number.isFinite(stop.max) ? String(stop.max) : "any");
    }
    if (state.costView === "range") costParts.push("range");
    if (costParts.length) params.set("cost", costParts.join(","));
    if (!state.cheapestPlanOnly) params.set("plans", "all");
    if (!state.cheapestEffortOnly) params.set("efforts", "all");
    if (!state.hideLegacy) params.set("legacy", "1");
    if (!state.hideOffPeak) params.set("offpeak", "1");
    if (state.minConf !== "medium") params.set("conf", LEVEL_PARAM[state.minConf]);
    if (state.fableCap === "own") params.set("fable", "own");
    if (state.billing === "yearly") params.set("billing", "yearly");
    if (state.hideCnPortal) params.set("nocn", "1");
    if (state.showApi) params.set("api", "1");
    if (state.openWeightsOnly) params.set("open", "1");
    if (state.extraCriteria.length) {
      params.set(
        "extra",
        state.extraCriteria.map((c) => `${c.benchKey}:${c.minScore}`).join(",")
      );
    }
    if (state.tableQuery.trim()) params.set("q", state.tableQuery.trim());
    if (state.groupByPlan) params.set("group", "1");
    if (state.sortKey !== "effectiveCost" || state.sortDir !== "asc") {
      params.set("sort", `${state.sortKey}:${state.sortDir}`);
    }

    const qs = params.toString();
    const nextSearch = qs ? `?${qs}` : "";
    if (window.location.search !== nextSearch) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${nextSearch}${window.location.hash}`
      );
    }
  } catch {
    // Ignore history API restrictions in embedded/file contexts
  }
}

function render() {
  const isTokens = state.costMode === "tokens";
  const modeMeta = COST_MODES[state.costMode] || COST_MODES.task;
  $("chartHeading").textContent = modeMeta.heading;
  $("effortToggleLabel").textContent = isTokens
    ? "Highest-scoring reasoning level only"
    : "Cheapest applicable reasoning level only";
  $("cheapestEffortOnly").closest("label").hidden = state.rankMode === "top";
  $("minScoreOut").textContent =
    state.rankMode === "top" ? String(state.topN) : `≥ ${fmtThreshold(state.minScore, state.benchKey)}`;
  $("maxBudgetOut").textContent = BUDGET_STOPS[state.budgetIdx].label;
  $("maxCostLabel").textContent = modeMeta.maxLabel;
  $("maxCostOut").textContent = currentCostStops()[state.maxCostIdx].label;
  const allResolved = getAllEntriesResolved();
  const rows = getFilteredRows(allResolved);
  renderBarChart(rows, allResolved);
  renderTable(rows);
  // Banner: rows below the default (Medium) now on view. Footer: rows at the next level down, revealed one level per "Show".
  // Counted on the chart's bars (deduplicated), not the full table rows
  const shownBars = chartBars(rows);
  const below = shownBars.filter((r) => LEVEL_RANK[r.level] > LEVEL_RANK.medium);
  const lowShown = below.filter((r) => r.level === "low").length;
  const specShown = below.length - lowShown;
  $("extrapBanner").hidden = below.length === 0;
  $("extrapBannerText").textContent = `${below.length} ${
    lowShown && specShown ? "low-confidence and speculative" : specShown ? "speculative" : "low-confidence"
  } ${below.length === 1 ? "row" : "rows"} shown`;
  const next = LEVELS[LEVEL_RANK[state.minConf] + 1];
  // Bars that would appear (or replace a bar) at the next level down
  const hidden = next ? chartBars(getFilteredRows(allResolved, next)).filter((r) => r.level === next).length : 0;
  $("extrapFooter").hidden = hidden <= 0;
  $("extrapFooterText").textContent = next
    ? `${hidden} ${{ medium: "medium-confidence", low: "low-confidence", speculative: "speculative" }[next]} ${hidden === 1 ? "row" : "rows"} hidden`
    : "";
  syncRadioPairs();
  if ($("billingYearly")) $("billingYearly").checked = state.billing === "yearly";
  syncUrlFromState();
}

function renderMeta() {
  const ds = state.dataset;
  if (!ds) return;
  const d = new Date(ds.generatedAt);
  const stamp = Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : ds.latestDataDate;
  $("updatedAt").textContent = `Updated ${stamp}`;

  const counts = ds.stats?.reliability?.counts || {};
  for (const l of LEVELS) {
    const el = $(`relCount-${l}`);
    if (el) el.textContent = counts[l] != null ? counts[l].toLocaleString() : "—";
  }
  const qc = ds.stats?.reliability?.claudeMixCorrection;
  const qEl = $("quotaCellCounts");
  if (qEl && qc?.cellCounts) {
    const c = qc.cellCounts;
    qEl.textContent = qc.forcedOff ? "off" : `cells ${c.validated || 0} validated · ${c.provisional || 0} provisional · ${c.unmeasured || 0} unmeasured`;
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("themeLabel").textContent = theme === "dark" ? "Light" : "Dark";
  localStorage.setItem("ai-plan-value-theme", theme);
  if (state.dataset) render();
}

function initTheme() {
  const saved = localStorage.getItem("ai-plan-value-theme");
  const initial =
    saved === "dark" || saved === "light"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  applyTheme(initial);
}

const DATA_CACHE_NAME = "ai-plan-value-data-v1";
const DATA_CACHE_KEY = "./data/combined.json";

async function readCachedDataset() {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(DATA_CACHE_NAME);
    const cached = await cache.match(DATA_CACHE_KEY);
    return cached ? await cached.json() : null;
  } catch {
    return null;
  }
}

async function writeCachedDataset(dataset) {
  if (typeof caches === "undefined" || !dataset) return;
  try {
    const cache = await caches.open(DATA_CACHE_NAME);
    await cache.put(
      DATA_CACHE_KEY,
      new Response(JSON.stringify(dataset), {
        headers: { "content-type": "application/json" },
      })
    );
  } catch {
    // Ignore storage quota or private-mode cache errors
  }
}

async function loadData() {
  const cached = await readCachedDataset();
  if (cached && Array.isArray(cached.entries)) {
    state.dataset = cached;
    $("refreshBtn").hidden = !state.dataset?.server?.liveRefreshSupported;
    renderMeta();
    render();
  }

  try {
    const isLocal = location.hostname === "127.0.0.1" || location.hostname === "localhost";
    let res = null;
    if (isLocal) {
      res = await fetch("/api/data", { cache: "no-store" }).catch(() => null);
    }
    if (!res || !res.ok) {
      res = await fetch("./data/combined.json", { cache: "no-store" });
    }
    if (!res || !res.ok) {
      throw new Error(`HTTP ${res?.status || "network error"}`);
    }
    const fresh = await res.json();
    const changed =
      !state.dataset ||
      fresh.generatedAt !== state.dataset.generatedAt ||
      Boolean(fresh.server?.liveRefreshSupported) !== Boolean(state.dataset.server?.liveRefreshSupported);
    state.dataset = fresh;
    $("refreshBtn").hidden = !state.dataset?.server?.liveRefreshSupported;
    writeCachedDataset(fresh);
    if (changed) {
      renderMeta();
      render();
    }
  } catch {
    if (!state.dataset) {
      $("updatedAt").textContent = "Failed to load";
      $("barChart").innerHTML = `<div class="empty">Could not load dataset. Please refresh.</div>`;
    }
  }
}

// Auto-pair (not locked): agent ↔ Coding Agent Index, CursorBench ↔ CursorBench, AA task ↔ Intelligence.
// When one control changes, the other follows only while it is at its default (task / intelligenceIndex) or
// still paired with the previous choice; anything else the user picked (e.g. hle, turn) is left alone.
const COST_BENCH_PAIR = { task: "intelligenceIndex", agent: "codingAgentIndex", cursor: "cursorBench" };
const BENCH_COST_PAIR = Object.fromEntries(Object.entries(COST_BENCH_PAIR).map(([c, b]) => [b, c]));

// Benchmark to show after the cost metric changes from prevCost to nextCost.
function pairedBench(prevCost, nextCost, bench) {
  const target = COST_BENCH_PAIR[nextCost];
  const synced = bench === "intelligenceIndex" || bench === COST_BENCH_PAIR[prevCost];
  return synced && target ? target : bench;
}

// Cost metric to use after the benchmark changes from prevBench to nextBench.
function pairedCost(prevBench, nextBench, cost) {
  const target = BENCH_COST_PAIR[nextBench];
  const synced = cost === "task" || cost === BENCH_COST_PAIR[prevBench];
  return synced && target ? target : cost;
}

function setBench(key) {
  state.benchKey = key;
  $("benchSelect").value = key;
  syncBenchSlider(true);
}

function setCostMode(mode) {
  state.costMode = mode;
  $("costMode").value = mode;
  state.maxCostIdx = 4;
  $("maxCost").value = "4";
}

$("benchSelect").addEventListener("change", (e) => {
  const prev = state.benchKey;
  setBench(e.target.value);
  const cost = pairedCost(prev, state.benchKey, state.costMode);
  if (cost !== state.costMode) setCostMode(cost);
  render();
});

$("minScore").addEventListener("input", (e) => {
  if (state.rankMode === "top") state.topN = Number(e.target.value);
  else state.minScore = Number(e.target.value);
  render();
});

$("rankMode").addEventListener("change", (e) => {
  state.rankMode = e.target.value === "top" ? "top" : "min";
  syncBenchSlider();
  render();
});

$("maxBudget").addEventListener("input", (e) => {
  state.budgetIdx = Number(e.target.value);
  render();
});

$("maxCost").addEventListener("input", (e) => {
  state.maxCostIdx = Number(e.target.value);
  render();
});

$("hideLegacy").addEventListener("change", (e) => {
  state.hideLegacy = e.target.checked;
  updateSettingsBadge();
  render();
});

$("hideOffPeak").addEventListener("change", (e) => {
  state.hideOffPeak = e.target.checked;
  updateSettingsBadge();
  render();
});

$("minConf").addEventListener("change", (e) => {
  state.minConf = LEVELS.includes(e.target.value) ? e.target.value : "medium";
  render();
});

$("costView").addEventListener("change", (e) => {
  state.costView = e.target.value === "range" ? "range" : "point";
  render();
});

$("fableCap").addEventListener("change", (e) => {
  state.fableCap = e.target.value === "own" ? "own" : "shared";
  render();
});

$("billing").addEventListener("change", (e) => {
  state.billing = parseBillingParam(e.target.value);
  render();
});

// Two-option settings are radio pairs (segmented buttons on phones) over a hidden <select>,
// so URLs, reset and the existing change handlers keep working on the select.
// "?" help tips: hover shows the title; a tap or click toggles the same text inline (phones have no hover)
if (document.querySelectorAll) {
  for (const btn of document.querySelectorAll(".help-tip")) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const pop = btn.nextElementSibling;
      if (pop) pop.hidden = !pop.hidden;
    });
  }
}

// Billing is a tick box over the hidden billing select
$("billingYearly")?.addEventListener("change", (e) => {
  $("billing").value = e.target.checked ? "yearly" : "monthly";
  $("billing").dispatchEvent(new Event("change"));
});

function syncRadioPairs() {
  if (!document.querySelectorAll) return;
  for (const group of document.querySelectorAll(".radio-pair[data-for]")) {
    const sel = $(group.dataset.for);
    if (!sel) continue;
    for (const input of group.querySelectorAll('input[type="radio"]')) input.checked = input.value === sel.value;
  }
}
if (document.querySelectorAll) {
  for (const group of document.querySelectorAll(".radio-pair[data-for]")) {
    group.addEventListener("change", (e) => {
      const sel = $(group.dataset.for);
      if (!sel || !e.target.matches?.('input[type="radio"]')) return;
      sel.value = e.target.value;
      sel.dispatchEvent(new Event("change"));
    });
  }
}

function setMinConf(level) {
  state.minConf = level;
  $("minConf").value = level;
  render();
}
$("disableExtrapBtn").addEventListener("click", () => setMinConf("medium"));
$("enableExtrapBtn").addEventListener("click", () => setMinConf(LEVELS[LEVEL_RANK[state.minConf] + 1] || "speculative"));

$("hideCnPortal").addEventListener("change", (e) => {
  state.hideCnPortal = e.target.checked;
  updateSettingsBadge();
  render();
});

$("showApi").addEventListener("change", (e) => {
  state.showApi = e.target.checked;
  updateSettingsBadge();
  render();
});

$("openWeightsOnly").addEventListener("change", (e) => {
  state.openWeightsOnly = e.target.checked;
  updateSettingsBadge();
  render();
});

$("resetSettingsBtn").addEventListener("click", () => {
  state.costMode = "task";
  state.accessFilter = "any";
  state.no5h = false;
  state.noWeekly = false;
  state.minEffort = "any";
  state.maxEffort = "any";
  state.maxCostIdx = 4;
  state.hideLegacy = true;
  state.hideOffPeak = true;
  state.minConf = "medium";
  state.costView = "point";
  state.fableCap = "shared";
  state.billing = "monthly";
  state.hideCnPortal = false;
  state.showApi = false;
  state.openWeightsOnly = false;
  state.extraCriteria = [];
  $("costMode").value = "task";
  if ($("accessFilter")) $("accessFilter").value = "any";
  if ($("no5h")) $("no5h").checked = false;
  if ($("noWeekly")) $("noWeekly").checked = false;
  if ($("minEffort")) $("minEffort").value = "any";
  if ($("maxEffort")) $("maxEffort").value = "any";
  $("maxCost").value = "4";
  $("hideLegacy").checked = true;
  $("hideOffPeak").checked = true;
  $("minConf").value = "medium";
  $("costView").value = "point";
  $("fableCap").value = "shared";
  $("billing").value = "monthly";
  $("hideCnPortal").checked = false;
  $("showApi").checked = false;
  $("openWeightsOnly").checked = false;
  renderExtraCriteria();
  render();
});

$("tableSearch").addEventListener("input", (e) => {
  state.tableQuery = e.target.value;
  state.tableLimit = TABLE_PAGE;
  render();
});

$("tableSort").addEventListener("change", (e) => {
  const key = e.target.value;
  setSort(key, DESC_SORT_KEYS.has(key) || key.startsWith("extra:") ? "desc" : "asc");
});
$("tableSortDir").addEventListener("click", () => setSort(state.sortKey, state.sortDir === "asc" ? "desc" : "asc"));
$("tableMoreBtn").addEventListener("click", () => {
  state.tableLimit += TABLE_PAGE;
  render();
});
phoneMq.addEventListener("change", () => {
  if (state.dataset) render();
});

$("groupByPlan").addEventListener("change", (e) => {
  state.groupByPlan = e.target.checked;
  render();
});

$("addCriterionBtn").addEventListener("click", () => {
  const key = nextUnusedBenchKey();
  state.extraCriteria.push({ benchKey: key, minScore: BENCHMARKS[key].def });
  renderExtraCriteria();
  render();
});

const settingsDialog = $("settingsDialog");
$("settingsBtn").addEventListener("click", () => settingsDialog.showModal());
$("closeSettingsBtn").addEventListener("click", () => settingsDialog.close());
settingsDialog.addEventListener("click", (e) => {
  if (e.target === settingsDialog) settingsDialog.close();
});

$("costMode").addEventListener("change", (e) => {
  const prev = state.costMode;
  state.costMode = e.target.value;
  state.maxCostIdx = 4; // ≤ $5/task or ≤ $5/1M tokens
  $("maxCost").value = "4";
  const bench = pairedBench(prev, state.costMode, state.benchKey);
  if (bench !== state.benchKey) setBench(bench);
  render();
});

$("accessFilter")?.addEventListener("change", (e) => {
  state.accessFilter = e.target.value;
  render();
});

$("no5h")?.addEventListener("change", (e) => {
  state.no5h = e.target.checked;
  render();
});

$("noWeekly")?.addEventListener("change", (e) => {
  state.noWeekly = e.target.checked;
  render();
});

$("minEffort")?.addEventListener("change", (e) => {
  state.minEffort = e.target.value;
  if (
    state.minEffort !== "any" &&
    state.maxEffort !== "any" &&
    EFFORT_ORDER[state.minEffort] > EFFORT_ORDER[state.maxEffort]
  ) {
    state.maxEffort = state.minEffort;
    if ($("maxEffort")) $("maxEffort").value = state.maxEffort;
  }
  render();
});

$("maxEffort")?.addEventListener("change", (e) => {
  state.maxEffort = e.target.value;
  if (
    state.minEffort !== "any" &&
    state.maxEffort !== "any" &&
    EFFORT_ORDER[state.maxEffort] < EFFORT_ORDER[state.minEffort]
  ) {
    state.minEffort = state.maxEffort;
    if ($("minEffort")) $("minEffort").value = state.minEffort;
  }
  render();
});

$("cheapestPlanOnly")?.addEventListener("change", (e) => {
  state.cheapestPlanOnly = e.target.checked;
  render();
});

$("cheapestEffortOnly").addEventListener("change", (e) => {
  state.cheapestEffortOnly = e.target.checked;
  render();
});

$("themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
});

const dialog = $("methodDialog");
$("methodBtn").addEventListener("click", () => dialog.showModal());
$("closeMethodBtn").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

$("refreshBtn").addEventListener("click", async () => {
  const btn = $("refreshBtn");
  const label = $("refreshLabel");
  btn.disabled = true;
  label.textContent = "Refreshing…";
  try {
    if (state.dataset?.server?.liveRefreshSupported) {
      const res = await fetch("/api/refresh", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.ok !== false) {
        state.dataset = data;
        writeCachedDataset(data);
        renderMeta();
        render();
      }
    } else {
      await loadData();
    }
  } finally {
    btn.disabled = false;
    label.textContent = "Refresh";
  }
});

async function loadStarCount() {
  try {
    const res = await fetch("https://api.github.com/repos/melo-foundation/ai-plan-value");
    if (!res.ok) return;
    const repo = await res.json();
    if (typeof repo?.stargazers_count === "number") {
      const el = $("starCount");
      el.textContent = repo.stargazers_count.toLocaleString();
      el.hidden = false;
    }
  } catch {
    // Ignore rate limits or offline mode
  }
}

loadStateFromUrl();
syncControlsFromState();
initTheme();
loadData();
loadStarCount();

// Easter egg: Shift pressed 5 times in a row shows a fake "Modernizing your UI with AI…" progress card, then
// slopifies the page with Slopstrap (public/vendor/slopstrap), plays a party blower, fires canvas-confetti and
// shows a congratulations toast.
// Pressing it again reloads, since unslopify restores innerHTML and would drop app.js's event listeners.
(() => {
  let run = 0;
  let last = 0;
  let active = false;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Shift") {
      run = 0;
      return;
    }
    if (e.repeat) return;
    const now = performance.now();
    run = now - last < 1000 ? run + 1 : 1;
    last = now;
    if (run < 5) return;
    run = 0;
    if (active) undoSlop();
    else {
      active = true;
      slopMode();
    }
  });

  // Undo: fade a cover in the normal page's background colour over the slop page, reload, then fade it back out.
  async function undoSlop() {
    const color = document.documentElement.getAttribute("data-theme") === "dark" ? "#161b22" : "#dce3ec";
    const cover = document.createElement("div");
    cover.style.cssText = `position:fixed;inset:0;z-index:10000;background:${color};opacity:0;transition:opacity 0.6s ease`;
    document.body.appendChild(cover);
    requestAnimationFrame(() => requestAnimationFrame(() => (cover.style.opacity = "1")));
    await sleep(650);
    try {
      sessionStorage.setItem("egg-undo", color);
    } catch {}
    location.reload();
  }

  if (document.documentElement.classList.contains("egg-undo")) {
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add("egg-reveal")));
    setTimeout(() => document.documentElement.classList.remove("egg-undo", "egg-reveal"), 900);
  }

  // Reuse app.js's deploy stamp (?v=<sha>) so the egg's files are refetched after each deploy.
  const ver = new URL(import.meta.url).search;

  const load = (tag, attrs) =>
    new Promise((resolve, reject) => {
      const el = Object.assign(document.createElement(tag), attrs, { onload: resolve, onerror: reject });
      document.head.appendChild(el);
    });

  // Party blower recording (public/vendor/sfx). Safari only plays audio started inside a user gesture, so the
  // keydown handler primes it muted and it is replayed later, after the fake progress bar.
  function primeBlower() {
    const audio = new Audio(`./vendor/sfx/party-blower.mp3${ver}`);
    audio.volume = 0.8;
    audio.muted = true;
    audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
      })
      .catch(() => {});
    return audio;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fakeModernize() {
    // [status line, bar %, ms to hold]: fast start, a stall near the end, then done.
    const steps = [
      ["Analyzing design debt…", 18, 700],
      ["Adding gradients…", 41, 750],
      ["Removing human taste…", 63, 800],
      ["Hallucinating testimonials…", 87, 1100],
      ["Almost there…", 94, 650],
      ["Done ✨", 100, 700],
    ];
    const overlay = document.createElement("div");
    overlay.className = "egg-overlay";
    overlay.innerHTML =
      '<div class="egg-card"><div class="egg-title slop-text-gradient">✨ Modernizing your UI with AI…</div>' +
      '<div class="slop-progress"><div class="slop-progress-bar"></div></div><div class="egg-step"></div></div>';
    document.body.appendChild(overlay);
    const bar = overlay.querySelector(".slop-progress-bar");
    const step = overlay.querySelector(".egg-step");
    await sleep(250);
    for (const [text, pct, hold] of steps) {
      step.textContent = text;
      bar.style.width = `${pct}%`;
      await sleep(hold);
    }
    return overlay;
  }

  // Cross-fades the old page (with the progress card) into the slopified one. View Transitions where supported,
  // otherwise a plain fade out and in.
  async function crossfade(change) {
    if (document.startViewTransition) {
      let applied = false;
      const once = () => {
        if (!applied) {
          applied = true;
          change();
        }
      };
      // A transition can stall (e.g. a backgrounded tab never paints), so cap the wait and apply directly.
      await Promise.race([document.startViewTransition(once).finished.catch(() => {}), sleep(2000)]);
      once();
      return;
    }
    const body = document.body.style;
    body.transition = "opacity 0.5s ease";
    body.opacity = "0";
    await sleep(500);
    change();
    body.opacity = "1";
    await sleep(500);
    body.transition = "";
  }

  function congratsToast() {
    const toast = document.createElement("div");
    toast.className = "egg-toast";
    toast.setAttribute("role", "status");
    toast.innerHTML =
      '<div class="egg-toast-emoji">🎉</div><div class="egg-toast-body">' +
      '<div class="egg-toast-title slop-text-gradient">Congratulation!</div>' +
      '<div class="egg-toast-text">Your UI has been modernized ✨</div>' +
      '<div class="egg-toast-hint"><kbd>Shift</kbd> ×5 to undo</div></div>' +
      '<button class="egg-toast-close" type="button" aria-label="Close">✕</button>';
    toast.querySelector("button").addEventListener("click", () => toast.remove());
    document.body.appendChild(toast);
  }

  function confettiParty() {
    const fire = window.confetti;
    if (!fire) return;
    const colors = ["#a855f7", "#6366f1", "#06b6d4", "#ec4899", "#facc15"];
    fire({ particleCount: 160, spread: 100, startVelocity: 48, origin: { y: 0.6 }, colors });
    fire({ particleCount: 80, angle: 60, spread: 60, origin: { x: 0, y: 0.75 }, colors });
    fire({ particleCount: 80, angle: 120, spread: 60, origin: { x: 1, y: 0.75 }, colors });
  }

  async function slopMode() {
    const blower = primeBlower();
    await Promise.all([
      load("link", { rel: "stylesheet", href: `./vendor/slopstrap/slopstrap.css${ver}` }),
      load("link", { rel: "stylesheet", href: `./vendor/slopstrap/site-slop.css${ver}` }),
      load("script", { src: `./vendor/slopstrap/slopstrap.js${ver}` }),
      load("script", { src: `./vendor/canvas-confetti/confetti.browser.js${ver}` }),
    ]);
    const overlay = await fakeModernize();
    const S = window.Slopstrap;
    await crossfade(() => {
      overlay.remove();
      document.documentElement.dataset.slop = "1";
      document.documentElement.setAttribute("data-slop-level", "3");
      document.body.classList.add("slop-body", "slop-grid-bg");
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<div class="slop-orb-layer" aria-hidden="true"><div class="slop-orb slop-orb-purple"></div><div class="slop-orb slop-orb-cyan"></div></div>'
      );
      S.slopify(document.querySelector(".workspace"));
      S.setLevel(3);
    });
    blower.play().catch(() => {});
    S.sparkleBurst(window.innerWidth / 2, window.innerHeight / 3, 24);
    confettiParty();
    congratsToast();
  }
})();
