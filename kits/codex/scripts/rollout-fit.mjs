/**
 * Codex rollout analysis: parses ~/.codex/sessions rollout files, prices every model call at API
 * list prices, and fits API dollars per percentage point (pp) of the Codex usage meter for the
 * 5-hour and weekly windows from the per-call meter readings.
 *
 * Meter model. Each token_count event carries rate_limits.{primary,secondary}.used_percent, a
 * reading rounded to a fixed step q (whole numbers in every file seen so far; q is detected, not
 * assumed). Write C for cumulative API $ over the run. With true usage U = U0 + C/β, the reading
 * steps from level k−q to k at the point where C crosses X_k = β·(k − U0'), whatever the rounding
 * rule (floor, round or ceil only moves U0'). Each step is located between two consecutive calls:
 * X_k ∈ [C_ref(a), C_ref(b)], where C_ref is cumulative $ through the reading's own call (lag 0)
 * or through the call before it (lag 1: the reading predates its own call's charge). Both lags are
 * fitted; the better one is kept and the gap between them is added to the error.
 *
 * Fit: X_k = α_s + β·k + e, one intercept per segment s (window epoch, or a break inserted after a
 * contamination jump). GLS with Var(e) = censoring (interval half-width h: h²/3) + white noise
 * (ωβ)² + a random walk (τβ)²·min(m_i, m_j) inside a segment (m = pp since the segment's first
 * step; models a meter that does not follow API price exactly, so the error builds with the mix).
 * τ and ω are profiled by maximum likelihood on a grid. 95% interval: Student t on the GLS SE.
 * Hard bounds: the range of β for which one line per segment passes through every step interval
 * (exact meter, chosen lag); null when no such line exists.
 *
 * Zero dependencies (Node ≥ 20). Imported by codex-quota.mjs and the tests.
 */

import fs from "node:fs";
import path from "node:path";
import { PLANS, DEFAULT_PLAN_ID, planById, planFee, plansForType } from "./plans.mjs";

export const RESULT_SCHEMA = "codex-quota.result/1";
export const COMPARE_SCHEMA = "codex-quota.compare/1";
export const RUN_SCHEMA = "codex-quota.run/1";
export const WINDOW_NAMES = { 300: "5h", 10080: "weekly" };
export const WEEKS_PER_MONTH = 4; // site convention: Fei2411 "×4周", subsidy = 4 × weekly pool ÷ fee
/** Monthly fee per kit plan id, from scripts/billing-periods.mjs (null: no record). */
export const PLAN_PRICE_USD = Object.fromEntries(PLANS.map((p) => [p.id, planFee(p)]));
/** Fewest meter steps a window fit needs. */
export const MIN_STEPS = 3;
export const RESET_TOLERANCE_S = 600;
export const LONG_CONTEXT_TOKENS = 272000;

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const ZERO_USAGE = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });

function usageFrom(u) {
  if (!u || typeof u !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input: n(u.input_tokens),
    cached: n(u.cached_input_tokens),
    cacheWrite: n(u.cache_write_input_tokens),
    output: n(u.output_tokens),
    reasoning: n(u.reasoning_output_tokens),
    total: n(u.total_tokens),
  };
}

function subUsage(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] - (b?.[k] || 0);
  return out;
}

/** Effort as recorded in a turn_context payload (field name differs across Codex versions). */
export function effortOf(p) {
  return p?.effort ?? p?.reasoning_effort ?? p?.collaboration_mode?.settings?.reasoning_effort ?? null;
}

function parseRate(rl) {
  if (!rl || typeof rl !== "object") return null;
  const windows = {};
  for (const key of ["primary", "secondary"]) {
    const w = rl[key];
    if (!w || w.used_percent == null) continue;
    const name = WINDOW_NAMES[w.window_minutes] || `${w.window_minutes}m`;
    windows[name] = { pct: Number(w.used_percent), windowMinutes: w.window_minutes ?? null, resetsAt: w.resets_at ?? null, slot: key };
  }
  return {
    limitId: rl.limit_id ?? null,
    planType: rl.plan_type ?? null,
    reachedType: rl.rate_limit_reached_type ?? null,
    credits: rl.credits ? { hasCredits: rl.credits.has_credits === true, unlimited: rl.credits.unlimited === true, balance: rl.credits.balance ?? null } : null,
    windows,
  };
}

/**
 * One rollout file → { file, sessionId, cwd, cliVersion, originator, events[] }.
 * events: { ts (ms), ord, kind: "call" | "meter", usage?, includesReasoning?, model, effort, rate }.
 * A call is a token_count event whose total_token_usage grew; its usage is the growth.
 */
export function parseRolloutText(text, file = "") {
  const out = { file, sessionId: null, cwd: null, cliVersion: null, originator: null, events: [], badLines: 0 };
  let model = null;
  let effort = null;
  let prevTotal = null;
  let ord = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      out.badLines++;
      continue;
    }
    ord++;
    const p = o.payload || {};
    const ts = Date.parse(o.timestamp);
    if (o.type === "session_meta") {
      out.sessionId = p.session_id || p.id || out.sessionId;
      out.cwd = p.cwd ?? out.cwd;
      out.cliVersion = p.cli_version ?? out.cliVersion;
      out.originator = p.originator ?? out.originator;
      continue;
    }
    if (o.type === "turn_context") {
      model = p.model ?? model;
      effort = effortOf(p) ?? effort;
      if (!out.cwd && p.cwd) out.cwd = p.cwd;
      continue;
    }
    if (o.type !== "event_msg" || p.type !== "token_count") continue;
    const rate = parseRate(p.rate_limits);
    const info = p.info || null;
    let usage = null;
    if (info) {
      const total = usageFrom(info.total_token_usage);
      const last = usageFrom(info.last_token_usage);
      if (total) {
        const d = prevTotal ? subUsage(total, prevTotal) : total;
        const grew = d.total > 0 || d.input > 0 || d.output > 0;
        const negative = Object.values(d).some((v) => v < 0);
        if (negative) usage = last; // counters restarted (e.g. compaction): fall back to the last call
        else if (grew) usage = d;
        prevTotal = total;
      } else if (last && last.total > 0) usage = last;
    }
    if (usage) {
      out.events.push({ ts, ord, kind: "call", usage, includesReasoning: info.last_usage_includes_reasoning !== false, model, effort, rate, contextWindow: info.model_context_window ?? null });
    } else if (rate) {
      out.events.push({ ts, ord, kind: "meter", model, effort, rate });
    }
  }
  for (const e of out.events) e.sessionId = out.sessionId;
  return out;
}

export function parseRolloutFile(file) {
  return parseRolloutText(fs.readFileSync(file, "utf8"), file);
}

/** Rollout files under a sessions dir (YYYY/MM/DD/…) for the days touching [fromMs, toMs]. */
export function listRolloutFiles(sessionsDir, fromMs = null, toMs = null) {
  const files = [];
  if (!fs.existsSync(sessionsDir)) return files;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(sessionsDir);
  return files
    .filter((f) => {
      if (fromMs == null) return true;
      const st = fs.statSync(f);
      return st.mtimeMs >= fromMs - 60_000; // file written to after the start
    })
    .filter((f) => {
      if (toMs == null) return true;
      const m = path.basename(f).match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      if (!m) return true;
      // session start time in the file name is local time; allow a day of slack either side
      const started = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
      return !Number.isFinite(started) || started <= toMs + 86_400_000;
    })
    .sort();
}

export function isUnder(p, root) {
  if (!p || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------------------------

/**
 * API $ of one call. OpenAI convention: input_tokens includes cached_input_tokens; output_tokens
 * includes reasoning when last_usage_includes_reasoning is true. Cache-write tokens are taken as a
 * part of the uncached input, priced at the input rate (no separate write price exists).
 */
export function priceCall(usage, includesReasoning, price) {
  const cachedExceedsInput = usage.cached > usage.input;
  const cached = usage.cached;
  const uncached = cachedExceedsInput ? usage.input : usage.input - usage.cached;
  const input = cachedExceedsInput ? usage.input + usage.cached : usage.input;
  const output = includesReasoning ? usage.output : usage.output + usage.reasoning;
  const parts = {
    uncachedInput: (uncached * price.input) / 1e6,
    cachedInput: (cached * price.cachedInput) / 1e6,
    output: (output * price.output) / 1e6,
  };
  return {
    usd: parts.uncachedInput + parts.cachedInput + parts.output,
    parts,
    tokens: { input, cached, uncached, cacheWrite: usage.cacheWrite, output, reasoning: usage.reasoning },
    cachedExceedsInput,
    cacheWriteExceedsUncached: usage.cacheWrite > uncached,
  };
}

// ---------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------

/**
 * Merge sessions into one time-ordered list of events inside [fromMs, toMs], keeping sessions
 * under `root` (all sessions when root is null). Returns { events, runSessions, otherSessions }.
 * otherSessions = sessions outside root with at least one event in the range.
 */
export function buildTimeline(sessions, { root = null, fromMs = null, toMs = null } = {}) {
  const inRange = (e) => (fromMs == null || e.ts >= fromMs) && (toMs == null || e.ts <= toMs);
  const runSessions = [];
  const otherSessions = [];
  const events = [];
  for (const s of sessions) {
    const ev = s.events.filter(inRange);
    if (!root || isUnder(s.cwd, root)) {
      if (ev.length || !fromMs) runSessions.push(s);
      for (const e of ev) events.push({ ...e, file: s.file });
    } else if (ev.length) {
      otherSessions.push({ sessionId: s.sessionId, calls: ev.filter((e) => e.kind === "call").length, firstTs: new Date(ev[0].ts).toISOString() });
    }
  }
  events.sort((a, b) => a.ts - b.ts || String(a.file).localeCompare(String(b.file)) || a.ord - b.ord);
  return { events, runSessions, otherSessions };
}

/** Price every call and attach cumulative $ before (cb) and after (ca) each event. */
export function priceTimeline(events, prices, modelFallback) {
  let c = 0;
  const priced = [];
  for (const e of events) {
    const out = { ...e, cb: c, ca: c, usd: 0 };
    if (e.kind === "call") {
      const price = prices[e.model] || prices[modelFallback];
      if (!price) throw new Error(`no price for model ${e.model}`);
      out.priced = priceCall(e.usage, e.includesReasoning, price);
      out.usd = out.priced.usd;
      c += out.usd;
      out.ca = c;
    }
    priced.push(out);
  }
  return priced;
}

// ---------------------------------------------------------------------------------------------
// Meter readings and step crossings
// ---------------------------------------------------------------------------------------------

/** Readings for one window: { i, ts, r, resetsAt, cb, ca } in event order. */
export function readingsFor(priced, win) {
  const out = [];
  priced.forEach((e, i) => {
    const w = e.rate?.windows?.[win];
    if (w && Number.isFinite(w.pct)) out.push({ i, ts: e.ts, r: w.pct, resetsAt: w.resetsAt, cb: e.cb, ca: e.ca, usd: e.usd });
  });
  return out;
}

/** Reading step q: the largest of 1, 0.5, 0.25, 0.1, 0.05, 0.01 that divides every reading. */
export function detectStep(readings) {
  const steps = [1, 0.5, 0.25, 0.1, 0.05, 0.01];
  for (const q of steps) {
    if (readings.every((x) => Math.abs(x.r / q - Math.round(x.r / q)) < 1e-6)) return q;
  }
  return 0.01;
}

/** Split readings into epochs at window resets (resets_at moves by > 10 min, or the reading falls). */
export function epochsOf(readings) {
  const epochs = [];
  let cur = [];
  for (const x of readings) {
    const prev = cur[cur.length - 1];
    const moved = prev && prev.resetsAt != null && x.resetsAt != null && Math.abs(x.resetsAt - prev.resetsAt) > RESET_TOLERANCE_S;
    const fell = prev && x.r < prev.r;
    if (prev && (moved || fell)) {
      epochs.push(cur);
      cur = [];
    }
    cur.push(x);
  }
  if (cur.length) epochs.push(cur);
  return epochs;
}

/**
 * Step crossings for one window. lag 0: C_ref = $ through the reading's call; lag 1: before it.
 * breaks: Set of reading event indices `i` where a new segment starts (contamination).
 * Returns [{ seg, k, lo, hi, mid, h, m, a, b }] with a, b the reading event indices around the step.
 */
export function crossingsFor(epochs, { lag = 0, q = 1, breaks = new Set() } = {}) {
  const ref = (x) => (lag === 1 ? x.cb : x.ca);
  const out = [];
  let seg = -1;
  for (const ep of epochs) {
    seg++;
    let first = null;
    for (let j = 1; j < ep.length; j++) {
      const a = ep[j - 1];
      const b = ep[j];
      const brk = breaks.has(b.i);
      if (brk) {
        seg++;
        first = null;
      }
      const steps = Math.round((b.r - a.r) / q);
      if (steps <= 0) continue;
      const lo = ref(a);
      const hi = ref(b);
      // a step at a break reading marks when the outside use landed, not where the run's usage
      // crossed a level: the new segment starts at the next step
      if (brk) continue;
      for (let s = 1; s <= steps; s++) {
        const k = a.r + s * q;
        if (first == null) first = k;
        out.push({ seg, k, lo, hi, mid: (lo + hi) / 2, h: (hi - lo) / 2, m: (k - first) / q, a: a.i, b: b.i });
      }
    }
  }
  // renumber segments that have crossings: 0..S-1
  const ids = [...new Set(out.map((c) => c.seg))];
  const map = new Map(ids.map((s, n) => [s, n]));
  for (const c of out) c.seg = map.get(c.seg);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Linear algebra and distributions
// ---------------------------------------------------------------------------------------------

function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

function cholSolve(L, b) {
  const n = L.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function invSmall(A) {
  const n = A.length;
  const L = cholesky(A);
  if (!L) return null;
  const inv = [];
  for (let j = 0; j < n; j++) {
    const e = new Float64Array(n);
    e[j] = 1;
    inv.push(cholSolve(L, e));
  }
  return inv.map((col, j) => col).map((_, i) => inv.map((col) => col[i]));
}

function lnGamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a, b, x) {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function tCdf(t, df) {
  const x = df / (df + t * t);
  const p = 0.5 * ibeta(x, df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

/** Two-sided Student t critical value for confidence `level` (e.g. 0.95). */
export function tCrit(df, level = 0.95) {
  const target = 1 - (1 - level) / 2;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function normCdf(z) {
  // Abramowitz–Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Seeded PRNG (mulberry32), same as the Claude kit's fitter. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Slope fit
// ---------------------------------------------------------------------------------------------

const TAU_GRID = [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3];
const OMEGA_GRID = [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3];

function glsOnce(cr, S, beta0, tau, omega, q) {
  const n = cr.length;
  const p = S + 1;
  const floor = (1e-6 * beta0) ** 2;
  const V = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let v = 0;
      if (cr[i].seg === cr[j].seg) v += (tau * beta0 * q) ** 2 * Math.min(cr[i].m, cr[j].m);
      if (i === j) v += (cr[i].h * cr[i].h) / 3 + (omega * beta0 * q) ** 2 + floor;
      V[i][j] = v;
      V[j][i] = v;
    }
  }
  const L = cholesky(V);
  if (!L) return null;
  const X = cr.map((c) => {
    const row = new Float64Array(p);
    row[c.seg] = 1;
    row[S] = c.k;
    return row;
  });
  const y = Float64Array.from(cr.map((c) => c.mid));
  // V^-1 X and V^-1 y
  const VinvX = [];
  for (let col = 0; col < p; col++) VinvX.push(cholSolve(L, Float64Array.from(X.map((r) => r[col]))));
  const Vinvy = cholSolve(L, y);
  const XtVX = Array.from({ length: p }, () => new Float64Array(p));
  const XtVy = new Float64Array(p);
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][a] * VinvX[b][i];
      XtVX[a][b] = s;
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][a] * Vinvy[i];
    XtVy[a] = s;
  }
  const covTheta = invSmall(XtVX);
  if (!covTheta) return null;
  const theta = new Float64Array(p);
  for (let a = 0; a < p; a++) {
    let s = 0;
    for (let b = 0; b < p; b++) s += covTheta[a][b] * XtVy[b];
    theta[a] = s;
  }
  const resid = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let f = 0;
    for (let a = 0; a < p; a++) f += X[i][a] * theta[a];
    resid[i] = y[i] - f;
  }
  const Vr = cholSolve(L, resid);
  let quad = 0;
  for (let i = 0; i < n; i++) quad += resid[i] * Vr[i];
  let logdet = 0;
  for (let i = 0; i < n; i++) logdet += 2 * Math.log(L[i][i]);
  // REML log-likelihood (accounts for the S + 1 fitted coefficients)
  let logdetX = 0;
  const Lx = cholesky(XtVX);
  if (Lx) for (let i = 0; i < p; i++) logdetX += 2 * Math.log(Lx[i][i]);
  const reml = -0.5 * (logdet + quad + logdetX);
  return { theta, covTheta, resid, reml, quad, n, p };
}

/**
 * GLS fit of X_k = α_seg + β·k. Returns { beta, se, df, ci95, tau, omega, reml, alphas, n, segments }
 * or null when there are fewer than 2 crossings in some segment with span.
 */
export function fitSlope(cr, { q = 1 } = {}) {
  if (cr.length < 2) return null;
  const S = Math.max(...cr.map((c) => c.seg)) + 1;
  if (cr.length < S + 1) return null;
  const spanOk = [...new Set(cr.map((c) => c.seg))].some((s) => {
    const ks = cr.filter((c) => c.seg === s).map((c) => c.k);
    return Math.max(...ks) > Math.min(...ks);
  });
  if (!spanOk) return null;
  // OLS start
  let beta0;
  {
    const ols = glsOnce(cr, S, 1, 0, 1, q); // equal weights
    beta0 = ols ? Math.abs(ols.theta[S]) || 1 : 1;
  }
  let best = null;
  for (let iter = 0; iter < 3; iter++) {
    best = null;
    for (const tau of TAU_GRID) {
      for (const omega of OMEGA_GRID) {
        const r = glsOnce(cr, S, beta0, tau, omega, q);
        if (r && (!best || r.reml > best.r.reml)) best = { r, tau, omega };
      }
    }
    if (!best) return null;
    const nb = best.r.theta[S];
    if (Math.abs(nb - beta0) / Math.abs(beta0) < 1e-6) break;
    beta0 = Math.abs(nb) || beta0;
  }
  const beta = best.r.theta[S];
  const se = Math.sqrt(Math.max(best.r.covTheta[S][S], 0));
  const df = Math.max(cr.length - (S + 1), 0);
  const crit = df >= 1 ? tCrit(df) : null;
  return {
    beta,
    se,
    df,
    ci95: crit != null ? [beta - crit * se, beta + crit * se] : null,
    tau: best.tau,
    omega: best.omega,
    reml: best.r.reml,
    alphas: Array.from(best.r.theta.slice(0, S)),
    n: cr.length,
    segments: S,
  };
}

/**
 * Range of β for which one line per segment passes through every step interval [lo, hi] at its
 * level k. Pairwise conditions inside each segment are necessary and sufficient. null = infeasible.
 */
export function stabBounds(cr) {
  let lo = 0;
  let hi = Infinity;
  const bySeg = new Map();
  for (const c of cr) {
    if (!bySeg.has(c.seg)) bySeg.set(c.seg, []);
    bySeg.get(c.seg).push(c);
  }
  for (const list of bySeg.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dk = b.k - a.k;
        if (dk > 0) {
          lo = Math.max(lo, (b.lo - a.hi) / dk);
          hi = Math.min(hi, (b.hi - a.lo) / dk);
        } else if (dk === 0 && i !== j && b.lo > a.hi + 1e-12) return null;
      }
    }
  }
  if (!(hi >= lo) || !Number.isFinite(hi)) return hi >= lo ? { lo, hi: null } : null;
  return { lo, hi };
}

/**
 * Steps that came too soon: the widest reading of the $ between step k and k+1 is below 65% of
 * the median step, and below the median by more than 4 robust SDs. Each marks usage the run did
 * not make (another client on the account). Returns [{ at (event index), k, shortPp }].
 */
export function shortSteps(cr, q = 1) {
  const bySeg = new Map();
  for (const c of cr) {
    if (!bySeg.has(c.seg)) bySeg.set(c.seg, []);
    bySeg.get(c.seg).push(c);
  }
  const incs = [];
  for (const list of bySeg.values()) {
    for (let j = 1; j < list.length; j++) {
      const a = list[j - 1];
      const b = list[j];
      incs.push({ a, b, mid: (b.mid - a.mid) / ((b.k - a.k) / q), max: (b.hi - a.lo) / ((b.k - a.k) / q) });
    }
  }
  if (incs.length < 4) return { flagged: [], medianStep: incs.length ? median(incs.map((x) => x.mid)) : null };
  const med = median(incs.map((x) => x.mid));
  const mad = median(incs.map((x) => Math.abs(x.mid - med))) * 1.4826;
  const thr = Math.min(0.65 * med, med - 4 * mad);
  // the step after a jump starts from the jump's level, so it is short too: not a second event
  const jumpReadings = new Set();
  const flagged = [];
  for (const x of incs) {
    if (x.max >= thr || jumpReadings.has(x.a.b)) continue;
    jumpReadings.add(x.b.b);
    const sameReading = cr.filter((c) => c.b === x.b.b && c.seg === x.b.seg && c.k > x.b.k).length;
    flagged.push({ at: x.b.b, k: x.b.k, shortPp: ((med - x.max) / med) * q + sameReading * q });
  }
  return { flagged, medianStep: med };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Fit one window at one lag, inserting breaks for short steps until none remain (≤ 5 rounds).
 */
export function fitWindowAtLag(epochs, q, lag) {
  const breaks = new Set();
  const found = [];
  let cr = crossingsFor(epochs, { lag, q, breaks });
  for (let round = 0; round < 5; round++) {
    const { flagged } = shortSteps(cr, q);
    const fresh = new Map();
    for (const f of flagged) {
      if (breaks.has(f.at)) continue;
      const cur = fresh.get(f.at);
      if (cur) cur.shortPp += f.shortPp;
      else fresh.set(f.at, { ...f });
    }
    if (!fresh.size) break;
    for (const f of fresh.values()) {
      breaks.add(f.at);
      found.push(f);
    }
    cr = crossingsFor(epochs, { lag, q, breaks });
  }
  const fit = fitSlope(cr, { q });
  return { lag, cr, fit, breaks: found, bounds: fit ? stabBounds(cr) : null };
}

/** First-to-last estimate per segment, weighted by span (for comparison only). */
export function naiveSlope(cr) {
  const bySeg = new Map();
  for (const c of cr) {
    if (!bySeg.has(c.seg)) bySeg.set(c.seg, []);
    bySeg.get(c.seg).push(c);
  }
  let num = 0;
  let den = 0;
  for (const list of bySeg.values()) {
    if (list.length < 2) continue;
    const a = list[0];
    const b = list[list.length - 1];
    num += b.mid - a.mid;
    den += b.k - a.k;
  }
  return den > 0 ? num / den : null;
}

/**
 * Full window analysis: both lags, choose by REML, add the lag gap to the error.
 * Returns null when the window has no usable steps.
 */
export function fitWindow(priced, win) {
  const readings = readingsFor(priced, win);
  if (readings.length < 2) return { window: win, readings: readings.length, usable: false, reason: "fewer than 2 readings" };
  const q = detectStep(readings);
  const epochs = epochsOf(readings);
  const fits = [0, 1].map((lag) => fitWindowAtLag(epochs, q, lag));
  const ok = fits.filter((f) => f.fit && f.fit.beta > 0 && f.cr.length >= MIN_STEPS);
  const first = readings[0];
  const last = readings[readings.length - 1];
  const observedPp = epochs.reduce((s, ep) => s + (ep[ep.length - 1].r - ep[0].r), 0);
  const base = {
    window: win,
    readings: readings.length,
    step: q,
    epochs: epochs.map((ep) => ({ first: ep[0].r, last: ep[ep.length - 1].r, resetsAt: ep[0].resetsAt != null ? new Date(ep[0].resetsAt * 1000).toISOString() : null })),
    observedPp,
    firstReading: first.r,
    lastReading: last.r,
  };
  if (!ok.length) return { ...base, usable: false, reason: `fewer than ${MIN_STEPS} steps of ${q} pp inside one window epoch` };
  ok.sort((a, b) => b.fit.reml - a.fit.reml);
  const chosen = ok[0];
  const other = ok[1] || null;
  const lagGap = other ? Math.abs(other.fit.beta - chosen.fit.beta) : 0;
  const se = Math.sqrt(chosen.fit.se ** 2 + (lagGap / 2) ** 2);
  const crit = chosen.fit.df >= 1 ? tCrit(chosen.fit.df) : null;
  const beta = chosen.fit.beta;
  const totalUsd = priced.length ? priced[priced.length - 1].ca : 0;
  return {
    ...base,
    usable: true,
    lag: chosen.lag,
    crossings: chosen.cr.length,
    segments: chosen.fit.segments,
    usdPerPp: {
      est: beta,
      se,
      ci95: crit != null ? [beta - crit * se, beta + crit * se] : null,
      relSe: se / beta,
      seFit: chosen.fit.se,
      lagGap,
      otherLag: other ? { lag: other.lag, est: other.fit.beta } : null,
      bounds: chosen.bounds,
      naiveFirstLast: naiveSlope(chosen.cr),
      df: chosen.fit.df,
      tau: chosen.fit.tau,
      omega: chosen.fit.omega,
    },
    ppModelled: totalUsd / beta,
    poolUsd: { est: 100 * beta, ci95: crit != null ? [100 * (beta - crit * se), 100 * (beta + crit * se)] : null },
    shortSteps: chosen.breaks.map((b) => ({ ts: new Date(priced[b.at].ts).toISOString(), level: b.k, extraPp: round(b.shortPp, 3) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Contamination checks
// ---------------------------------------------------------------------------------------------

/**
 * Idle checks: for each idle interval { start, end } (ISO), compare the last reading at or before
 * start with the first reading after end. Any move by ≥ one step while the run made (almost) no
 * calls is use from elsewhere.
 */
export function idleChecks(priced, idle, wins) {
  const out = [];
  for (const it of idle || []) {
    const s = Date.parse(it.start);
    const e = Date.parse(it.end);
    for (const win of wins) {
      const rs = readingsFor(priced, win);
      const before = [...rs].reverse().find((x) => x.ts <= s + 1000);
      const after = rs.find((x) => x.ts >= e - 1000 && (!before || x.i > before.i));
      if (!before || !after) {
        out.push({ phase: it.phase, window: win, checked: false });
        continue;
      }
      const reset = before.resetsAt != null && after.resetsAt != null && Math.abs(after.resetsAt - before.resetsAt) > RESET_TOLERANCE_S;
      out.push({ phase: it.phase, window: win, checked: !reset, before: before.r, after: after.r, usdBetween: after.ca - before.cb, moved: !reset && after.r > before.r });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Whole-run analysis
// ---------------------------------------------------------------------------------------------

export function round(x, d = 4) {
  if (x == null || !Number.isFinite(x)) return x ?? null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function roundDeep(o, d = 6) {
  if (Array.isArray(o)) return o.map((x) => roundDeep(x, d));
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) r[k] = roundDeep(v, d);
    return r;
  }
  if (typeof o === "number" && !Number.isInteger(o)) return round(o, d);
  return o;
}

/**
 * analyse({ sessions, prices, manifest?, expected: { model, effort }, root?, fromMs?, toMs?, site? })
 *   sessions: parsed rollouts (parseRolloutFile). prices: { asOf, source, models: { id: {input, cachedInput, output} } }.
 *   site: { subsidy, source } for comparison (optional).
 *   plan: kit plan id or record (plans.mjs); default: the manifest's plan, else the one plan the
 *   rollouts' plan_type names, else Plus.
 */
export function analyse({ sessions, prices, manifest = null, expected = {}, root = null, fromMs = null, toMs = null, site = null, otherSessionsExtra = [], plan = null }) {
  const tl = buildTimeline(sessions, { root, fromMs, toMs });
  const model = expected.model || "gpt-6.2-sol";
  const priced = priceTimeline(tl.events, prices.models, model);
  const calls = priced.filter((e) => e.kind === "call");
  const flags = [];
  const flag = (code, severity, detail) => flags.push({ code, severity, detail });

  // tokens and dollars
  const tokens = { input: 0, cachedInput: 0, uncachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const usd = { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
  const byEffort = {};
  const byModel = {};
  let cachedExceeds = 0;
  let writeExceeds = 0;
  let longContext = 0;
  for (const c of calls) {
    const t = c.priced.tokens;
    tokens.input += t.input;
    tokens.cachedInput += t.cached;
    tokens.uncachedInput += t.uncached;
    tokens.cacheWrite += t.cacheWrite;
    tokens.output += t.output;
    tokens.reasoning += t.reasoning;
    for (const k of ["uncachedInput", "cachedInput", "output"]) usd[k] += c.priced.parts[k];
    usd.total += c.usd;
    const ef = c.effort ?? "unrecorded";
    byEffort[ef] ||= { calls: 0, usd: 0 };
    byEffort[ef].calls++;
    byEffort[ef].usd += c.usd;
    const md = c.model ?? "unrecorded";
    byModel[md] ||= { calls: 0, usd: 0 };
    byModel[md].calls++;
    byModel[md].usd += c.usd;
    if (c.priced.cachedExceedsInput) cachedExceeds++;
    if (c.priced.cacheWriteExceedsUncached) writeExceeds++;
    if (t.input > LONG_CONTEXT_TOKENS) longContext++;
  }

  if (!calls.length) flag("no_calls", "error", "no model calls in the selected rollouts");

  // model / effort mismatch
  const wrongModel = calls.filter((c) => c.model !== model);
  if (wrongModel.length) flag("model_mismatch", "error", `${wrongModel.length} of ${calls.length} calls not on ${model}: ${Object.keys(byModel).filter((m) => m !== model).join(", ")}`);
  if (expected.effort) {
    const wrongEffort = calls.filter((c) => c.effort != null && c.effort !== expected.effort);
    const unrecorded = calls.filter((c) => c.effort == null);
    if (wrongEffort.length) flag("effort_mismatch", "error", `${wrongEffort.length} of ${calls.length} calls not at effort ${expected.effort}: ${Object.keys(byEffort).filter((e) => e !== expected.effort && e !== "unrecorded").join(", ")}`);
    if (unrecorded.length) flag("effort_unrecorded", "warning", `${unrecorded.length} of ${calls.length} calls have no effort in turn_context`);
  }
  if (cachedExceeds) flag("cached_exceeds_input", "warning", `${cachedExceeds} calls report cached_input_tokens > input_tokens; priced as input excluding cached`);
  if (writeExceeds) flag("cache_write_exceeds_uncached", "warning", `${writeExceeds} calls report cache_write_input_tokens above uncached input; writes priced as uncached input only`);
  if (longContext) flag("long_context", "warning", `${longContext} calls above ${LONG_CONTEXT_TOKENS} input tokens; API may price these higher`);

  // plan / limit / credits
  const rates = priced.filter((e) => e.rate).map((e) => e.rate);
  const planTypes = [...new Set(rates.map((r) => r.planType).filter(Boolean))];
  let P = typeof plan === "string" ? planById(plan) : plan;
  if (!P && manifest?.plan?.id) P = planById(manifest.plan.id);
  const typePlans = planTypes.length === 1 ? plansForType(planTypes[0]) : [];
  if (!P && typePlans.length === 1) P = typePlans[0];
  if (!P && typePlans.length > 1) flag("plan_ambiguous", "error", `plan_type ${planTypes[0]} is one of ${typePlans.map((p) => p.name).join(", ")}; analyse with --plan`);
  const planKnown = !!P;
  P ||= planById(DEFAULT_PLAN_ID);
  const unknownTypes = planTypes.filter((t) => !plansForType(t).length);
  if (unknownTypes.length) flag("plan_unknown", "error", `plan_type ${unknownTypes.join(", ")} is not a plan this kit measures`);
  const wrongTypes = planTypes.filter((t) => plansForType(t).length && !P.planTypes.includes(t));
  if (wrongTypes.length) flag("plan_mismatch", "error", `plan_type ${wrongTypes.join(", ")}; ${P.name} reports ${P.planTypes.join(" or ")}`);
  const fee = planKnown ? planFee(P) : null;
  if (planKnown && fee == null) flag("plan_fee_unknown", "warning", `no monthly fee for ${P.name} in scripts/billing-periods.mjs; no subsidy`);
  const limits = [...new Set(rates.map((r) => r.limitId).filter(Boolean))];
  if (limits.some((l) => l !== "codex")) flag("limit_id", "warning", `limit_id ${limits.join(", ")}`);
  const balances = [...new Set(rates.map((r) => r.credits?.balance).filter((b) => b != null))];
  if (rates.some((r) => r.credits?.hasCredits) || balances.length > 1) flag("credits", "error", `credits in use (balances ${balances.join(", ")})`);
  const reached = rates.filter((r) => r.reachedType);
  if (reached.length) flag("limit_reached", "warning", `${reached.length} readings with rate_limit_reached_type ${[...new Set(reached.map((r) => r.reachedType))].join(", ")}`);

  // other Codex sessions
  const others = [...tl.otherSessions, ...otherSessionsExtra.filter((x) => !tl.otherSessions.some((y) => y.sessionId === x.sessionId))];
  if (others.length) flag("other_codex_session", "error", `${others.length} other Codex session(s) made calls during the run: ${others.map((o) => o.sessionId).join(", ")}`);

  // windows
  const wins = [...new Set(priced.flatMap((e) => Object.keys(e.rate?.windows || {})))];
  const windows = {};
  for (const w of wins) windows[w] = fitWindow(priced, w);
  if (calls.length && !windows.weekly) flag("window_missing", "error", "no weekly readings in the rollouts");
  for (const [w, r] of Object.entries(windows)) {
    if (r.epochs && r.epochs.length > 1) flag("window_reset", w === "weekly" ? "warning" : "info", `${w} window reset ${r.epochs.length - 1}× during the run; one intercept per window`);
    if (r.step && r.step !== 1) flag("meter_step", "info", `${w} readings move in steps of ${r.step} pp`);
    for (const s of r.shortSteps || []) flag("meter_jump", "error", `${w}: meter ran ${s.extraPp} pp ahead of usage at ${s.ts}`);
    if (r.usable && r.usdPerPp.bounds === null) flag("not_exactly_linear", "info", `${w}: no single line through every step; the meter does not follow API $ exactly`);
    if (!r.usable) flag("window_unusable", w === "weekly" ? "error" : "warning", `${w}: ${r.reason}`);
  }
  const idle = idleChecks(priced, manifest?.idle, wins);
  for (const it of idle) if (it.moved) flag("meter_moved_idle", "error", `${it.window} moved ${it.before} → ${it.after} during idle check (${it.phase})`);
  for (const it of manifest?.idle || []) if (!idle.some((x) => x.phase === it.phase && x.checked)) flag("idle_unchecked", "warning", `idle check ${it.phase} has no readings on both sides`);
  if (manifest && !(manifest.idle || []).length) flag("idle_missing", "warning", "no idle checks recorded");
  if (manifest?.concurrentCodex?.length) flag("concurrent_codex_process", "warning", `${manifest.concurrentCodex.length} other codex process(es) running at start`);

  // subsidy (weekly window, site definition)
  const wk = windows.weekly;
  let subsidy = null;
  if (wk?.usable && fee != null) {
    const b = wk.usdPerPp;
    const monthly = (x) => 100 * x * WEEKS_PER_MONTH;
    subsidy = {
      definition: `monthly API value = 100 × weekly $/pp × 4 weeks; multiple = monthly ÷ $${fee}`,
      window: "weekly",
      monthlyApiUsd: { est: monthly(b.est), ci95: b.ci95 ? b.ci95.map(monthly) : null },
      multiple: { est: monthly(b.est) / fee, ci95: b.ci95 ? b.ci95.map((x) => monthly(x) / fee) : null, sigmaLn: b.relSe },
    };
    if (site?.subsidy) {
      const ratio = subsidy.multiple.est / site.subsidy;
      subsidy.site = { value: site.subsidy, source: site.source ?? null, ratio, lnRatio: Math.log(ratio) };
    }
  }
  const fh = windows["5h"];
  const fiveHourPerWeek = wk?.usable && fh?.usable ? { est: wk.usdPerPp.est / fh.usdPerPp.est, se: (wk.usdPerPp.est / fh.usdPerPp.est) * Math.hypot(wk.usdPerPp.relSe, fh.usdPerPp.relSe) } : null;

  const sev = new Set(flags.map((f) => f.severity));
  const ts = calls.map((c) => c.ts);
  const result = {
    schema: RESULT_SCHEMA,
    tag: manifest?.tag ?? null,
    arm: manifest?.arm ?? null,
    plan: P.id,
    planName: P.name,
    planTypes,
    planPriceUsd: fee,
    model,
    effortExpected: expected.effort ?? null,
    verdict: sev.has("error") ? "contaminated" : sev.has("warning") ? "check" : "clean",
    run: {
      start: ts.length ? new Date(Math.min(...ts)).toISOString() : null,
      end: ts.length ? new Date(Math.max(...ts)).toISOString() : null,
      minutes: ts.length ? (Math.max(...ts) - Math.min(...ts)) / 60000 : 0,
      sessions: tl.runSessions.length,
      calls: calls.length,
      tasks: manifest?.tasks?.length ?? null,
      codexVersions: [...new Set(tl.runSessions.map((s) => s.cliVersion).filter(Boolean))],
    },
    prices: { source: prices.source, asOf: prices.asOf, unit: "USD per 1M tokens", model, ...prices.models[model] },
    tokens,
    usd,
    usdShare: usd.total > 0 ? { uncachedInput: usd.uncachedInput / usd.total, cachedInput: usd.cachedInput / usd.total, output: usd.output / usd.total } : null,
    cacheShare: { tokens: tokens.input > 0 ? tokens.cachedInput / tokens.input : null, usd: usd.total > 0 ? usd.cachedInput / usd.total : null },
    reasoningShareOfOutput: tokens.output > 0 ? tokens.reasoning / tokens.output : null,
    effort: byEffort,
    models: byModel,
    windows,
    fiveHourWindowsPerWeek: fiveHourPerWeek,
    subsidy,
    idle,
    otherSessions: others,
    flags,
  };
  return roundDeep(result, 6);
}

// ---------------------------------------------------------------------------------------------
// Two-run comparison (rate-card test)
// ---------------------------------------------------------------------------------------------

/**
 * Compare two results on the weekly window. ρ = β_A / β_B. If the meter charged API $ exactly,
 * ρ = 1 whatever the mix. Under "meter = γ·(w·U + other $)", with U the uncached-input $ share u:
 * w = 1 + (1 − ρ) / (ρ·u_A − u_B). w = 1 means uncached input counts at its API price.
 */
export function compareResults(a, b, { draws = 4000, seed = 1 } = {}) {
  const wa = a.windows?.weekly;
  const wb = b.windows?.weekly;
  if (!wa?.usable || !wb?.usable) return { schema: COMPARE_SCHEMA, ok: false, reason: "weekly window unusable in one run" };
  if ((a.plan ?? "plus") !== (b.plan ?? "plus")) return { schema: COMPARE_SCHEMA, ok: false, reason: `runs on different plans: ${a.plan} and ${b.plan}` };
  const ba = wa.usdPerPp.est;
  const bb = wb.usdPerPp.est;
  const sa = wa.usdPerPp.relSe;
  const sb = wb.usdPerPp.relSe;
  const lnRho = Math.log(ba / bb);
  const sd = Math.hypot(sa, sb);
  const z = lnRho / sd;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const ua = a.usdShare.uncachedInput;
  const ub = b.usdShare.uncachedInput;
  const wOf = (rho) => 1 + (1 - rho) / (rho * ua - ub);
  let wEst = null;
  let wCi = null;
  if (Math.abs(ua - ub) >= 0.1) {
    wEst = wOf(Math.exp(lnRho));
    const rnd = mulberry32(seed);
    const ws = [];
    for (let i = 0; i < draws; i++) {
      const u1 = Math.max(rnd(), 1e-12);
      const u2 = rnd();
      const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      ws.push(wOf(Math.exp(lnRho + sd * g)));
    }
    ws.sort((x, y) => x - y);
    wCi = [ws[Math.floor(0.025 * draws)], ws[Math.floor(0.975 * draws)]];
  }
  return roundDeep({
    schema: COMPARE_SCHEMA,
    ok: true,
    a: { tag: a.tag, arm: a.arm, usdPerPp: ba, relSe: sa, uncachedInputShare: ua, cachedInputShare: a.usdShare.cachedInput, outputShare: a.usdShare.output, subsidy: a.subsidy?.multiple?.est ?? null },
    b: { tag: b.tag, arm: b.arm, usdPerPp: bb, relSe: sb, uncachedInputShare: ub, cachedInputShare: b.usdShare.cachedInput, outputShare: b.usdShare.output, subsidy: b.subsidy?.multiple?.est ?? null },
    ratio: { est: Math.exp(lnRho), ci95: [Math.exp(lnRho - 1.96 * sd), Math.exp(lnRho + 1.96 * sd)], z, p },
    mixGap: { uncachedInputShare: ua - ub },
    uncachedInputWeight: wEst != null ? { est: wEst, ci95: wCi } : null,
    verdict: p >= 0.05 && Math.abs(lnRho) <= Math.log(1.1) ? "price-proportional" : p < 0.05 ? "not price-proportional" : "inconclusive",
  });
}
