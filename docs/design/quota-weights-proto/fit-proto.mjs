// Prototype of scripts/fit-quota-weights.mjs (zero-dependency). Scratchpad only.
// Model: points_s = gamma_g * sum_k w_k * usd_sk, w_input = 1, w_k >= 0, gamma_g = 1 / (parity-$ per point) per group.
export const KINDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];

// --- deterministic RNG (mulberry32) so runs reproduce ---
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- small dense linear algebra ---
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Weighted NNLS by enumerating active sets (K <= 6): min sum om_i (t_i - X_i.b)^2, b >= 0. */
export function nnls(X, t, om) {
  const K = X[0].length;
  let best = null;
  for (let mask = 0; mask < 1 << K; mask++) {
    const idx = [];
    for (let k = 0; k < K; k++) if (mask & (1 << k)) idx.push(k);
    let b = new Array(K).fill(0);
    if (idx.length) {
      const A = idx.map((i) => idx.map((j) => X.reduce((s, r, n) => s + om[n] * r[i] * r[j], 0)));
      const v = idx.map((i) => X.reduce((s, r, n) => s + om[n] * r[i] * t[n], 0));
      const sol = solve(A, v);
      if (!sol || sol.some((x) => x < 0)) continue;
      idx.forEach((k, i) => (b[k] = sol[i]));
    }
    const rss = X.reduce((s, r, n) => s + om[n] * (t[n] - r.reduce((q, x, k) => q + x * b[k], 0)) ** 2, 0);
    if (!best || rss < best.rss - 1e-15) best = { b, rss };
  }
  return best.b;
}

/**
 * segments: [{ group, session, y, usd: {kind: $}, anchored: bool, boundaryUsd?: [first,last] }]
 * free: kinds to estimate (others fixed at `fixed[k]`, default 1 for input).
 */
export function fit(segments, { free = ["output", "cacheRead", "cacheWrite5m", "cacheWrite1h"], fixed = { input: 1 }, tau = 0.03, iters = 200 } = {}) {
  const groups = [...new Set(segments.map((s) => s.group))];
  let w = Object.fromEntries(KINDS.map((k) => [k, fixed[k] ?? 1]));
  let gamma = Object.fromEntries(groups.map((g) => [g, 1]));
  const z = (s) => KINDS.reduce((q, k) => q + w[k] * (s.usd[k] || 0), 0);
  const variance = (s) => {
    const g = gamma[s.group];
    const round = s.anchored
      ? (s.boundaryUsd || [0, 0]).reduce((q, b) => q + (g * b) ** 2 / 12, 0) + 1e-4
      : 1 / 6;
    return round + (tau * s.y) ** 2;
  };
  for (let it = 0; it < iters; it++) {
    const prev = { ...w };
    for (const g of groups) {
      const S = segments.filter((s) => s.group === g);
      let num = 0, den = 0;
      for (const s of S) { const om = 1 / variance(s), zz = z(s); num += om * s.y * zz; den += om * zz * zz; }
      gamma[g] = den > 0 ? num / den : gamma[g];
    }
    const X = [], t = [], om = [];
    for (const s of segments) {
      const g = gamma[s.group];
      const fixedPart = KINDS.filter((k) => !free.includes(k)).reduce((q, k) => q + w[k] * (s.usd[k] || 0), 0);
      X.push(free.map((k) => s.usd[k] || 0)); t.push(s.y / g - fixedPart); om.push((g * g) / variance(s));
    }
    const b = nnls(X, t, om);
    free.forEach((k, i) => (w[k] = b[i]));
    if (free.every((k) => Math.abs(w[k] - prev[k]) < 1e-10)) break;
  }
  const resid = segments.map((s) => ({ s, pred: gamma[s.group] * z(s), r: s.y - gamma[s.group] * z(s) }));
  return { w, gamma, resid };
}

export function bootstrap(segments, opts, B, rand) {
  const groups = [...new Set(segments.map((s) => s.group))];
  const draws = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (const g of groups) {
      const sess = [...new Set(segments.filter((s) => s.group === g).map((s) => s.session))];
      for (let i = 0; i < sess.length; i++) {
        const pick = sess[Math.floor(rand() * sess.length)];
        for (const s of segments) if (s.group === g && s.session === pick) sample.push({ ...s, session: `${pick}#${i}` });
      }
    }
    draws.push(fit(sample, opts).w);
  }
  return draws;
}

export const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
export const phi = (mix, w) => { const tot = KINDS.reduce((q, k) => q + (mix[k] || 0), 0); return KINDS.reduce((q, k) => q + w[k] * (mix[k] || 0), 0) / tot; };

// ---------------------------------------------------------------------------------------------
// Simulation of the protocol: chained single-kind arms inside one window, integer meter, 1-request lag.
// ---------------------------------------------------------------------------------------------
export function simulateSession({ rand, trueW, parityUsdPerPoint, pointsPerArm, arms, price, noise = 0.03, lag = 1, background = 0, resolution = 1 }) {
  // per-request list-$ by kind for each arm
  // request sizes shrink on small plans so that no request costs more than about 0.1 point
  const sc = Math.min(1, parityUsdPerPoint / 0.68);
  const req = {
    input: () => ({ input: 20000 * sc * price.input }),
    output: () => ({ input: 300 * sc * price.input, output: 1500 * sc * price.output }),
    cacheRead: () => ({ cacheRead: 150000 * price.cacheRead, output: 5 * price.output, input: 3 * price.input }),
    cacheWrite1h: () => ({ cacheWrite1h: 12000 * sc * price.cacheWrite1h, output: 5 * price.output }),
    cacheWrite5m: () => ({ cacheWrite5m: 12000 * sc * price.cacheWrite5m, output: 5 * price.output }),
  };
  let u = rand(); // unknown phase inside the first point
  const segs = [];
  const armNoise = () => 1 + noise * (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3); // ~N(1, noise)
  let pending = []; // lagged request costs not yet visible on the meter
  const visible = () => Math.floor((u - pending.reduce((a, b) => a + b, 0)) / resolution) * resolution;
  for (const arm of arms) {
    const mult = armNoise();
    // warm-up: the read arm writes its prefix once (kept in the data as a real request)
    let cum = Object.fromEntries(KINDS.map((k) => [k, 0]));
    let last = visible(), ticks = [], n = 0, recent = [0, 0];
    const push = (r) => {
      const cost = KINDS.reduce((q, k) => q + trueW[k] * (r[k] || 0), 0) / parityUsdPerPoint * mult + background * rand();
      u += cost; pending.push(cost); if (pending.length > lag) pending.shift();
      for (const k of KINDS) cum[k] += r[k] || 0;
      n++; recent = [recent[1], cost];
      const v = visible();
      // an anchor is valid only when the requests that could have caused the tick are small (<= 0.15 point)
      if (v > last) { if (Math.max(...recent) <= 0.15) ticks.push({ at: { ...cum }, v, reqUsd: KINDS.reduce((q, k) => q + (r[k] || 0), 0) }); last = v; }
    };
    if (arm === "cacheRead") push({ cacheWrite1h: 150000 * price.cacheWrite1h });
    while (ticks.length < pointsPerArm + 1 && n < 20000) push(req[arm]());
    if (ticks.length < 2) continue;
    const a = ticks[0], b = ticks[ticks.length - 1];
    segs.push({
      arm, y: b.v - a.v, anchored: true, boundaryUsd: [a.reqUsd, b.reqUsd],
      usd: Object.fromEntries(KINDS.map((k) => [k, b.at[k] - a.at[k]])),
    });
  }
  return segs;
}
