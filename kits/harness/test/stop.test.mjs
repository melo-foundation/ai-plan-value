// node --test kits/harness/test/*.test.mjs
// The stopping rule: ±precision of the fitted $/pp with 3+ steps, or the +max-pct cap with
// low_precision. Simulated meters at whole %, decimal and very coarse resolutions, the finer
// window and the flag in the result. The run loop under the rule: run.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { RF } from "../scripts/lib/fit.mjs";
import { analyse } from "../scripts/lib/analyse.mjs";
import { DEFAULT_MAX_PCT, DEFAULT_PRECISION, MIN_STOP_STEPS, stopCheck, usedPp } from "../scripts/lib/stop.mjs";
import { FEE, PRICE, simulateManifest } from "./sim.mjs";

/**
 * Feed readings to stopCheck one at a time, as the run loop does. res: meter resolution in pp;
 * every: tasks between readings; ppPerTask: mean meter points per task (β = 1 $/pp).
 * fineRes / fineScale: a second, finer window that moves fineScale × as fast.
 */
function runRule({ res, every = 1, ppPerTask, seed = 1, precision = DEFAULT_PRECISION, maxPct = DEFAULT_MAX_PCT, fineRes = null, fineScale = 10 }) {
  const rnd = RF.mulberry32(seed);
  let U = 12.37 + rnd() * 0.9;
  let F = 3.1;
  let usd = 0;
  let t = Date.parse("2026-11-28T09:00:00Z");
  const q = (x, r) => Math.floor(x / r + 1e-9) * r;
  const reading = (n) => ({ ts: new Date(t).toISOString(), pct: q(U, res), tasksDone: n, resetsAt: null, ...(fineRes ? { fine: { pct: q(F, fineRes), resetsAt: null } } : {}) });
  const readings = [reading(0)];
  const cum = [0];
  for (let n = 1; n <= 400; n++) {
    const c = ppPerTask * (0.4 + 1.2 * rnd());
    usd += c;
    U += c;
    F += c * fineScale;
    cum.push(usd);
    t += 240000;
    if (n % every) continue;
    readings.push(reading(n));
    const st = stopCheck({ readings, cum, precision, maxPct, window: "weekly", fineWindow: fineRes ? "5h" : null });
    if (st.stop) return { ...st, tasks: n, readings: readings.length };
  }
  return { stop: false, tasks: 400 };
}

test("defaults: ±10%, 5 pp, 3 steps", () => {
  assert.equal(DEFAULT_PRECISION, 0.1);
  assert.equal(DEFAULT_MAX_PCT, 5);
  assert.equal(MIN_STOP_STEPS, 3);
  assert.equal(usedPp([{ pct: 10 }, { pct: 12 }, { pct: 1 }, { pct: 2.5 }]), 3.5, "a fall (reset) is skipped");
});

test("decimal meter read after every task: stops at ±10% well before the cap", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const st = runRule({ res: 1e-6, ppPerTask: 0.2, seed });
    assert.equal(st.reached, true, JSON.stringify(st));
    assert.equal(st.reason, "precision reached");
    assert.ok(st.halfWidth <= 0.1 && st.steps >= 3, JSON.stringify(st));
    assert.ok(st.usedPp < 2, `used ${st.usedPp} pp`);
  }
});

test("0.1 pp meter: stops at ±10% before the cap", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const st = runRule({ res: 0.1, ppPerTask: 0.2, seed });
    assert.equal(st.reached, true, JSON.stringify(st));
    assert.ok(st.usedPp < 5, `used ${st.usedPp} pp`);
  }
});

test("whole-% meter, small tasks, reading after every task: ±10% reachable inside 5 pp", () => {
  let reached = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const st = runRule({ res: 1, ppPerTask: 0.05, seed });
    assert.equal(st.stop, true);
    assert.ok(st.usedPp <= 5 + 1e-9, `used ${st.usedPp} pp`);
    if (st.reached) {
      reached++;
      assert.ok(st.halfWidth <= 0.1);
    }
  }
  assert.ok(reached >= 8, `${reached}/10 reached ±10%`);
});

test("whole-% meter read every 5 tasks of 0.5 pp: stops at the 5 pp cap, not reached", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const st = runRule({ res: 1, every: 5, ppPerTask: 0.5, seed });
    assert.equal(st.stop, true);
    assert.equal(st.reached, false, JSON.stringify(st));
    assert.equal(st.reason, "+5 pp cap reached");
    assert.ok(st.halfWidth == null || st.halfWidth > 0.1, JSON.stringify(st));
  }
});

test("very coarse meter (5 pp steps): cap with no usable interval", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const st = runRule({ res: 5, every: 5, ppPerTask: 0.2, seed });
    assert.equal(st.reached, false, JSON.stringify(st));
    assert.match(st.reason, /cap/);
    assert.ok(st.halfWidth == null || st.halfWidth > 0.1);
  }
});

test("--max-pct and --precision move the stop", () => {
  const capped = runRule({ res: 1, every: 5, ppPerTask: 0.5, maxPct: 2 });
  assert.equal(capped.reached, false);
  assert.ok(capped.usedPp >= 2 && capped.usedPp < 5, String(capped.usedPp));
  const loose = runRule({ res: 1e-6, ppPerTask: 0.2, precision: 0.3 });
  const tight = runRule({ res: 1e-6, ppPerTask: 0.2, precision: 0.03 });
  assert.equal(loose.reached, true);
  assert.equal(tight.reached, true);
  assert.ok(tight.tasks > loose.tasks, `${tight.tasks} vs ${loose.tasks}`);
});

test("finer window: a decimal 5-hour meter reaches ±10% where the whole-% weekly meter cannot", () => {
  const plain = runRule({ res: 1, ppPerTask: 0.5 });
  assert.equal(plain.reached, false);
  const fine = runRule({ res: 1, ppPerTask: 0.5, fineRes: 0.01, fineScale: 5 });
  assert.equal(fine.reached, true, JSON.stringify(fine));
  assert.equal(fine.window, "5h");
  assert.ok(fine.usedPp < 5);
  // a fine meter that never moves leaves the plan window's test in charge
  const stuck = runRule({ res: 1e-6, ppPerTask: 0.2, fineRes: 0.01, fineScale: 0 });
  assert.equal(stuck.reached, true);
  assert.equal(stuck.window, "weekly");
});

test("analyse: stopRule not reached → low_precision with the interval; reached → no flag", () => {
  const { manifest } = simulateManifest({ mode: "manual", every: 5, tasks: 30 });
  const rule = { precision: 0.1, maxPct: 5, minSteps: 3, window: "weekly", fineWindow: null, steps: 4, usedPp: 5 };
  const low = analyse({ manifest: { ...manifest, stopRule: { ...rule, reached: false, halfWidth: 0.234, stopWindow: "weekly" } }, price: PRICE, fee: FEE });
  const f = low.flags.find((x) => x.code === "low_precision");
  assert.ok(f, JSON.stringify(low.flags));
  assert.equal(f.severity, "warning");
  assert.match(f.detail, /±23\.4%.*weekly.*target ±10%/);
  assert.equal(low.precision.reached, false);
  assert.equal(low.precision.halfWidthAtStop, 0.234);
  const ok = analyse({ manifest: { ...manifest, stopRule: { ...rule, reached: true, halfWidth: 0.08, stopWindow: "weekly" } }, price: PRICE, fee: FEE });
  assert.ok(!ok.flags.some((x) => x.code === "low_precision"));
  assert.equal(ok.precision.reached, true);
  const none = analyse({ manifest: { ...manifest, stopRule: { ...rule, reached: false, halfWidth: null, stopWindow: "weekly" } }, price: PRICE, fee: FEE });
  assert.match(none.flags.find((x) => x.code === "low_precision").detail, /not reached/);
  // runs from before the rule carry no stopRule: no flag, precision null
  const old = analyse({ manifest, price: PRICE, fee: FEE });
  assert.ok(!old.flags.some((x) => x.code === "low_precision"));
  assert.equal(old.precision, null);
});
