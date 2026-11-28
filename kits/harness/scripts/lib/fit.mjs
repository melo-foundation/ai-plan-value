/**
 * Fit API $ per meter point from meter readings taken between tasks.
 *
 * Each reading j carries the meter value r_j (% used) and the run's cumulative API $ C_j at the
 * moment it was taken. Readings are taken between tasks, so C_j is exact (no lag). A step of the
 * meter from level k−q to k happened somewhere in [C_{j−1}, C_j]; the Codex kit's fitter
 * (kits/codex/scripts/rollout-fit.mjs) turns those intervals into one slope β ($ per pp) with GLS,
 * a 95% interval, hard bounds and short-step (outside use) detection. Sparse manual readings give
 * wide intervals, which the censoring term in that fit carries into the error.
 *
 * Fine-grained meters (fractions from an internal API) are floored to a coarser grid before the
 * fit so that one window has at most MAX_LEVELS levels: a floored exact meter is still a step meter.
 */

import * as RF from "../../../codex/scripts/rollout-fit.mjs";

export const MAX_LEVELS = 80;
const GRID = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

/** API $ of one usage record. usage: { uncached, cached, cacheWrite, output } tokens; price per 1M. */
export function priceUsage(u, p) {
  const parts = {
    uncachedInput: ((u.uncached + (u.cacheWrite || 0)) * p.input) / 1e6,
    cachedInput: (u.cached * p.cachedInput) / 1e6,
    output: (u.output * p.output) / 1e6,
  };
  return { usd: parts.uncachedInput + parts.cachedInput + parts.output, parts };
}

/** Grid step for the fit: the reading step, coarsened so that the observed span has ≤ MAX_LEVELS levels. */
export function fitGrid(readings) {
  const q0 = RF.detectStep(readings.map((x) => ({ r: x.pct })));
  const pcts = readings.map((x) => x.pct);
  const span = Math.max(...pcts) - Math.min(...pcts);
  for (const q of GRID) if (q >= q0 - 1e-12 && span / q <= MAX_LEVELS) return { q, readingStep: q0 };
  return { q: GRID[GRID.length - 1], readingStep: q0 };
}

/**
 * readings: [{ ts (ms), pct, usd (cumulative API $), resetsAt (s or null) }] in time order, one
 * window. Returns the window fit (usable or not, with a reason).
 */
export function fitReadings(readings, { window = null } = {}) {
  const base = { window, readings: readings.length };
  if (readings.length < 2) return { ...base, usable: false, reason: "fewer than 2 readings" };
  const { q, readingStep } = fitGrid(readings);
  const floorQ = (x) => Math.floor(x / q + 1e-9) * q;
  const rs = readings.map((x, i) => ({ i, ts: x.ts, r: q === readingStep ? x.pct : floorQ(x.pct), resetsAt: x.resetsAt ?? null, cb: x.usd, ca: x.usd }));
  const epochs = RF.epochsOf(rs);
  const observedPp = epochs.reduce((s, ep) => s + (ep[ep.length - 1].r - ep[0].r), 0);
  const info = {
    ...base,
    readingStep,
    fitStep: q,
    epochs: epochs.length,
    firstReading: readings[0].pct,
    lastReading: readings[readings.length - 1].pct,
    observedPp: RF.round(observedPp, 6),
  };
  const w = RF.fitWindowAtLag(epochs, q, 0);
  if (!w.fit || !(w.fit.beta > 0)) return { ...info, usable: false, crossings: w.cr.length, reason: `fewer than 2 steps of ${q} pp inside one window epoch` };
  const crit = w.fit.df >= 1 ? RF.tCrit(w.fit.df) : null;
  const beta = w.fit.beta;
  const se = w.fit.se;
  const jumps = excessMoves(readings, beta, readingStep);
  return {
    ...info,
    usable: true,
    crossings: w.cr.length,
    segments: w.fit.segments,
    usdPerPp: {
      est: beta,
      se,
      relSe: se / beta,
      ci95: crit != null ? [beta - crit * se, beta + crit * se] : null,
      bounds: w.bounds,
      naiveFirstLast: RF.naiveSlope(w.cr),
      df: w.fit.df,
    },
    shortSteps: [
      ...w.breaks.map((b) => ({ ts: new Date(rs[b.at].ts).toISOString(), level: b.k, extraPp: RF.round(b.shortPp, 3) })),
      ...jumps.filter((j) => !w.breaks.some((b) => b.at === j.i)).map((j) => ({ ts: new Date(readings[j.i].ts).toISOString(), level: readings[j.i].pct, extraPp: RF.round(j.extraPp, 3) })),
    ],
  };
}

/**
 * Reading intervals where the meter moved more than the run's API $ explain: excess = Δpct −
 * Δ$ / β above max(2 reading steps, 5 robust SDs of the excess, 0.5 pp). Window resets (a falling
 * reading) are skipped. Catches outside use that lands inside one task, which the step fit alone
 * misses when a task costs more than one meter step.
 */
export function excessMoves(readings, beta, step = 1) {
  const ex = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    if (b.pct < a.pct) continue;
    ex.push({ i, e: b.pct - a.pct - (b.usd - a.usd) / beta });
  }
  if (ex.length < 4) return [];
  const med = (xs) => {
    const s = [...xs].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const m = med(ex.map((x) => x.e));
  const sd = 1.4826 * med(ex.map((x) => Math.abs(x.e - m)));
  const thr = Math.max(2 * step, 5 * sd, 0.5);
  return ex.filter((x) => x.e - m > thr).map((x) => ({ i: x.i, extraPp: x.e - m }));
}

/**
 * Idle checks: pairs of readings with no task between them. moved = the later reading is above
 * the earlier one by at least the reading step (a window reset is not movement).
 */
export function idleMoves(idle, readings, step = 0) {
  return (idle || []).map((it) => {
    const a = readings[it.from];
    const b = readings[it.to];
    if (!a || !b) return { phase: it.phase, checked: false };
    const reset = b.pct < a.pct || (a.resetsAt != null && b.resetsAt != null && Math.abs(b.resetsAt - a.resetsAt) > RF.RESET_TOLERANCE_S);
    const delta = b.pct - a.pct;
    return { phase: it.phase, checked: !reset, before: a.pct, after: b.pct, minutes: RF.round((b.ts - a.ts) / 60000, 2), moved: !reset && delta > Math.max(step, 0) / 2 && delta > 1e-9 };
  });
}

export { RF };
