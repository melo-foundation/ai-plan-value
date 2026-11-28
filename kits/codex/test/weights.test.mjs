// node --test kits/codex/test/*.test.mjs
// Token weights: joint fit of the cache / input / output / reasoning arms, holdout check on A and
// B, 5h vs weekly; fake codex runs of every arm and the weights command.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as RF from "../scripts/rollout-fit.mjs";
import * as WT from "../scripts/weights.mjs";
import * as TW from "../../lib/token-weights.mjs";
import { armKey, pacing, resumeArgs } from "../scripts/codex-quota.mjs";
import { planById } from "../scripts/plans.mjs";
import { cacheFirst, cacheTurn, inputPrompt, outputPrompt, reasoningPrompt, armWorkloadHash } from "../workload/arms.mjs";
import { simulateArms } from "./weights-sim.mjs";
import { PRICES } from "./sim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "codex-quota.mjs");
const FAKE = path.join(here, "fake-codex.mjs");
const REAL_PRICES = JSON.parse(fs.readFileSync(path.join(here, "..", "prices.json"), "utf8"));
const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 300000 });
const TRUE_W = { input: 1, cached: 3, output: 1, reasoning: 1.5 };

function fitSim(opts) {
  const sim = simulateArms(opts);
  const runs = sim.map((r) => WT.runFromSessions({ tag: r.tag, arm: r.arm, sessions: r.sessions, prices: PRICES, model: "gpt-6.2-sol", root: r.root }));
  return WT.fitRuns({ runs, model: "gpt-6.2-sol", plan: planById("plus"), prices: PRICES, boot: 300, seed: opts.seed ?? 1 });
}

test("simulated meter, cached 3× and reasoning 1.5×: weights recovered inside their intervals over seeds; holdouts A and B inside", () => {
  let covered = 0;
  let intervals = 0;
  let holdInside = 0;
  let holdouts = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = fitSim({ seed });
    for (const w of ["5h", "weekly"]) {
      const x = r.windows[w];
      assert.ok(x.usable, `${seed} ${w}: ${x.reason}`);
      assert.deepEqual(x.weights.input, { est: 1, fixed: true, identified: true, role: "reference" });
      for (const k of ["cached", "output", "reasoning"]) {
        const v = x.weights[k];
        assert.ok(v.identified, `${seed} ${w} ${k} not identified`);
        const tol = w === "5h" ? 0.06 : 0.12;
        assert.ok(Math.abs(v.est / TRUE_W[k] - 1) <= tol, `${seed} ${w} ${k}: ${v.est} vs ${TRUE_W[k]}`);
        assert.ok(v.ci95[0] < v.est && v.est < v.ci95[1]);
        intervals++;
        if (v.ci95[0] <= TRUE_W[k] && v.ci95[1] >= TRUE_W[k]) covered++;
      }
      // scale: $/pp at weight 1
      const beta = w === "5h" ? 0.11 : 0.66;
      assert.ok(Math.abs(x.scale.usdPerUnit / beta - 1) < 0.08, `${seed} ${w} scale ${x.scale.usdPerUnit}`);
      for (const h of x.holdout) {
        assert.ok(h.usable, h.reason);
        holdouts++;
        if (h.inside) holdInside++;
        assert.ok(Math.abs(Math.log(h.ratio.est)) < 0.06, `${seed} ${w} ${h.tag} ratio ${h.ratio.est}`);
        // where API prices miss by > 10% (run A: 80% cached tokens), the weights predict better
        if (Math.abs(Math.log(h.apiPriceRatio.est)) > 0.1) assert.ok(Math.abs(Math.log(h.ratio.est)) < Math.abs(Math.log(h.apiPriceRatio.est)), `${h.tag}: ${h.ratio.est} vs API ${h.apiPriceRatio.est}`);
      }
    }
    assert.equal(r.windowsCompared.comparable, true);
    assert.deepEqual(Object.keys(r.windowsCompared.kinds).sort(), ["cached", "output", "reasoning"]);
  }
  assert.ok(covered / intervals >= 0.9, `coverage ${covered}/${intervals}`);
  assert.ok(holdInside / holdouts >= 0.9, `holdouts inside ${holdInside}/${holdouts}`);
});

test("simulated meter at API prices: every weight 1; 5h and weekly agree", () => {
  const r = fitSim({ seed: 11, weight: { input: 1, cached: 1, output: 1, reasoning: 1 } });
  for (const w of ["5h", "weekly"]) for (const k of ["cached", "output", "reasoning"]) {
    const v = r.windows[w].weights[k];
    assert.ok(v.ci95[0] <= 1 && v.ci95[1] >= 1, `${w} ${k} ${v.est} ${v.ci95}`);
  }
  assert.equal(r.windowsCompared.same, true);
  for (const h of r.windows["5h"].holdout) assert.ok(h.inside, `${h.tag} ${h.ratio.est}`);
});

test("5h and weekly weighting cached input differently: the comparison says so", () => {
  const r = fitSim({ seed: 3, weight: { "5h": { cached: 1 }, weekly: { cached: 3 } } });
  assert.ok(Math.abs(r.windows["5h"].weights.cached.est - 1) < 0.1);
  assert.ok(Math.abs(r.windows.weekly.weights.cached.est - 3) < 0.4);
  assert.equal(r.windowsCompared.kinds.cached.same, false);
  assert.equal(r.windowsCompared.same, false);
  assert.ok(r.flags.some((f) => f.code === "windows_differ"));
});

test("an arm missing, or a kind below 5% of every fit run: held at 1, not identified", () => {
  const sim = simulateArms({ seed: 2, arms: [{ arm: "A", tag: "A1", targetPp: 12 }, { arm: "cache", tag: "c1", targetPp: 3 }, { arm: "input", tag: "i1", targetPp: 3 }, { arm: "output", tag: "o1", targetPp: 3 }] });
  const runs = sim.map((r) => WT.runFromSessions({ tag: r.tag, arm: r.arm, sessions: r.sessions, prices: PRICES, model: "gpt-6.2-sol" }));
  const r = WT.fitRuns({ runs, model: "gpt-6.2-sol", prices: PRICES, boot: 50 });
  assert.equal(r.windows["5h"].weights.reasoning.est, null);
  assert.equal(r.windows["5h"].weights.reasoning.held, 1);
  assert.ok(r.flags.some((f) => f.code === "arm_missing" && /reasoning/.test(f.detail)));
});

test("kindUsd splits a call into uncached, cached, visible output and reasoning at API prices", () => {
  const p = { input: 2, cachedInput: 0.1, output: 10 };
  const k = WT.kindUsd({ input: 10000, cached: 8000, output: 3000, reasoning: 1000 }, true, p);
  assert.deepEqual(k.tokens, [2000, 8000, 2000, 1000]);
  assert.deepEqual(k.usd.map((x) => Math.round(x * 1e6) / 1e6), [0.004, 0.0008, 0.02, 0.01]);
  // output_tokens without reasoning
  assert.deepEqual(WT.kindUsd({ input: 100, cached: 0, output: 50, reasoning: 30 }, false, p).tokens, [100, 0, 50, 30]);
});

test("runFromSessions: readings carry the $ vector through the call (lag 0) and before it (lag 1); repeated calls dropped", () => {
  const sim = simulateArms({ seed: 1, arms: [{ arm: "input", tag: "i", targetPp: 1 }] });
  const s = sim[0].sessions;
  const once = WT.runFromSessions({ tag: "i", arm: "input", sessions: s, prices: PRICES, model: "gpt-6.2-sol" });
  const twice = WT.runFromSessions({ tag: "i", arm: "input", sessions: [...s, ...s.map((x) => ({ ...x, file: `${x.file}.copy` }))], prices: PRICES, model: "gpt-6.2-sol" });
  assert.equal(once.role, "fit");
  assert.equal(twice.calls, once.calls);
  assert.deepEqual(twice.usd, once.usd);
  const r0 = once.windows.weekly[0];
  assert.ok(r0.ref[0][0] > 0 && r0.ref[1].every((x) => x === 0));
  assert.equal(WT.runFromSessions({ tag: "a", arm: "A", sessions: s, prices: PRICES, model: "gpt-6.2-sol" }).role, "holdout");
});

test("arm prompts: generated from the tag, cache turns short, input unique from the first line", () => {
  assert.equal(cacheFirst("t"), cacheFirst("t"));
  assert.notEqual(cacheFirst("t"), cacheFirst("u"));
  assert.ok(cacheFirst("t").length > 100000);
  assert.ok(cacheTurn("t", 5).length < 200);
  assert.notEqual(inputPrompt("t", 0).split("\n")[0], inputPrompt("t", 1).split("\n")[0]);
  assert.ok(inputPrompt("t", 0).length > 80000);
  assert.match(outputPrompt("t", 0), /Write exactly 400 numbered lines/);
  assert.ok(reasoningPrompt("t", 0).length < 400);
  assert.match(armWorkloadHash(), /^[0-9a-f]{16}$/);
  assert.equal(armKey("a"), "A");
  assert.equal(armKey("Cache"), "cache");
  assert.equal(armKey("x"), null);
  const ra = resumeArgs({ sessionId: "sid-1", model: "gpt-6.2-sol", effort: "low", lastFile: null });
  assert.deepEqual(ra.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(ra.slice(-2), ["sid-1", "-"]);
  assert.ok(ra.includes('sandbox_mode="read-only"'));
});

test("pacing: weight arms target 3 weekly pp on Plus, 6 pp with --window 5h", () => {
  const plus = planById("plus");
  for (const arm of ["cache", "input", "output", "reasoning"]) {
    const p = pacing({ arm, plan: plus, model: "gpt-6.2-sol", prices: REAL_PRICES });
    assert.equal(p.targetPp, 3, arm);
    assert.ok(p.est.hours < 1, `${arm} ${p.est.hours}`);
    assert.equal(pacing({ arm, plan: plus, model: "gpt-6.2-sol", prices: REAL_PRICES, window: "5h" }).targetPp, 6);
  }
});

// ---------------------------------------------------------------------------------------------
// fake codex runs of every arm, then the weights command
// ---------------------------------------------------------------------------------------------

test("fake codex: every arm runs; the cache arm is mostly cache hits; weights recovers the fake's weights and predicts A and B", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weights-"));
  const scratch = path.join(tmp, "scratch");
  // each run on its own fake account state (5h stays below its pause), one meter scale
  const env = (name) => {
    const home = path.join(tmp, `home-${name}`);
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    return { CODEX_HOME: home, CODEX_QUOTA_SCRATCH: scratch, FAKE_CODEX_WEIGHTS: JSON.stringify({ cached: 3, reasoning: 1.5 }), FAKE_CODEX_BETA: JSON.stringify({ "5h": 0.05, weekly: 0.3 }) };
  };
  try {
    const plan = [
      ["cache", ["--target-pp", "3"]],
      ["input", ["--target-pp", "3"]],
      ["output", ["--target-pp", "3"]],
      ["reasoning", ["--target-pp", "3"]],
      ["A", ["--target-pp", "3"]],
      ["B", ["--target-pp", "3"]],
    ];
    for (const [arm, extra] of plan) {
      const r = cli(["run", "--arm", arm, "--tag", `f-${arm}`, "--codex", FAKE, "--idle-min", "0", "--settle-min", "0", "--force", ...extra], env(arm));
      assert.equal(r.status, 0, `${arm}\n${r.stderr}\n${r.stdout.slice(-2000)}`);
      const m = JSON.parse(fs.readFileSync(path.join(scratch, "runs", `f-${arm}`, "manifest.json"), "utf8"));
      assert.equal(m.stopReason, "target reached", arm);
      assert.equal(m.arm, arm);
      if (arm === "cache") {
        assert.equal(m.cacheMode, "resume");
        assert.ok(m.tasks.filter((t) => t.resumed).length >= m.tasks.length - m.parallel, "every call after a stream's first resumes its session");
        assert.ok(m.tasks.filter((t) => t.resumed).every((t) => t.cachedShare > 0.95), "resumed calls are cache hits");
      }
      if (["cache", "input", "output", "reasoning"].includes(arm)) assert.equal(m.workload.version, "arms-1");
    }
    const w = cli(["weights", "--runs", plan.map(([a]) => `f-${a}`).join(","), "--boot", "200"], { CODEX_HOME: path.join(tmp, "home-cache"), CODEX_QUOTA_SCRATCH: scratch });
    assert.equal(w.status, 0, w.stderr + w.stdout);
    const out = JSON.parse(fs.readFileSync(path.join(scratch, "results", "weights-plus-gpt-6.2-sol.json"), "utf8"));
    assert.equal(out.schema, "codex-quota.weights/1");
    const byTag = Object.fromEntries(out.runs.map((r) => [r.tag, r]));
    assert.ok(byTag["f-cache"].cachedShareOfInput > 0.9, `cache arm cached share ${byTag["f-cache"].cachedShareOfInput}`);
    assert.ok(byTag["f-cache"].apiShare.cached > 0.5, `cached $ share ${byTag["f-cache"].apiShare.cached}`);
    assert.ok(byTag["f-input"].apiShare.input > 0.8);
    assert.ok(byTag["f-output"].apiShare.output > 0.7);
    assert.ok(byTag["f-reasoning"].apiShare.reasoning > 0.7);
    assert.equal(byTag["f-A"].role, "holdout");
    assert.equal(byTag["f-B"].role, "holdout");
    assert.ok(!out.flags.some((f) => f.code === "cache_low"));
    const x = out.windows["5h"];
    assert.ok(x.usable, x.reason);
    assert.ok(Math.abs(x.weights.cached.est / 3 - 1) < 0.15, `cached ${x.weights.cached.est}`);
    assert.ok(Math.abs(x.weights.reasoning.est / 1.5 - 1) < 0.15, `reasoning ${x.weights.reasoning.est}`);
    assert.ok(Math.abs(x.weights.output.est - 1) < 0.15, `output ${x.weights.output.est}`);
    for (const h of x.holdout) assert.ok(h.usable && Math.abs(Math.log(h.ratio.est)) < 0.1, `${h.tag} ${JSON.stringify(h.ratio)}`);
    assert.ok(out.windows.weekly.usable, out.windows.weekly.reason);
    assert.match(w.stdout, /weights · ChatGPT Plus · gpt-6\.2-sol/);
    assert.match(w.stdout, /holdout f-A/);
    assert.match(w.stdout, /5h ÷ weekly/);

    // the same runs found through --runs-dir from another results folder; A and B as explicit holdouts
    const other = path.join(tmp, "other");
    const w2 = cli(["weights", "--runs", "f-cache,f-input,f-output,f-reasoning", "--holdout", "f-A,f-B", "--runs-dir", path.join(scratch, "runs"), "--boot", "50", "--out", path.join(tmp, "w2.json")], { CODEX_HOME: path.join(tmp, "home-cache"), CODEX_QUOTA_SCRATCH: other });
    assert.equal(w2.status, 0, w2.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "w2.json"), "utf8")).runs.length, 6);

    // no cache hits: flagged
    const nc = { ...env("nocache"), FAKE_CODEX_NO_CACHE: "1" };
    const r = cli(["run", "--arm", "cache", "--tag", "f-nocache", "--codex", FAKE, "--idle-min", "0", "--settle-min", "0", "--force", "--target-pp", "1"], nc);
    assert.equal(r.status, 0, r.stderr);
    const w3 = cli(["weights", "--runs", "f-nocache,f-input", "--boot", "20", "--out", path.join(tmp, "w3.json")], { CODEX_HOME: nc.CODEX_HOME, CODEX_QUOTA_SCRATCH: scratch });
    assert.equal(w3.status, 0, w3.stderr);
    assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, "w3.json"), "utf8")).flags.some((f) => f.code === "cache_low"));

    // analyse --dir reads a sessions folder recursively and keeps --root
    const a = cli(["analyse", "--dir", path.join(tmp, "home-input", "sessions"), "--root", path.join(scratch, "work", "f-input"), "--plan", "plus", "--out", path.join(tmp, "dir.json")], { CODEX_QUOTA_SCRATCH: scratch });
    assert.equal(a.status, 0, a.stderr);
    const ad = JSON.parse(fs.readFileSync(path.join(tmp, "dir.json"), "utf8"));
    assert.equal(ad.run.calls, byTag["f-input"].calls);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("weights: a run tag that exists nowhere, or no fit run, fails with what to pass", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weights-"));
  try {
    const r = cli(["weights", "--runs", "nope-1"], { CODEX_HOME: path.join(tmp, "h"), CODEX_QUOTA_SCRATCH: tmp });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /run nope-1 not found .* pass --runs-dir/);
    const r2 = cli(["weights"], { CODEX_QUOTA_SCRATCH: tmp });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /weights --runs/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("compareWindows: windows without data are not comparable", () => {
  assert.equal(TW.compareWindows({ usable: false, window: "5h" }, { usable: true, window: "weekly" }, WT.KINDS).comparable, false);
  assert.equal(RF.MIN_STEPS, TW.MIN_STEPS);
});
