// node --test kits/harness/test/*.test.mjs
// Core fit on synthetic readings (manual and automatic) and the contamination flags.
import test from "node:test";
import assert from "node:assert/strict";
import { analyse } from "../scripts/lib/analyse.mjs";
import { fitGrid, fitReadings, priceUsage } from "../scripts/lib/fit.mjs";
import { simulateManifest, PRICE, FEE } from "./sim.mjs";

const run = (o, extra = {}) => {
  const { manifest, truth } = simulateManifest(o);
  const r = analyse({ manifest, price: PRICE, fee: FEE, site: { value: 10, id: "supergrok::grok-4.7", effort: "medium" }, sameModel: (a, b) => a === b, ...extra });
  return { r, truth };
};
const codes = (r) => r.flags.map((f) => f.code);

test("priceUsage: uncached + cache write at input, cached at cache price, output (incl. reasoning) at output", () => {
  const p = priceUsage({ uncached: 1e6, cached: 2e6, cacheWrite: 1e6, output: 1e6 }, { input: 2, cachedInput: 0.5, output: 6 });
  assert.equal(p.usd, 2 * 2 + 2 * 0.5 + 6);
});

test("manual readings every 5 tasks: β inside the 95% interval and within 15%", () => {
  for (const seed of [1, 2, 3]) {
    const { r, truth } = run({ seed, tasks: 80, every: 5 });
    assert.ok(r.fit.usable, JSON.stringify(r.fit));
    const u = r.fit.usdPerPp;
    assert.ok(Math.abs(u.est - truth.beta) / truth.beta < 0.15, `seed ${seed}: ${u.est}`);
    assert.ok(u.ci95[0] <= truth.beta && truth.beta <= u.ci95[1], `seed ${seed}: ${u.ci95}`);
    assert.equal(r.verdict, "clean", JSON.stringify(r.flags));
  }
});

test("automatic readings after every task: tight β", () => {
  const { r, truth } = run({ mode: "auto", tasks: 60 });
  assert.ok(r.fit.usable);
  assert.ok(Math.abs(r.fit.usdPerPp.est - truth.beta) / truth.beta < 0.03, String(r.fit.usdPerPp.est));
  assert.ok(r.fit.fitStep <= 0.25, `fit step ${r.fit.fitStep}`);
  assert.equal(r.meter.mode, "auto");
});

test("fine meters are floored to at most 80 levels", () => {
  const rs = Array.from({ length: 50 }, (_, i) => ({ ts: i, pct: 10 + i * 0.7333, usd: i }));
  const g = fitGrid(rs);
  assert.ok((rs[49].pct - rs[0].pct) / g.q <= 80);
  assert.equal(fitReadings(rs).usable, true);
});

test("subsidy: 100 × $/pp × windows per month ÷ fee, and measured ÷ site", () => {
  const { r } = run({ tasks: 80 });
  const b = r.fit.usdPerPp.est;
  assert.ok(Math.abs(r.subsidy.monthlyApiUsd.est - 100 * b * 4) < 1e-3);
  assert.ok(Math.abs(r.subsidy.multiple.est - (100 * b * 4) / 30) < 1e-4);
  assert.ok(Math.abs(r.subsidy.site.ratio - r.subsidy.multiple.est / 10) < 1e-4);
  const d = run({ tasks: 80, window: "daily", perMonth: 30 }).r;
  assert.ok(Math.abs(d.subsidy.monthlyApiUsd.est - 100 * d.fit.usdPerPp.est * 30) < 1e-3);
  assert.match(d.subsidy.definition, /× 30/);
});

test("flag: idle movement", () => {
  const { r } = run({ idleMove: 2 });
  assert.ok(codes(r).includes("meter_moved_idle"), codes(r).join());
  assert.equal(r.verdict, "contaminated");
});

test("flag: window reset", () => {
  const { r } = run({ tasks: 80, resetAt: 40 });
  assert.ok(codes(r).includes("window_reset"), codes(r).join());
});

test("flag: model mismatch", () => {
  const { r } = run({ modelAt: { 3: "grok-4.6", 4: "grok-4.6" } });
  assert.ok(codes(r).includes("model_mismatch"));
  assert.equal(r.verdict, "contaminated");
});

test("flag: too few steps, and unusable with one reading", () => {
  const few = run({ tasks: 12, every: 4 }).r;
  assert.ok(codes(few).includes("too_few_steps") || codes(few).includes("window_unusable"), codes(few).join());
  const { manifest } = simulateManifest({ tasks: 3 });
  manifest.readings = manifest.readings.slice(0, 1);
  const one = analyse({ manifest, price: PRICE, fee: FEE, sameModel: (a, b) => a === b });
  assert.ok(codes(one).includes("window_unusable"));
  assert.equal(one.subsidy, null);
});

test("flag: outside use mid-run shows as a meter jump", () => {
  const { r } = run({ mode: "auto", tasks: 80, extraAt: { 40: 3 } });
  assert.ok(codes(r).includes("meter_jump"), codes(r).join());
});

test("flag: plan mismatch and on-demand credits", () => {
  const { r } = run({ detectedPlan: "SuperGrok Heavy", extraUsed: [0, 250] });
  assert.ok(codes(r).includes("plan_mismatch"));
  assert.ok(codes(r).includes("on_demand"));
});
