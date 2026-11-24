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

const USAGE_PRESETS = new Set(["20", "50", "100", "250", "500", "1000"]);
const ACCESS_FILTERS = new Set(["any", "open", "locked"]);
const WINDOW_FILTERS = new Set(["any", "monthly", "weekly", "rolling"]);

const state = {
  dataset: null,
  benchKey: "intelligenceIndex",
  costMode: "task", // "task" | "tokens"
  monthlyApiUsage: null, // null ("max" = 100% quota) | number ($/mo API-equivalent workload)
  minEffort: "any", // "any" | "none" | "low" | "medium" | "high" | "xhigh" | "max"
  maxEffort: "any",
  accessFilter: "any", // "any" | "open" | "locked"
  windowFilter: "any", // "any" | "monthly" | "noweekly" | "rolling" | "weekly"
  minScore: 45,
  budgetIdx: 5,
  maxCostIdx: 4,
  hideLegacy: true,
  hideOffPeak: true,
  hideEstimated: false,
  hideInterpolated: false,
  showExtrapolated: false,
  hideCnPortal: false,
  showApi: false,
  openWeightsOnly: false,
  extraCriteria: [], // [{ benchKey, minScore }]
  tableQuery: "",
  groupByPlan: false,
  expandedTableGroups: new Set(),
  cheapestPlanOnly: true,
  cheapestEffortOnly: true,
  expandedPlans: new Set(),
  sortKey: "effectiveCost",
  sortDir: "asc",
};

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

function feeText(r) {
  if (r.isApi) {
    return state.monthlyApiUsage ? `$${state.monthlyApiUsage}/mo API` : "API";
  }
  const base = r.priceUsd >= 100 ? Math.round(r.priceUsd) : r.priceUsd;
  if (state.monthlyApiUsage && r.overageUsd >= 1) {
    return `$${base} + $${Math.round(r.overageUsd)} API`;
  }
  return `$${base}/mo`;
}

function getPlanAccessMeta(r) {
  if (typeof r.openEndpoint === "boolean" && r.harness && r.quotaWindow && r.quotaWindowLabel) {
    return {
      openEndpoint: r.openEndpoint,
      harness: r.harness,
      quotaWindow: r.quotaWindow,
      quotaWindowLabel: r.quotaWindowLabel,
    };
  }
  if (r.billing === "metered" || r.isApi) {
    return { openEndpoint: true, harness: "Any API / CLI", quotaWindow: "payg", quotaWindowLabel: "Pay-as-you-go" };
  }
  const p = String(r.plan || "");
  if (/^kilo pass\b/i.test(p)) return { openEndpoint: true, harness: "Kilo / OpenAI API", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  if (/^ollama\s+team\b/i.test(p)) return { openEndpoint: true, harness: "Any CLI / API", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  if (/^ollama\b/i.test(p)) return { openEndpoint: true, harness: "Any CLI / API", quotaWindow: "weekly", quotaWindowLabel: "Weekly cap" };
  if (/^opencode\b/i.test(p)) return { openEndpoint: true, harness: "OpenCode / API", quotaWindow: "weekly", quotaWindowLabel: "Weekly cap" };
  if (/^glm coding\b|^minimax\b|^kimi\b/i.test(p)) return { openEndpoint: true, harness: "Any CLI / API", quotaWindow: "rolling", quotaWindowLabel: "5h / daily" };
  if (/qwen token plan|alibaba|阿里云百炼|^tencent token|^mimo token|^step plan|^deeprelay\b/i.test(p)) {
    return { openEndpoint: true, harness: "Any CLI / API", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  }
  if (/^claude\b/i.test(p)) return { openEndpoint: false, harness: "Claude Code / Web", quotaWindow: "weekly", quotaWindowLabel: "Weekly cap" };
  if (/^chatgpt\b/i.test(p)) return { openEndpoint: false, harness: "Codex / Web", quotaWindow: "weekly", quotaWindowLabel: "Weekly cap" };
  if (/^devin\b/i.test(p)) return { openEndpoint: false, harness: "Devin Agent", quotaWindow: "weekly", quotaWindowLabel: "Weekly cap" };
  if (/^github copilot\b/i.test(p)) return { openEndpoint: false, harness: "Copilot IDE / CLI", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  if (/^cursor\b/i.test(p)) return { openEndpoint: false, harness: "Cursor IDE", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  if (/^command code\b/i.test(p)) return { openEndpoint: false, harness: "Command Code CLI", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  if (/^droid\b/i.test(p)) return { openEndpoint: false, harness: "Factory Droid CLI", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  if (/^google ai\b/i.test(p)) return { openEndpoint: false, harness: "Gemini CLI / Web", quotaWindow: "rolling", quotaWindowLabel: "5h / daily" };
  if (/^(?:supergrok|x\s+(?:plus|premium|super|ultra))\b/i.test(p)) return { openEndpoint: false, harness: "Grok Web / App", quotaWindow: "rolling", quotaWindowLabel: "5h / daily" };
  if (/^mistral\b/i.test(p)) return { openEndpoint: false, harness: "Le Chat / Vibe", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
  return { openEndpoint: false, harness: "First-party app", quotaWindow: "monthly", quotaWindowLabel: "Monthly pool" };
}

function passesAccessAndWindow(r) {
  if (state.accessFilter === "open" && !r.openEndpoint) return false;
  if (state.accessFilter === "locked" && r.openEndpoint) return false;
  if (state.windowFilter !== "any" && !r.isApi && r.quotaWindow !== state.windowFilter) {
    return false;
  }
  return true;
}

function getScore(entry, benchKey) {
  if (benchKey === "contextWindow") {
    return entry.contextWindowTokens > 0 ? entry.contextWindowTokens / 1000 : null;
  }
  if (benchKey === "outputSpeed") {
    return entry.aaSpeed?.outputTokPerSec > 0 ? entry.aaSpeed.outputTokPerSec : null;
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

function estMark(r) {
  if (!r.isPreliminary) return "";
  const tip =
    r.estimateType === "assumed"
      ? "Estimated subsidy (prior-generation quota carryover)"
      : "Estimated subsidy (preliminary user report)";
  return `<span class="est-star" title="${esc(tip)}">*</span>`;
}

function interpMark(r) {
  if (r.effortEstimate === "interpolated") {
    return `<span class="est-star" title="Interpolated reasoning effort (bracketed between measured efforts on this model)">†</span>`;
  }
  if (r.effortEstimate === "extrapolated") {
    const src = r.effortEstimateSource === "arc-agi-2"
      ? "ARC-AGI-2 effort ratios"
      : "other measured models in the same family";
    return `<span class="est-star" title="Extrapolated reasoning effort (estimated from ${src}, not directly benchmarked)">‡</span>`;
  }
  return "";
}

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
  const isTokens = state.costMode === "tokens";
  const usageUsd = state.monthlyApiUsage;

  return raw
    .filter((e) => !replaced.has(e.id))
    .map((e) => {
      const isApi = e.billing === "metered";
      const rawSubsidy = isApi ? 1 : e.unmetered ? Infinity : e.subsidyMultiple;
      const accessMeta = getPlanAccessMeta(e);

      let subsidy = rawSubsidy;
      let overageUsd = 0;
      let effectiveMonthlySpend = isApi ? (usageUsd ?? 0) : e.priceUsd;

      if (usageUsd != null && usageUsd > 0) {
        if (isApi) {
          subsidy = 1;
          effectiveMonthlySpend = usageUsd;
        } else if (e.unmetered && e.priceUsd > 0) {
          subsidy = usageUsd / e.priceUsd;
          effectiveMonthlySpend = e.priceUsd;
        } else if (e.priceUsd > 0 && rawSubsidy > 0) {
          const capUsd = e.priceUsd * rawSubsidy;
          overageUsd = Math.max(0, usageUsd - capUsd);
          effectiveMonthlySpend = e.priceUsd + overageUsd;
          subsidy = usageUsd / effectiveMonthlySpend;
        }
      }

      const score = getScore(e, state.benchKey);
      const taskCost = e.aaCostPerTaskUsd;
      const unmeteredFree = !usageUsd && e.unmetered;

      const p = e.aaPricing || {};
      const apiMtok = p.blended3to1Per1M ?? p.blended7to2to1Per1M ?? e.listBlendedUsdPerMtok ?? null;
      const realMtok = unmeteredFree
        ? 0
        : apiMtok != null && subsidy > 0
          ? apiMtok / subsidy
          : e.realUsdPerMtok ?? null;

      const realTaskCost =
        taskCost == null ? null : unmeteredFree ? 0 : taskCost / (subsidy || 1);

      const apiMetric = isTokens ? apiMtok : taskCost;
      const effectiveCost = isTokens ? realMtok : realTaskCost;

      const volumePerMonth =
        usageUsd != null
          ? apiMetric != null && apiMetric > 0
            ? usageUsd / apiMetric
            : null
          : !isApi && e.priceUsd && !e.unmetered && effectiveCost != null && effectiveCost > 0
            ? e.priceUsd / effectiveCost
            : null;

      return {
        ...e,
        ...accessMeta,
        isApi,
        score,
        subsidy,
        rawSubsidy,
        overageUsd,
        effectiveMonthlySpend,
        apiMetric,
        effectiveCost,
        realTaskCost,
        tasksPerMonth: volumePerMonth,
      };
    });
}

function getFilteredRows(allResolved) {
  const maxBudget = BUDGET_STOPS[state.budgetIdx].max;
  const maxCost = currentCostStops()[state.maxCostIdx].max;

  const out = [];
  for (const r of allResolved) {
    if (r.score == null || r.score < state.minScore) continue;
    if (!passesExtraCriteria(r)) continue;
    if (!passesModelSpecs(r)) continue;
    if (!passesEffortBounds(r)) continue;
    if (!passesAccessAndWindow(r)) continue;
    if (r.effectiveCost == null || !Number.isFinite(r.effectiveCost)) continue;
    if (r.isApi && !state.showApi) continue;
    if (!r.isApi && state.hideLegacy && isLegacyEntry(r)) continue;
    if (!r.isApi && state.hideOffPeak && isOffPeakEntry(r)) continue;
    if (!r.isApi && state.hideCnPortal && isCnPortalEntry(r)) continue;
    if (state.hideEstimated && r.isPreliminary) continue;
    if (state.hideInterpolated && r.effortEstimate === "interpolated") continue;
    if (!state.showExtrapolated && r.effortEstimate === "extrapolated") continue;
    if (!r.isApi && Number.isFinite(maxBudget) && (r.priceUsd == null || r.priceUsd > maxBudget + 0.5)) {
      continue;
    }
    if (Number.isFinite(maxCost) && r.effectiveCost > maxCost) continue;
    out.push(r);
  }
  return out;
}

function renderPlanDrawer(planName, allResolved) {
  const maxCost = currentCostStops()[state.maxCostIdx].max;
  const planEntries = allResolved.filter(
    (e) =>
      !e.isApi &&
      cleanPlan(e) === planName &&
      e.effectiveCost != null &&
      !(state.hideEstimated && e.isPreliminary) &&
      !(state.hideInterpolated && e.effortEstimate === "interpolated") &&
      (state.showExtrapolated || e.effortEstimate !== "extrapolated")
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
              : e.intelligenceIndex != null
                ? `II ${e.intelligenceIndex.toFixed(1)}`
                : "—";
          const isExtrap = e.effortEstimate === "extrapolated";
          const costPrefix = isExtrap ? "~" : "";
          return `<td class="pm-cell${passes ? "" : " dim"}${isExtrap ? " is-extrapolated" : ""}"><span class="pm-cost">${costPrefix}${fmtUsd(e.effectiveCost)}${estMark(e)}${interpMark(e)}</span><span class="pm-score">${costPrefix}${esc(scoreStr)}</span></td>`;
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
  `;
}

function renderBarChart(rows, allResolved) {
  const host = $("barChart");

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
      const planFee = r.isApi && !state.monthlyApiUsage ? "" : ` · ${feeText(r)}`;
      const planText = `${planName}${r.isPreliminary ? "*" : ""}${planFee} · ${r.harness} · ${r.quotaWindowLabel}`;
      const planHtml = `${renderLink(planName, r.planUrl)}${estMark(r)}${planFee ? esc(planFee) : ""}`;
      const note = `${benchMeta.label} ${fmtScore(r.score, scoreKey)}`;
      const expKey = `${r.id}`;
      const isExpanded = !r.isApi && state.expandedPlans.has(expKey);
      const expBtn = r.isApi
        ? ""
        : `<button class="plan-exp-btn" type="button" data-exp="${esc(expKey)}" title="Show all models on ${esc(planName)}">${isExpanded ? "▾" : "▸"}</button>`;

      const isExtrap = r.effortEstimate === "extrapolated";
      const tilde = isExtrap ? "~" : "";

      return `
        <div class="bar-row${isExtrap ? " is-extrapolated" : ""}">
          <div class="bar-label">
            <div class="bar-model">${renderLink(r.modelDisplay, r.aaUrl)}${interpMark(r)}</div>
            <div class="bar-plan"><span class="plan-text" title="${esc(planText)}">${planHtml}</span>${expBtn}</div>
          </div>
          <div class="bar-track-wrap">
            <span class="bar-fill${isExtrap ? " is-extrapolated" : ""}" style="width:${widthPct.toFixed(2)}%; background-color:${barColor}"></span>
            <span class="bar-val">${tilde}${fmtUsd(r.effectiveCost)}</span>
            <span class="bar-note">${isExtrap ? `${esc(benchMeta.label)} ~${esc(fmtScore(r.score, scoreKey))}` : esc(note)}</span>
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

  const cols = [
    { key: "model", label: state.groupByPlan ? "Plan / Model" : "Model & Plan", cls: "" },
    { key: "score", label: benchMeta.label, cls: "num-col" },
    ...state.extraCriteria.map((c) => ({
      key: `extra:${c.benchKey}`,
      label: (BENCHMARKS[c.benchKey] || BENCHMARKS.intelligenceIndex).label,
      cls: "num-col col-hide-sm",
      benchKey: c.benchKey,
    })),
    { key: "access", label: "Harness / Reset", cls: "col-hide-sm" },
    { key: "fee", label: state.monthlyApiUsage ? "Spend" : "Fee", cls: "num-col" },
    { key: "subsidy", label: "Subsidy", cls: "num-col col-hide-sm" },
    { key: "apiCost", label: isTokens ? "API $/1M" : "API $/task", cls: "num-col col-hide-sm" },
    { key: "effectiveCost", label: isTokens ? "Real $/1M" : "Real $/task", cls: "num-col" },
    { key: "tasksPerMonth", label: isTokens ? "Mtok/mo" : "Tasks/mo", cls: "num-col col-hide-sm" },
  ];

  if (!cols.some((c) => c.key === state.sortKey)) {
    state.sortKey = "effectiveCost";
    state.sortDir = "asc";
  }

  const thead = $("tableHead");
  thead.innerHTML = `<tr>${cols
    .map((c) => {
      const active = c.key === state.sortKey ? ` active ${state.sortDir}` : "";
      return `<th data-sort="${esc(c.key)}" class="${c.cls}${active}">${esc(c.label)}</th>`;
    })
    .join("")}</tr>`;

  thead.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        const descDefault =
          key === "score" ||
          key === "subsidy" ||
          key === "tasksPerMonth" ||
          key === "context" ||
          key === "speed" ||
          key.startsWith("extra:");
        state.sortDir = descDefault ? "desc" : "asc";
      }
      render();
    });
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
        case "fee": return r.effectiveMonthlySpend ?? (r.isApi ? 0 : (r.priceUsd ?? 1e9));
        case "subsidy": return Number.isFinite(r.subsidy) ? r.subsidy : 1e9;
        case "apiCost": return r.apiMetric ?? 1e9;
        case "tasksPerMonth": return r.tasksPerMonth ?? -1;
        default: return r.effectiveCost ?? 1e9;
      }
    };
    return dir * (val(a) - val(b));
  });

  const tbody = $("rows");
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty">No plans match these limits.</td></tr>`;
    return;
  }

  const renderRow = (r, grouped) => {
    const tasksLabel =
      !state.monthlyApiUsage && r.unmetered
        ? "∞"
        : r.tasksPerMonth
          ? Math.round(r.tasksPerMonth).toLocaleString()
          : "—";

    const extraCells = state.extraCriteria
      .map((c) => `<td class="num-col col-hide-sm">${fmtScore(getScore(r, c.benchKey), c.benchKey)}</td>`)
      .join("");

    const nameCell = grouped
      ? `<div class="model">${renderLink(r.modelDisplay, r.aaUrl)}${interpMark(r)}</div>`
      : `<div class="model">${renderLink(r.modelDisplay, r.aaUrl)}${interpMark(r)}</div><div class="plan">${renderLink(cleanPlan(r), r.planUrl)}${estMark(r)}</div>`;

    const accessCell = grouped
      ? `<td class="meta-cell col-hide-sm"></td>`
      : `<td class="meta-cell col-hide-sm"><div>${esc(r.harness)}</div><div class="plan">${esc(r.quotaWindowLabel)}</div></td>`;

    const isExtrap = r.effortEstimate === "extrapolated";
    const rowCls = [grouped ? "grouped-item" : "", isExtrap ? "is-extrapolated" : ""].filter(Boolean).join(" ");
    const tilde = isExtrap ? "~" : "";

    return `
      <tr${rowCls ? ` class="${rowCls}"` : ""}>
        <td>${nameCell}</td>
        <td class="num-col">${tilde}${fmtScore(r.score, scoreKey)}</td>
        ${extraCells}
        ${accessCell}
        <td class="num-col">${feeText(r)}</td>
        <td class="num-col col-hide-sm">${!state.monthlyApiUsage && r.unmetered ? "∞" : fmtMult(r.subsidy)}${estMark(r)}</td>
        <td class="num-col col-hide-sm">${tilde}${fmtUsd(r.apiMetric)}</td>
        <td class="num-col real-cell">${tilde}${fmtUsd(r.effectiveCost)}</td>
        <td class="num-col col-hide-sm">${tasksLabel}</td>
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
    for (const [pName, g] of groups.entries()) {
      const isOpen = state.expandedTableGroups.has(pName);
      const maxScore = Math.max(...g.rows.map((r) => r.score ?? -Infinity));
      const minCost = Math.min(...g.rows.map((r) => r.effectiveCost ?? Infinity));
      const maxTasks = Math.max(...g.rows.map((r) => r.tasksPerMonth ?? -1));
      const hasUnmetered = !state.monthlyApiUsage && g.rows.some((r) => r.unmetered);
      const hasEst = g.rows.some((r) => r.isPreliminary);
      const finiteSubs = g.rows.map((r) => r.subsidy).filter((s) => Number.isFinite(s));
      let subText = hasUnmetered ? "∞" : "—";
      if (!hasUnmetered && finiteSubs.length) {
        const lo = Math.min(...finiteSubs);
        const hi = Math.max(...finiteSubs);
        subText = Math.abs(hi - lo) < 0.05 ? fmtMult(hi) : `${fmtMult(lo)}–${fmtMult(hi)}`;
      }
      const groupEst = hasEst
        ? `<span class="est-star" title="Contains estimated subsidy">*</span>`
        : "";
      const extraSummary = state.extraCriteria
        .map((c) => {
          const vals = g.rows.map((r) => getScore(r, c.benchKey)).filter((v) => v != null);
          const bestVal = vals.length ? Math.max(...vals) : null;
          return `<td class="num-col col-hide-sm">${fmtScore(bestVal, c.benchKey)}</td>`;
        })
        .join("");
      const tasksText = hasUnmetered
        ? "∞"
        : maxTasks > 0
          ? Math.round(maxTasks).toLocaleString()
          : "—";

      const spends = g.rows.map((r) => r.effectiveMonthlySpend).filter((v) => Number.isFinite(v));
      const groupFeeText =
        state.monthlyApiUsage && !g.sample.isApi && spends.length > 1 && Math.max(...spends) - Math.min(...spends) >= 1
          ? `$${Math.round(Math.min(...spends))}–$${Math.round(Math.max(...spends))}`
          : feeText(g.sample);

      html.push(`
        <tr class="group-row" data-group="${esc(pName)}">
          <td><span class="group-caret">${isOpen ? "▾" : "▸"}</span>${renderLink(pName, g.sample.planUrl)}${groupEst}</td>
          <td class="num-col">${fmtScore(Number.isFinite(maxScore) ? maxScore : null, scoreKey)}</td>
          ${extraSummary}
          <td class="meta-cell col-hide-sm">${esc(g.sample.harness)} · ${esc(g.sample.quotaWindowLabel)}</td>
          <td class="num-col">${groupFeeText}</td>
          <td class="num-col col-hide-sm">${subText}${groupEst}</td>
          <td class="num-col col-hide-sm">—</td>
          <td class="num-col real-cell">${fmtUsd(Number.isFinite(minCost) ? minCost : null)}</td>
          <td class="num-col col-hide-sm">${tasksText}</td>
        </tr>
      `);
      if (isOpen) {
        for (const r of g.rows) html.push(renderRow(r, true));
      }
    }
    tbody.innerHTML = html.join("");

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
    tbody.innerHTML = sorted.map((r) => renderRow(r, false)).join("");
  }
}

function syncBenchSlider(resetDefault = false) {
  const meta = activeBenchMeta();
  const slider = $("minScore");
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

  if (params.get("mode") === "tokens") {
    state.costMode = "tokens";
  }

  const usageRaw = params.get("usage");
  if (usageRaw && USAGE_PRESETS.has(usageRaw)) {
    state.monthlyApiUsage = Number(usageRaw);
  }

  const accessRaw = params.get("access");
  if (accessRaw && ACCESS_FILTERS.has(accessRaw)) state.accessFilter = accessRaw;

  const windowRaw = params.get("window");
  if (windowRaw && WINDOW_FILTERS.has(windowRaw)) state.windowFilter = windowRaw;

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
  state.maxCostIdx = stopIdxFromParam(params.get("cost"), currentCostStops(), 4);

  if (params.get("plans") === "all") state.cheapestPlanOnly = false;
  if (params.get("efforts") === "all") state.cheapestEffortOnly = false;
  if (params.get("legacy") === "1") state.hideLegacy = false;
  if (params.get("offpeak") === "1") state.hideOffPeak = false;
  if (params.get("noest") === "1") state.hideEstimated = true;
  if (params.get("nointerp") === "1") state.hideInterpolated = true;
  if (params.get("extrap") === "1") state.showExtrapolated = true;
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
  if ($("usagePreset")) $("usagePreset").value = state.monthlyApiUsage ? String(state.monthlyApiUsage) : "max";
  if ($("accessFilter")) $("accessFilter").value = state.accessFilter;
  if ($("windowFilter")) $("windowFilter").value = state.windowFilter;
  if ($("minEffort")) $("minEffort").value = state.minEffort;
  if ($("maxEffort")) $("maxEffort").value = state.maxEffort;
  $("maxCost").value = String(state.maxCostIdx);
  if ($("cheapestPlanOnly")) $("cheapestPlanOnly").checked = state.cheapestPlanOnly;
  $("cheapestEffortOnly").checked = state.cheapestEffortOnly;
  $("hideLegacy").checked = state.hideLegacy;
  $("hideOffPeak").checked = state.hideOffPeak;
  $("hideEstimated").checked = state.hideEstimated;
  if ($("hideInterpolated")) $("hideInterpolated").checked = state.hideInterpolated;
  if ($("showExtrapolated")) $("showExtrapolated").checked = state.showExtrapolated;
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
    if (state.minScore !== meta.def) params.set("min", String(state.minScore));
    if (state.costMode !== "task") params.set("mode", state.costMode);
    if (state.monthlyApiUsage) params.set("usage", String(state.monthlyApiUsage));
    if (state.accessFilter !== "any") params.set("access", state.accessFilter);
    if (state.windowFilter !== "any") params.set("window", state.windowFilter);
    if (state.minEffort !== "any") params.set("minEffort", state.minEffort);
    if (state.maxEffort !== "any") params.set("maxEffort", state.maxEffort);
    if (state.budgetIdx !== 5) {
      const stop = BUDGET_STOPS[state.budgetIdx];
      params.set("budget", Number.isFinite(stop.max) ? String(stop.max) : "any");
    }
    if (state.maxCostIdx !== 4) {
      const stop = currentCostStops()[state.maxCostIdx];
      params.set("cost", Number.isFinite(stop.max) ? String(stop.max) : "any");
    }
    if (!state.cheapestPlanOnly) params.set("plans", "all");
    if (!state.cheapestEffortOnly) params.set("efforts", "all");
    if (!state.hideLegacy) params.set("legacy", "1");
    if (!state.hideOffPeak) params.set("offpeak", "1");
    if (state.hideEstimated) params.set("noest", "1");
    if (state.hideInterpolated) params.set("nointerp", "1");
    if (state.showExtrapolated) params.set("extrap", "1");
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
  const usageSuffix = state.monthlyApiUsage ? ` ($${state.monthlyApiUsage.toLocaleString()}/mo usage)` : "";
  $("chartHeading").textContent = (isTokens
    ? "Best Real Cost per 1M Tokens"
    : "Best Real Cost per Task") + usageSuffix;
  $("effortToggleLabel").textContent = isTokens
    ? "Highest-scoring reasoning level only"
    : "Cheapest applicable reasoning level only";
  $("minScoreOut").textContent = `≥ ${fmtThreshold(state.minScore, state.benchKey)}`;
  $("maxBudgetOut").textContent = BUDGET_STOPS[state.budgetIdx].label;
  $("maxCostLabel").textContent = isTokens ? "Max $/1M tokens:" : "Max cost/task:";
  $("maxCostOut").textContent = currentCostStops()[state.maxCostIdx].label;
  const allResolved = getAllEntriesResolved();
  const rows = getFilteredRows(allResolved);
  renderBarChart(rows, allResolved);
  renderTable(rows);
  if ($("extrapBanner")) {
    $("extrapBanner").hidden = !state.showExtrapolated;
  }
  $("estFootnote").hidden = !rows.some((r) => r.isPreliminary);
  if ($("interpFootnote")) {
    $("interpFootnote").hidden = !rows.some((r) => r.effortEstimate === "interpolated");
  }
  if ($("extrapFootnote")) {
    $("extrapFootnote").hidden = !rows.some((r) => r.effortEstimate === "extrapolated");
  }
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

  const acc = ds.stats?.effortAccuracy;
  if (acc?.interp?.intelPts != null && acc?.interp?.costPct != null && $("interpErrNote")) {
    $("interpErrNote").textContent = ` (typical error ~±${acc.interp.intelPts} pts / ±${acc.interp.costPct}% $/task)`;
  }
  if (
    acc?.extrap?.intelPts1 != null &&
    acc?.extrap?.intelPtsAll != null &&
    acc?.extrap?.costPct1 != null &&
    acc?.extrap?.costPctAll != null &&
    $("extrapErrNote")
  ) {
    $("extrapErrNote").textContent = ` (typical error ~±${acc.extrap.intelPts1}–${acc.extrap.intelPtsAll} pts / ±${acc.extrap.costPct1}–${acc.extrap.costPctAll}% $/task)`;
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

$("benchSelect").addEventListener("change", (e) => {
  state.benchKey = e.target.value;
  syncBenchSlider(true);
  render();
});

$("minScore").addEventListener("input", (e) => {
  state.minScore = Number(e.target.value);
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

$("hideEstimated").addEventListener("change", (e) => {
  state.hideEstimated = e.target.checked;
  updateSettingsBadge();
  render();
});

$("hideInterpolated")?.addEventListener("change", (e) => {
  state.hideInterpolated = e.target.checked;
  updateSettingsBadge();
  render();
});

$("showExtrapolated")?.addEventListener("change", (e) => {
  state.showExtrapolated = e.target.checked;
  updateSettingsBadge();
  render();
});

$("disableExtrapBtn")?.addEventListener("click", () => {
  state.showExtrapolated = false;
  if ($("showExtrapolated")) $("showExtrapolated").checked = false;
  updateSettingsBadge();
  render();
});

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
  state.monthlyApiUsage = null;
  state.accessFilter = "any";
  state.windowFilter = "any";
  state.minEffort = "any";
  state.maxEffort = "any";
  state.maxCostIdx = 4;
  state.hideLegacy = true;
  state.hideOffPeak = true;
  state.hideEstimated = false;
  state.hideInterpolated = false;
  state.showExtrapolated = false;
  state.hideCnPortal = false;
  state.showApi = false;
  state.openWeightsOnly = false;
  state.extraCriteria = [];
  $("costMode").value = "task";
  if ($("usagePreset")) $("usagePreset").value = "max";
  if ($("accessFilter")) $("accessFilter").value = "any";
  if ($("windowFilter")) $("windowFilter").value = "any";
  if ($("minEffort")) $("minEffort").value = "any";
  if ($("maxEffort")) $("maxEffort").value = "any";
  $("maxCost").value = "4";
  $("hideLegacy").checked = true;
  $("hideOffPeak").checked = true;
  $("hideEstimated").checked = false;
  if ($("hideInterpolated")) $("hideInterpolated").checked = false;
  if ($("showExtrapolated")) $("showExtrapolated").checked = false;
  $("hideCnPortal").checked = false;
  $("showApi").checked = false;
  $("openWeightsOnly").checked = false;
  renderExtraCriteria();
  render();
});

$("tableSearch").addEventListener("input", (e) => {
  state.tableQuery = e.target.value;
  render();
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
  state.costMode = e.target.value;
  state.maxCostIdx = 4; // ≤ $5/task or ≤ $5/1M tokens
  $("maxCost").value = "4";
  render();
});

$("usagePreset")?.addEventListener("change", (e) => {
  const val = e.target.value;
  const wasMax = state.monthlyApiUsage == null;
  state.monthlyApiUsage = val === "max" ? null : Number(val);
  // Automatically show Pay-as-you-go API when switching to a finite usage level so break-even is visible
  if (wasMax && state.monthlyApiUsage != null && !state.showApi) {
    state.showApi = true;
    $("showApi").checked = true;
  }
  render();
});

$("accessFilter")?.addEventListener("change", (e) => {
  state.accessFilter = e.target.value;
  render();
});

$("windowFilter")?.addEventListener("change", (e) => {
  state.windowFilter = e.target.value;
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
