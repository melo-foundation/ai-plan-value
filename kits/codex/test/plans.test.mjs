// node --test kits/codex/test/*.test.mjs
// Plans: plan_type detection, --plan, fees from scripts/billing-periods.mjs, weekly-only Pro meters, pacing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as RF from "../scripts/rollout-fit.mjs";
import { PLANS, planById, planFee, resolvePlan } from "../scripts/plans.mjs";
import { pacing, siteRefFor, ARMS, MAX_PARALLEL } from "../scripts/codex-quota.mjs";
import { BILLING_PERIODS } from "../../../scripts/billing-periods.mjs";
import { simulateRun, PRICES } from "./sim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "codex-quota.mjs");
const FAKE = path.join(here, "fake-codex.mjs");
const REAL_PRICES = JSON.parse(fs.readFileSync(path.join(here, "..", "prices.json"), "utf8"));
const parseSim = (sim) => sim.sessions.map((s) => RF.parseRolloutText(s.text, s.name));
const codes = (r) => r.flags.map((f) => f.code);
const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;
const billed = (name) => BILLING_PERIODS.find((r) => r.plan === name).monthly;
const tmpHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-plans-"));
  fs.mkdirSync(path.join(d, "codex-home", "sessions"), { recursive: true });
  return d;
};
const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 });

test("fees come from scripts/billing-periods.mjs", () => {
  assert.equal(planFee(planById("plus")), 20);
  for (const id of ["pro-10x", "pro-20x", "pro-500"]) {
    const p = planById(id);
    assert.equal(planFee(p), billed(p.name), id);
    assert.equal(RF.PLAN_PRICE_USD[id], billed(p.name), id);
  }
  assert.equal(planFee(planById("business")), null, "no billing record for ChatGPT Business");
  assert.equal(RF.PLAN_PRICE_USD.plus, 20);
});

test("--plan accepts ids and site names", () => {
  assert.equal(planById("Pro 20x").id, "pro-20x");
  assert.equal(planById("ChatGPT Pro 500").id, "pro-500");
  assert.equal(planById("PRO_10X").id, "pro-10x");
  assert.equal(planById("team").id, "business");
  assert.equal(planById("pro"), null);
  assert.equal(planById("pro-50x"), null);
  for (const p of PLANS) assert.equal(planById(p.name), p);
});

test("plan detection from plan_type and the --plan check", () => {
  assert.equal(resolvePlan({ planTypes: ["plus"] }).id, "plus");
  assert.equal(resolvePlan({ planTypes: [] }), null);
  assert.equal(resolvePlan({ planTypes: ["team"] }).id, "business");
  for (const t of ["pro", "prolite", "promax"]) {
    assert.throws(() => resolvePlan({ planTypes: [t] }), /pass --plan pro-10x \| pro-20x \| pro-500/, t);
    assert.equal(resolvePlan({ planTypes: [t], requested: "pro-20x" }).id, "pro-20x", t);
  }
  assert.throws(() => resolvePlan({ planTypes: ["plus"], requested: "pro-20x" }), /--plan pro-20x does not match plan_type plus/);
  assert.throws(() => resolvePlan({ planTypes: ["pro"], requested: "plus" }), /--plan plus does not match plan_type pro/);
  assert.throws(() => resolvePlan({ planTypes: ["enterprise"] }), /plan_type enterprise is not a plan this kit measures/);
  assert.throws(() => resolvePlan({ planTypes: ["free"], requested: "plus" }), /plan_type free is not a plan/);
  assert.throws(() => resolvePlan({ planTypes: ["plus", "pro"] }), /plan_type changes: plus, pro/);
  assert.throws(() => resolvePlan({ requested: "pro-50x" }), /--plan pro-50x: use plus, pro-10x, pro-20x, pro-500, business/);
  assert.equal(resolvePlan({ requested: "pro-500" }).id, "pro-500");
});

const PRO20_SOL = siteRefFor(REAL_PRICES, "gpt-6.2-sol", "ChatGPT Pro 20x");
const proRun = (extra = {}, simOpts = {}) => {
  const beta = (PRO20_SOL.subsidy * billed("ChatGPT Pro 20x")) / 400;
  const sim = simulateRun({ seed: 31, calls: 3000, sessions: 30, planType: "pro", windows: "weekly", beta: { "5h": 1, weekly: beta }, ...simOpts });
  return { beta, sim, r: RF.analyse({ sessions: parseSim(sim), prices: PRICES, expected: { model: "gpt-6.2-sol", effort: "medium" }, site: PRO20_SOL, plan: "pro-20x", ...extra }) };
};

test("Pro, weekly window only (primary null): fit, subsidy on the Pro 20x fee, site ratio on the Pro 20x multiple", () => {
  const { beta, r } = proRun();
  assert.deepEqual(Object.keys(r.windows), ["weekly"]);
  assert.equal(r.windows.weekly.usable, true);
  assert.ok(r.windows.weekly.crossings >= RF.MIN_STEPS, String(r.windows.weekly.crossings));
  assert.ok(within(r.windows.weekly.usdPerPp.est, beta, 0.03), `${r.windows.weekly.usdPerPp.est} vs ${beta}`);
  assert.equal(r.plan, "pro-20x");
  assert.equal(r.planName, "ChatGPT Pro 20x");
  assert.deepEqual(r.planTypes, ["pro"]);
  assert.equal(r.planPriceUsd, billed("ChatGPT Pro 20x"));
  assert.match(r.subsidy.definition, new RegExp(`monthly ÷ \\$${billed("ChatGPT Pro 20x")}$`));
  assert.ok(within(r.subsidy.multiple.est, PRO20_SOL.subsidy, 0.03), String(r.subsidy.multiple.est));
  assert.ok(within(r.subsidy.site.ratio, 1, 0.03), String(r.subsidy.site.ratio));
  assert.equal(r.fiveHourWindowsPerWeek, null);
  assert.equal(r.verdict, "clean", JSON.stringify(r.flags));
});

test("Pro, weekly window in the primary slot", () => {
  const { beta, r } = proRun({}, { windows: "weekly-primary", seed: 32 });
  assert.deepEqual(Object.keys(r.windows), ["weekly"]);
  assert.ok(within(r.windows.weekly.usdPerPp.est, beta, 0.03));
  assert.equal(r.verdict, "clean", JSON.stringify(r.flags));
});

test("Pro rollouts with no plan given: plan_ambiguous, no subsidy", () => {
  const { r } = proRun({ plan: null, site: null });
  assert.ok(codes(r).includes("plan_ambiguous"));
  assert.equal(r.subsidy, null);
  assert.equal(r.verdict, "contaminated");
});

test("plan_mismatch, plan_unknown, plan_fee_unknown, window_missing", () => {
  const plus = simulateRun({ seed: 2, calls: 120, sessions: 6 });
  const r1 = RF.analyse({ sessions: parseSim(plus), prices: PRICES, expected: { model: "gpt-6.2-sol" }, plan: "pro-20x" });
  assert.ok(codes(r1).includes("plan_mismatch"));
  const ent = simulateRun({ seed: 2, calls: 120, sessions: 6, planType: "enterprise" });
  const r2 = RF.analyse({ sessions: parseSim(ent), prices: PRICES, expected: { model: "gpt-6.2-sol" } });
  assert.ok(codes(r2).includes("plan_unknown"));
  const team = simulateRun({ seed: 2, calls: 120, sessions: 6, planType: "team" });
  const r3 = RF.analyse({ sessions: parseSim(team), prices: PRICES, expected: { model: "gpt-6.2-sol" } });
  assert.equal(r3.plan, "business");
  assert.ok(codes(r3).includes("plan_fee_unknown"));
  assert.equal(r3.subsidy, null);
  assert.ok(r3.windows.weekly.usable);
  const s = parseSim(plus);
  for (const x of s) for (const e of x.events) if (e.rate) delete e.rate.windows.weekly;
  const r4 = RF.analyse({ sessions: s, prices: PRICES, expected: { model: "gpt-6.2-sol" } });
  assert.ok(codes(r4).includes("window_missing"));
});

test("Plus results keep plan plus and the $20 fee", () => {
  const sim = simulateRun({ seed: 6 });
  const r = RF.analyse({ sessions: parseSim(sim), prices: PRICES, expected: { model: "gpt-6.2-sol", effort: "medium" } });
  assert.equal(r.plan, "plus");
  assert.equal(r.planPriceUsd, 20);
  assert.match(r.subsidy.definition, /monthly ÷ \$20$/);
});

test("a window with fewer than 3 steps is unusable", () => {
  const sim = simulateRun({ seed: 4, calls: 30, sessions: 3, beta: { "5h": 0.15, weekly: 0.75 }, start: { "5h": 0.4, weekly: 19.9 } });
  const r = RF.analyse({ sessions: parseSim(sim), prices: PRICES, expected: { model: "gpt-6.2-sol" } });
  const w = r.windows.weekly;
  assert.ok(w.observedPp < RF.MIN_STEPS, String(w.observedPp));
  assert.equal(w.usable, false);
  assert.match(w.reason, /fewer than 3 steps/);
});

test("pacing: Plus keeps 12 / 8 pp and 1 task at a time; Pro scales the target and parallel tasks", () => {
  const plus = planById("plus");
  for (const arm of ["A", "B"]) {
    const p = pacing({ arm, plan: plus, model: "gpt-6.2-sol", prices: REAL_PRICES });
    assert.equal(p.targetPp, ARMS[arm].targetPp, arm);
    assert.equal(p.parallel, 1, arm);
  }
  for (const id of ["pro-10x", "pro-20x", "pro-500"]) {
    const plan = planById(id);
    for (const arm of ["A", "B"]) {
      const p = pacing({ arm, plan, model: "gpt-6.2-sol", prices: REAL_PRICES });
      assert.ok(p.targetPp >= RF.MIN_STEPS && p.targetPp <= ARMS[arm].targetPp, `${id} ${arm} ${p.targetPp}`);
      assert.ok(p.parallel >= 1 && p.parallel <= MAX_PARALLEL);
      assert.ok(p.est.hours <= 4, `${id} ${arm} ${p.est.hours} h`);
      assert.ok(within(p.usdPerPp, (siteRefFor(REAL_PRICES, "gpt-6.2-sol", plan.name).subsidy * planFee(plan)) / 400, 1e-9));
    }
  }
  const fixed = pacing({ arm: "A", plan: planById("pro-500"), model: "gpt-6.2-sol", prices: REAL_PRICES, targetPp: 5, parallel: 2, maxHours: 1 });
  assert.deepEqual([fixed.targetPp, fixed.parallel, fixed.maxHours], [5, 2, 1]);
});

test("dry run: Pro reading with no --plan fails; --plan picks the tier; unknown --plan fails", () => {
  const tmp = tmpHome();
  try {
    const home = path.join(tmp, "codex-home");
    const sim = simulateRun({ seed: 1, calls: 4, sessions: 1, planType: "pro", windows: "weekly", startMs: Date.now() - 60000 });
    const day = path.join(home, "sessions", "2026", "11", "28");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, sim.sessions[0].name), sim.sessions[0].text);
    const env = { CODEX_HOME: home };
    const a = cli(["run", "--arm", "A", "--dry-run"], env);
    assert.equal(a.status, 1);
    assert.match(a.stderr, /plan_type pro is one of ChatGPT Pro 10x, ChatGPT Pro 20x, ChatGPT Pro 500: pass --plan/);
    const b = cli(["run", "--arm", "A", "--plan", "pro-20x", "--dry-run"], env);
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, new RegExp(`plan +ChatGPT Pro 20x · \\$${billed("ChatGPT Pro 20x")}/month`));
    assert.match(b.stdout, /pacing +target \+\d+ pp weekly · stop at 3 h with 3\+ steps · \d parallel · expected/);
    const c = cli(["run", "--arm", "A", "--plan", "pro-50x", "--dry-run"], env);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /--plan pro-50x: use /);
    const d = cli(["run", "--arm", "A", "--plan", "business", "--dry-run"], env);
    assert.equal(d.status, 1);
    assert.match(d.stderr, /ChatGPT Business: no monthly fee in scripts\/billing-periods\.mjs/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function fakeRun(args, env) {
  const tmp = tmpHome();
  const tag = "pro-e2e";
  const r = cli(["run", "--arm", "A", "--tag", tag, "--codex", FAKE, "--idle-min", "0", "--settle-min", "0", "--force", ...args], {
    CODEX_HOME: path.join(tmp, "codex-home"),
    CODEX_QUOTA_SCRATCH: path.join(tmp, "scratch"),
    ...env,
  });
  const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
  return { r, tmp, tag, manifest: read(path.join(tmp, "scratch", "runs", tag, "manifest.json")), result: read(path.join(tmp, "scratch", "results", `${tag}.json`)) };
}

test("run on Pro 20x, weekly only, 3 tasks at a time: stops at the target; analyse without --plan asks for it", () => {
  const { r, tmp, tag, manifest, result } = fakeRun(["--plan", "pro-20x", "--target-pp", "5", "--parallel", "3"], {
    FAKE_CODEX_PLAN: "pro",
    FAKE_CODEX_WINDOWS: "weekly",
    FAKE_CODEX_BETA: JSON.stringify({ "5h": 1, weekly: 0.1 }),
    FAKE_CODEX_SLEEP_MS: "150",
  });
  try {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(manifest.plan, { id: "pro-20x", name: "ChatGPT Pro 20x", feeUsd: billed("ChatGPT Pro 20x"), planType: "pro" });
    assert.equal(manifest.parallel, 3);
    assert.equal(manifest.stopReason, "target reached");
    assert.ok(!/ 5h /.test(r.stdout.split("\n").find((l) => /exit 0/.test(l)) || ""), "no 5h column without a 5h window");
    assert.deepEqual(Object.keys(result.windows), ["weekly"]);
    assert.equal(result.plan, "pro-20x");
    assert.equal(result.planPriceUsd, billed("ChatGPT Pro 20x"));
    assert.ok(within(result.windows.weekly.usdPerPp.est, 0.1, 0.1), String(result.windows.weekly.usdPerPp.est));
    assert.ok(result.subsidy.site, "site reference on Pro 20x");
    assert.equal(result.subsidy.site.value, siteRefFor(REAL_PRICES, "gpt-6.2-sol", "ChatGPT Pro 20x").subsidy);
    assert.ok(r.stdout.includes("site gpt-6.2-sol Pro 20x"), r.stdout);
    assert.ok(!codes(result).includes("plan_mismatch"));
    const a = cli(["analyse", "--dir", path.join(tmp, "scratch", "runs", tag, "rollouts"), "--out", path.join(tmp, "x.json")], { CODEX_QUOTA_SCRATCH: path.join(tmp, "scratch") });
    assert.equal(a.status, 1);
    assert.match(a.stderr, /pass --plan pro-10x \| pro-20x \| pro-500/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("run stops at --max-hours once weekly made 3 steps", () => {
  const { r, tmp, manifest } = fakeRun(["--plan", "pro-500", "--target-pp", "12", "--max-hours", "0.00001", "--parallel", "1"], {
    FAKE_CODEX_PLAN: "promax",
    FAKE_CODEX_WINDOWS: "weekly-primary",
    FAKE_CODEX_BETA: JSON.stringify({ "5h": 1, weekly: 0.1 }),
  });
  try {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(manifest.stopReason, /^1e-05 h with [3-5] steps$|^0\.00001 h with [3-5] steps$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("run fails after the first ping when --plan does not match plan_type", () => {
  const { r, tmp } = fakeRun(["--plan", "plus", "--target-pp", "3"], { FAKE_CODEX_PLAN: "pro" });
  try {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--plan plus does not match plan_type pro/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
