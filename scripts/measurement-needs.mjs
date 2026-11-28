#!/usr/bin/env node
/**
 * Ranks subscription plans by how much they need a quota measurement and writes kits/NEEDED.md.
 *
 *   node scripts/measurement-needs.mjs            # reads public/data/combined.json, writes kits/NEEDED.md
 *   node scripts/measurement-needs.mjs --stdout   # prints instead of writing
 *
 * Also called at the end of scripts/refresh-data.mjs. Output depends only on the dataset (the
 * reference date is dataset.generatedAt), so two runs on one file give identical bytes.
 *
 * Method (rationale lives here, not in the generated file):
 * - Rows: subscription rows visible by default on the site: not legacy, not off-peak, not
 *   yearly-only. Peak / mixed / Day variants of one plan are folded into one plan.
 * - Cell = plan × base model; its representative row is the effort level with the highest
 *   Intelligence Index (ties: modelId), since the site's default view ranks by it.
 * - Model weight = 1 + 2·frontier + 2·popularity. frontier = best Intelligence Index of the base
 *   model ÷ the best on the site; popularity = log(1 + T3 Code turns) ÷ log(1 + most turns).
 *   Popular and frontier models dominate a plan's shares.
 * - A cell is "priced" when its whole chain is an official credit pool or list price (S1 credits /
 *   list price): the subsidy is known from the price and needs no measurement. Plans with only
 *   priced cells are listed on one line at the end.
 * - "Measured" = the chain has a first-hand step (accounts, screenshot, tweet, Priors users).
 *   Official quota tables (S1 "official", S2) are arithmetic on vendor numbers, not measurements.
 * - Need score = 100 × (0.35·low + 0.30·borrowed + 0.20·old) weighted shares
 *   + 40 per disagreement fail that flags the plan (max 2) + 30 when no cell is measured first-hand,
 *   all × (0.5 + 0.5·plan weight), plan weight = heaviest model on the plan ÷ heaviest overall.
 *   Disagreement plans are always listed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
export const DATA_PATH = path.join(ROOT, "public", "data", "combined.json");
export const NEEDED_PATH = path.join(ROOT, "kits", "NEEDED.md");

export const OLD_DAYS = 60;
const MEASURED_STEPS = new Set(["S3", "S4", "S5", "S6", "T", "prelim", "priors", "pooled"]);
const PRICED_TEXT = new Set(["official credits", "list price"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

/**
 * Kit per plan family. `kit` links are relative to kits/. Methods per family: kits/METHODS.md.
 */
export const FAMILIES = [
  { id: "chatgpt-plus", test: (p) => p === "ChatGPT Plus", kit: { name: "Codex", href: "codex/README.md" } },
  { id: "chatgpt-pro", test: (p) => /^ChatGPT Pro\b/.test(p), kit: null, note: "Codex kit takes Plus only" },
  { id: "claude", test: (p) => /^Claude (Pro|Max|Ultra|Team)\b/.test(p), kit: { name: "Claude Code", href: "../docs/QUOTA-WEIGHTS.md" } },
  { id: "google", test: (p) => /^Google AI\b/.test(p), kit: null },
  { id: "copilot", test: (p) => /^GitHub Copilot\b/.test(p), kit: null },
  { id: "cursor", test: (p) => /^Cursor\b/.test(p), kit: null },
  { id: "devin", test: (p) => /^Devin\b/.test(p), kit: null },
  { id: "droid", test: (p) => /^Droid\b/.test(p), kit: null },
  { id: "command-code", test: (p) => /^Command Code\b/.test(p), kit: null },
  { id: "kilo", test: (p) => /^Kilo Pass\b/.test(p), kit: null },
  { id: "kimi", test: (p) => /^Kimi\b/.test(p), kit: null },
  { id: "glm", test: (p) => /^GLM Coding\b/.test(p), kit: null },
  { id: "minimax", test: (p) => /^MiniMax\b/.test(p), kit: null },
  { id: "mimo", test: (p) => /^MiMo\b/.test(p), kit: null },
  { id: "grok", test: (p) => /^(SuperGrok|X (Plus|Ultra))\b/.test(p), kit: null },
  { id: "ollama", test: (p) => /^Ollama\b/.test(p), kit: null },
  { id: "mistral", test: (p) => /^Mistral Vibe\b/.test(p), kit: null },
  { id: "deeprelay", test: (p) => /^DeepRelay\b/.test(p), kit: null },
  { id: "opencode", test: (p) => /^OpenCode Go\b/.test(p), kit: null },
  { id: "token-plans", test: (p) => /Token Plan|^Step Plan|阿里云百炼/.test(p), kit: null },
];

export const familyOf = (plan) => FAMILIES.find((f) => f.test(plan)) || null;

export function kitText(plan) {
  const f = familyOf(plan);
  if (f?.kit) return `[Kit: ${f.kit.name}](${f.kit.href})`;
  return f?.note ? `No kit yet (${f.note})` : "No kit yet";
}

/** Peak / mixed / Day variants share one plan; off-peak rows are already dropped. */
export const planGroup = (plan) => plan.replace(/\s*\((peak|mixed|Day)\)$/, "");

export const isDefaultVisible = (e) =>
  e.billing === "subscription" && !e.isLegacy && !e.isOffPeak && e.billingOnly !== "yearly";

const baseName = (display) =>
  String(display || "").replace(/\s*\((none|non-reasoning|minimal|low|medium|high|xhigh|max)\)$/i, "");

/** Last calendar day named by a dataDate ("2026-09-29~2026-10-03", "2026-08", "2026-11-28"). */
function dataEnd(dataDate) {
  const last = String(dataDate || "").split("~").pop().trim();
  let m = last.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = last.match(/^(\d{4})-(\d{2})$/);
  if (m) return Date.UTC(+m[1], +m[2], 0);
  return null;
}

function monthText(t, refYear) {
  if (t == null) return "";
  const d = new Date(t);
  const y = d.getUTCFullYear();
  return y === refYear ? MONTHS[d.getUTCMonth()] : `${MONTHS[d.getUTCMonth()]} ${y}`;
}

/** Plain words for the first-hand source behind a chain ("1 screenshot", "2 accounts", "Priors, 1 user"). */
function basisText(chain) {
  const st = chain?.steps || [];
  const pick = (k) => st.find((s) => s.k === k);
  if (pick("pooled")) return "Fei + Priors";
  if (pick("S3")) return pick("S3").t;
  if (pick("S4")) return "1 account";
  if (pick("S5")) return "1 screenshot";
  if (pick("S6")) return pick("S6").t === "1 screenshot" ? "1 screenshot" : `1 ${pick("S6").t}`;
  if (pick("T")) return "1 tweet";
  if (pick("prelim")) return `Priors, ${pick("prelim").t}`;
  if (pick("priors")) return "Priors";
  if (st.some((s) => s.k === "S1" || s.k === "S2")) return "official quota table";
  return "";
}

/** Name of the model (and plan, when it is another plan) a borrowed value comes from. */
function borrowedFrom(chain, entityName, plan) {
  const proxy = (chain.steps || []).find((s) => s.k === "M3proxy");
  if (proxy) return proxy.t.replace(/^measured on\s+/, "");
  for (const a of chain.anchors || []) {
    const src = entityName.get(a);
    if (src) return src.plan === plan ? src.model : `${src.model} on ${src.plan}`;
  }
  const line = String((chain.lines || [])[0] || "");
  if (line && !/^\d/.test(line) && !/^derived\b/.test(line)) {
    let s = line.replace(/^=\s*/, "").split(/ tokens\b| × | ÷ /)[0].trim();
    s = s.replace(/\s*\((same pool|assumed equal|price ratio|official plan ratio|ruled plan ratio)\)$/, "");
    if (/^Fable-only reading/.test(s)) return "the Fable-only reading";
    if (s) return s;
  }
  return "a sibling plan";
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const mdCell = (s) => String(s).replace(/\|/g, "\\|");

/** Ranked list of plans with their need score and plain-language reasons. */
export function rankPlans(dataset) {
  const chains = dataset.stats?.chains || {};
  const refT = dataEnd(String(dataset.generatedAt || "").slice(0, 10)) ?? dataEnd(dataset.latestDataDate);
  const refYear = new Date(refT).getUTCFullYear();
  const all = (dataset.entries || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Model weights over the whole site.
  const ii = new Map();
  const turns = new Map();
  const display = new Map();
  for (const e of all) {
    const b = e.baseModelId || e.modelId;
    if (Number.isFinite(e.intelligenceIndex)) ii.set(b, Math.max(ii.get(b) ?? 0, e.intelligenceIndex));
    if (e.t3Turn?.turns > 0) turns.set(b, Math.max(turns.get(b) ?? 0, e.t3Turn.turns));
    if (!display.has(b)) display.set(b, baseName(e.modelDisplay));
  }
  const maxIi = Math.max(1, ...ii.values());
  const maxTurns = Math.max(1, ...turns.values());
  const weight = (b) => r4(1 + 2 * ((ii.get(b) ?? 0) / maxIi) + 2 * (Math.log1p(turns.get(b) ?? 0) / Math.log1p(maxTurns)));

  // Chain entity → { model, plan } for anchors.
  const entityName = new Map();
  for (const e of all) {
    const c = chains[e.rel?.chain];
    if (c?.entity && !entityName.has(c.entity)) entityName.set(c.entity, { model: baseName(e.modelDisplay), plan: planGroup(e.plan) });
  }

  // Disagreement fails → plan group + model.
  const entityRows = new Map();
  for (const e of all) {
    const c = chains[e.rel?.chain];
    if (!c?.entity || !isDefaultVisible(e)) continue;
    if (!entityRows.has(c.entity)) entityRows.set(c.entity, []);
    entityRows.get(c.entity).push(e);
  }
  const fails = new Map(); // plan → Map(baseModelId → name)
  for (const c of dataset.stats?.reliability?.consistency || []) {
    if (c.verdict !== "fail") continue;
    const rows = entityRows.get(c.flagged) || [];
    // Unresolved flag: fall back to the check's second plan (the flagged cell is the less certain
    // side of the pair), or its only plan for a same-pool check.
    const plan = rows.length ? planGroup(rows[0].plan) : planGroup(c.q || c.p);
    const base = rows.length ? rows[0].baseModelId : c.a;
    const name = rows.length ? baseName(rows[0].modelDisplay) : display.get(base) || base;
    if (!fails.has(plan)) fails.set(plan, new Map());
    fails.get(plan).set(base, name);
  }

  // Cells.
  const plans = new Map();
  for (const e of all) {
    if (!isDefaultVisible(e)) continue;
    const p = planGroup(e.plan);
    if (!plans.has(p)) plans.set(p, { plan: p, harness: e.harness, cells: new Map() });
    const P = plans.get(p);
    const b = e.baseModelId || e.modelId;
    const cur = P.cells.get(b);
    const better = !cur || (e.intelligenceIndex ?? -1) > (cur.intelligenceIndex ?? -1) || ((e.intelligenceIndex ?? -1) === (cur.intelligenceIndex ?? -1) && e.modelId < cur.modelId);
    if (better) P.cells.set(b, e);
  }

  const out = [];
  let maxPlanW = 0;
  for (const P of plans.values()) for (const b of P.cells.keys()) maxPlanW = Math.max(maxPlanW, weight(b));

  for (const P of plans.values()) {
    const cells = [...P.cells.entries()]
      .map(([b, e]) => {
        const chain = chains[e.rel?.chain] || { steps: [], lines: [], anchors: [] };
        const steps = chain.steps || [];
        const priced = steps.length > 0 && steps.every((s) => s.k === "S1" && PRICED_TEXT.has(s.t));
        const measured = steps.some((s) => MEASURED_STEPS.has(s.k));
        const end = dataEnd(e.dataDate);
        const ageDays = end == null || refT == null ? null : Math.round((refT - end) / 864e5);
        return {
          base: b,
          name: baseName(e.modelDisplay),
          w: weight(b),
          priced,
          measured,
          direct: measured && !e.rel?.sd,
          low: e.rel?.level === "low" || e.rel?.level === "speculative",
          borrowed: Boolean(e.rel?.sd),
          old: measured && ageDays != null && ageDays > OLD_DAYS,
          end,
          chain,
        };
      })
      .sort((a, b) => b.w - a.w || (a.base < b.base ? -1 : 1));

    const planFails = fails.get(P.plan) || new Map();
    if (cells.every((c) => c.priced) && !planFails.size) {
      out.push({ plan: P.plan, harness: P.harness, priced: true, score: 0 });
      continue;
    }
    const W = cells.reduce((s, c) => s + c.w, 0);
    const share = (k) => cells.reduce((s, c) => s + (c[k] ? c.w : 0), 0) / W;
    const lowS = share("low");
    const borS = share("borrowed");
    const oldS = share("old");
    const noMeasurement = !cells.some((c) => c.direct);
    const planW = cells[0].w / maxPlanW;
    const score = r4((100 * (0.35 * lowS + 0.3 * borS + 0.2 * oldS) + 40 * Math.min(2, planFails.size) + (noMeasurement ? 30 : 0)) * (0.5 + 0.5 * planW));

    // Model to measure first: a disagreement cell, else the heaviest weak cell, else the heaviest cell.
    const weak = (c) => !c.priced && (c.low || c.borrowed || c.old || !c.direct);
    let first = null;
    if (planFails.size) {
      const fb = [...planFails.keys()].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))[0];
      first = cells.find((c) => c.base === fb) || { name: planFails.get(fb) };
    }
    first = first || cells.find(weak) || cells[0];

    const reasons = [];
    const n = cells.length;
    const count = (k, text) => {
      const m = cells.filter((c) => c[k]).length;
      if (!m) return;
      reasons.push(m === n ? (n === 1 ? text : n === 2 ? `both models ${text}` : `all ${n} models ${text}`) : `${m} of ${n} models ${text}`);
    };
    const basis = (c) => {
      if (!c?.measured) return "";
      return [basisText(c.chain), monthText(c.end, refYear)].filter(Boolean).join(", ");
    };
    if (planFails.size) reasons.push(`sources disagree on ${[...planFails.values()].sort().join(", ")}`);
    const bor = cells.filter((c) => c.borrowed);
    const official = cells.some((c) => !c.borrowed && basisText(c.chain) === "official quota table");
    if (noMeasurement && official) reasons.push("no measurement, official quota table only");
    else if (noMeasurement && !bor.length) reasons.push("no measurement");
    if (bor.length) {
      const c = first.borrowed ? first : bor[0];
      const from = `${borrowedFrom(c.chain, entityName, P.plan)}${basis(c) ? ` (${basis(c)})` : ""}`;
      reasons.push(bor.length === n ? `borrowed from ${from}` : `${bor.length} of ${n} models borrowed; ${c.name} from ${from}`);
    }
    if (first.chain && !first.borrowed && first.measured && (first.low || first.old || n === 1)) {
      reasons.push(n === 1 ? basis(first) : `${first.name}: ${basis(first)}`);
    }
    count("low", "low confidence");
    count("old", "older than 60 days");

    out.push({
      plan: P.plan,
      harness: P.harness,
      priced: false,
      score,
      first: first.name,
      reasons,
      fails: [...planFails.values()].sort(),
      kit: kitText(P.plan),
    });
  }

  out.sort((a, b) => b.score - a.score || (a.plan < b.plan ? -1 : a.plan > b.plan ? 1 : 0));
  return { refT, plans: out };
}

export function renderNeeded(dataset) {
  const { refT, plans } = rankPlans(dataset);
  const listed = plans.filter((p) => !p.priced && (p.score > 0 || p.fails.length));
  const priced = plans.filter((p) => p.priced).map((p) => p.plan).sort();
  const date = refT == null ? "" : new Date(refT).toISOString().slice(0, 10);
  const lines = [
    "# Most needed measurements",
    "",
    `Generated by \`node scripts/measurement-needs.mjs\` from \`public/data/combined.json\`, data as of ${date}. Most needed first. Do not edit by hand.`,
    "",
    "Pick a plan you pay for, measure the model in **Measure first**, and send the result with the [Quota measurement](https://github.com/melo-foundation/ai-plan-value/issues/new?template=quota-measurement.yml) issue form. Methods per plan: [METHODS.md](METHODS.md).",
    "",
    "| # | Plan | Harness | What's wrong | Measure first | Kit |",
    "|---|---|---|---|---|---|",
    ...listed.map((p, i) => `| ${i + 1} | ${mdCell(p.plan)} | ${mdCell(p.harness)} | ${mdCell(p.reasons.join("; "))} | ${mdCell(p.first)} | ${p.kit} |`),
    "",
  ];
  if (priced.length) lines.push(`Known from the price, no measurement needed: ${priced.map(mdCell).join(", ")}.`, "");
  return lines.join("\n");
}

export function writeNeeded(dataset, file = NEEDED_PATH) {
  const md = renderNeeded(dataset);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md, "utf8");
  return md;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataset = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  if (process.argv.includes("--stdout")) process.stdout.write(renderNeeded(dataset));
  else {
    writeNeeded(dataset);
    console.log(`Wrote ${path.relative(ROOT, NEEDED_PATH)}`);
  }
}
