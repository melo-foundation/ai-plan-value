// Fit and flags on synthetic runs with a known meter.
import test from "node:test";
import assert from "node:assert/strict";
import { analyseRun, resolutionOf, typedResolution, modelMatches } from "../scripts/fit.mjs";
import { simulateRun } from "./sim.mjs";

const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;
const codes = (r) => r.flags.map((f) => f.code);
const sevOf = (r, code) => r.flags.find((f) => f.code === code)?.severity;

test("automatic integer-% meter: $/pp near β with a 95% interval that covers it; weekly × 4 ÷ fee", () => {
  const { run } = simulateRun({ windows: { weekly: { beta: 0.05, start: 20.3, q: 1, capacity: 100, unit: "%" }, "5h": { beta: 0.02, start: 3.2, q: 1, capacity: 100, unit: "%" } } });
  const r = analyseRun(run);
  const w = r.windows.weekly;
  assert.ok(w.usable, JSON.stringify(w));
  assert.ok(within(w.usdPerUnit.est, 0.05, 0.1), `${w.usdPerUnit.est}`);
  assert.ok(w.usdPerUnit.ci95[0] <= 0.05 && 0.05 <= w.usdPerUnit.ci95[1], JSON.stringify(w.usdPerUnit.ci95));
  assert.ok(within(r.windows["5h"].usdPerUnit.est, 0.02, 0.1));
  assert.equal(r.subsidy.window, "weekly");
  assert.ok(within(r.subsidy.monthlyApiUsd.est, w.usdPerUnit.est * 100 * 4, 1e-6));
  assert.ok(within(r.subsidy.multiple.est, r.subsidy.monthlyApiUsd.est / 17.7326, 1e-6));
  assert.ok(within(r.fiveHourWindowsPerWeek.est, 2.5, 0.15));
  assert.equal(r.windows["5h"].monthlyApiUsd, null, "5-hour windows have no month factor");
  assert.equal(r.verdict, "clean", JSON.stringify(r.flags));
});

test("fine-grained token meter: readings coarsened onto a grid; estimate still near β", () => {
  const { run } = simulateRun({ adapter: "deeprelay", windows: { "monthly-input": { beta: 1e-7, start: 1234567, q: 1, capacity: 5e8, unit: "weighted tokens" } }, fee: { plan: "DeepRelay Base", feeUsd: 0.99, currency: "USD", feeLocal: 0.99 } });
  const r = analyseRun(run);
  const w = r.windows["monthly-input"];
  assert.ok(w.usable, JSON.stringify(w));
  assert.ok(w.grid > 1000, `grid ${w.grid}`);
  assert.ok(w.crossings <= 210, `crossings ${w.crossings}`);
  assert.ok(within(w.usdPerUnit.est, 1e-7, 0.03), `${w.usdPerUnit.est}`);
  assert.ok(within(r.subsidy.monthlyApiUsd.est, 1e-7 * 5e8, 0.03));
});

test("manual meter: end-point estimate C ÷ Δ with bounds from the typed resolution", () => {
  const { run, truth } = simulateRun({ adapter: "kimi", mode: "manual", calls: 40, windows: { monthly: { beta: 0.6, start: 10, q: 0.01, capacity: 100, unit: "%" } }, fee: { plan: "Kimi Allegretto", feeUsd: 39, currency: "USD", feeLocal: 39 } });
  const r = analyseRun(run);
  const w = r.windows.monthly;
  assert.ok(w.usable, JSON.stringify(w));
  assert.equal(w.resolution, 0.01);
  assert.ok(within(w.usdPerUnit.est, w.usdBetween / w.moved, 1e-6));
  assert.ok(Math.abs(w.usdBetween - truth.total) < 1e-6);
  assert.ok(w.usdPerUnit.bounds.lo <= 0.6 && 0.6 <= w.usdPerUnit.bounds.hi, JSON.stringify(w.usdPerUnit.bounds));
  assert.ok(w.usdPerUnit.ci95[0] < w.usdPerUnit.est && w.usdPerUnit.est < w.usdPerUnit.ci95[1]);
  assert.ok(within(r.subsidy.multiple.est, (w.usdPerUnit.est * 100) / 39, 1e-6));
  assert.equal(r.verdict, "clean", JSON.stringify(r.flags));
});

test("manual meter that moved less than twice its resolution is unusable", () => {
  const { run } = simulateRun({ adapter: "kimi", mode: "manual", calls: 2, windows: { monthly: { beta: 0.6, start: 10, q: 1, capacity: 100, unit: "%" } } });
  const r = analyseRun(run);
  assert.equal(r.windows.monthly.usable, false);
  assert.match(r.windows.monthly.reason, /run longer/);
  assert.equal(sevOf(r, "window_unusable"), "error");
  assert.equal(r.verdict, "contaminated");
});

test("flag: meter moved while idle (before: error; manual after: warning)", () => {
  const a = analyseRun(simulateRun({ idleBump: { phase: "before", window: "weekly", amount: 2 } }).run);
  assert.equal(sevOf(a, "meter_moved_idle"), "error");
  assert.equal(a.verdict, "contaminated");
  const m = analyseRun(simulateRun({ adapter: "kimi", mode: "manual", calls: 40, windows: { monthly: { beta: 0.6, start: 10, q: 0.01, capacity: 100, unit: "%" } }, idleBump: { phase: "after", window: "monthly", amount: 0.05 } }).run);
  assert.equal(sevOf(m, "meter_moved_idle"), "warning");
});

test("flag: window reset (automatic: one intercept per window, still usable; manual: error)", () => {
  const a = analyseRun(simulateRun({ calls: 160, resetAt: { call: 80, window: "weekly" } }).run);
  assert.ok(codes(a).includes("window_reset"));
  assert.equal(sevOf(a, "window_reset"), "warning");
  assert.ok(a.windows.weekly.usable);
  assert.ok(within(a.windows.weekly.usdPerUnit.est, 0.05, 0.15), `${a.windows.weekly.usdPerUnit.est}`);
  const m = analyseRun(simulateRun({ adapter: "kimi", mode: "manual", calls: 40, windows: { monthly: { beta: 0.6, start: 10, q: 0.01, capacity: 100, unit: "%" } }, resetAt: { call: 20, window: "monthly" } }).run);
  assert.equal(sevOf(m, "window_reset"), "error");
});

test("flag: unexpected model (dated variants of the requested model pass)", () => {
  const bad = analyseRun(simulateRun({ responseModel: (i) => (i % 10 === 0 ? "glm-4.7" : "glm-5.3") }).run);
  assert.equal(sevOf(bad, "model_mismatch"), "error");
  assert.match(bad.flags.find((f) => f.code === "model_mismatch").detail, /glm-4\.7/);
  const ok = analyseRun(simulateRun({ responseModel: () => "glm-5.3-20261101" }).run);
  assert.ok(!codes(ok).includes("model_mismatch"));
  assert.ok(modelMatches("MiniMax-M3", "minimax-m3"));
  assert.ok(modelMatches("kimi-k3", "moonshotai/kimi-k3"));
  assert.ok(!modelMatches("glm-5.3", "glm-5.3x"));
});

test("flag: responses without usage", () => {
  const { run } = simulateRun();
  run.calls[3].usage = null;
  run.calls[3].usd = 0;
  const r = analyseRun(run);
  assert.equal(sevOf(r, "no_usage"), "error");
});

test("subsidy uses the window that runs out first; measured ÷ site", () => {
  const { run } = simulateRun({
    adapter: "bailian",
    windows: { monthly: { beta: 0.2, start: 1, q: 0.01, capacity: 100, unit: "%" }, weekly: { beta: 0.04, start: 1, q: 0.01, capacity: 100, unit: "%" } },
    siteRef: { id: "x::y", subsidy: 2, level: "low", dataDate: "2026-11-01" },
    fee: { plan: "阿里云百炼 Token Plan Lite (¥39)", feeUsd: 5.8608, currency: "CNY", feeLocal: 39 },
  });
  const r = analyseRun(run);
  assert.equal(r.subsidy.window, "weekly");
  assert.ok(within(r.subsidy.monthlyApiUsd.est, 16, 0.05), `${r.subsidy.monthlyApiUsd.est}`);
  assert.ok(within(r.subsidy.otherWindows[0].monthlyApiUsd, 20, 0.05));
  assert.ok(within(r.subsidy.site.ratio, r.subsidy.multiple.est / 2, 1e-6));
});

test("result holds no key, no prompts and no raw responses", () => {
  const { run } = simulateRun();
  const s = JSON.stringify(analyseRun(run));
  assert.ok(!/authorization|bearer|api[_-]?key|"system"|"messages"/i.test(s), s.match(/authorization|bearer|api[_-]?key|"system"|"messages"/i)?.[0]);
});

test("resolution detection", () => {
  assert.equal(resolutionOf([12, 13, 20]), 1);
  assert.equal(resolutionOf([12.34, 12.5]), 0.01);
  assert.equal(resolutionOf([1000, 3000]), 1000);
  assert.equal(typedResolution("1.92"), 0.01);
  assert.equal(typedResolution("37"), 1);
});
