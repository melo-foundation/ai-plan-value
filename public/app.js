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

const SUITE_META = {
  intelligence: { label: "Intelligence", heading: "Best Real Cost", benchLabel: null },
  codingAgent: { label: "Coding Agent", heading: "Coding Agent Cost", benchLabel: "Coding Agent Index", unit: "", min: 15, max: 60, step: 1, def: 40 },
  deepSwe: { label: "DeepSWE 1.1", heading: "DeepSWE Cost", benchLabel: "DeepSWE 1.1", unit: "%", min: 20, max: 75, step: 1, def: 50 },
};

const state = {
  dataset: null,
  suite: "intelligence", // "intelligence" | "codingAgent" | "deepSwe"
  benchKey: "intelligenceIndex",
  costMode: "task", // "task" | "tokens"
  minScore: 45,
  budgetIdx: 5,
  maxCostIdx: 4,
  hideLegacy: true,
  hideOffPeak: true,
  hideEstimated: false,
  hideCnPortal: false,
  showApi: false,
  openWeightsOnly: false,
  extraCriteria: [], // [{ benchKey, minScore }]
  tableQuery: "",
  groupByPlan: false,
  expandedTableGroups: new Set(),
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
  return state.suite === "intelligence" ? state.benchKey : state.suite;
}

function activeBenchMeta() {
  if (state.suite === "codingAgent") return SUITE_META.codingAgent;
  if (state.suite === "deepSwe") return SUITE_META.deepSwe;
  return BENCHMARKS[state.benchKey] || BENCHMARKS.intelligenceIndex;
}

function fmtScore(val, key) {
  if (val == null || !Number.isFinite(val)) return "—";
  if (key === "codingAgent") return val.toFixed(1);
  if (key === "deepSwe") return `${val.toFixed(1)}%`;
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
  if (key === "codingAgent") return String(val);
  if (key === "deepSwe") return `${val}%`;
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
  return r.isApi ? "API" : `$${r.priceUsd >= 100 ? Math.round(r.priceUsd) : r.priceUsd}/mo`;
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
const EFFORT_COL_TITLE = {
  none: "Non-reasoning",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  default: "Default",
};

function getAllEntriesResolved() {
  if (!state.dataset) return [];
  const raw = state.dataset.entries || [];
  const replaced = new Set();
  for (const e of raw) {
    if (e.isPreliminary && e.replacesId) replaced.add(e.replacesId);
  }
  const isTokens = state.costMode === "tokens";
  const suite = state.suite;

  return raw
    .filter((e) => !replaced.has(e.id))
    .map((e) => {
      const isApi = e.billing === "metered";
      const subsidy = isApi ? 1 : e.unmetered ? Infinity : e.subsidyMultiple;
      const suiteObj = suite === "codingAgent" ? e.suites?.codingAgent : suite === "deepSwe" ? e.suites?.deepSwe : null;
      const score = suite === "intelligence" ? getScore(e, state.benchKey) : (suiteObj?.score ?? null);
      const taskCost = suite === "intelligence" ? e.aaCostPerTaskUsd : (suiteObj?.costPerTaskUsd ?? null);

      const p = e.aaPricing || {};
      const apiMtok = p.blended3to1Per1M ?? p.blended7to2to1Per1M ?? e.listBlendedUsdPerMtok ?? null;
      const realMtok = e.unmetered
        ? 0
        : apiMtok != null && subsidy > 0
          ? apiMtok / subsidy
          : e.realUsdPerMtok ?? null;

      const apiMetric = isTokens ? apiMtok : taskCost;
      const effectiveCost = isTokens
        ? realMtok
        : taskCost == null
          ? null
          : e.unmetered
            ? 0
            : taskCost / (subsidy || 1);

      const volumePerMonth =
        !isApi && e.priceUsd && !e.unmetered && effectiveCost != null && effectiveCost > 0
          ? e.priceUsd / effectiveCost
          : null;

      return {
        ...e,
        isApi,
        score,
        subsidy,
        apiMetric,
        effectiveCost,
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
    if (r.effectiveCost == null || !Number.isFinite(r.effectiveCost)) continue;
    if (r.isApi && !state.showApi) continue;
    if (!r.isApi && state.hideLegacy && isLegacyEntry(r)) continue;
    if (!r.isApi && state.hideOffPeak && isOffPeakEntry(r)) continue;
    if (!r.isApi && state.hideCnPortal && isCnPortalEntry(r)) continue;
    if (state.hideEstimated && r.isPreliminary) continue;
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
      !(state.hideEstimated && e.isPreliminary)
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
            (!Number.isFinite(maxCost) || e.effectiveCost <= maxCost);
          const scoreStr =
            e.score != null
              ? fmtScore(e.score, activeScoreKey())
              : e.intelligenceIndex != null
                ? `II ${e.intelligenceIndex.toFixed(1)}`
                : "—";
          return `<td class="pm-cell${passes ? "" : " dim"}"><span class="pm-cost">${fmtUsd(e.effectiveCost)}${estMark(e)}</span><span class="pm-score">${esc(scoreStr)}</span></td>`;
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

  // Checked (default): 1 bar per base model (cheapest qualifying effort+plan; ties broken by higher score).
  // Unchecked: 1 bar per (model, effort) variant.
  const bestByModel = new Map();
  for (const r of rows) {
    const groupKey = state.cheapestEffortOnly ? (r.baseModelId || r.modelId) : r.modelId;
    const prev = bestByModel.get(groupKey);
    const isBetter =
      !prev ||
      r.effectiveCost < prev.effectiveCost - 1e-9 ||
      (Math.abs(r.effectiveCost - prev.effectiveCost) <= 1e-9 && (r.score ?? 0) > (prev.score ?? 0));
    if (isBetter) {
      bestByModel.set(groupKey, r);
    }
  }

  const bars = [...bestByModel.values()].sort((a, b) => a.effectiveCost - b.effectiveCost);

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
      const planText = `${planName}${r.isPreliminary ? "*" : ""}${r.isApi ? "" : ` · ${feeText(r)}`}`;
      const planHtml = `${renderLink(planName, r.planUrl)}${estMark(r)}${r.isApi ? "" : ` · ${esc(feeText(r))}`}`;
      const note = `${benchMeta.label} ${fmtScore(r.score, scoreKey)}`;
      const expKey = `${r.id}`;
      const isExpanded = !r.isApi && state.expandedPlans.has(expKey);
      const expBtn = r.isApi
        ? ""
        : `<button class="plan-exp-btn" type="button" data-exp="${esc(expKey)}" title="Show all models on ${esc(planName)}">${isExpanded ? "▾" : "▸"}</button>`;

      return `
        <div class="bar-row">
          <div class="bar-label">
            <div class="bar-model">${renderLink(r.modelDisplay, r.aaUrl)}</div>
            <div class="bar-plan"><span class="plan-text" title="${esc(planText)}">${planHtml}</span>${expBtn}</div>
          </div>
          <div class="bar-track-wrap">
            <span class="bar-fill" style="width:${widthPct.toFixed(2)}%; background-color:${barColor}"></span>
            <span class="bar-val">${fmtUsd(r.effectiveCost)}</span>
            <span class="bar-note">${esc(note)}</span>
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
    ? rows.filter((r) => `${r.modelDisplay} ${cleanPlan(r)} ${r.vendor || ""}`.toLowerCase().includes(q))
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
    { key: "fee", label: "Fee", cls: "num-col" },
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
    const tasksLabel = r.unmetered
      ? "∞"
      : r.tasksPerMonth
        ? Math.round(r.tasksPerMonth).toLocaleString()
        : "—";

    const extraCells = state.extraCriteria
      .map((c) => `<td class="num-col col-hide-sm">${fmtScore(getScore(r, c.benchKey), c.benchKey)}</td>`)
      .join("");

    const nameCell = grouped
      ? `<div class="model">${renderLink(r.modelDisplay, r.aaUrl)}</div>`
      : `<div class="model">${renderLink(r.modelDisplay, r.aaUrl)}</div><div class="plan">${renderLink(cleanPlan(r), r.planUrl)}${estMark(r)}</div>`;

    return `
      <tr${grouped ? ' class="grouped-item"' : ""}>
        <td>${nameCell}</td>
        <td class="num-col">${fmtScore(r.score, scoreKey)}</td>
        ${extraCells}
        <td class="num-col">${feeText(r)}</td>
        <td class="num-col col-hide-sm">${r.unmetered ? "∞" : fmtMult(r.subsidy)}${estMark(r)}</td>
        <td class="num-col col-hide-sm">${fmtUsd(r.apiMetric)}</td>
        <td class="num-col real-cell">${fmtUsd(r.effectiveCost)}</td>
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
      const hasUnmetered = g.rows.some((r) => r.unmetered);
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

      html.push(`
        <tr class="group-row" data-group="${esc(pName)}">
          <td><span class="group-caret">${isOpen ? "▾" : "▸"}</span>${renderLink(pName, g.sample.planUrl)}${groupEst}</td>
          <td class="num-col">${fmtScore(Number.isFinite(maxScore) ? maxScore : null, scoreKey)}</td>
          ${extraSummary}
          <td class="num-col">${feeText(g.sample)}</td>
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
  const isIntel = state.suite === "intelligence";
  $("benchSelect").hidden = !isIntel;
  const suiteLabel = $("suiteBenchLabel");
  suiteLabel.hidden = isIntel;
  if (!isIntel) suiteLabel.textContent = meta.benchLabel || meta.label;

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

function render() {
  const isTokens = state.costMode === "tokens";
  const suiteHead = (SUITE_META[state.suite] || SUITE_META.intelligence).heading;
  $("chartHeading").textContent = isTokens
    ? `${suiteHead} per 1M Tokens`
    : `${suiteHead} per Task`;
  $("effortToggleLabel").textContent = isTokens
    ? "Highest-scoring reasoning level only"
    : "Cheapest applicable reasoning level only";
  $("minScoreOut").textContent = `≥ ${fmtThreshold(state.minScore, activeScoreKey())}`;
  $("maxBudgetOut").textContent = BUDGET_STOPS[state.budgetIdx].label;
  $("maxCostLabel").textContent = isTokens ? "Max $/1M tokens:" : "Max cost/task:";
  $("maxCostOut").textContent = currentCostStops()[state.maxCostIdx].label;
  const allResolved = getAllEntriesResolved();
  const rows = getFilteredRows(allResolved);
  renderBarChart(rows, allResolved);
  renderTable(rows);
  $("estFootnote").hidden = !rows.some((r) => r.isPreliminary);
}

function renderMeta() {
  const ds = state.dataset;
  if (!ds) return;
  const d = new Date(ds.generatedAt);
  const stamp = Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : ds.latestDataDate;
  $("updatedAt").textContent = `Updated ${stamp}`;
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

async function loadData() {
  const isLocal = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  let res = null;
  if (isLocal) {
    res = await fetch("/api/data", { cache: "no-store" }).catch(() => null);
  }
  if (!res || !res.ok) {
    res = await fetch("./data/combined.json", { cache: "no-store" });
  }
  state.dataset = await res.json();
  $("refreshBtn").hidden = !state.dataset?.server?.liveRefreshSupported;
  renderMeta();
  render();
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
  state.maxCostIdx = 4;
  state.hideLegacy = true;
  state.hideOffPeak = true;
  state.hideEstimated = false;
  state.hideCnPortal = false;
  state.showApi = false;
  state.openWeightsOnly = false;
  state.extraCriteria = [];
  $("costMode").value = "task";
  $("maxCost").value = "4";
  $("hideLegacy").checked = true;
  $("hideOffPeak").checked = true;
  $("hideEstimated").checked = false;
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

document.querySelectorAll("button[data-suite]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.suite;
    if (!next || next === state.suite || !SUITE_META[next]) return;
    state.suite = next;
    document.querySelectorAll("button[data-suite]").forEach((b) => {
      const on = b.dataset.suite === next;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    syncBenchSlider(true);
    render();
  });
});

$("costMode").addEventListener("change", (e) => {
  state.costMode = e.target.value;
  state.maxCostIdx = 4; // ≤ $5/task or ≤ $5/1M tokens
  $("maxCost").value = "4";
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

syncBenchSlider(true);
initTheme();
loadData();
loadStarCount();
