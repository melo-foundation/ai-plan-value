#!/usr/bin/env node
/**
 * Fits subscription quota weights per token kind (input, output, cache read, 5m / 1h cache write)
 * from quota-probe submissions, and gates each cell (vendor × model × bar × client class).
 *
 * Spec: docs/design/quota-weight-methodology.md §1.4, §2–§4. Usage: docs/QUOTA-WEIGHTS.md.
 *
 *   node scripts/fit-quota-weights.mjs              fit data/quota-weights/submissions/ → fit.json, fit.md, index.csv
 *   node scripts/fit-quota-weights.mjs --check      fit in memory, compare with fit.json, write nothing
 *   node scripts/fit-quota-weights.mjs --simulate   recovery tables + the §3.3 assertion
 *   node scripts/fit-quota-weights.mjs --cell <key> fit one cell and print it
 *   node scripts/fit-quota-weights.mjs --pool-classes  diagnostic: pool client classes incl. emulated labels, print only
 *   options: --boot N (2000) --perm N (1000) --seed N (1) --runs N (simulation runs, 200)
 *
 * Model (§3.1): points_s = γ_g × Σ_k w_k × usd_sk + ε_s, w_input = 1, w_k ≥ 0, one γ per group
 * (account × plan × bar × client class × model × ISO week). Weights are shared inside a cell.
 * Zero dependencies (Node ≥ 20). Also imported by scripts/quota-probe.mjs and scripts/test-site.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// Current Claude plans: pro, max ($100), ultra ($200). Older names map onto them.
const PLAN_ALIASES = { max_5x: "max", max_20x: "ultra" };
const normPlan = (p) => PLAN_ALIASES[p] || p;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const QW_DIR = path.join(ROOT, "data", "quota-weights");
export const SUBMISSIONS_DIR = path.join(QW_DIR, "submissions");
export const PRICES_PATH = path.join(QW_DIR, "prices.json");
export const FIT_PATH = path.join(QW_DIR, "fit.json");
export const FIT_MD_PATH = path.join(QW_DIR, "fit.md");
export const INDEX_PATH = path.join(QW_DIR, "index.csv");
export const DOC_PATH = path.join(ROOT, "docs", "QUOTA-WEIGHTS.md");

export const KINDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
export const FREE_KINDS = KINDS.filter((k) => k !== "input");
/** Token field in req / seg rows for each kind. */
export const TOKEN_FIELD = { input: "input", output: "output", cacheRead: "cache_read", cacheWrite5m: "cache_write_5m", cacheWrite1h: "cache_write_1h" };
export const ARMS = ["input", "output", "read", "write1h", "write5m"];
export const ARM_KIND = { input: "input", output: "output", read: "cacheRead", write1h: "cacheWrite1h", write5m: "cacheWrite5m" };
/** Non-protocol arm labels: `mixed` (counted, any workload) and `context` (meter anchoring only, never counted). */
export const EXTRA_ARMS = ["mixed", "context"];
export const SCHEMA = { session: "quota-weights.session/1", segments: "quota-weights.segments/1", fit: "quota-weights.fit/1" };
export const METER_SOURCES = ["rate_limit_event", "statusline", "oauth_usage", "headers", "usage_screenshot", "manual", "codex_rollout", "antigravity_usage"];
export const BARS = ["5h", "7d"];
export const CLASSES = ["interactive", "sdk"];

export const T = {
  anchorMaxPoints: 0.15, // §1.4.2: both requests before an anchor tick cost ≤ 0.15 point
  defaultBoundaryPoints: 0.05, // anchored seg rows without boundary_points
  unanchoredVar: 1 / 6, // §1.4.4: ±1 point, variance 1/6 point²
  tau0: 0.03,
  tauFloor: 0.01,
  identShare: 0.5, // §3.2.4: some segment has ≥ 50% of its quota-$ in the kind
  minorShare: 0.05, // a kind below 5% of list-$ in every segment is held at list price (weight 1), not fitted
  condMax: 100, // §3.2.4: condition number of the γ-profiled, column-normalised design
  boot: 2000,
  drawsKept: 200,
  perm: 1000,
  seed: 1,
  requiredKinds: ["output", "cacheRead", "cacheWrite1h"], // kinds the Claude correction uses
  g1: { sessions: 3, accounts: 2, identifiedSessions: 2 },
  g2: { median: 0.05, max: 0.15 },
  g3: { ratio: 1.15, p: 0.05 },
  g4: { minPoints: 5, spanPp: 20, rms: 0.07 },
  g5: { runs: 200, sessions: 3, points: 3, noise: 0.03, parity: 0.68, bias: 0.01, half95: 0.07 },
  hetero: { p: 0.05, diff: 0.1 },
  priceTolerance: 0.01,
  sigmaFloor: 0.03,
  vendorDefaultSigma: { anthropic: 0.15, openai: 0.05, google: 0.15 },
};

// ---------------------------------------------------------------------------------------------
// Small numerics
// ---------------------------------------------------------------------------------------------

/** mulberry32: seeded PRNG so fits and simulations reproduce. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussFrom = (rand) => () => (rand() + rand() + rand() + rand() + rand() + rand() - 3) * Math.SQRT2;

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function invert(A) {
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const x = solve(A, e);
    if (!x) return null;
    cols.push(x);
  }
  return A.map((_, i) => cols.map((c) => c[i]));
}
/** Jacobi eigen-decomposition of a small symmetric matrix → { values, vectors (columns) }. */
function eigSym(A) {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: v };
}
export const quantile = (arr, q) => {
  const s = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = (a) => quantile(a, 0.5);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const round = (x, d = 6) => (x == null || !Number.isFinite(x) ? x ?? null : Number(x.toFixed(d)));

/** Regularised lower incomplete gamma P(a, x) (Numerical Recipes gser / gcf). */
function gammp(a, x) {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
/** Upper tail of χ² with df degrees of freedom. */
export const chi2Sf = (q, df) => (df > 0 ? 1 - gammp(df / 2, q / 2) : 1);

// ---------------------------------------------------------------------------------------------
// Prices, keys, φ
// ---------------------------------------------------------------------------------------------

export function loadPrices(file = PRICES_PATH) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j;
}
/** $/token by kind for a model, from prices.json ($ per 1M tokens). */
export function priceFor(prices, model) {
  const p = prices?.models?.[model];
  if (!p) return null;
  return Object.fromEntries(KINDS.map((k) => [k, p[k] / 1e6]));
}
export const classOf = (h) => h.client_class || (/^sdk/.test(String(h.entrypoint || "")) ? "sdk" : "interactive");
export const cellKey = (vendor, model, bar, cls) => `${vendor}/${model}/${bar}/${cls}`;
export function isoWeek(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
/** φ(mix) = Σ w_k usd_k / Σ usd_k. `w` missing a kind → that kind at 1. */
export function phi(usd, w) {
  const tot = KINDS.reduce((s, k) => s + (usd[k] || 0), 0);
  if (!(tot > 0)) return null;
  return KINDS.reduce((s, k) => s + (w[k] ?? 1) * (usd[k] || 0), 0) / tot;
}
const usdOfTokens = (tok, price) => Object.fromEntries(KINDS.map((k) => [k, (tok[k] || 0) * price[k]]));
const tokensOfRow = (r) => Object.fromEntries(KINDS.map((k) => [k, Number(r[TOKEN_FIELD[k]] || 0)]));
const sumUsd = (u) => KINDS.reduce((s, k) => s + (u[k] || 0), 0);

// ---------------------------------------------------------------------------------------------
// Loading and validation (§2)
// ---------------------------------------------------------------------------------------------

export function parseJsonl(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
export function listJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJsonl(p));
    else if (ent.name.endsWith(".jsonl")) out.push(p);
  }
  return out.sort();
}
const isNonNegInt = (x) => Number.isInteger(x) && x >= 0;

/** Returns the reason the file is rejected, or null. Exclusions that keep the file (emulated label, holdout) are not errors. */
export function validateSubmission(sub, prices) {
  const { header: h, rows } = sub;
  if (!h || typeof h !== "object") return "no header";
  if (h.schema !== SCHEMA.session && h.schema !== SCHEMA.segments) return `unknown schema ${h.schema}`;
  for (const f of ["session_id", "submitter", "account_hash", "vendor", "plan", "model", "client", "entrypoint", "meter_source"]) {
    if (h[f] == null || h[f] === "") return `header.${f} missing`;
  }
  if (!METER_SOURCES.includes(h.meter_source)) return `meter_source ${h.meter_source} unknown`;
  if (!Array.isArray(h.bars) || !h.bars.length || h.bars.some((b) => !BARS.includes(b.id))) return "header.bars must list 5h / 7d";
  if (!CLASSES.includes(classOf(h))) return `client class ${classOf(h)} unknown`;
  if (h.simulated === true) return "simulated (dry run)";
  if (!h.raw || !h.raw.url) return "raw.url missing";
  if (h.shared_account !== false) return "shared_account is not false";
  // null = idle baseline not recorded (seeds from public reports): kept, but such a session cannot pass G1.
  if (h.idle_ticks !== 0 && h.idle_ticks !== null) return `idle_ticks = ${h.idle_ticks}: meter moved while idle`;
  const price = priceFor(prices, h.model);
  if (!price) return `no list price for ${h.model} in prices.json`;
  const hp = h.prices_usd_per_mtok;
  if (!hp) return "prices_usd_per_mtok missing";
  for (const k of KINDS) {
    if (hp[k] == null) continue;
    const ref = price[k] * 1e6;
    if (Math.abs(hp[k] - ref) > T.priceTolerance * ref) return `price mismatch on ${k}: ${hp[k]} vs ${ref}`;
  }
  const armsOk = new Set([...ARMS, ...EXTRA_ARMS]);
  if (h.schema === SCHEMA.segments) {
    const segs = rows.filter((r) => r.t === "seg");
    if (!segs.length) return "no seg rows";
    for (const s of segs) {
      if (!armsOk.has(s.arm)) return `seg arm ${s.arm} unknown`;
      if (!BARS.includes(s.bar)) return `seg bar ${s.bar} unknown`;
      if (!(Number(s.points) > 0)) return "seg points must be > 0";
      if (typeof s.anchored !== "boolean") return "seg anchored must be boolean";
      for (const k of KINDS) if (!isNonNegInt(s[TOKEN_FIELD[k]] ?? 0)) return `seg ${TOKEN_FIELD[k]} not a non-negative integer`;
    }
    return null;
  }
  const reqs = rows.filter((r) => r.t === "req");
  if (!reqs.length) return "no req rows";
  const ids = new Set();
  for (const r of reqs) {
    if (!armsOk.has(r.arm)) return `req arm ${r.arm} unknown`;
    if (!r.request_id || ids.has(r.request_id)) return `request_id missing or duplicate: ${r.request_id}`;
    ids.add(r.request_id);
    for (const k of KINDS) if (!isNonNegInt(r[TOKEN_FIELD[k]] ?? 0)) return `req ${r.request_id}: ${TOKEN_FIELD[k]} not a non-negative integer`;
  }
  const meters = rows.filter((r) => r.t === "meter");
  for (const bar of h.bars.map((b) => b.id)) {
    const ms = meters.filter((m) => m.bar === bar);
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].resets_at === ms[i - 1].resets_at && Number(ms[i].used_pct) < Number(ms[i - 1].used_pct)) return `meter ${bar} decreased inside a window at ${ms[i].ts}`;
    }
    // resets_at constant inside an arm, on the bar under test (a reset of the other bar only
    // removes that bar's segments for the arm)
    if (h.bar_under_test && bar !== h.bar_under_test) continue;
    const pos = meterPositions(reqs, ms);
    for (const run of armRuns(reqs)) {
      if (run.arm === "context") continue;
      const inside = ms.filter((m, i) => pos[i] >= run.start && pos[i] <= run.end);
      if (new Set(inside.map((m) => m.resets_at)).size > 1) return `window reset during arm ${run.arm} (${bar})`;
    }
  }
  return null;
}

export function loadSubmissions(dir = SUBMISSIONS_DIR, prices = loadPrices()) {
  const out = [];
  const seen = new Set();
  for (const file of listJsonl(dir)) {
    const rel = path.relative(ROOT, file);
    let rows;
    try {
      rows = parseJsonl(fs.readFileSync(file, "utf8"));
    } catch (err) {
      out.push({ file: rel, error: `unreadable: ${err.message}` });
      continue;
    }
    const sub = { file: rel, header: rows[0], rows: rows.slice(1) };
    sub.error = validateSubmission(sub, prices);
    if (!sub.error && seen.has(sub.header.session_id)) sub.error = `duplicate session_id ${sub.header.session_id}`;
    if (!sub.error) seen.add(sub.header.session_id);
    out.push(sub);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Segments (§1.4): tick-to-tick, anchor-on-tick rule
// ---------------------------------------------------------------------------------------------

/** Position of each meter row: index of the last request it follows (−1 = before any request). */
function meterPositions(reqs, meters) {
  const idx = new Map(reqs.map((r, i) => [r.request_id, i]));
  return meters.map((m) => {
    if (m.after_request_id != null && idx.has(m.after_request_id)) return idx.get(m.after_request_id);
    const t = Date.parse(m.ts);
    let p = -1;
    for (let i = 0; i < reqs.length; i++) if (Date.parse(reqs[i].ts) <= t) p = i;
    return p;
  });
}
/** Contiguous runs of requests with the same arm and block. */
function armRuns(reqs) {
  const runs = [];
  for (let i = 0; i < reqs.length; i++) {
    const key = `${reqs[i].arm}|${reqs[i].block ?? ""}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.end = i;
    else runs.push({ key, arm: reqs[i].arm, block: reqs[i].block ?? null, start: i, end: i });
  }
  return runs;
}

/**
 * Meter readings per request for one bar: val[i] = reading after request i, tick[i] = the reading
 * after request i rose above the previous reading inside the same window.
 */
export function meterTrack(reqs, meters) {
  const pos = meterPositions(reqs, meters);
  const val = new Array(reqs.length).fill(null);
  const win = new Array(reqs.length).fill(null);
  const tick = new Array(reqs.length).fill(false);
  let prev = null;
  let prevWin = null;
  const byPos = new Map();
  meters.forEach((m, i) => {
    if (!byPos.has(pos[i])) byPos.set(pos[i], []);
    byPos.get(pos[i]).push(m);
  });
  for (const m of byPos.get(-1) || []) {
    prev = Number(m.used_pct);
    prevWin = m.resets_at ?? null;
  }
  const base = { val: prev, win: prevWin };
  for (let i = 0; i < reqs.length; i++) {
    const ms = byPos.get(i) || [];
    let v = prev;
    let w = prevWin;
    for (const m of ms) {
      const u = Number(m.used_pct);
      if ((m.resets_at ?? null) !== w) {
        v = u;
        w = m.resets_at ?? null;
        prev = null; // window changed: no tick across it
      } else v = v == null ? u : Math.max(v, u);
    }
    val[i] = v;
    win[i] = w;
    tick[i] = ms.length > 0 && prev != null && v > prev && w === prevWin;
    prev = v;
    prevWin = w;
  }
  return { val, win, tick, base };
}

/**
 * Segments of one session/1 file for one bar. Request cost in points is estimated from list-$
 * per point of its arm run (session-wide when a run moved no point).
 */
export function sessionSegments(sub, price, bar) {
  const h = sub.header;
  const reqs = sub.rows.filter((r) => r.t === "req");
  const meters = sub.rows.filter((r) => r.t === "meter" && r.bar === bar);
  if (!reqs.length || !meters.length) return [];
  const { val, win, tick, base } = meterTrack(reqs, meters);
  const usd = reqs.map((r) => usdOfTokens(tokensOfRow(r), price));
  const tot = usd.map(sumUsd);
  const runs = armRuns(reqs);
  // list-$ per point
  const movedBetween = (a, b) => {
    // points moved from reading before request a to reading after request b, inside one window
    const v0 = a > 0 ? val[a - 1] : base.val;
    const v1 = val[b];
    if (v0 == null || v1 == null || win[b] !== (a > 0 ? win[a - 1] : base.win)) return null;
    return v1 - v0;
  };
  let sessUsd = 0;
  let sessPts = 0;
  for (const run of runs) {
    if (run.arm === "context") continue;
    const d = movedBetween(run.start, run.end);
    if (d > 0) {
      sessUsd += tot.slice(run.start, run.end + 1).reduce((x, y) => x + y, 0);
      sessPts += d;
    }
  }
  const sessP = sessPts > 0 ? sessUsd / sessPts : null;
  const cost = new Array(reqs.length).fill(null);
  for (const run of runs) {
    const d = movedBetween(run.start, run.end);
    const u = tot.slice(run.start, run.end + 1).reduce((x, y) => x + y, 0);
    // context runs follow a gap in the file: their meter delta is not theirs
    const P = run.arm !== "context" && d > 0 ? u / d : sessP;
    for (let i = run.start; i <= run.end; i++) cost[i] = P ? tot[i] / P : Infinity;
  }
  const valid = (i) => i >= 0 && tick[i] && cost[i] <= T.anchorMaxPoints && (i === 0 || cost[i - 1] <= T.anchorMaxPoints);
  const mode = h.segmenting === "point" ? "point" : "arm";
  const segs = [];
  for (const run of runs) {
    if (run.arm === "context") continue;
    const anchors = [];
    // Chain start (previous run's last tick) only when the file says the runs use the same request
    // sizes: with a one-request meter lag, the shift cancels only between equal-sized requests.
    if (h.chain_anchors === true && run.start > 0 && valid(run.start - 1)) anchors.push(run.start - 1);
    for (let i = run.start; i <= run.end; i++) if (valid(i)) anchors.push(i);
    if (anchors.length < 2) continue;
    const pairs = mode === "point" ? anchors.slice(1).map((b, j) => [anchors[j], b]) : [[anchors[0], anchors[anchors.length - 1]]];
    for (const [a, b] of pairs) {
      if (win[a] !== win[b]) continue;
      const points = val[b] - val[a];
      if (!(points >= 1)) continue;
      const tok = Object.fromEntries(KINDS.map((k) => [k, 0]));
      for (let i = a + 1; i <= b; i++) for (const k of KINDS) tok[k] += Number(reqs[i][TOKEN_FIELD[k]] || 0);
      segs.push({
        arm: run.arm,
        block: run.block,
        bar,
        y: points,
        anchored: true,
        boundary: [cost[a], cost[b]],
        tokens: tok,
        usd: usdOfTokens(tok, price),
        ts_start: reqs[a + 1].ts,
        ts_end: reqs[b].ts,
      });
    }
  }
  return segs;
}

function segRowsSegments(sub, price, bar) {
  return sub.rows
    .filter((r) => r.t === "seg" && r.bar === bar)
    .map((r) => {
      const tok = tokensOfRow(r);
      const b = r.anchored ? r.boundary_points || [T.defaultBoundaryPoints, T.defaultBoundaryPoints] : null;
      return { arm: r.arm, block: r.block ?? null, bar, y: Number(r.points), anchored: r.anchored, boundary: b, tokens: tok, usd: usdOfTokens(tok, price), ts_start: r.ts_start, ts_end: r.ts_end };
    });
}

/** Holdout chunks (G4): consecutive valid anchors at least g4.minPoints apart, arms ignored. */
function holdoutChunks(sub, price, bar) {
  const h = { ...sub, header: { ...sub.header, segmenting: "point" }, rows: sub.rows.map((r) => (r.t === "req" ? { ...r, arm: "mixed", block: null } : r)) };
  const pts = sessionSegments(h, price, bar);
  const chunks = [];
  let cur = null;
  for (const s of pts) {
    if (!cur) cur = { ...s, tokens: { ...s.tokens }, usd: { ...s.usd } };
    else {
      cur.y += s.y;
      for (const k of KINDS) {
        cur.tokens[k] += s.tokens[k];
        cur.usd[k] += s.usd[k];
      }
      cur.boundary = [cur.boundary[0], s.boundary[1]];
      cur.ts_end = s.ts_end;
    }
    if (cur.y >= T.g4.minPoints) {
      chunks.push(cur);
      cur = null;
    }
  }
  return chunks;
}

/** Every segment of every accepted submission, tagged with its cell, group and exclusion state. */
export function buildSegments(subs, prices) {
  const segs = [];
  for (const sub of subs) {
    if (sub.error) continue;
    const h = sub.header;
    const price = priceFor(prices, h.model);
    const cls = classOf(h);
    const firstTs = sub.rows.find((r) => r.ts || r.ts_start)?.ts || sub.rows.find((r) => r.ts_start)?.ts_start || h.started_at;
    for (const bar of h.bars.map((b) => b.id)) {
      const raw = h.holdout ? holdoutChunks(sub, price, bar) : h.schema === SCHEMA.segments ? segRowsSegments(sub, price, bar) : sessionSegments(sub, price, bar);
      for (const s of raw) {
        segs.push({
          ...s,
          file: sub.file,
          session: h.session_id,
          submitter: h.submitter,
          account: h.account_hash,
          plan: normPlan(h.plan),
          entrypoint: h.entrypoint,
          clientVersion: h.client_version || null,
          cls,
          cell: cellKey(h.vendor, h.model, bar, cls),
          group: [h.account_hash, normPlan(h.plan), bar, cls, h.model, isoWeek(firstTs)].join("|"),
          emulated: h.label_emulated === true,
          idleRecorded: h.idle_ticks === 0,
          holdout: h.holdout === true,
          r: s.anchored ? (s.boundary[0] ** 2 + s.boundary[1] ** 2) / 12 + 1e-4 : T.unanchoredVar,
        });
      }
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------------------------
// Fit (§3.2): alternating γ / weighted NNLS
// ---------------------------------------------------------------------------------------------

/** Weighted NNLS by enumerating active sets on the Gram matrix (K ≤ 6). */
export function nnlsGram(G, h, tt) {
  const K = h.length;
  let best = null;
  for (let mask = 0; mask < 1 << K; mask++) {
    const idx = [];
    for (let k = 0; k < K; k++) if (mask & (1 << k)) idx.push(k);
    const b = new Array(K).fill(0);
    if (idx.length) {
      const sol = solve(
        idx.map((i) => idx.map((j) => G[i][j])),
        idx.map((i) => h[i])
      );
      if (!sol || sol.some((x) => !(x >= 0))) continue;
      idx.forEach((k, i) => (b[k] = sol[i]));
    }
    let rss = tt;
    for (let i = 0; i < K; i++) {
      rss -= 2 * b[i] * h[i];
      for (let j = 0; j < K; j++) rss += b[i] * G[i][j] * b[j];
    }
    if (!best || rss < best.rss - 1e-15 * Math.max(1, Math.abs(best.rss))) best = { b, rss };
  }
  return best.b;
}

/**
 * Fit weights shared across `segs`, one γ per group. `free` kinds are estimated; the others are
 * fixed at 1 (input) or `fixed[k]`.
 */
export function fitSegments(segs, { free = FREE_KINDS, fixed = {}, tau = T.tau0, iters = 200, w0 = null } = {}) {
  const groups = [...new Set(segs.map((s) => s.group))];
  const w = Object.fromEntries(KINDS.map((k) => [k, k === "input" ? 1 : fixed[k] ?? w0?.[k] ?? 1]));
  if (w0) for (const k of free) w[k] = w0[k] ?? 1;
  const gamma = Object.fromEntries(groups.map((g) => [g, 1]));
  const v = segs.map((s) => s.r + (tau * s.y) ** 2);
  const z = (s) => KINDS.reduce((q, k) => q + w[k] * (s.usd[k] || 0), 0);
  const K = free.length;
  let rounds = 0;
  for (let it = 0; it < iters; it++) {
    rounds = it + 1;
    const prev = free.map((k) => w[k]);
    const num = {};
    const den = {};
    segs.forEach((s, i) => {
      const zz = z(s);
      num[s.group] = (num[s.group] || 0) + (s.y * zz) / v[i];
      den[s.group] = (den[s.group] || 0) + (zz * zz) / v[i];
    });
    for (const g of groups) if (den[g] > 0) gamma[g] = num[g] / den[g];
    if (!K) break;
    const G = Array.from({ length: K }, () => new Array(K).fill(0));
    const h = new Array(K).fill(0);
    let tt = 0;
    segs.forEach((s, i) => {
      const g = gamma[s.group];
      if (!(g > 0)) return;
      const fixedPart = KINDS.filter((k) => !free.includes(k)).reduce((q, k) => q + w[k] * (s.usd[k] || 0), 0);
      const t = s.y / g - fixedPart;
      const om = (g * g) / v[i];
      const x = free.map((k) => s.usd[k] || 0);
      for (let a = 0; a < K; a++) {
        h[a] += om * x[a] * t;
        for (let b = 0; b < K; b++) G[a][b] += om * x[a] * x[b];
      }
      tt += om * t * t;
    });
    const b = nnlsGram(G, h, tt);
    free.forEach((k, i) => (w[k] = b[i]));
    if (free.every((k, i) => Math.abs(w[k] - prev[i]) < 1e-10)) break;
  }
  let rss = 0;
  const resid = segs.map((s, i) => {
    const pred = gamma[s.group] * z(s);
    rss += (s.y - pred) ** 2 / v[i];
    return { pred, r: s.y - pred, rel: (s.y - pred) / s.y };
  });
  return { w, gamma, tau, rss, resid, rounds };
}

/** Fit with τ re-estimated from anchored residuals (df-corrected RMS, floor 0.01). */
export function fitWithTau(segs, opts = {}) {
  let tau = T.tau0;
  let f = fitSegments(segs, { ...opts, tau });
  const groups = new Set(segs.map((s) => s.group)).size;
  const df = segs.filter((s) => s.anchored).length - (opts.free || FREE_KINDS).length - groups;
  for (let i = 0; i < 6 && df > 0; i++) {
    const rel = segs.map((s, j) => (s.anchored ? f.resid[j].rel : null)).filter((x) => x != null);
    const next = Math.max(T.tauFloor, Math.sqrt(rel.reduce((a, x) => a + x * x, 0) / df));
    if (Math.abs(next - tau) < 1e-4) break;
    tau = next;
    f = fitSegments(segs, { ...opts, tau, w0: f.w });
  }
  return f;
}

/**
 * Identifiability (§3.2.4): γ-profiled Fisher information on the free kinds, normalised to unit
 * diagonal; kinds on near-null directions (design condition number ≥ 100) and kinds with no segment
 * at ≥ 50% quota-$ share are unidentified. Returns the covariance of identified kinds.
 */
export function identify(segs, fit, free) {
  const v = segs.map((s) => s.r + (fit.tau * s.y) ** 2);
  const share = Object.fromEntries(free.map((k) => [k, 0]));
  for (const s of segs) {
    const q = KINDS.reduce((a, k) => a + fit.w[k] * (s.usd[k] || 0), 0);
    const l = sumUsd(s.usd);
    if (!(q > 0) || !(l > 0)) continue;
    // a kind dominates a segment at both its fitted weight and list price (a runaway weight on a
    // minor kind cannot identify itself)
    for (const k of free) share[k] = Math.max(share[k], Math.min((fit.w[k] * (s.usd[k] || 0)) / q, (s.usd[k] || 0) / l));
  }
  let kinds = free.filter((k) => segs.some((s) => (s.usd[k] || 0) > 0));
  const reason = Object.fromEntries(free.filter((k) => !kinds.includes(k)).map((k) => [k, "no data"]));
  const groups = [...new Set(segs.map((s) => s.group))];
  const info = (ks) => {
    const n = ks.length;
    const Iww = Array.from({ length: n }, () => new Array(n).fill(0));
    const Iwg = Object.fromEntries(groups.map((g) => [g, new Array(n).fill(0)]));
    const Igg = Object.fromEntries(groups.map((g) => [g, 0]));
    segs.forEach((s, i) => {
      const g = fit.gamma[s.group];
      const z = KINDS.reduce((a, k) => a + fit.w[k] * (s.usd[k] || 0), 0);
      const jw = ks.map((k) => g * (s.usd[k] || 0));
      const om = 1 / v[i];
      for (let a = 0; a < n; a++) {
        Iwg[s.group][a] += om * jw[a] * z;
        for (let b = 0; b < n; b++) Iww[a][b] += om * jw[a] * jw[b];
      }
      Igg[s.group] += om * z * z;
    });
    for (const g of groups) {
      if (!(Igg[g] > 0)) continue;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) Iww[a][b] -= (Iwg[g][a] * Iwg[g][b]) / Igg[g];
    }
    return Iww;
  };
  let cond = null;
  for (;;) {
    if (!kinds.length) break;
    const I = info(kinds);
    const d = I.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
    const zero = kinds.filter((_, i) => !(d[i] > 0));
    if (zero.length) {
      for (const k of zero) reason[k] = "absorbed by γ";
      kinds = kinds.filter((k) => !zero.includes(k));
      continue;
    }
    const C = I.map((r, i) => r.map((x, j) => x / (d[i] * d[j])));
    const { values, vectors } = eigSym(C);
    const lmax = Math.max(...values);
    const iMin = values.indexOf(Math.min(...values));
    const lmin = values[iMin];
    cond = lmin > 0 ? Math.sqrt(lmax / lmin) : Infinity;
    if (cond < T.condMax) break;
    const vec = kinds.map((_, i) => vectors[i][iMin]);
    const maxAbs = Math.max(...vec.map(Math.abs));
    const drop = kinds.filter((_, i) => Math.abs(vec[i]) >= Math.max(0.3, maxAbs * 0.5));
    for (const k of drop) reason[k] = `collinear (condition number ${Number.isFinite(cond) ? cond.toFixed(0) : "∞"})`;
    kinds = kinds.filter((k) => !drop.includes(k));
  }
  for (const k of [...kinds]) {
    if (share[k] < T.identShare) {
      reason[k] = `max quota-$ share ${(100 * share[k]).toFixed(0)}% < 50%`;
      kinds = kinds.filter((x) => x !== k);
    }
  }
  let cov = null;
  if (kinds.length) {
    const inv = invert(info(kinds));
    if (inv) cov = Object.fromEntries(kinds.map((k, i) => [k, Object.fromEntries(kinds.map((q, j) => [q, inv[i][j]]))]));
  }
  // Full-design condition number (all kinds with data), reported for diagnostics.
  let fullCond = cond;
  const withData = free.filter((k) => segs.some((s) => (s.usd[k] || 0) > 0));
  if (withData.length) {
    const I = info(withData);
    const d = I.map((r, i) => Math.sqrt(Math.max(r[i], 0)));
    if (d.every((x) => x > 0)) {
      const { values } = eigSym(I.map((r, i) => r.map((x, j) => x / (d[i] * d[j]))));
      const lmin = Math.min(...values);
      fullCond = lmin > 0 ? Math.sqrt(Math.max(...values) / lmin) : Infinity;
      // A kind estimated against a partner pinned at the NNLS bound (w ≈ 0) is conditional on that
      // corner: if their estimates correlate strongly, neither is identified.
      const inv = invert(I);
      if (inv) {
        for (const j of withData) {
          if (kinds.includes(j) || !(fit.w[j] < 0.05)) continue;
          const jj = withData.indexOf(j);
          for (const k of [...kinds]) {
            const kk = withData.indexOf(k);
            const r = inv[jj][kk] / Math.sqrt(inv[jj][jj] * inv[kk][kk]);
            if (Math.abs(r) >= 0.8) {
              reason[k] = `conditional on ${j} at the 0 bound (correlation ${r.toFixed(2)})`;
              kinds = kinds.filter((x) => x !== k);
            }
          }
        }
      }
    } else fullCond = Infinity;
  }
  if (cov) cov = Object.fromEntries(Object.entries(cov).filter(([k]) => kinds.includes(k)));
  return { identified: Object.fromEntries(free.map((k) => [k, kinds.includes(k)])), reason, share, cov, conditionNumber: fullCond };
}

/** Cluster bootstrap (§3.2.5): sessions within group; segments when a group has < 3 sessions. */
export function bootstrap(segs, { free, tau, w0, B, rand }) {
  const groups = [...new Set(segs.map((s) => s.group))];
  const byGroup = groups.map((g) => {
    const S = segs.filter((s) => s.group === g);
    const sessions = [...new Set(S.map((s) => s.session))];
    return { S, sessions, bySession: sessions.map((id) => S.filter((s) => s.session === id)) };
  });
  const draws = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (const g of byGroup) {
      if (g.sessions.length >= 3) {
        for (let i = 0; i < g.sessions.length; i++) {
          const j = Math.floor(rand() * g.sessions.length);
          for (const s of g.bySession[j]) sample.push({ ...s, session: `${s.session}#${i}` });
        }
      } else {
        for (let i = 0; i < g.S.length; i++) sample.push(g.S[Math.floor(rand() * g.S.length)]);
      }
    }
    draws.push(fitSegments(sample, { free, tau, w0 }).w);
  }
  return draws;
}

// ---------------------------------------------------------------------------------------------
// Validation (§4)
// ---------------------------------------------------------------------------------------------

const isParityArm = (s) => s.arm === "input" || s.arm === "output";

/** Kinds identified inside one session: some segment with ≥ 50% of its quota-$ in the kind. */
function sessionIdentified(segs, w, free) {
  const out = new Set();
  for (const s of segs) {
    const q = KINDS.reduce((a, k) => a + w[k] * (s.usd[k] || 0), 0);
    const l = sumUsd(s.usd);
    if (!(q > 0) || !(l > 0)) continue;
    for (const k of free) if (Math.min((w[k] * (s.usd[k] || 0)) / q, (s.usd[k] || 0) / l) >= T.identShare) out.add(k);
  }
  return out;
}

/** G2: leave one session out; γ of its group from its parity arms only; predict its other arms. */
export function loso(segs, free, tau) {
  const sessions = [...new Set(segs.map((s) => s.session))];
  const errs = [];
  const perSession = [];
  for (const id of sessions) {
    const own = segs.filter((s) => s.session === id);
    const rest = segs.filter((s) => s.session !== id);
    const parity = own.filter(isParityArm);
    const other = own.filter((s) => !isParityArm(s));
    if (!rest.length || !parity.length || !other.length) continue;
    const f = fitSegments(rest, { free, tau });
    const idRest = identify(rest, f, free);
    const needs = free.filter((k) => other.some((s) => (s.usd[k] || 0) / sumUsd(s.usd) >= T.minorShare));
    if (needs.some((k) => !idRest.identified[k])) {
      perSession.push({ session: id, skipped: "refit without this session does not identify its kinds" });
      continue;
    }
    const z = (s) => KINDS.reduce((q, k) => q + f.w[k] * (s.usd[k] || 0), 0);
    let num = 0;
    let den = 0;
    for (const s of parity) {
      const om = 1 / (s.r + (tau * s.y) ** 2);
      num += om * s.y * z(s);
      den += om * z(s) ** 2;
    }
    if (!(den > 0)) continue;
    const g = num / den;
    const e = other.map((s) => Math.log((g * z(s)) / s.y));
    errs.push(...e);
    perSession.push({ session: id, n: e.length, maxAbsLn: round(Math.max(...e.map(Math.abs)), 4) });
  }
  const evaluated = perSession.filter((x) => !x.skipped).length;
  if (!errs.length) return { n: 0, sessions: 0, medianAbsLn: null, maxAbsLn: null, perSession, pass: false };
  const abs = errs.map(Math.abs);
  const med = median(abs);
  const max = Math.max(...abs);
  return { n: errs.length, sessions: evaluated, medianAbsLn: round(med, 4), maxAbsLn: round(max, 4), perSession, pass: evaluated >= 2 && med <= T.g2.median && max <= T.g2.max };
}

/** Per-level weights with delta-method variance of ln w (for Q, I², DerSimonian–Laird). */
function levelFits(segs, levelOf, free, tau, w0 = null) {
  const levels = [...new Set(segs.map(levelOf))];
  return levels.map((lv) => {
    const S = segs.filter((s) => levelOf(s) === lv);
    const f = fitSegments(S, { free, tau, w0 });
    const id = identify(S, f, free);
    const lnw = {};
    const vln = {};
    for (const k of free) {
      if (!id.identified[k] || !(f.w[k] > 0) || !id.cov?.[k]) continue;
      lnw[k] = Math.log(f.w[k]);
      vln[k] = Math.max(id.cov[k][k], 1e-12) / f.w[k] ** 2;
    }
    return { level: lv, sessions: new Set(S.map((s) => s.session)).size, rss: f.rss, w: f.w, lnw, vln };
  });
}
function qTest(fits, k) {
  const xs = fits.filter((f) => f.lnw[k] != null);
  if (xs.length < 2) return null;
  const wsum = xs.reduce((a, f) => a + 1 / f.vln[k], 0);
  const mu = xs.reduce((a, f) => a + f.lnw[k] / f.vln[k], 0) / wsum;
  const Q = xs.reduce((a, f) => a + (f.lnw[k] - mu) ** 2 / f.vln[k], 0);
  const df = xs.length - 1;
  const w2 = xs.reduce((a, f) => a + 1 / f.vln[k] ** 2, 0);
  const tau2 = Math.max(0, (Q - df) / (wsum - w2 / wsum));
  return { k: xs.length, Q, df, p: chi2Sf(Q, df), I2: Q > df ? (Q - df) / Q : 0, tauB: Math.sqrt(tau2), ratio: Math.exp(Math.max(...xs.map((f) => f.lnw[k])) - Math.min(...xs.map((f) => f.lnw[k]))) };
}

/** §3.2.6 heterogeneity per dimension, with a session-label permutation test on the RSS drop. */
export function heterogeneity(segs, free, tau, { perm = T.perm, rand }) {
  const dims = {
    submitter: (s) => s.submitter,
    account: (s) => s.account,
    plan: (s) => s.plan,
    entrypoint: (s) => s.entrypoint,
    clientVersion: (s) => s.clientVersion || "unknown",
  };
  const pooled = fitSegments(segs, { free, tau });
  const out = [];
  const done = new Map(); // identical session partitions (e.g. one submitter per account) are tested once
  for (const [dim, levelOf] of Object.entries(dims)) {
    const levels = [...new Set(segs.map(levelOf))];
    if (levels.length < 2) continue;
    const sig = [...new Set(segs.map((s) => `${s.session}=${levels.indexOf(levelOf(s))}`))].sort().join(",");
    if (done.has(sig)) {
      out.push({ ...done.get(sig), dimension: dim, sameAs: done.get(sig).dimension });
      continue;
    }
    const fits = levelFits(segs, levelOf, free, tau, pooled.w);
    const measured = fits.filter((f) => Object.keys(f.lnw).length);
    const drop = pooled.rss - fits.reduce((a, f) => a + f.rss, 0);
    // permutation of level labels across sessions
    const sessions = [...new Set(segs.map((s) => s.session))];
    const labelOf = new Map(sessions.map((id) => [id, levelOf(segs.find((s) => s.session === id))]));
    const labels = sessions.map((id) => labelOf.get(id));
    let ge = 0;
    const P = sessions.length > levels.length ? perm : 0;
    const memo = new Map(); // few sessions → few distinct arrangements
    for (let p = 0; p < P; p++) {
      const sh = [...labels];
      for (let i = sh.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [sh[i], sh[j]] = [sh[j], sh[i]];
      }
      const key = sh.join("\u0000");
      if (!memo.has(key)) {
        const map = new Map(sessions.map((id, i) => [id, sh[i]]));
        memo.set(key, [...new Set(sh)].reduce((a, lv) => a + fitSegments(segs.filter((s) => map.get(s.session) === lv), { free, tau, w0: pooled.w }).rss, 0));
      }
      if (pooled.rss - memo.get(key) >= drop - 1e-12) ge++;
    }
    const pPerm = P ? (ge + 1) / (P + 1) : null;
    const perKind = {};
    for (const k of free) {
      const q = qTest(fits, k);
      if (q) perKind[k] = { Q: round(q.Q, 4), I2: round(q.I2, 4), p: round(q.p, 4), ratio: round(q.ratio, 4) };
    }
    const maxRatio = Math.max(1, ...Object.values(perKind).map((x) => x.ratio));
    const row = {
      dimension: dim,
      levels: fits.map((f) => ({ level: f.level, sessions: f.sessions, weights: Object.fromEntries(Object.keys(f.lnw).map((k) => [k, round(f.w[k], 4)])) })),
      perKind,
      pPermutation: pPerm == null ? null : round(pPerm, 4),
      flagged: measured.length >= 2 && pPerm != null && pPerm < T.hetero.p && maxRatio > 1 + T.hetero.diff,
    };
    done.set(sig, row);
    out.push(row);
  }
  return out;
}

/** G3 submitter agreement and τ_b (DerSimonian–Laird on per-submitter ln w). */
export function submitterAgreement(segs, pooledW, free, tau, required) {
  const fits = levelFits(segs, (s) => s.submitter, free, tau);
  const tauBetween = {};
  const checks = {};
  for (const k of free) {
    const q = qTest(fits, k);
    tauBetween[k] = q ? round(q.tauB, 4) : null;
    const xs = fits.filter((f) => f.lnw[k] != null);
    const within = xs.length >= 2 && xs.every((f) => Math.abs(f.lnw[k] - Math.log(pooledW[k])) <= Math.log(T.g3.ratio));
    checks[k] = { submitters: xs.length, within, p: q ? round(q.p, 4) : null, pass: xs.length >= 2 && (within || (q && q.p >= T.g3.p)) };
  }
  const pass = fits.length >= 2 && required.every((k) => checks[k]?.pass);
  return { submitters: fits.length, checks, tauBetween, pass };
}

/** G4 mixed-workload holdout: γ on half the chunks, predict the rest; compare with list-price weights. */
export function holdoutCheck(chunks, w) {
  if (chunks.length < 2) return { n: chunks.length, pass: false };
  const readShare = chunks.map((c) => c.usd.cacheRead / sumUsd(c.usd));
  const spanPp = 100 * (Math.max(...readShare) - Math.min(...readShare));
  const rmsFor = (ww) => {
    const errs = [];
    for (const grp of new Set(chunks.map((c) => c.group))) {
      const C = chunks.filter((c) => c.group === grp);
      const fitHalf = C.filter((_, i) => i % 2 === 0);
      const test = C.filter((_, i) => i % 2 === 1);
      const z = (c) => KINDS.reduce((a, k) => a + (ww[k] ?? 1) * (c.usd[k] || 0), 0);
      const g = fitHalf.reduce((a, c) => a + c.y * z(c), 0) / fitHalf.reduce((a, c) => a + z(c) ** 2, 0);
      for (const c of test) errs.push(Math.log((g * z(c)) / c.y));
    }
    return errs.length ? Math.sqrt(mean(errs.map((e) => e * e))) : null;
  };
  const rmsFit = rmsFor(w);
  const rmsList = rmsFor(Object.fromEntries(KINDS.map((k) => [k, 1])));
  const pass = rmsFit != null && spanPp >= T.g4.spanPp && rmsFit <= T.g4.rms && rmsFit < rmsList;
  return { n: chunks.length, spanPp: round(spanPp, 2), rmsLnFit: round(rmsFit, 4), rmsLnList: round(rmsList, 4), pass };
}

/** Censoring check (§3.1): every unanchored prediction lies inside (points − 1, points + 1). */
const censoringViolations = (segs, fit) => segs.filter((s, i) => !s.anchored && Math.abs(fit.resid[i].r) >= 1).length;

// ---------------------------------------------------------------------------------------------
// Cell fit and gate
// ---------------------------------------------------------------------------------------------

/**
 * Gate from the check results (§4). Exported for tests.
 * status: validated (G1–G5) | provisional (some identified kind) | unmeasured.
 */
export function gateStatus({ coverage, loso: g2, agreement, holdout, simulation, anyIdentified }) {
  const gate = { coverage: !!coverage, loso: !!g2, agreement: !!agreement, holdout: !!holdout, simulation: !!simulation };
  const status = Object.values(gate).every(Boolean) ? "validated" : anyIdentified ? "provisional" : "unmeasured";
  return { gate, status };
}

export function fitCell(key, allSegs, { boot = T.boot, perm = T.perm, seed = T.seed, simulationPass = false, includeEmulated = false } = {}) {
  const [vendor, model, bar, cls] = key.split("/");
  const inCell = allSegs.filter((s) => s.cell === key);
  const holdoutChunksAll = inCell.filter((s) => s.holdout);
  const fitPool = inCell.filter((s) => !s.holdout);
  const real = fitPool.filter((s) => !s.emulated);
  const segs = real.length && !includeEmulated ? real : fitPool;
  const excludedEmulated = [...new Set(fitPool.filter((s) => s.emulated && !segs.includes(s)).map((s) => s.session))];
  const base = {
    key,
    vendor,
    model,
    bar,
    clientClass: cls,
    status: "unmeasured",
    weights: Object.fromEntries(KINDS.map((k) => [k, k === "input" ? 1 : null])),
    identified: Object.fromEntries(FREE_KINDS.map((k) => [k, false])),
    ci95: {},
    tauBetween: {},
    drawKinds: KINDS,
    draws: [],
    n: { sessions: 0, accounts: 0, submitters: 0, segments: 0, points: 0, emulatedSessions: 0, excludedEmulated: excludedEmulated.length, holdoutChunks: holdoutChunksAll.length },
    gate: { coverage: false, loso: false, agreement: false, holdout: false, simulation: !!simulationPass },
  };
  if (!segs.length) return base;
  const listShare = (s, k) => (s.usd[k] || 0) / (sumUsd(s.usd) || 1);
  const free = FREE_KINDS.filter((k) => segs.some((s) => listShare(s, k) >= T.minorShare));
  const minor = FREE_KINDS.filter((k) => !free.includes(k) && segs.some((s) => (s.usd[k] || 0) > 0));
  const f = fitWithTau(segs, { free });
  const id = identify(segs, f, free);
  for (const k of minor) id.reason[k] = `below ${100 * T.minorShare}% of list-$ in every segment: held at list price`;
  for (const k of FREE_KINDS) if (!free.includes(k)) id.identified[k] = false;
  const rand = rng(seed);
  const draws = free.length ? bootstrap(segs, { free, tau: f.tau, w0: f.w, B: boot, rand }) : [];
  const sessions = [...new Set(segs.map((s) => s.session))];
  const accounts = new Set(segs.map((s) => s.account));
  const submitters = new Set(segs.map((s) => s.submitter));
  const emulatedSessions = new Set(segs.filter((s) => s.emulated).map((s) => s.session));
  const noIdleBaseline = new Set(segs.filter((s) => !s.idleRecorded).map((s) => s.session));
  // G1
  const perSessionIdent = sessions.map((sid) => sessionIdentified(segs.filter((s) => s.session === sid), f.w, free));
  const parityEverySession = sessions.every((sid) => segs.some((s) => s.session === sid && isParityArm(s)));
  const reqIdent = T.requiredKinds.every((k) => id.identified[k] && perSessionIdent.filter((set) => set.has(k)).length >= T.g1.identifiedSessions);
  const coverage = sessions.length >= T.g1.sessions && accounts.size >= T.g1.accounts && parityEverySession && reqIdent && emulatedSessions.size === 0 && noIdleBaseline.size === 0;
  // G2, G3, step 6, G4
  const g2 = loso(segs, free, f.tau);
  const g3 = submitterAgreement(segs, f.w, free, f.tau, T.requiredKinds);
  const het = heterogeneity(segs, free, f.tau, { perm, rand });
  const flagged = het.filter((x) => x.flagged).map((x) => x.dimension);
  const g4 = holdoutCheck(holdoutChunksAll, f.w);
  const anyIdentified = Object.values(id.identified).some(Boolean);
  const { gate, status } = gateStatus({ coverage, loso: g2.pass, agreement: g3.pass && !flagged.length, holdout: g4.pass, simulation: simulationPass, anyIdentified });

  const weights = { input: 1 };
  const ci95 = {};
  for (const k of FREE_KINDS) {
    weights[k] = id.identified[k] ? round(f.w[k], 6) : null;
    if (id.identified[k]) {
      const a = draws.map((d) => d[k]);
      ci95[k] = [round(quantile(a, 0.025), 6), round(quantile(a, 0.975), 6)];
    }
  }
  const step = Math.max(1, Math.floor(draws.length / T.drawsKept));
  const kept = draws.filter((_, i) => i % step === 0).slice(0, T.drawsKept);
  return {
    ...base,
    status,
    weights,
    identified: id.identified,
    unidentifiedReason: Object.fromEntries(Object.entries(id.reason).filter(([k]) => !id.identified[k])),
    ci95,
    tauBetween: Object.fromEntries(Object.entries(g3.tauBetween).filter(([k, v]) => v != null && id.identified[k])),
    draws: kept.map((d) => KINDS.map((k) => (k === "input" ? 1 : id.identified[k] ? round(d[k], 6) : null))),
    fitRaw: Object.fromEntries(FREE_KINDS.map((k) => [k, free.includes(k) ? round(f.w[k], 6) : null])),
    parityUsdPerPoint: Object.fromEntries(Object.entries(f.gamma).map(([g, v]) => [g, round(1 / v, 6)])),
    n: {
      ...base.n,
      sessions: sessions.length,
      accounts: accounts.size,
      submitters: submitters.size,
      segments: segs.length,
      points: round(segs.reduce((a, s) => a + s.y, 0), 4),
      emulatedSessions: emulatedSessions.size,
    },
    diagnostics: {
      tau: round(f.tau, 6),
      rounds: f.rounds,
      conditionNumber: Number.isFinite(id.conditionNumber) ? round(id.conditionNumber, 3) : null,
      loso: { n: g2.n, sessions: g2.sessions, medianAbsLn: g2.medianAbsLn, maxAbsLn: g2.maxAbsLn, perSession: g2.perSession },
      submitterAgreement: g3.checks,
      censoringViolations: censoringViolations(segs, f),
      heterogeneity: het,
      holdout: g4,
      coverage: { sessions: sessions.length, accounts: accounts.size, parityEverySession, requiredIdentified: reqIdent, emulatedSessions: emulatedSessions.size, noIdleBaseline: noIdleBaseline.size },
    },
    gate,
  };
}

/** Cells the site needs (model × bar × client class for every priced model), plus every cell with data. */
export function cellKeys(segs, prices) {
  const keys = new Set(segs.map((s) => s.cell));
  for (const [model, p] of Object.entries(prices.models || {})) {
    for (const bar of BARS) for (const cls of CLASSES) keys.add(cellKey(p.vendor || "anthropic", model, bar, cls));
  }
  return [...keys].sort();
}

export function runFit({ dir = SUBMISSIONS_DIR, prices = loadPrices(), boot = T.boot, perm = T.perm, seed = T.seed, runs = T.g5.runs, only = null, poolClasses = false } = {}) {
  const subs = loadSubmissions(dir, prices);
  const segs = buildSegments(subs, prices);
  // Diagnostic only (never written): pool client classes and keep emulated labels, as in the spec's §6.2 joint estimate.
  if (poolClasses) for (const s of segs) s.cell = s.cell.replace(/[/](sdk|interactive)$/, "/pooled");
  const sim = simulationAssertion({ runs, seed });
  const keys = only ? [only] : poolClasses ? [...new Set(segs.map((s) => s.cell))].sort() : cellKeys(segs, prices);
  const cells = keys.map((k) => fitCell(k, segs, { boot, perm, seed, simulationPass: sim.pass, includeEmulated: poolClasses }));
  return {
    fit: {
      schema: SCHEMA.fit,
      generatedAt: new Date().toISOString(),
      seed,
      options: { boot, perm, runs },
      thresholds: { ...T, vendorDefaultSigma: T.vendorDefaultSigma },
      prices: { source: prices.source, asOf: prices.asOf },
      simulation: sim,
      submissions: subs.map((s) => ({ file: s.file, session: s.header?.session_id ?? null, included: !s.error, reason: s.error || null })),
      cells,
    },
    subs,
    segs,
  };
}

// ---------------------------------------------------------------------------------------------
// Simulation (§3.3): protocol sessions as session/1 files, through the same segment builder
// ---------------------------------------------------------------------------------------------

export const SIM_PRICE = { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite5m: 5e-6, cacheWrite1h: 8e-6 }; // Opus 5.5 list
export const SIM_TRUE_W = { input: 1, output: 1, cacheRead: 0.5, cacheWrite5m: 0.9, cacheWrite1h: 0.6 };

/** Request size per arm (tokens), shrunk on small plans so no request costs more than about 0.1 point. */
export function armRequest(arm, scale = 1, { first = false } = {}) {
  const sc = scale;
  switch (arm) {
    case "input":
      return { input: Math.round(20000 * sc) };
    case "output":
      return { input: Math.round(300 * sc), output: Math.round(1500 * sc) };
    case "read":
      return first ? { cacheWrite1h: 150000, output: 5, input: 3 } : { cacheRead: 150000, output: 5, input: 3 };
    case "write1h":
      return { cacheWrite1h: Math.round(12000 * sc), output: 5 };
    case "write5m":
      return { cacheWrite5m: Math.round(12000 * sc), output: 5 };
    default:
      throw new Error(`arm ${arm}`);
  }
}

/**
 * A simulated meter: hidden quota use u (points), integer display, `lag` requests of delay.
 * cost(tokens) = Σ w_k × tokens_k × price_k / parity × armMult.
 */
export function simMeter({ rand, trueW = SIM_TRUE_W, price = SIM_PRICE, parity = 0.68, lag = 1, resolution = 1, start = null }) {
  let u = start ?? 10 + rand();
  const pending = [];
  return {
    push(tok, mult = 1) {
      const c = (KINDS.reduce((q, k) => q + trueW[k] * (tok[k] || 0) * price[k], 0) / parity) * mult;
      u += c;
      pending.push(c);
      if (pending.length > lag) pending.shift();
      return c;
    },
    read() {
      return Math.floor((u - pending.reduce((a, b) => a + b, 0)) / resolution) * resolution;
    },
    get used() {
      return u;
    },
  };
}

/**
 * Live anchor tracker used while running arms (probe and simulator): counts valid anchors with
 * the §1.4.2 rule from list-$ and an estimate of list-$ per point.
 */
export class AnchorTracker {
  constructor(usdPerPoint) {
    this.P = usdPerPoint;
    this.last = null;
    this.costs = [];
    this.anchors = 0;
  }
  /** Feed one request's list-$ and the reading after it. Returns true when this request is a valid anchor. */
  feed(usd, reading) {
    this.costs.push(usd / this.P);
    const n = this.costs.length;
    const tick = this.last != null && reading > this.last;
    this.last = reading;
    const ok = tick && this.costs[n - 1] <= T.anchorMaxPoints && (n < 2 || this.costs[n - 2] <= T.anchorMaxPoints);
    if (ok) this.anchors++;
    return ok;
  }
  /** Carry the last valid anchor into the next arm (arms are chained tick to tick). */
  chain(validLast) {
    this.anchors = validLast ? 1 : 0;
  }
}

/** One simulated protocol session as a session/1 object { header, rows }. */
export function simulateSession({ rand, trueW = SIM_TRUE_W, price = SIM_PRICE, parity = 0.68, pointsPerArm = 3, arms = ARMS, noise = 0.03, lag = 1, sessionId = "sim", account = "sim0", submitter = "sim", bar = "5h", model = "claude-opus-5-5", maxRequests = 20000 }) {
  const meter = simMeter({ rand, trueW, price, parity, lag });
  const gauss = gaussFrom(rand);
  const usdOf = (tok) => KINDS.reduce((q, k) => q + (tok[k] || 0) * price[k], 0);
  const sc = Math.min(1, parity / 0.68);
  const rows = [];
  let t0 = Date.parse("2026-11-02T00:00:00Z");
  let n = 0;
  const resetsAt = "2026-11-02T05:00:00Z";
  rows.push({ t: "meter", ts: new Date(t0).toISOString(), bar, used_pct: meter.read(), resets_at: resetsAt });
  const tracker = new AnchorTracker(parity);
  tracker.last = meter.read();
  for (const arm of arms) {
    const mult = 1 + noise * gauss();
    tracker.chain(false);
    let first = true;
    let k = 0;
    while (tracker.anchors < pointsPerArm + 1 && k < maxRequests) {
      const tok = armRequest(arm, sc, { first: arm === "read" && first });
      first = false;
      meter.push(tok, mult);
      const id = `${sessionId}-r${++n}`;
      t0 += 1000;
      rows.push({ t: "req", ts: new Date(t0).toISOString(), arm, request_id: id, input: tok.input || 0, output: tok.output || 0, cache_read: tok.cacheRead || 0, cache_write_5m: tok.cacheWrite5m || 0, cache_write_1h: tok.cacheWrite1h || 0 });
      const v = meter.read();
      rows.push({ t: "meter", ts: new Date(t0).toISOString(), after_request_id: id, bar, used_pct: v, resets_at: resetsAt });
      tracker.feed(usdOf(tok), v);
      k++;
    }
  }
  const header = {
    schema: SCHEMA.session,
    session_id: sessionId,
    submitter,
    account_hash: account,
    vendor: "anthropic",
    plan: "max",
    plan_price_usd: 100,
    model,
    effort: "low",
    client: "claude-code",
    client_version: "sim",
    entrypoint: "sdk-cli",
    label_emulated: false,
    meter_source: "rate_limit_event",
    meter_resolution: 1,
    bars: [{ id: bar, resets_at: resetsAt }],
    cache_ttl: "mixed",
    shared_account: false,
    idle_before_min: 10,
    idle_after_min: 10,
    idle_ticks: 0,
    prices_usd_per_mtok: Object.fromEntries(KINDS.map((k) => [k, price[k] * 1e6])),
    raw: { url: "simulation", sha256: null },
    simulated: true,
  };
  return { header, rows };
}

/**
 * A simulated mixed-workload holdout session (G4): chunks of agent-like requests whose cache-read
 * share of list-$ runs from about 7% to 83%. Header `holdout: true`, arm `mixed`.
 */
export function simulateHoldoutSession({ rand, trueW = SIM_TRUE_W, price = SIM_PRICE, parity = 0.68, chunks = 6, pointsPerChunk = 6, noise = 0.01, sessionId = "sim-holdout", account = "simH", submitter = "sim", bar = "5h" }) {
  const base = simulateSession({ rand, trueW, price, parity, pointsPerArm: 1, arms: [], sessionId, account, submitter, bar });
  const meter = simMeter({ rand, trueW, price, parity, lag: 1 });
  const gauss = gaussFrom(rand);
  const rows = [];
  let t0 = Date.parse("2026-11-03T00:00:00Z");
  const resetsAt = "2026-11-03T05:00:00Z";
  rows.push({ t: "meter", ts: new Date(t0).toISOString(), bar, used_pct: meter.read(), resets_at: resetsAt });
  const heavy = { cacheRead: 150000, output: 300 };
  const light = { cacheRead: 20000, cacheWrite1h: 5000, output: 800, input: 50 };
  let n = 0;
  for (let c = 0; c < chunks; c++) {
    const p = c / Math.max(1, chunks - 1);
    const mult = 1 + noise * gauss();
    const start = meter.read();
    while (meter.read() < start + pointsPerChunk && n < 50000) {
      const tok = rand() < p ? heavy : light;
      meter.push(tok, mult);
      const id = `${sessionId}-r${++n}`;
      t0 += 1000;
      rows.push({ t: "req", ts: new Date(t0).toISOString(), arm: "mixed", request_id: id, input: tok.input || 0, output: tok.output || 0, cache_read: tok.cacheRead || 0, cache_write_5m: 0, cache_write_1h: tok.cacheWrite1h || 0 });
      rows.push({ t: "meter", ts: new Date(t0).toISOString(), after_request_id: id, bar, used_pct: meter.read(), resets_at: resetsAt });
    }
  }
  return { header: { ...base.header, holdout: true, bars: [{ id: bar, resets_at: resetsAt }] }, rows };
}

const SIM_PRICES = { models: { "claude-opus-5-5": Object.fromEntries(KINDS.map((k) => [k, SIM_PRICE[k] * 1e6])) } };

/** Recovery of known weights over `runs` seeded replicates of one design. */
export function simulateDesign({ runs = 200, sessions = 3, points = 3, noise = 0.03, parity = 0.68, seed = 1, anchored = true, lag = 1 }) {
  const rand = rng(seed);
  const est = Object.fromEntries(FREE_KINDS.map((k) => [k, []]));
  for (let r = 0; r < runs; r++) {
    const segs = [];
    for (let s = 0; s < sessions; s++) {
      const sub = simulateSession({ rand, parity, pointsPerArm: points, noise, lag, sessionId: `r${r}s${s}` });
      const price = priceFor(SIM_PRICES, "claude-opus-5-5");
      for (const seg of sessionSegments({ ...sub, header: { ...sub.header, simulated: false } }, price, "5h")) {
        let y = seg.y;
        let rr = (seg.boundary[0] ** 2 + seg.boundary[1] ** 2) / 12 + 1e-4;
        if (!anchored) {
          // start/end integer readings only: ±1 point of rounding on y
          y = Math.max(1, y + Math.round(rand() + rand() - 1));
          rr = T.unanchoredVar;
        }
        segs.push({ ...seg, y, anchored, r: rr, group: "g", session: `s${s}` });
      }
    }
    const f = fitSegments(segs, { free: FREE_KINDS });
    for (const k of FREE_KINDS) est[k].push(f.w[k]);
  }
  const out = {};
  for (const k of FREE_KINDS) {
    const rel = est[k].map((v) => v / SIM_TRUE_W[k] - 1);
    out[k] = { bias: round(mean(rel), 5), half95: round((quantile(rel, 0.975) - quantile(rel, 0.025)) / 2, 5) };
  }
  return out;
}

/** §3.3 CI assertion: runs × (3 sessions × 3 points, noise 3%): |bias| ≤ 1%, 95% half-width ≤ 7%. */
export function simulationAssertion({ runs = T.g5.runs, seed = T.seed } = {}) {
  const g = T.g5;
  const r = simulateDesign({ runs, sessions: g.sessions, points: g.points, noise: g.noise, parity: g.parity, seed });
  const pass = FREE_KINDS.every((k) => Math.abs(r[k].bias) <= g.bias && r[k].half95 <= g.half95);
  return { design: `${g.sessions} sessions × ${g.points} points, noise ${g.noise}`, runs, trueWeights: SIM_TRUE_W, recovery: r, tolerance: { bias: g.bias, half95: g.half95 }, pass };
}

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

const fmtW = (c, k) => {
  if (c.weights[k] == null) return "—";
  const ci = c.ci95[k];
  return ci ? `${c.weights[k].toFixed(2)} (${ci[0].toFixed(2)}–${ci[1].toFixed(2)})` : c.weights[k].toFixed(2);
};
export function fitTable(fit) {
  const lines = [
    "| Cell | Status | Cache read | 1h write | 5m write | Output | Sessions / accounts | LOSO median error |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const c of fit.cells) {
    if (!c.n.segments && c.status === "unmeasured") continue;
    const lo = c.diagnostics?.loso?.medianAbsLn;
    lines.push(`| ${c.key} | ${c.status} | ${fmtW(c, "cacheRead")} | ${fmtW(c, "cacheWrite1h")} | ${fmtW(c, "cacheWrite5m")} | ${fmtW(c, "output")} | ${c.n.sessions} / ${c.n.accounts} | ${lo == null ? "—" : `${(100 * lo).toFixed(1)}%`} |`);
  }
  const empty = fit.cells.filter((c) => !c.n.segments).map((c) => c.key);
  if (empty.length) lines.push("", `Unmeasured, no data: ${empty.map((k) => `\`${k}\``).join(", ")}.`);
  return lines.join("\n");
}
function fitMarkdown(fit) {
  const s = fit.simulation;
  const out = [
    "# Quota weight fit",
    "",
    `Generated by \`node scripts/fit-quota-weights.mjs\` at ${fit.generatedAt}. Seed ${fit.seed}, ${fit.options.boot} bootstrap resamples.`,
    "",
    fitTable(fit),
    "",
    "## Gate",
    "",
    "| Cell | G1 coverage | G2 LOSO | G3 agreement | G4 holdout | G5 simulation | Unidentified |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const c of fit.cells.filter((x) => x.n.segments)) {
    const g = c.gate;
    const yn = (b) => (b ? "pass" : "fail");
    const un = Object.entries(c.unidentifiedReason || {}).map(([k, r]) => `${k}: ${r}`).join("; ");
    out.push(`| ${c.key} | ${yn(g.coverage)} | ${yn(g.loso)} | ${yn(g.agreement)} | ${yn(g.holdout)} | ${yn(g.simulation)} | ${un || "—"} |`);
  }
  out.push("", "## Simulation", "", `${s.design}, ${s.runs} runs, true weights ${JSON.stringify(s.trueWeights)}: ${s.pass ? "pass" : "FAIL"}.`, "", "| Kind | Bias | 95% half-width |", "|---|---|---|");
  for (const [k, r] of Object.entries(s.recovery)) out.push(`| ${k} | ${(100 * r.bias).toFixed(2)}% | ${(100 * r.half95).toFixed(2)}% |`);
  out.push("", "## Submissions", "", "| File | Included | Reason |", "|---|---|---|");
  for (const x of fit.submissions) out.push(`| ${x.file} | ${x.included ? "yes" : "no"} | ${x.reason || ""} |`);
  return out.join("\n") + "\n";
}
function indexCsv(subs, segs) {
  const head = "session_id,submitter,account_hash,vendor,plan,model,entrypoint,bar,arm,points,anchored,usd_input,usd_output,usd_cache_read,usd_cache_write_5m,usd_cache_write_1h,included,exclude_reason";
  const esc = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
  const lines = [head];
  for (const s of segs) {
    const reason = s.holdout ? "holdout" : s.emulated ? "label emulated" : "";
    const vendor = s.cell.split("/")[0];
    lines.push([s.session, s.submitter, s.account, vendor, s.plan, s.cell.split("/")[1], s.entrypoint, s.bar, s.arm, s.y, s.anchored, ...KINDS.map((k) => (s.usd[k] || 0).toFixed(6)), !reason, reason].map(esc).join(","));
  }
  for (const sub of subs.filter((x) => x.error)) {
    const h = sub.header || {};
    lines.push([h.session_id, h.submitter, h.account_hash, h.vendor, normPlan(h.plan), h.model, h.entrypoint, "", "", "", "", "", "", "", "", "", false, sub.error].map(esc).join(","));
  }
  return lines.join("\n") + "\n";
}
const DOC_START = "<!-- fit-table:start -->";
const DOC_END = "<!-- fit-table:end -->";
export function docTableBlock(fit) {
  return `${DOC_START}\n${fitTable(fit)}\n${DOC_END}`;
}
function updateDoc(fit) {
  if (!fs.existsSync(DOC_PATH)) return false;
  const doc = fs.readFileSync(DOC_PATH, "utf8");
  const i = doc.indexOf(DOC_START);
  const j = doc.indexOf(DOC_END);
  if (i < 0 || j < 0) return false;
  fs.writeFileSync(DOC_PATH, doc.slice(0, i) + docTableBlock(fit) + doc.slice(j + DOC_END.length));
  return true;
}

/** Compare two fits ignoring generatedAt; numbers to 1e-6. Returns a list of differences. */
export function compareFits(a, b) {
  const diffs = [];
  const walk = (x, y, p) => {
    if (p === ".generatedAt") return;
    if (typeof x === "number" && typeof y === "number") {
      if (Math.abs(x - y) > 1e-6 * Math.max(1, Math.abs(x))) diffs.push(`${p}: ${x} vs ${y}`);
      return;
    }
    if (x === null || y === null || typeof x !== "object" || typeof y !== "object") {
      if (x !== y) diffs.push(`${p}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) walk(x[k], y[k], `${p}.${k}`);
  };
  walk(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), "");
  return diffs;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);

function printSimulation(runs) {
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  console.log(`True weights: ${JSON.stringify(SIM_TRUE_W)}  (Opus 5.5 list prices, integer meter, one-request lag)`);
  console.log("design                                   | output         | cacheRead      | cacheWrite5m   | cacheWrite1h    (95% half-width, bias)");
  const designs = [
    ["1 session × 3 points, noise 1%", { sessions: 1, points: 3, noise: 0.01 }],
    ["1 session × 5 points, noise 1%", { sessions: 1, points: 5, noise: 0.01 }],
    ["3 sessions × 3 points, noise 3%", { sessions: 3, points: 3, noise: 0.03 }],
    ["3 sessions × 5 points, noise 3%", { sessions: 3, points: 5, noise: 0.03 }],
    ["1 session × 5 points, no noise", { sessions: 1, points: 5, noise: 0 }],
    ["1 session × 10 unanchored, noise 3%", { sessions: 1, points: 10, noise: 0.03, anchored: false }],
    ["weekly scale ($8.3/pt), 1 × 3, noise 1%", { sessions: 1, points: 3, noise: 0.01, parity: 8.3 }],
    ["Pro 5h scale ($0.29/pt), 1 × 5, noise 1%", { sessions: 1, points: 5, noise: 0.01, parity: 0.29 }],
  ];
  for (const [name, d] of designs) {
    const t0 = Date.now();
    const r = simulateDesign({ runs: Math.max(20, Math.round(runs / (d.parity === 8.3 ? 4 : 2))), seed: 7, ...d });
    console.log(`${name.padEnd(40)} | ` + FREE_KINDS.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`.padEnd(14)).join(" | ") + `  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const a = simulationAssertion({ runs, seed: T.seed });
  console.log(`\nAssertion (${a.design}, ${a.runs} runs): |bias| ≤ ${(100 * a.tolerance.bias).toFixed(0)}% and 95% half-width ≤ ${(100 * a.tolerance.half95).toFixed(0)}%`);
  for (const k of FREE_KINDS) console.log(`  ${k.padEnd(13)} bias ${pct(a.recovery[k].bias).padStart(6)}  half-width ${pct(a.recovery[k].half95).padStart(6)}`);
  console.log(a.pass ? "PASS" : "FAIL");
  return a.pass;
}

function printCell(c) {
  const w = KINDS.map((k) => `${k} ${c.weights[k] == null ? "—" : c.weights[k].toFixed(3)}${c.ci95[k] ? ` (${c.ci95[k][0].toFixed(3)}–${c.ci95[k][1].toFixed(3)})` : ""}`).join(", ");
  console.log(`${c.key}: ${c.status}`);
  if (!c.n.segments) return;
  console.log(`  weights: ${w}`);
  console.log(`  n: ${JSON.stringify(c.n)}`);
  console.log(`  gate: ${JSON.stringify(c.gate)}`);
  if (Object.keys(c.unidentifiedReason || {}).length) console.log(`  unidentified: ${JSON.stringify(c.unidentifiedReason)}`);
  console.log(`  raw fit (incl. unidentified): ${JSON.stringify(c.fitRaw)}  τ ${c.diagnostics.tau}  condition ${c.diagnostics.conditionNumber}`);
  console.log(`  parity $/point by group: ${JSON.stringify(c.parityUsdPerPoint)}`);
}

async function main() {
  const boot = Number(arg("--boot", T.boot));
  const perm = Number(arg("--perm", T.perm));
  const seed = Number(arg("--seed", T.seed));
  const runs = Number(arg("--runs", T.g5.runs));
  if (has("--simulate")) {
    process.exit(printSimulation(runs) ? 0 : 1);
  }
  const only = arg("--cell", null);
  const poolClasses = has("--pool-classes");
  const t0 = Date.now();
  const { fit, subs, segs } = runFit({ boot, perm, seed, runs, only, poolClasses });
  for (const s of fit.submissions) if (!s.included) console.log(`rejected ${s.file}: ${s.reason}`);
  for (const c of fit.cells) printCell(c);
  console.log(`simulation assertion: ${fit.simulation.pass ? "pass" : "FAIL"}; ${segs.length} segments from ${subs.filter((s) => !s.error).length} files; ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (only || poolClasses) return;
  if (has("--check")) {
    const prev = fs.existsSync(FIT_PATH) ? JSON.parse(fs.readFileSync(FIT_PATH, "utf8")) : null;
    const diffs = prev ? compareFits(prev, fit) : ["fit.json missing"];
    if (diffs.length) {
      console.error(`fit.json is not current (${diffs.length} differences):\n  ${diffs.slice(0, 20).join("\n  ")}`);
      process.exit(1);
    }
    console.log("fit.json is current");
    return;
  }
  fs.mkdirSync(QW_DIR, { recursive: true });
  fs.writeFileSync(FIT_PATH, JSON.stringify(fit, null, 1) + "\n");
  fs.writeFileSync(FIT_MD_PATH, fitMarkdown(fit));
  fs.writeFileSync(INDEX_PATH, indexCsv(subs, segs));
  const doc = updateDoc(fit);
  console.log(`wrote ${path.relative(ROOT, FIT_PATH)}, ${path.relative(ROOT, FIT_MD_PATH)}, ${path.relative(ROOT, INDEX_PATH)}${doc ? `, table in ${path.relative(ROOT, DOC_PATH)}` : ""}`);
}

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
