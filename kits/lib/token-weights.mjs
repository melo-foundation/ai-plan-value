/**
 * Token-weight fit shared by the Codex and API plan kits: how a plan's usage meter weights each
 * token type relative to its API price.
 *
 * Model. Every call costs API $ in K kinds (uncached input, cached input, visible output,
 * reasoning, cache writes; the kit picks the list). The meter charges
 *     meter units = Σ_k θ_k × $_k,      θ_k = w_k ÷ β,
 * with w_k the kind's weight relative to its API price (w_ref = 1 for the reference kind) and β the
 * API $ per meter step at weight 1. Readings are rounded to a step Q; each step crossed is located
 * between two consecutive readings, whose cumulative $ vectors are lo and hi. With m = (lo + hi)/2
 * and d = (hi − lo)/2, the level y of the step satisfies
 *     y = α_seg + θ·m + e,   e = censoring (uniform, variance (θ·d)²/3) + white noise ω² + a random
 *                                walk τ²·min(i, j) inside a segment (one segment per run and window
 *                                epoch, each with its own intercept α).
 * θ ≥ 0 by enumerating active sets (K ≤ 6); the variance depends on θ, so the fit iterates.
 * τ and ω are profiled by REML on a grid. Both reading lags are fitted (lag 0: a reading includes
 * its own call; lag 1: it does not); the better REML is kept and the gap between them is added to
 * the interval.
 *
 * Intervals: parametric bootstrap (y* = fitted + V^½ z at the fitted θ, τ, ω; refit), 2.5–97.5
 * percentiles of w_k = θ_k / θ_ref, widened by the lag gap. Kinds below 5% of the API $ of every
 * fit run are held at weight 1 and reported as not identified; a kind is identified when some fit
 * run has ≥ 50% of its API $ and of its fitted meter $ in it.
 *
 * Holdout check: each holdout run's own slope (meter steps per API $, one-kind fit of the same
 * model) against the slope the fitted weights predict from its token mix; ratio = predicted ÷
 * measured, 95% interval from the bootstrap draws and the run's own standard error.
 *
 * Zero dependencies (Node ≥ 20).
 */

export const SCHEMA = "token-weights.fit/1";
export const MIN_STEPS = 3;
export const IDENT_SHARE = 0.5;
export const MINOR_SHARE = 0.05;
const RESET_TOLERANCE_S = 600;
const MAX_LEVELS = 160;
const TAU_GRID = [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3];
const OMEGA_GRID = [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3];
const Z95 = 1.959964;

// ---------------------------------------------------------------------------------------------
// Small numerics
// ---------------------------------------------------------------------------------------------

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

function gauss(rnd) {
  const u1 = Math.max(rnd(), 1e-12);
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

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

/** Solve L x = b (forward). */
function fwd(L, b) {
  const n = L.length;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function cholSolve(L, b) {
  const n = L.length;
  const y = fwd(L, b);
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function invertSpd(A) {
  const L = cholesky(A);
  if (!L) return null;
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    const e = new Float64Array(n);
    e[j] = 1;
    cols.push(cholSolve(L, e));
  }
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => cols[j][i]));
}

function lnGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a, b, x) {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function tCrit(df, level = 0.95) {
  if (!(df >= 1)) return null;
  const cdf = (t) => 1 - 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  const target = 1 - (1 - level) / 2;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const quantile = (sorted, p) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

export function round(x, d = 6) {
  if (x == null || !Number.isFinite(x)) return x ?? null;
  return Number(x.toPrecision(d));
}
export function roundDeep(o, d = 6) {
  if (Array.isArray(o)) return o.map((x) => roundDeep(x, d));
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, roundDeep(v, d)]));
  if (typeof o === "number" && !Number.isInteger(o)) return round(o, d);
  return o;
}

// ---------------------------------------------------------------------------------------------
// Readings → step crossings
// ---------------------------------------------------------------------------------------------

/** Largest of 1000 … 1e-6 that divides every value. */
export function resolutionOf(values) {
  const steps = [1000, 100, 10, 1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.001, 1e-4, 1e-5, 1e-6];
  for (const q of steps) if (values.every((v) => Math.abs(v / q - Math.round(v / q)) < 1e-6)) return q;
  return 1e-6;
}

/** Split readings at window resets (resets_at moves by > 10 min, or the reading falls). */
export function epochsOf(readings) {
  const out = [];
  let cur = [];
  for (const x of readings) {
    const prev = cur[cur.length - 1];
    const moved = prev && prev.resetsAt != null && x.resetsAt != null && Math.abs(x.resetsAt - prev.resetsAt) > RESET_TOLERANCE_S;
    if (prev && (moved || x.r < prev.r - 1e-12)) {
      out.push(cur);
      cur = [];
    }
    cur.push(x);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Common grid of one window over runs: meter resolution q and step Q (a multiple of q), raised
 * until the runs cross at most MAX_LEVELS levels in all (the GLS is cubic in the crossings; fine
 * meters such as 0.01% or token counts would otherwise give thousands).
 */
export function gridOf(runs, w, moveRuns = runs) {
  const all = runs.flatMap((r) => (r.windows?.[w] || []).map((x) => x.r));
  if (!all.length) return null;
  const q = resolutionOf(all);
  let move = 0;
  for (const r of moveRuns) for (const ep of epochsOf(r.windows?.[w] || [])) move += ep[ep.length - 1].r - ep[0].r;
  const Q = q * Math.max(1, Math.ceil(move / q / MAX_LEVELS - 1e-9));
  return { q, Q };
}

/**
 * Crossings of one run's window at one lag: [{ run, seg, y, m[K], d[K], i }]. seg is local to the
 * run (0…); i = steps since the segment's first crossing.
 */
export function crossingsOf(readings, { lag = 0, Q = 1 } = {}) {
  const out = [];
  let seg = -1;
  for (const ep of epochsOf(readings)) {
    seg++;
    let first = null;
    for (let j = 1; j < ep.length; j++) {
      const a = ep[j - 1];
      const b = ep[j];
      const la = Math.floor(a.r / Q + 1e-9);
      const lb = Math.floor(b.r / Q + 1e-9);
      if (lb <= la) continue;
      const lo = a.ref[lag];
      const hi = b.ref[lag];
      const m = lo.map((x, k) => (x + hi[k]) / 2);
      const d = lo.map((x, k) => Math.max(0, (hi[k] - x) / 2));
      for (let L = la + 1; L <= lb; L++) {
        if (first == null) first = L;
        out.push({ seg, y: L, m, d, i: L - first });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// GLS with non-negative slopes
// ---------------------------------------------------------------------------------------------

/**
 * One GLS fit at fixed θ (for V), τ, ω. cr: crossings with global seg ids 0…S−1 and group values
 * g[P] (from m) and h[P] (from d). ref: index of the group that must stay > 0 (null: none).
 * Returns { theta[P], alpha[S], reml, quad, cov (P×P, active groups; null elsewhere), active[] }.
 */
function glsOnce(cr, S, P, thetaV, tau, omega, ref, yOverride = null, Lcache = null) {
  const n = cr.length;
  let L = Lcache;
  if (!L) {
    const V = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      let hd = 0;
      for (let p = 0; p < P; p++) hd += thetaV[p] * cr[i].h[p];
      for (let j = 0; j <= i; j++) {
        let v = 0;
        if (cr[i].seg === cr[j].seg) v += tau * tau * Math.min(cr[i].i, cr[j].i);
        if (i === j) v += (hd * hd) / 3 + omega * omega + 1e-10;
        V[i][j] = v;
        V[j][i] = v;
      }
    }
    L = cholesky(V);
    if (!L) return null;
  }
  const y = yOverride || Float64Array.from(cr.map((c) => c.y));
  const cols = S + P;
  // whitened design columns and y
  const Wx = [];
  for (let c = 0; c < cols; c++) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = c < S ? (cr[i].seg === c ? 1 : 0) : cr[i].g[c - S];
    Wx.push(fwd(L, col));
  }
  const Wy = fwd(L, y);
  const G = Array.from({ length: cols }, () => new Float64Array(cols));
  const b = new Float64Array(cols);
  for (let a = 0; a < cols; a++) {
    for (let c = a; c < cols; c++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += Wx[a][i] * Wx[c][i];
      G[a][c] = s;
      G[c][a] = s;
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += Wx[a][i] * Wy[i];
    b[a] = s;
  }
  let yy = 0;
  for (let i = 0; i < n; i++) yy += Wy[i] * Wy[i];
  let best = null;
  for (let mask = 0; mask < 1 << P; mask++) {
    if (ref != null && !(mask & (1 << ref))) continue;
    const idx = [];
    for (let s = 0; s < S; s++) idx.push(s);
    for (let p = 0; p < P; p++) if (mask & (1 << p)) idx.push(S + p);
    if (idx.length > n) continue;
    const Gs = idx.map((r) => idx.map((c) => G[r][c]));
    const Ls = cholesky(Gs);
    if (!Ls) continue;
    const sol = cholSolve(Ls, Float64Array.from(idx.map((r) => b[r])));
    let ok = true;
    for (let t = S; t < idx.length; t++) if (!(sol[t] > 0)) ok = false;
    if (!ok) continue;
    let quad = yy;
    for (let t = 0; t < idx.length; t++) quad -= sol[t] * b[idx[t]];
    if (!best || quad < best.quad - 1e-12 * Math.max(1, Math.abs(best.quad))) best = { idx, sol, quad, Ls };
  }
  if (!best) return null;
  const theta = new Array(P).fill(0);
  const alpha = new Array(S).fill(0);
  best.idx.forEach((c, t) => (c < S ? (alpha[c] = best.sol[t]) : (theta[c - S] = best.sol[t])));
  let logdet = 0;
  for (let i = 0; i < n; i++) logdet += 2 * Math.log(L[i][i]);
  let logdetX = 0;
  for (let i = 0; i < best.Ls.length; i++) logdetX += 2 * Math.log(best.Ls[i][i]);
  const reml = -0.5 * (logdet + Math.max(best.quad, 0) + logdetX);
  // covariance of the active slopes (Wald)
  const inv = invertSpd(best.idx.map((r) => best.idx.map((c) => G[r][c])));
  const cov = Array.from({ length: P }, () => new Array(P).fill(null));
  if (inv) best.idx.forEach((r, a) => best.idx.forEach((c, bb) => r >= S && c >= S && (cov[r - S][c - S] = inv[a][bb])));
  return { theta, alpha, reml, quad: best.quad, cov, active: best.idx.filter((c) => c >= S).map((c) => c - S), L, df: n - best.idx.length };
}

/** Fit at fixed τ, ω: iterate θ (V depends on it). */
function fitFixed(cr, S, P, theta0, tau, omega, ref, y = null) {
  let theta = theta0;
  let r = null;
  for (let it = 0; it < 6; it++) {
    const next = glsOnce(cr, S, P, theta, tau, omega, ref, y);
    if (!next) return r;
    const moved = Math.max(...next.theta.map((t, p) => Math.abs(t - theta[p]) / Math.max(Math.abs(theta[p]), 1e-12)));
    r = next;
    theta = next.theta;
    if (moved < 1e-6) break;
  }
  return r;
}

/** Start: one common slope through all groups (API-price weights). */
function startTheta(cr, S, P, ref) {
  const one = cr.map((c) => ({ ...c, g: [c.g.reduce((a, b) => a + b, 0)], h: [c.h.reduce((a, b) => a + b, 0)] }));
  const r = glsOnce(one, S, 1, [0], 0, 1, ref == null ? null : 0);
  const t = r && r.theta[0] > 0 ? r.theta[0] : 1;
  return new Array(P).fill(t);
}

/** Profile τ, ω by REML; returns the best fit with tau, omega. */
export function fitCrossings(cr, S, P, { ref = 0, tauGrid = TAU_GRID, omegaGrid = OMEGA_GRID } = {}) {
  if (cr.length < S + 2) return null;
  const theta0 = startTheta(cr, S, P, ref);
  let best = null;
  for (const tau of tauGrid) {
    for (const omega of omegaGrid) {
      const r = fitFixed(cr, S, P, theta0, tau, omega, ref);
      if (r && (!best || r.reml > best.reml)) best = { ...r, tau, omega };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Joint fit of one window
// ---------------------------------------------------------------------------------------------

/**
 * Groups of kinds for the design: the reference kind plus every kind held at weight 1 share one
 * column; each free kind has its own.
 */
function groupsFor(kinds, ref, free) {
  const groups = [[kinds.indexOf(ref), ...kinds.map((k, i) => (k !== ref && !free.includes(k) ? i : -1)).filter((i) => i >= 0)]];
  for (const k of free) groups.push([kinds.indexOf(k)]);
  return groups;
}

function toGroups(cr, groups) {
  return cr.map((c) => ({ ...c, g: groups.map((gr) => gr.reduce((a, k) => a + c.m[k], 0)), h: groups.map((gr) => gr.reduce((a, k) => a + c.d[k], 0)) }));
}

/** Crossings of every run in `runs` for window w at one lag, with global segment ids. */
function allCrossings(runs, w, lag, Q) {
  const out = [];
  let base = 0;
  const perRun = [];
  for (const r of runs) {
    const cr = crossingsOf(r.windows?.[w] || [], { lag, Q });
    const segs = cr.length ? Math.max(...cr.map((c) => c.seg)) + 1 : 0;
    // renumber this run's segments that have crossings
    const ids = [...new Set(cr.map((c) => c.seg))];
    const map = new Map(ids.map((s, n) => [s, base + n]));
    for (const c of cr) out.push({ ...c, seg: map.get(c.seg), run: r.tag });
    perRun.push({ tag: r.tag, crossings: cr.length, segments: ids.length, epochs: segs });
    base += ids.length;
  }
  return { cr: out, S: base, perRun };
}

/** Share of each kind in a run's API $ (totals vector). */
const shares = (usd) => {
  const t = usd.reduce((a, b) => a + b, 0);
  return usd.map((x) => (t > 0 ? x / t : 0));
};

/**
 * fitWindow({ runs, kinds, ref, window, boot, seed })
 *   runs: [{ tag, arm, role: "fit" | "holdout", usd: [K] API $ per kind,
 *            windows: { [w]: [{ r, resetsAt, ref: [lag0 vector[K], lag1 vector[K]] }] } }]
 * Returns the window's weights, scale, holdout checks and diagnostics.
 */
export function fitWindow({ runs, kinds, ref, window: w, boot = 400, seed = 1, unit = "pp" }) {
  const K = kinds.length;
  const fitRuns = runs.filter((r) => r.role === "fit" && (r.windows?.[w] || []).length >= 2);
  const holdRuns = runs.filter((r) => r.role === "holdout" && (r.windows?.[w] || []).length >= 2);
  const grid = gridOf([...fitRuns, ...holdRuns], w, fitRuns);
  const base = { window: w, unit, fitRuns: fitRuns.map((r) => r.tag), holdoutRuns: holdRuns.map((r) => r.tag) };
  if (!grid || !fitRuns.length) return { ...base, usable: false, reason: "no fit run has readings on this window" };
  const { q, Q } = grid;
  // kinds with data, minor kinds held at 1
  const maxShare = kinds.map((_, k) => Math.max(...fitRuns.map((r) => shares(r.usd)[k])));
  const free = kinds.filter((k, i) => k !== ref && maxShare[i] >= MINOR_SHARE);
  const held = kinds.filter((k, i) => k !== ref && maxShare[i] < MINOR_SHARE);
  const groups = groupsFor(kinds, ref, free);
  const P = groups.length;
  const fits = [0, 1].map((lag) => {
    const { cr, S, perRun } = allCrossings(fitRuns, w, lag, Q);
    const crg = toGroups(cr, groups);
    const f = cr.length >= S + P + 1 ? fitCrossings(crg, S, P, { ref: 0 }) : null;
    return { lag, cr: crg, S, perRun, f };
  });
  const ok = fits.filter((x) => x.f);
  const perRun = fits[0].perRun;
  if (!ok.length) return { ...base, usable: false, step: Q, reason: `too few steps: ${perRun.map((p) => `${p.tag} ${p.crossings}`).join(", ")} (need ${MIN_STEPS}+ per run and more steps than fitted values)`, perRun };
  ok.sort((a, b) => b.f.reml - a.f.reml);
  const chosen = ok[0];
  const other = ok[1] || null;
  const { f, cr, S } = chosen;
  const kindTheta = (theta) => kinds.map((_, k) => theta[groups.findIndex((g) => g.includes(k))]);
  const wOf = (theta) => {
    const t = kindTheta(theta);
    const tr = t[kinds.indexOf(ref)];
    return t.map((x) => x / tr);
  };
  const west = wOf(f.theta);
  const wOther = other ? wOf(other.f.theta) : null;
  const scaleOf = (theta) => 1 / (theta[0] * Q); // API $ per meter unit at weight 1

  // parametric bootstrap at the fitted θ, τ, ω
  const rnd = mulberry32(seed);
  const n = cr.length;
  const fitted = cr.map((c) => f.alpha[c.seg] + c.g.reduce((a, g, p) => a + g * f.theta[p], 0));
  const draws = [];
  for (let b = 0; b < boot; b++) {
    const z = Array.from({ length: n }, () => gauss(rnd));
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k <= i; k++) s += f.L[i][k] * z[k];
      ys[i] = fitted[i] + s;
    }
    const r = fitFixed(cr, S, P, f.theta, f.tau, f.omega, 0, ys);
    if (r) draws.push(r.theta);
  }
  const wDraws = draws.map(wOf);
  const scaleDraws = draws.map(scaleOf);
  const ciOf = (vals, est, gap) => {
    const s = [...vals].sort((a, b) => a - b);
    const lo = quantile(s, 0.025);
    const hi = quantile(s, 0.975);
    if (lo == null) return null;
    const extra = Z95 * (gap / 2);
    return [Math.max(0, est - Math.hypot(est - lo, extra)), est + Math.hypot(hi - est, extra)];
  };
  // identification: some fit run with ≥ 50% of its API $ and fitted meter $ in the kind
  const runShare = fitRuns.map((r) => {
    const api = shares(r.usd);
    const meter = shares(r.usd.map((x, k) => x * west[k]));
    return { tag: r.tag, api, meter };
  });
  const weights = {};
  kinds.forEach((k, i) => {
    const best = Math.max(...runShare.map((s) => Math.min(s.api[i], s.meter[i])));
    if (k === ref) {
      weights[k] = { est: 1, fixed: true, identified: true, role: "reference" };
      return;
    }
    if (held.includes(k)) {
      weights[k] = { est: null, held: 1, identified: false, reason: maxShare[i] > 0 ? `below ${100 * MINOR_SHARE}% of every fit run's API $` : "no data" };
      return;
    }
    const gap = wOther ? Math.abs(wOther[i] - west[i]) : 0;
    const vals = wDraws.map((d) => d[i]);
    const identified = best >= IDENT_SHARE;
    weights[k] = {
      est: west[i],
      ci95: ciOf(vals, west[i], gap),
      se: vals.length > 1 ? Math.hypot(sd(vals), gap / 2) : null,
      identified,
      ...(identified ? {} : { reason: `largest share in one fit run ${Math.round(100 * best)}% < ${100 * IDENT_SHARE}%` }),
      otherLag: wOther ? wOther[i] : null,
    };
  });
  const scaleEst = scaleOf(f.theta);
  const scaleGap = other ? Math.abs(scaleOf(other.f.theta) - scaleEst) : 0;
  const scale = { usdPerUnit: scaleEst, ci95: ciOf(scaleDraws, scaleEst, scaleGap), unit, definition: `API $ per ${unit} at weight 1 (reference kind ${ref})` };

  // per-run residuals: mean residual in steps and the run's measured ÷ fitted slope
  const resid = cr.map((c, i) => c.y - fitted[i]);
  const rms = Math.sqrt(resid.reduce((a, x) => a + x * x, 0) / Math.max(1, n));

  // holdouts
  const holdout = holdRuns.map((r) => holdoutCheck(r, { w, lag: chosen.lag, Q, kinds, thetaKind: kindTheta(f.theta), drawsKind: draws.map(kindTheta), ref }));

  return {
    ...base,
    usable: true,
    lag: chosen.lag,
    resolution: q,
    step: Q,
    crossings: n,
    segments: S,
    tau: f.tau,
    omega: f.omega,
    rmsResidualSteps: rms,
    bootstrapDraws: draws.length,
    perRun: chosen.perRun.map((p) => ({ ...p, apiShare: Object.fromEntries(kinds.map((k, i) => [k, runShare.find((s) => s.tag === p.tag)?.api[i] ?? null])) })),
    weights,
    scale,
    holdout,
    drawsKept: wDraws.slice(0, 200).map((d) => Object.fromEntries(kinds.map((k, i) => [k, d[i]]))),
  };
}

/**
 * Holdout run: measured slope (steps per API $, one kind) vs the slope the weights predict from the
 * run's mix. ratio = predicted ÷ measured.
 */
export function holdoutCheck(run, { w, lag, Q, kinds, thetaKind, drawsKind, ref }) {
  const total = run.usd.reduce((a, b) => a + b, 0);
  const cr = crossingsOf(run.windows[w] || [], { lag, Q });
  const ids = [...new Set(cr.map((c) => c.seg))];
  const map = new Map(ids.map((s, n) => [s, n]));
  const one = cr.map((c) => ({ ...c, seg: map.get(c.seg), g: [c.m.reduce((a, b) => a + b, 0)], h: [c.d.reduce((a, b) => a + b, 0)] }));
  const base = { tag: run.tag, arm: run.arm ?? null, crossings: cr.length, apiUsd: total };
  if (cr.length < MIN_STEPS || !(total > 0)) return { ...base, usable: false, reason: `${cr.length} steps (need ${MIN_STEPS})` };
  const f = fitCrossings(one, ids.length, 1, { ref: 0 });
  if (!f) return { ...base, usable: false, reason: "fit failed" };
  const measured = f.theta[0];
  const seM = f.cov[0][0] != null ? Math.sqrt(Math.max(f.cov[0][0], 0)) : null;
  const predOf = (t) => run.usd.reduce((a, x, k) => a + x * t[k], 0) / total;
  const pred = predOf(thetaKind);
  const atApi = thetaKind[kinds.indexOf(ref)]; // all weights 1 at the fitted scale
  const lnDraws = drawsKind.map((t) => Math.log(predOf(t)));
  const sdPred = lnDraws.length > 1 ? sd(lnDraws) : 0;
  const crit = tCrit(f.df) ?? Z95;
  const relM = seM != null ? seM / measured : null;
  const sdLn = Math.hypot(sdPred, relM ?? 0);
  const ratio = pred / measured;
  const ci = [ratio * Math.exp(-Math.hypot(Z95 * sdPred, crit * (relM ?? 0))), ratio * Math.exp(Math.hypot(Z95 * sdPred, crit * (relM ?? 0)))];
  return {
    ...base,
    usable: true,
    measuredStepsPerUsd: measured,
    measuredUsdPerUnit: 1 / (measured * Q),
    predictedUsdPerUnit: 1 / (pred * Q),
    ratio: { est: ratio, ci95: ci, sdLn, definition: "predicted ÷ measured meter use per API $" },
    inside: ci[0] <= 1 && ci[1] >= 1,
    apiPriceRatio: { est: atApi / measured, definition: "same, with every weight 1 at the fitted scale" },
    mix: Object.fromEntries(kinds.map((k, i) => [k, run.usd[i] / total])),
  };
}

/** Weights of two windows side by side: ratio per kind, 95% interval from the bootstrap draws. */
export function compareWindows(a, b, kinds) {
  if (!a?.usable || !b?.usable) return { comparable: false, reason: `${a?.usable ? b?.window : a?.window} not usable` };
  const out = {};
  let all = true;
  let any = false;
  for (const k of kinds) {
    const x = a.weights[k];
    const y = b.weights[k];
    if (!x || !y || x.fixed || x.est == null || y.est == null) continue;
    const dx = a.drawsKept.map((d) => d[k]).filter((v) => v > 0);
    const dy = b.drawsKept.map((d) => d[k]).filter((v) => v > 0);
    const est = x.est / y.est;
    if (!(est > 0) || dx.length < 10 || dy.length < 10) {
      out[k] = { ratio: Number.isFinite(est) ? est : null, ci95: null, same: null };
      continue;
    }
    const s = Math.hypot(sd(dx.map(Math.log)), sd(dy.map(Math.log)));
    const ci = [est * Math.exp(-Z95 * s), est * Math.exp(Z95 * s)];
    const same = ci[0] <= 1 && ci[1] >= 1;
    any = true;
    if (!same) all = false;
    out[k] = { ratio: est, ci95: ci, same };
  }
  return { comparable: any, windows: [a.window, b.window], kinds: out, same: any ? all : null, definition: `weight on ${a.window} ÷ weight on ${b.window}; same = the 95% interval contains 1` };
}
