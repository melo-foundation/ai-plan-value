// node --test kits/codex/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as RF from "../scripts/rollout-fit.mjs";
import { simulateRun, PRICES } from "./sim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const parseSim = (sim) => sim.sessions.map((s) => RF.parseRolloutText(s.text, s.name));
const run = (opts, extra = {}) => {
  const sim = simulateRun(opts);
  return { sim, r: RF.analyse({ sessions: parseSim(sim), prices: PRICES, expected: { model: "gpt-6.2-sol", effort: "medium" }, ...extra }) };
};
const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;
const covers = (ci, x) => ci[0] <= x && x <= ci[1];
const codes = (r) => r.flags.map((f) => f.code);

test("parses the verified codex-cli 0.172.0 line shapes", () => {
  const s = RF.parseRolloutFile(path.join(here, "fixtures", "rollout-basic.jsonl"));
  assert.equal(s.cliVersion, "0.172.0");
  assert.equal(s.cwd, "/home/u/.cache/codex-quota-runs/fixture/ping");
  const calls = s.events.filter((e) => e.kind === "call");
  assert.equal(calls.length, 2, "duplicate token_count without growth is not a call");
  assert.equal(s.events.filter((e) => e.kind === "meter").length, 1);
  assert.deepEqual(calls[0].usage, { input: 16137, cached: 13952, cacheWrite: 0, output: 5, reasoning: 0, total: 16142 });
  assert.equal(calls[0].model, "gpt-6.2-sol");
  assert.equal(calls[0].effort, null);
  assert.equal(calls[1].effort, "medium");
  assert.equal(calls[1].usage.input, 20000, "second call = growth of total_token_usage");
  assert.equal(calls[0].rate.windows["5h"].pct, 0);
  assert.equal(calls[0].rate.windows.weekly.pct, 19);
  assert.equal(calls[0].rate.windows.weekly.windowMinutes, 10080);
  assert.equal(calls[0].rate.planType, "plus");
});

test("prices: input includes cached; reasoning inside output unless flagged otherwise", () => {
  const p = { input: 2, cachedInput: 0.1, output: 10 };
  const u = { input: 16137, cached: 13952, cacheWrite: 0, output: 5, reasoning: 0, total: 16142 };
  const a = RF.priceCall(u, true, p);
  assert.equal(a.tokens.uncached, 2185);
  assert.ok(Math.abs(a.usd - (2185 * 2 + 13952 * 0.1 + 5 * 10) / 1e6) < 1e-12);
  const b = RF.priceCall({ ...u, output: 100, reasoning: 400 }, false, p);
  assert.equal(b.tokens.output, 500);
  const c = RF.priceCall({ ...u, cached: 20000 }, true, p);
  assert.equal(c.cachedExceedsInput, true);
});

test("detects the meter step and window epochs", () => {
  assert.equal(RF.detectStep([{ r: 1 }, { r: 19 }]), 1);
  assert.equal(RF.detectStep([{ r: 1.5 }, { r: 2 }]), 0.5);
  assert.equal(RF.detectStep([{ r: 1.23 }]), 0.01);
  const ep = RF.epochsOf([
    { r: 80, resetsAt: 1000 },
    { r: 81, resetsAt: 1000 },
    { r: 0, resetsAt: 20000 },
    { r: 2, resetsAt: 20000 },
  ]);
  assert.equal(ep.length, 2);
});

test("clean run: recovers $/pp in both windows, interval covers truth, verdict clean", () => {
  const { sim, r } = run({ seed: 3 });
  for (const w of ["weekly", "5h"]) {
    const u = r.windows[w].usdPerPp;
    assert.ok(within(u.est, sim.truth.beta[w], 0.01), `${w} ${u.est}`);
    assert.ok(covers(u.ci95, sim.truth.beta[w]), `${w} ci ${u.ci95}`);
    assert.ok(u.bounds && u.bounds.lo <= sim.truth.beta[w] && sim.truth.beta[w] <= u.bounds.hi, `${w} bounds`);
  }
  assert.equal(r.verdict, "clean");
  assert.equal(r.windows.weekly.lag, 1);
});

test("rounding rule and lag do not bias the slope", () => {
  for (const [rounding, lag] of [["floor", 0], ["round", 1], ["round", 0]]) {
    const { sim, r } = run({ seed: 11, rounding, lag });
    assert.ok(within(r.windows.weekly.usdPerPp.est, sim.truth.beta.weekly, 0.01), `${rounding}/${lag}`);
    assert.equal(r.windows.weekly.lag, lag, `${rounding}/${lag} lag chosen`);
  }
});

test("interval coverage over 40 seeds is at least 90%", () => {
  let hit = 0;
  for (let s = 1; s <= 40; s++) {
    const { sim, r } = run({ seed: s, lag: s % 2, start: { "5h": (s * 0.37) % 1, weekly: 19 + ((s * 0.61) % 1) } });
    if (covers(r.windows.weekly.usdPerPp.ci95, sim.truth.beta.weekly)) hit++;
  }
  assert.ok(hit >= 36, `${hit}/40`);
});

test("beats first-and-last: per-call steps give a tighter estimate", () => {
  const errs = { fit: 0, naive: 0 };
  for (let s = 1; s <= 20; s++) {
    const { sim, r } = run({ seed: 100 + s, calls: 200, sessions: 10 });
    const u = r.windows.weekly.usdPerPp;
    errs.fit += (u.est / sim.truth.beta.weekly - 1) ** 2;
    errs.naive += (u.naiveFirstLast / sim.truth.beta.weekly - 1) ** 2;
  }
  assert.ok(errs.fit <= errs.naive, JSON.stringify(errs));
});

test("outside use: meter jump with no matching usage is flagged and the slope survives", () => {
  const { sim, r } = run({ seed: 5, extra: [{ atCall: 210, pp: { weekly: 2, "5h": 3 } }] });
  assert.ok(codes(r).includes("meter_jump"));
  assert.equal(r.verdict, "contaminated");
  const jumps = r.windows.weekly.shortSteps;
  assert.equal(jumps.length, 1);
  assert.ok(jumps[0].extraPp > 1 && jumps[0].extraPp < 3, String(jumps[0].extraPp));
  assert.ok(within(r.windows.weekly.usdPerPp.est, sim.truth.beta.weekly, 0.03));
  assert.ok(covers(r.windows.weekly.usdPerPp.ci95, sim.truth.beta.weekly));
});

test("no false jump flags when the meter weights token kinds differently from API price", () => {
  for (let s = 1; s <= 10; s++) {
    const { r } = run({ seed: s, weight: { uncached: 1, cached: 3, output: 0.5 }, mix: { uncached: [500, 20000], cached: [5000, 150000], output: [100, 5000] } });
    assert.ok(!codes(r).includes("meter_jump"), `seed ${s}`);
  }
});

test("window reset during the run is flagged and handled with one intercept per epoch", () => {
  const { sim, r } = run({ seed: 7, resetAtCall: { "5h": 200 } });
  assert.ok(codes(r).includes("window_reset"));
  assert.equal(r.windows["5h"].epochs.length, 2);
  assert.ok(within(r.windows["5h"].usdPerPp.est, sim.truth.beta["5h"], 0.01));
  assert.ok(within(r.windows.weekly.usdPerPp.est, sim.truth.beta.weekly, 0.01));
});

test("model and effort mismatches are flagged", () => {
  const { r } = run({ seed: 2, modelAt: { 50: "gpt-6.1-sol" }, effortAt: { 100: "high" } });
  assert.ok(codes(r).includes("model_mismatch"));
  assert.ok(codes(r).includes("effort_mismatch"));
  assert.ok(r.effort.high.calls > 0);
});

test("missing effort is flagged as unrecorded", () => {
  const { r } = run({ seed: 2, effort: null });
  assert.ok(codes(r).includes("effort_unrecorded"));
});

test("idle check: meter moving while idle is flagged", () => {
  const sim = simulateRun({ seed: 9, calls: 60, sessions: 3, gapS: 30, extra: [{ atCall: 21, pp: { weekly: 1, "5h": 2 } }] });
  const sessions = parseSim(sim);
  const ts = sessions.flatMap((s) => s.events.filter((e) => e.kind === "call").map((e) => e.ts)).sort((x, y) => x - y);
  const manifest = { tag: "t", arm: "A", idle: [{ phase: "before", start: new Date(ts[19]).toISOString(), end: new Date(ts[20] + 31000).toISOString() }] };
  const r = RF.analyse({ sessions, prices: PRICES, manifest, expected: { model: "gpt-6.2-sol", effort: "medium" } });
  assert.ok(codes(r).includes("meter_moved_idle"), JSON.stringify(r.idle));
});

test("other Codex sessions outside the run directory are flagged; sessions are filtered by cwd", () => {
  const sim = simulateRun({ seed: 4, calls: 120, sessions: 6 });
  const other = simulateRun({ seed: 99, calls: 10, sessions: 1, cwd: "/home/u/projects/app" });
  const sessions = [...parseSim(sim), ...parseSim(other)];
  const r = RF.analyse({ sessions, prices: PRICES, root: "/home/u/.cache/codex-quota-runs/t/work", expected: { model: "gpt-6.2-sol", effort: "medium" } });
  assert.ok(codes(r).includes("other_codex_session"));
  assert.equal(r.run.sessions, 6);
  assert.equal(r.run.calls, 120);
  assert.ok(!JSON.stringify(r).includes("/home/u/projects"), "no foreign paths in the result");
});

test("subsidy uses the site definition: 100 × weekly $/pp × 4 ÷ $20", () => {
  const beta = (14.9326 * 20) / 400; // $0.74663 per weekly pp
  const { r } = run({ seed: 6, beta: { "5h": 0.15, weekly: beta } }, { site: { subsidy: 14.9326, source: "test" } });
  assert.ok(within(r.subsidy.multiple.est, 14.9326, 0.01), String(r.subsidy.multiple.est));
  assert.ok(Math.abs(r.subsidy.monthlyApiUsd.est - 400 * r.windows.weekly.usdPerPp.est) < 1e-3);
  assert.ok(within(r.subsidy.site.ratio, 1, 0.01));
  assert.ok(within(r.fiveHourWindowsPerWeek.est, beta / 0.15, 0.02));
});

test("compare: equal rate card → price-proportional; skewed meter → weight recovered", () => {
  const mixA = { uncached: [1500, 6000], cached: [15000, 90000], output: [200, 2500] };
  const mixB = { uncached: [25000, 35000], cached: [12000, 16000], output: [100, 400] };
  const a = run({ seed: 21, mix: mixA }).r;
  const b = run({ seed: 22, mix: mixB, calls: 150, sessions: 150 }).r;
  const c = RF.compareResults(a, b);
  assert.equal(c.verdict, "price-proportional", JSON.stringify(c.ratio));
  assert.ok(within(c.uncachedInputWeight.est, 1, 0.05));
  const w = { uncached: 0.5, cached: 1, output: 1 };
  const a2 = run({ seed: 23, mix: mixA, weight: w }).r;
  const b2 = run({ seed: 24, mix: mixB, weight: w, calls: 150, sessions: 150 }).r;
  const c2 = RF.compareResults(a2, b2);
  assert.equal(c2.verdict, "not price-proportional");
  assert.ok(Math.abs(c2.uncachedInputWeight.est - 0.5) < 0.05, String(c2.uncachedInputWeight.est));
  assert.ok(covers(c2.uncachedInputWeight.ci95, 0.5));
});

test("listRolloutFiles and isUnder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-test-"));
  try {
    const day = path.join(dir, "2026", "11", "28");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "rollout-2026-11-28T09-00-00-x.jsonl"), "");
    fs.writeFileSync(path.join(day, "notes.txt"), "");
    assert.equal(RF.listRolloutFiles(dir).length, 1);
    assert.equal(RF.isUnder("/a/b/c", "/a/b"), true);
    assert.equal(RF.isUnder("/a/bc", "/a/b"), false);
    assert.equal(RF.isUnder(null, "/a"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("t critical values", () => {
  assert.ok(Math.abs(RF.tCrit(10) - 2.228) < 0.002);
  assert.ok(Math.abs(RF.tCrit(1000) - 1.962) < 0.002);
});
