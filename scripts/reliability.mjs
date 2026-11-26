/**
 * Reliability model (docs/RELIABILITY.md).
 *
 * Every value is a product / quotient of positive numbers (real cost = API cost ÷ subsidy,
 * subsidy = anchor × ratios), so uncertainty is tracked as σ = sd of ln(value) per derivation
 * step and variances add along the chain (GUM §5.1.6 log linearization; ecoinvent pedigree
 * matrix). The total maps to four displayed levels by the width of the 80% band.
 * Step σ values are priors calibrated against Fei2411 revisions and Fei-vs-Priors overlaps
 * (reliability design doc §1.2); refit when a step type reaches n ≥ 15 replacements.
 */

export const Z80 = 1.2816;
export const LEVELS = ["high", "medium", "low", "speculative"];
const LEVEL_RANK = { high: 0, medium: 1, low: 2, speculative: 3 };
// Max σ per level: 80% of values within ×1.25 / ×1.7 / ×2.5.
export const LEVEL_SIGMA = { high: 0.18, medium: 0.4, low: 0.7 };
// Max score error (± pts) per level.
export const LEVEL_SCORE_PTS = { high: 1.5, medium: 3, low: 5 };

// Starting σ by source type (A) and transfer steps (B).
export const STEP_SIGMA = {
  S1: 0.03, // official credit pool in $, rate table, API list price
  S2: 0.12, // official quota table through a workload mix
  S3: 0.1, // several accounts / sources, ≥100 pp, within ×1.1
  S4: 0.2, // one account, own token logs + first-party meter
  S5: 0.35, // one first-party screenshot with token breakdown and quota %
  S6: 0.45, // tweet, third-party gateway panel, verbal or rounded %
  S7: 0.7, // claim with no numbers
  T: 0.3, // known account, large sample, figures in text only (between S4 and S5)
  promo: 0.2, // sample taken in a promo period and re-based
  attribution: 0.15, // other usage possible in the window
  raw: 0.1, // raw token total, no per-kind breakdown
  P1: 0.25, // sibling plan, official ratio
  P2: 0.35, // sibling plan, ruled ratio or window multiplier
  X1: 0.15, // sibling plan via the model's measured ratio to an anchor model (+ σ of the cells used)
  M1: 0.15, // other model, same pool, vendor-stated price-proportional draw
  M2: 0.3, // other model, same pool, official rate card not guaranteed (OpenAI)
  M3: 0.25, // other model, price ratio assumed (≤ 5×)
  M3far: 0.45, // price ratio assumed (> 5×), or a ruled model weight
  M4: 0.7, // successor assumed equal to predecessor
  M5: 1.0, // model with its own weight / cap valued by another model's multiple
  T45: 0.15, // data older than 45 days
  T90: 0.3, // data older than 90 days
};
export const UPSTREAM_FLOOR = { high: 0.08, medium: 0.18, low: 0.4 };
export const TRANSFER_KINDS = new Set(["P1", "P2", "X1", "M1", "M2", "M3", "M3far", "M3proxy", "M4", "M5", "token"]);
export const CAPPED_KINDS = new Set(["M4", "M5"]);

export const qsum = (...xs) => Math.sqrt(xs.reduce((a, x) => a + (Number.isFinite(x) ? x * x : 0), 0));
export const levelFromSigma = (s) =>
  s <= LEVEL_SIGMA.high + 1e-9 ? "high" : s <= LEVEL_SIGMA.medium + 1e-9 ? "medium" : s <= LEVEL_SIGMA.low + 1e-9 ? "low" : "speculative";
export const levelFromScore = (p) =>
  !(p > 0) ? "high" : p <= LEVEL_SCORE_PTS.high ? "high" : p <= LEVEL_SCORE_PTS.medium ? "medium" : p <= LEVEL_SCORE_PTS.low ? "low" : "speculative";
export const worseLevel = (...ls) => ls.filter(Boolean).reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), "high");
export const levelRank = (l) => LEVEL_RANK[l] ?? 3;

/** A chain: steps origin-first ({k, s, t}), display lines nearest-first, anchors (entry ids). */
export function makeChain({ steps = [], lines = [], anchors = [], cap = null, flags = [], drop = 0 } = {}) {
  const c = { steps, lines, anchors, cap, flags, drop };
  c.s = qsum(...steps.map((x) => x.s));
  return c;
}
export function extendChain(base, step, line, extra = {}) {
  const prefix = extra.at ? `${extra.at}: ` : "";
  const keep = base.steps.filter((x) => !(extra.dropKinds || []).includes(x.k));
  const dropped = base.steps.filter((x) => (extra.dropKinds || []).includes(x.k));
  return makeChain({
    steps: [...keep, ...(Array.isArray(step) ? step : step ? [step] : [])],
    lines: [...(line ? [line] : []), ...base.lines.map((l, i) => (i === 0 ? prefix + l : l))],
    anchors: [...new Set([...(extra.anchorId ? [extra.anchorId] : []), ...base.anchors])],
    cap: extra.cap !== undefined ? extra.cap : base.cap,
    flags: [...new Set([...base.flags, ...(extra.flags || [])])],
    drop: dropped.reduce((a, x) => a + x.s * x.s, base.drop || 0),
  });
}
export const chainDerived = (c) => c.steps.some((x) => TRANSFER_KINDS.has(x.k));
export const chainCapped = (c) => c.steps.some((x) => CAPPED_KINDS.has(x.k)) || c.flags.includes("stale");

/** Apply an upstream grade floor: the parsed chain may lower a level, never raise it. */
export function applyFloor(chain, grade, who) {
  const f = UPSTREAM_FLOOR[grade];
  if (f && chain.s < f) {
    chain.steps.push({ k: "floor", s: Number(Math.sqrt(f * f - chain.s * chain.s).toFixed(4)), t: `${who} ${grade}` });
    chain.s = qsum(...chain.steps.map((x) => x.s));
  }
  if (grade === "high" || grade === "medium" || grade === "low") chain.cap = chain.cap ? worseLevel(chain.cap, grade) : grade;
  return chain;
}

/** Add an inconsistency penalty in quadrature (one per cell: the largest). */
export function addPenalty(chain, sigma, line, flag = "inconsistent") {
  const prev = chain.steps.find((x) => x.k === "inconsistent");
  if (prev && prev.s >= sigma) return chain;
  if (prev) chain.steps.splice(chain.steps.indexOf(prev), 1);
  chain.steps.push({ k: "inconsistent", s: Number(sigma.toFixed(4)), t: line });
  if (!chain.flags.includes(flag)) chain.flags.push(flag);
  chain.lines = [...chain.lines.filter((l) => !l.startsWith("inconsistent")), line];
  chain.s = qsum(...chain.steps.map((x) => x.s));
  return chain;
}

// ---------- dates ----------
export function lastDate(raw) {
  const s = String(raw || "");
  let best = null;
  for (const m of s.matchAll(/(\d{4})-(\d{2})(?:-(\d{2}))?/g)) {
    const d = m[3] ? `${m[1]}-${m[2]}-${m[3]}` : new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
    if (!best || d > best) best = d;
  }
  return best;
}
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------- Fei2411 chain parser (§4.2) ----------
const RE_TWEET = /X @|推文|twitter|x\.com/i;
const RE_GATEWAY = /第三方|网关|relay/i;
const RE_SHOT = /截图/;
const RE_MAINT = /维护者(本机|本地|实测|提供样本)/;
const RE_ISSUE = /issue #\d+/i;
const RE_BREAKDOWN = /(读|cache|缓存读)[^，；]{0,12}[\d.]+\s*[KMBkmb]?/i;
const RE_PROMO = /促销|活动期/;
const RE_ATTRIB = /为推断|是否全归|另有用量|若周内另有|归属.{0,10}推断/;

function parsePp(src, note) {
  const grab = (t) => {
    const out = [];
    for (const m of String(t || "").matchAll(/(\d+(?:\.\d+)?)%\s*→\s*(\d+(?:\.\d+)?)%/g)) out.push(Math.abs(Number(m[2]) - Number(m[1])));
    for (const m of String(t || "").matchAll(/\+?(\d+(?:\.\d+)?)\s*(?:pp|个百分点)/g)) out.push(Number(m[1]));
    for (const m of String(t || "").matchAll(/(?:＝|=|÷)\s*周额度[^0-9]{0,20}(\d+(?:\.\d+)?)%/g)) out.push(Number(m[1]));
    for (const m of String(t || "").matchAll(/÷\s*(\d+(?:\.\d+)?)%/g)) out.push(Number(m[1]));
    return out.filter((x) => x > 0 && x <= 400);
  };
  const a = grab(src);
  if (a.length) return Math.max(...a.slice(0, 3));
  const b = grab(note);
  return b.length ? Math.max(...b.slice(0, 3)) : null;
}

/** Shorten a plan name for chain lines ("Claude Max" → "Max", "Google AI Ultra 5x" → "Ultra 5x"). */
export function shortPlan(plan) {
  return String(plan || "")
    .replace(/^(Claude|Google AI|ChatGPT|Kimi|SuperGrok|GitHub Copilot)\s+/i, "")
    .replace(/\s*\(9\/14\+\)/, "");
}
export function shortModel(m) {
  return String(m || "").replace(/^Claude\s+/i, "");
}

/**
 * Build the subsidy chain for one Fei2411 points.csv row. `ctx` = { byId, byPlanModel, today, cellName(row), memo }.
 */
export function feiChain(row, ctx, depth = 0, seen = new Set()) {
  if (ctx.memo.has(row.id)) return ctx.memo.get(row.id);
  const conf = String(row.confidence || "medium").toLowerCase();
  const src = String(row.source || "");
  const note = String(row.note || "");
  const text = `${src} ${note}`;
  const kind = row.data_date_kind;
  const date = lastDate(row.data_date);
  let chain;
  if (row.billing === "metered") {
    chain = makeChain({ steps: [{ k: "S1", s: STEP_SIGMA.S1, t: "list price" }], lines: ["list price"] });
    ctx.memo.set(row.id, chain);
    return chain;
  } else if (kind === "official") {
    const s = conf === "high" ? 0.05 : conf === "medium" ? STEP_SIGMA.S2 : 0.4;
    chain = makeChain({ steps: [{ k: conf === "high" ? "S1" : "S2", s, t: "official" }], lines: [`official${date ? `, ${date}` : ""}`] });
  } else if (kind === "sample") {
    const pp = parsePp(src, note);
    const maint = RE_MAINT.test(src);
    const issue = RE_ISSUE.test(src);
    const tweet = RE_TWEET.test(src) && !maint && !issue;
    const gateway = RE_GATEWAY.test(src);
    const shot = RE_SHOT.test(src) && !maint && !issue;
    const breakdown = RE_BREAKDOWN.test(text);
    let k, label;
    if (gateway || tweet || shot) {
      // Tweets and single screenshots start Low; Medium only with a first-party panel,
      // a token breakdown and ≥15 pp of quota (Admiralty-style source × information grading).
      if (!gateway && breakdown && pp >= 15) {
        k = "S5";
        label = tweet ? "tweet screenshot" : "1 screenshot";
      } else {
        k = "S6";
        label = gateway ? "gateway panel" : tweet ? "tweet" : "1 screenshot";
      }
    } else if (conf === "high") {
      k = "S3";
      const n = /两个[^，；]{0,8}账号/.test(src) ? 2 : /三源|三个/.test(text) ? 3 : 2;
      label = `${n} accounts`;
    } else {
      k = "S4";
      label = "1 account";
    }
    const steps = [{ k, s: STEP_SIGMA[k], t: label }];
    if (pp > 0) {
      const sr = 0.41 / pp;
      if (sr > 0.02) steps.push({ k: "reading", s: Number(sr.toFixed(4)), t: `integer % over ${pp} pp` });
    }
    if (RE_PROMO.test(text)) steps.push({ k: "promo", s: STEP_SIGMA.promo, t: "promo period" });
    if (RE_ATTRIB.test(text)) steps.push({ k: "attribution", s: STEP_SIGMA.attribution, t: "attribution inferred" });
    if (String(row.workload || "").toLowerCase() === "measured" || /未折算/.test(text)) {
      steps.push({ k: "raw", s: STEP_SIGMA.raw, t: "raw tokens" });
    }
    if (date && ctx.today) {
      const age = daysBetween(date, ctx.today);
      if (age > 90) steps.push({ k: "T90", s: STEP_SIGMA.T90, t: `${age} d old` });
      else if (age > 45) steps.push({ k: "T45", s: STEP_SIGMA.T45, t: `${age} d old` });
    }
    // Kimi CN pools were measured on K3.1 Pro traffic; a K3 row needs a price-ratio model step.
    if (/^kimi-k3$/.test(row.model) && /k3\.1-pro/i.test(text)) {
      steps.push({ k: "M3proxy", s: STEP_SIGMA.M3, t: "measured on K3.1 Pro" });
    }
    const line = [label, pp ? `${pp} pp` : null, date].filter(Boolean).join(", ");
    chain = makeChain({ steps, lines: [line] });
  } else {
    // derived: resolve the anchor, then classify the step
    let anchor = null;
    let step;
    let line;
    const m = /^由同套餐 (\S+) ([\d.]+) 亿 × ([\d.]+)/.exec(src);
    if (m) {
      anchor = ctx.byId.get(`${row.id.split("::")[0]}::${m[1]}`) || null;
      const r = Number(m[3]);
      const priceProp = /google|gemini/i.test(row.vendor || "") || /^google_/.test(row.id);
      if (Math.abs(r - 1) < 1e-6) step = { k: "M1", s: STEP_SIGMA.M1, t: "same pool" };
      else if (/fable/i.test(row.model)) step = { k: "M3far", s: STEP_SIGMA.M3far, t: "ruled model weight" };
      else if (r > 5 || r < 0.2) step = { k: "M3far", s: STEP_SIGMA.M3far, t: "price ratio" };
      else if (priceProp) step = { k: "M1", s: STEP_SIGMA.M1, t: "price-proportional pool" };
      else step = { k: "M3", s: STEP_SIGMA.M3, t: "price ratio" };
      line = `${shortModel(anchor ? ctx.modelName(anchor) : m[1])} × ${Number(r.toFixed(3))}${step.k === "M1" ? " (same pool)" : ""}`;
    } else {
      if (/由 .* 共享周池/.test(src)) step = { k: "M1", s: STEP_SIGMA.M1, t: "shared $ pool" };
      else if (/官方/.test(text) && /(倍率|worth|\d+\/\d+|为.*的\d倍)/.test(text)) step = { k: "P1", s: STEP_SIGMA.P1, t: "official plan ratio" };
      else step = { k: "P2", s: STEP_SIGMA.P2, t: "ruled plan ratio" };
    }
    if (!anchor && row.data_date_from) {
      const want = row.data_date_from.split("、")[0].trim();
      anchor = ctx.byLabel.get(want) || null;
    }
    if (anchor && anchor.id === row.id) anchor = null;
    let base;
    if (anchor && depth < 6 && !seen.has(anchor.id)) {
      seen.add(row.id);
      base = feiChain(anchor, ctx, depth + 1, seen);
      if (!line) {
        const f = ctx.subsidyOf(row) / ctx.subsidyOf(anchor);
        line = `${ctx.cellName(anchor)} × ${Number.isFinite(f) ? Number(f.toFixed(3)) : "?"} (${step.t})`;
      }
      chain = extendChain(base, step, line, { at: ctx.cellName(anchor), anchorId: anchor.id });
    } else {
      const f = UPSTREAM_FLOOR[conf] || 0.4;
      chain = makeChain({
        steps: [{ k: "unresolved", s: f, t: "anchor not parsed" }, step],
        lines: [line || `derived (${step.t})`],
        flags: ["unresolved"],
      });
    }
  }
  applyFloor(chain, conf, "Fei");
  ctx.memo.set(row.id, chain);
  return chain;
}

// ---------- Claude quota token weighting (§3.3) ----------
// Scenarios (cacheRead, cacheWrite1h) consistent with Fei #98; index 1 is the central weight set.
export const MIX_SCENARIOS = [
  { cacheRead: 0.31, cacheWrite1h: 1.0 },
  { cacheRead: 0.5, cacheWrite1h: 0.625 },
  { cacheRead: 0.56, cacheWrite1h: 0.5 },
  { cacheRead: 0.81, cacheWrite1h: 0 },
];
export const MIX_CENTRAL = 1;

/** φ per scenario for a $ mix { read, w1h, w5m, input, output }. */
export function phiVector(d) {
  if (!d) return null;
  const tot = (d.read || 0) + (d.w1h || 0) + (d.w5m || 0) + (d.input || 0) + (d.output || 0);
  if (!(tot > 0)) return null;
  return MIX_SCENARIOS.map(
    (w) => (w.cacheRead * (d.read || 0) + w.cacheWrite1h * (d.w1h || 0) + (d.w5m || 0) + (d.input || 0) + (d.output || 0)) / tot
  );
}

/** Parse Fei's "段 worth $X（读 A×$p＋1h写 B×$p＋入 C×$p＋出 D×$p）" into list $ by kind. */
export function parseFeiSampleMix(note) {
  const t = String(note || "");
  // First "worth $X（…）" group: the sample's own list dollars by token kind.
  const m0 = /worth \$[\d.,]+\s*[（(]/.exec(t);
  if (!m0) return null;
  const seg = t.slice(m0.index, m0.index + 300).split(/[）)]/)[0];
  const out = { read: 0, w1h: 0, w5m: 0, input: 0, output: 0 };
  let any = false;
  const mult = { "": 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };
  for (const m of seg.matchAll(/(cache读|缓存读|读|1h\s*写|5m\s*写|写|非缓存输入|入|输出|出)\s*([\d.,]+)\s*([KMBkmb]?)\s*×\s*\$([\d.]+)/g)) {
    const n = Number(m[2].replace(/,/g, "")) * (mult[m[3]] ?? 1);
    const usd = (n / 1e6) * Number(m[4]);
    if (!Number.isFinite(usd)) continue;
    const kind = m[1].replace(/\s+/g, "");
    if (/读/.test(kind)) out.read += usd;
    else if (kind === "1h写") out.w1h += usd;
    else if (/写/.test(kind)) out.w5m += usd;
    else if (/入/.test(kind)) out.input += usd;
    else out.output += usd;
    any = true;
  }
  return any ? out : null;
}

/** Same $ mix with its cache writes counted as 1-hour writes (for the TTL-unknown range). */
export const asHourWrites = (d) => (d ? { ...d, w1h: (d.w1h || 0) + (d.w5m || 0), w5m: 0 } : null);

/** $ mix from token counts and per-1M prices (5-minute writes at 1.25× input). */
export function dollarMixFromTokens(tok, p) {
  if (!tok || !p || p.inputPer1M == null || p.outputPer1M == null) return null;
  const cached = p.cacheHitPer1M ?? p.inputPer1M * 0.1;
  return {
    read: ((tok.cached || 0) / 1e6) * cached,
    w1h: 0,
    w5m: ((tok.written || 0) / 1e6) * p.inputPer1M * 1.25,
    input: ((tok.fresh || 0) / 1e6) * p.inputPer1M,
    output: ((tok.output || 0) / 1e6) * p.outputPer1M,
  };
}

/** AA Intelligence Index cost breakdown → $ mix (AA cache writes taken as 5-minute). */
export function dollarMixFromAa(b) {
  if (!b || !(b.total > 0)) return null;
  return { read: b.cacheRead || 0, w1h: 0, w5m: b.cacheWrite || 0, input: b.nonCacheInput || 0, output: b.output || 0 };
}

/** Fei's anthropic workload convention (tokens) priced at the model's list prices. */
export function conventionMix(mixTok, p) {
  if (!mixTok || !p || p.inputPer1M == null) return null;
  const cached = p.cacheHitPer1M ?? p.inputPer1M * 0.1;
  return {
    read: (mixTok.cache || 0) * cached,
    w1h: 0,
    w5m: (mixTok.cacheWrite || 0) * p.inputPer1M * 1.25,
    input: (mixTok.input || 0) * p.inputPer1M,
    output: (mixTok.output || 0) * (p.outputPer1M || 0),
  };
}

/** Correction factor S_eff / S = φ(sample) / φ(metric), central and scenario range; σ from the range. */
export function mixFactor(phiSample, phiMetric, phiMetricAlt = null) {
  if (!phiSample || !phiMetric) return null;
  const f = phiSample.map((x, i) => x / phiMetric[i]);
  // The metric's cache-write TTL is not published: the range also spans its writes weighted as 1-hour writes.
  const fAlt = phiMetricAlt ? phiSample.map((x, i) => x / phiMetricAlt[i]) : [];
  const lo = Math.min(...f, ...fAlt);
  const hi = Math.max(...f, ...fAlt);
  // Treat the scenario spread as an 80% interval.
  const sigma = Math.max(0.05, Math.log(hi / lo) / (2 * Z80));
  return { f: Number(f[MIX_CENTRAL].toFixed(4)), lo: Number(lo.toFixed(4)), hi: Number(hi.toFixed(4)), sigma: Number(sigma.toFixed(4)) };
}

// ---------- cost and score steps (C) ----------
const sigmaFromPct = (pct, fallback) => (Number.isFinite(pct) && pct > 0 ? Math.log(1 + pct / 100) / 0.6745 : fallback);

export function costSteps(effortAcc, agentAcc) {
  const x = effortAcc?.extrap || {};
  return {
    aa: 0.05,
    interp: sigmaFromPct(effortAcc?.interp?.costPct, 0.17),
    extrap: [sigmaFromPct(x.costPct1, 0.21), sigmaFromPct(x.costPct2, 0.37), sigmaFromPct(x.costPct3, 0.52), 0.7],
    arc: 0.39,
    agentSame: sigmaFromPct(agentAcc?.sameModel?.costPct, 0.16),
    agentCross: sigmaFromPct(agentAcc?.crossAgent?.costPct, 0.4),
    agentFit: sigmaFromPct(agentAcc?.model?.costPct, 0.25),
    agentFitBelow: 0.6,
    t3: (turns) => (turns >= 1000 ? 0.1 : turns >= 100 ? 0.25 : 0.4),
    t3Harness: 0.35, // no fixed task: cross-harness turn size spread (1.4–1.6×)
    cursor: 0.1,
    tokens: 0.03,
    pts: {
      interp: effortAcc?.interp?.intelPts ?? 1.1,
      extrap: [x.intelPts1 ?? 1.4, x.intelPts2 ?? 2.5, x.intelPts3 ?? 3.1, 4.6],
      arc: 2.9,
      agentSame: agentAcc?.sameModel?.pts ?? 1.4,
      agentCross: agentAcc?.crossAgent?.pts ?? 2.7,
      agentFit: agentAcc?.model?.pts ?? 2.8,
      agentFitBelow: 4.6,
    },
  };
}

export const r4 = (v) => Number(v.toFixed(4));
