/**
 * Stopping rule shared by every adapter: stop when the 95% interval of the fitted API $ (or ACUs)
 * per meter point is within ±precision of the estimate with at least MIN_STOP_STEPS meter steps,
 * or when the run has used maxPct points of the plan's window since the start, whichever comes
 * first. The precision test also runs on the finest window the adapter reads (e.g. a 5-hour meter
 * next to the weekly one), because finer steps narrow the interval sooner; either window reaching
 * ±precision stops the run, so a stuck fine meter costs nothing. The cap and the subsidy use the
 * plan's window.
 */

import { fitReadings } from "./fit.mjs";

export const DEFAULT_PRECISION = 0.1;
export const DEFAULT_MAX_PCT = 5;
export const MIN_STOP_STEPS = 3;

/** Meter points used across readings: rises summed, falls (window resets) skipped. */
export function usedPp(readings) {
  let s = 0;
  for (let i = 1; i < readings.length; i++) if (readings[i].pct > readings[i - 1].pct) s += readings[i].pct - readings[i - 1].pct;
  return s;
}

/** 95% half-width ÷ estimate of a fitReadings result, or null when there is no interval. */
export function relHalfWidth(fit) {
  const b = fit?.usable ? fit.usdPerPp : null;
  if (!b?.ci95 || !(b.est > 0)) return null;
  return (b.ci95[1] - b.ci95[0]) / 2 / b.est;
}

/**
 * readings: manifest readings from the first task's start reading on ({ ts, pct, tasksDone,
 * resetsAt, fine? }); cum: cumulative $ (or ACUs) after each task, cum[0] = 0.
 * Returns { stop, reached, reason, halfWidth, steps, usedPp, window }.
 */
export function stopCheck({ readings, cum, precision = DEFAULT_PRECISION, maxPct = DEFAULT_MAX_PCT, window = null, fineWindow = null }) {
  const at = (r) => cum[Math.min(r.tasksDone, cum.length - 1)];
  const toFit = (rs, pick) => rs.map((r) => ({ ts: Date.parse(r.ts), pct: pick(r).pct, usd: at(r), resetsAt: pick(r).resetsAt ?? null }));
  const test = (rs, w) => {
    const fit = fitReadings(rs, { window: w });
    const halfWidth = relHalfWidth(fit);
    const steps = fit.crossings ?? 0;
    return { window: w, halfWidth, steps, ok: halfWidth != null && halfWidth <= precision && steps >= MIN_STOP_STEPS };
  };
  const tests = [test(toFit(readings, (r) => r), window)];
  // the fine window counts only when every reading since the start has it
  const fine = fineWindow ? readings.filter((r) => r.fine && Number.isFinite(r.fine.pct)) : [];
  if (fineWindow && fine.length === readings.length && fine.length >= 2) tests.unshift(test(toFit(fine, (r) => r.fine), fineWindow));
  const narrow = (x) => (x.halfWidth == null ? Infinity : x.halfWidth);
  const best = tests.find((x) => x.ok) || [...tests].sort((x, y) => narrow(x) - narrow(y))[0];
  const used = usedPp(readings);
  const base = { halfWidth: best.halfWidth, steps: best.steps, usedPp: used, window: best.window };
  if (best.ok) return { ...base, stop: true, reached: true, reason: "precision reached" };
  if (used >= maxPct - 1e-9) return { ...base, stop: true, reached: false, reason: `+${maxPct} pp cap reached` };
  return { ...base, stop: false, reached: false, reason: null };
}
