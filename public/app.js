// AI Plan Value — 2003 SaaS edition with Artificial Analysis domains/tests & official plan links

const BUDGET_STOPS = [
  { label: "≤ $10/mo", max: 10 },
  { label: "≤ $20/mo", max: 20 },
  { label: "≤ $50/mo", max: 50 },
  { label: "≤ $100/mo", max: 100 },
  { label: "≤ $200/mo", max: 200 },
  { label: "Any", max: Infinity },
];

const COST_STOPS = [
  { label: "≤ $0.25", max: 0.25 },
  { label: "≤ $0.50", max: 0.5 },
  { label: "≤ $1", max: 1 },
  { label: "≤ $2", max: 2 },
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
};

const state = {
  dataset: null,
  benchKey: "intelligenceIndex",
  minScore: 45,
  budgetIdx: 5,
  maxCostIdx: 4,
  showApi: false,
  cheapestEffortOnly: true,
  expandedPlans: new Set(),
  sortKey: "effectiveCost",
  sortDir: "asc",
};

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

function fmtScore(val, key) {
  if (val == null || !Number.isFinite(val)) return "—";
  const meta = BENCHMARKS[key] || BENCHMARKS.intelligenceIndex;
  const num = key === "gdpval" ? Math.round(val) : val.toFixed(1);
  return `${num}${meta.unit}`;
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
  return raw
    .filter((e) => !replaced.has(e.id))
    .map((e) => {
      const isApi = e.billing === "metered";
      const subsidy = isApi ? 1 : e.unmetered ? Infinity : e.subsidyMultiple;
      const effectiveCost = e.unmetered ? 0 : e.aaCostPerTaskUsd / (subsidy || 1);
      const score = getScore(e, state.benchKey);
      const tasksPerMonth =
        !isApi && e.priceUsd && !e.unmetered && effectiveCost > 0
          ? e.priceUsd / effectiveCost
          : null;
      return { ...e, isApi, score, subsidy, effectiveCost, tasksPerMonth };
    });
}

function getFilteredRows(allResolved) {
  const maxBudget = BUDGET_STOPS[state.budgetIdx].max;
  const maxCost = COST_STOPS[state.maxCostIdx].max;

  const out = [];
  for (const r of allResolved) {
    if (r.score == null || r.score < state.minScore) continue;
    if (r.isApi && !state.showApi) continue;
    if (!r.isApi && Number.isFinite(maxBudget) && (r.priceUsd == null || r.priceUsd > maxBudget + 0.5)) {
      continue;
    }
    if (Number.isFinite(maxCost) && r.effectiveCost > maxCost) continue;
    out.push(r);
  }
  return out;
}

function renderPlanDrawer(planName, allResolved) {
  const maxCost = COST_STOPS[state.maxCostIdx].max;
  const benchMeta = BENCHMARKS[state.benchKey] || BENCHMARKS.intelligenceIndex;
  const planEntries = allResolved.filter((e) => !e.isApi && cleanPlan(e) === planName);

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
            (!Number.isFinite(maxCost) || e.effectiveCost <= maxCost);
          const scoreStr =
            e.score != null ? fmtScore(e.score, state.benchKey) : `II ${e.intelligenceIndex.toFixed(1)}`;
          return `<td class="pm-cell${passes ? "" : " dim"}"><span class="pm-cost">${fmtUsd(e.effectiveCost)}</span><span class="pm-score">${esc(scoreStr)}</span></td>`;
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
      <div class="plan-drawer-head">
        <span>All models in ${esc(planName)}</span>
      </div>
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

  // Checked (default): 1 bar per base model (cheapest qualifying effort+plan).
  // Unchecked: 1 bar per (model, effort) variant.
  const bestByModel = new Map();
  for (const r of rows) {
    const groupKey = state.cheapestEffortOnly ? (r.baseModelId || r.modelId) : r.modelId;
    const prev = bestByModel.get(groupKey);
    if (!prev || r.effectiveCost < prev.effectiveCost) {
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
  const benchMeta = BENCHMARKS[state.benchKey] || BENCHMARKS.intelligenceIndex;

  host.innerHTML = bars
    .map((r) => {
      const widthPct = Math.max(1.2, (r.effectiveCost / maxCost) * 68);
      const barColor =
        isDark && (r.color === "#1F2937" || r.color === "#1f1f1f" || r.color === "#334155")
          ? "#8fa3b8"
          : r.color || "#3a6ea5";

      const planName = cleanPlan(r);
      const planText = `${planName}${r.isApi ? "" : ` · ${feeText(r)}`}`;
      const note = `${benchMeta.label} ${fmtScore(r.score, state.benchKey)}`;
      const expKey = `${r.id}`;
      const isExpanded = !r.isApi && state.expandedPlans.has(expKey);
      const expBtn = r.isApi
        ? ""
        : `<button class="plan-exp-btn" type="button" data-exp="${esc(expKey)}" title="Show all models on ${esc(planName)}">${isExpanded ? "▾" : "▸"}</button>`;

      return `
        <div class="bar-row">
          <div class="bar-label">
            <div class="bar-model">${renderLink(r.modelDisplay, r.aaUrl)}</div>
            <div class="bar-plan">${renderLink(planText, r.planUrl)}${expBtn}</div>
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
  const dir = state.sortDir === "asc" ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    if (state.sortKey === "model") {
      return dir * `${a.modelDisplay} ${a.plan}`.localeCompare(`${b.modelDisplay} ${b.plan}`);
    }
    const val = (r) => {
      switch (state.sortKey) {
        case "score": return r.score ?? -1;
        case "fee": return r.isApi ? 0 : (r.priceUsd ?? 1e9);
        case "subsidy": return Number.isFinite(r.subsidy) ? r.subsidy : 1e9;
        case "apiCost": return r.aaCostPerTaskUsd ?? 1e9;
        case "tasksPerMonth": return r.tasksPerMonth ?? -1;
        default: return r.effectiveCost ?? 1e9;
      }
    };
    return dir * (val(a) - val(b));
  });

  const benchMeta = BENCHMARKS[state.benchKey] || BENCHMARKS.intelligenceIndex;
  $("scoreColHead").textContent = benchMeta.label;

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.classList.remove("active", "asc", "desc");
    if (th.dataset.sort === state.sortKey) {
      th.classList.add("active", state.sortDir);
    }
  });

  const tbody = $("rows");
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No plans match these limits.</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted
    .map((r) => {
      const tasksLabel = r.unmetered
        ? "∞"
        : r.tasksPerMonth
          ? Math.round(r.tasksPerMonth).toLocaleString()
          : "—";

      return `
        <tr>
          <td>
            <div class="model">${renderLink(r.modelDisplay, r.aaUrl)}</div>
            <div class="plan">${renderLink(cleanPlan(r), r.planUrl)}</div>
          </td>
          <td class="num-col">${fmtScore(r.score, state.benchKey)}</td>
          <td class="num-col">${feeText(r)}</td>
          <td class="num-col">${r.unmetered ? "∞" : fmtMult(r.subsidy)}</td>
          <td class="num-col">${fmtUsd(r.aaCostPerTaskUsd)}</td>
          <td class="num-col real-cell">${fmtUsd(r.effectiveCost)}</td>
          <td class="num-col">${tasksLabel}</td>
        </tr>
      `;
    })
    .join("");
}

function syncBenchSlider(resetDefault = false) {
  const meta = BENCHMARKS[state.benchKey] || BENCHMARKS.intelligenceIndex;
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

function render() {
  const meta = BENCHMARKS[state.benchKey] || BENCHMARKS.intelligenceIndex;
  $("minScoreOut").textContent = `${state.minScore}${meta.unit}`;
  $("maxBudgetOut").textContent = BUDGET_STOPS[state.budgetIdx].label;
  $("maxCostOut").textContent = COST_STOPS[state.maxCostIdx].label;
  const allResolved = getAllEntriesResolved();
  const rows = getFilteredRows(allResolved);
  renderBarChart(rows, allResolved);
  renderTable(rows);
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

$("showApi").addEventListener("change", (e) => {
  state.showApi = e.target.checked;
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

document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = ["score", "subsidy", "tasksPerMonth"].includes(key) ? "desc" : "asc";
    }
    render();
  });
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
