// node --test kits/api-plan/test/*.test.mjs
// Token weights: simulated run records with known weights (five kinds), and fake-provider runs of
// every arm followed by the weights command. The fake runs as its own child process on a free
// random port and is stopped by its own PID.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as WT from "../scripts/weights.mjs";
import { mulberry32 } from "../../lib/token-weights.mjs";
import { requestFor } from "../scripts/api-plan.mjs";
import { armPromptAt, API_ARMS } from "../workload/arms.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "api-plan.mjs");
const FAKE = path.join(here, "fake-provider.mjs");
const KEY = "sk-test-0123456789abcdefSECRET";
const FAST = ["--idle-min", "0.003", "--settle-min", "0.002"];

// ---------------------------------------------------------------------------------------------
// simulated run records
// ---------------------------------------------------------------------------------------------

const PRICE = { input: 1.4, cachedInput: 0.26, cacheWrite: 1.75, output: 4.4 };
const MIX = {
  cache: { uncached: [100, 300], cached: [38000, 42000], cacheWrite: [0, 0], output: [2, 4], reasoning: [0, 0] },
  input: { uncached: [28000, 32000], cached: [0, 0], cacheWrite: [0, 0], output: [2, 4], reasoning: [0, 0] },
  output: { uncached: [80, 120], cached: [0, 0], cacheWrite: [0, 0], output: [5000, 6000], reasoning: [0, 40] },
  reasoning: { uncached: [60, 90], cached: [0, 0], cacheWrite: [0, 0], output: [2, 5], reasoning: [3000, 6000] },
  write: { uncached: [20, 40], cached: [0, 0], cacheWrite: [28000, 32000], output: [2, 4], reasoning: [0, 0] },
  mixed: { uncached: [2000, 9000], cached: [0, 6000], cacheWrite: [0, 2000], output: [600, 1100], reasoning: [100, 400] },
};
const TRUE_W = { input: 1, cached: 3, cacheWrite: 0.5, output: 1, reasoning: 1.5 };

function simRecords(seed, weights = TRUE_W) {
  const rnd = mulberry32(seed);
  const used = { weekly: 20.3 + rnd(), "5h": 4 + rnd() };
  const beta = { weekly: 0.5, "5h": 0.1 };
  let ts = Date.parse("2026-11-28T09:00:00Z");
  const out = [];
  for (const [arm, target] of [["cache", 2.2], ["input", 2.2], ["output", 2.2], ["reasoning", 2.2], ["write", 2.2], ["mixed", 5]]) {
    const run = { tag: `sim-${arm}`, adapter: "minimax", provider: "fake", api: "anthropic", model: "m", price: PRICE, fee: { plan: "Fake Plan" }, arm: arm === "mixed" ? null : arm, mode: "auto", calls: [], readings: [] };
    const read = () => run.readings.push({ ts, afterCall: run.calls.length, windows: Object.fromEntries(Object.keys(used).map((w) => [w, { used: Math.floor(used[w] * 10) / 10, unit: "%", capacity: 100, resetsAt: null }])) });
    read();
    const start = used.weekly;
    while (used.weekly - start < target) {
      if (used["5h"] > 90) used["5h"] = rnd();
      const u = Object.fromEntries(Object.entries(MIX[arm]).map(([k, r]) => [k, Math.round(r[0] + rnd() * (r[1] - r[0]))]));
      const usage = { uncached: u.uncached, cached: u.cached, cacheWrite: u.cacheWrite, output: u.output + u.reasoning, reasoning: u.reasoning };
      const k = WT.kindUsd(usage, PRICE);
      const meter = WT.KINDS.reduce((a, kind, i) => a + k.usd[i] * weights[kind], 0);
      for (const w of Object.keys(used)) used[w] += meter / beta[w];
      ts += 5000;
      run.calls.push({ ok: true, usage, usd: k.usd.reduce((a, b) => a + b, 0) });
      read();
    }
    out.push(run);
  }
  return out;
}

test("simulated records, five kinds (cached 3×, cache write 0.5×, reasoning 1.5×): recovered inside the intervals over seeds; mixed holdout inside", () => {
  let covered = 0;
  let n = 0;
  for (const seed of [1, 2, 3, 4]) {
    const r = WT.fitRuns({ records: simRecords(seed), boot: 150, seed });
    for (const w of ["5h", "weekly"]) {
      const x = r.windows[w];
      assert.ok(x.usable, x.reason);
      assert.equal(x.resolution, 0.1);
      assert.ok(x.crossings <= 170, `${x.crossings} crossings`);
      for (const k of ["cached", "cacheWrite", "output", "reasoning"]) {
        const v = x.weights[k];
        assert.ok(v.identified, `${seed} ${w} ${k}`);
        assert.ok(Math.abs(v.est / TRUE_W[k] - 1) < 0.12, `${seed} ${w} ${k} ${v.est}`);
        n++;
        if (v.ci95[0] <= TRUE_W[k] && v.ci95[1] >= TRUE_W[k]) covered++;
      }
      const h = x.holdout.find((y) => y.tag === "sim-mixed");
      assert.ok(h.usable && Math.abs(Math.log(h.ratio.est)) < 0.05, `${seed} ${w} ${JSON.stringify(h.ratio)}`);
    }
    assert.equal(r.windowsCompared.length, 1);
  }
  assert.ok(covered / n >= 0.9, `coverage ${covered}/${n}`);
});

test("runFromRecord: a reading after call k sits at the $ of calls before it (lag 0) and one call earlier (lag 1)", () => {
  const rec = simRecords(1)[1];
  const r = WT.runFromRecord(rec);
  assert.equal(r.role, "fit");
  const x = r.windows.weekly[2];
  const c0 = WT.kindUsd(rec.calls[0].usage, PRICE).usd;
  const c1 = WT.kindUsd(rec.calls[1].usage, PRICE).usd;
  assert.deepEqual(x.ref[1].map((v) => +v.toFixed(12)), c0.map((v) => +v.toFixed(12)));
  assert.deepEqual(x.ref[0].map((v) => +v.toFixed(12)), c0.map((v, i) => +(v + c1[i]).toFixed(12)));
  assert.equal(WT.runFromRecord({ ...rec, arm: null }).role, "holdout");
});

test("arm prompts and requests: effort per arm and API; cache arm marks its system prompt; --no-effort drops the field", () => {
  const out = armPromptAt("output", 0, "t");
  assert.equal(requestFor("openai", "http://x", "k", "m", out, 8000).body.reasoning_effort, "low");
  assert.equal(requestFor("openai", "http://x", "k", "m", armPromptAt("reasoning", 0, "t"), 16000).body.reasoning_effort, "high");
  assert.equal(requestFor("openai", "http://x", "k", "m", out, 8000, { effort: false }).body.reasoning_effort, undefined);
  const an = requestFor("anthropic", "http://x", "k", "m", armPromptAt("reasoning", 0, "t"), 16000).body;
  assert.equal(an.thinking.type, "enabled");
  assert.ok(an.thinking.budget_tokens < 16000);
  assert.equal(requestFor("anthropic", "http://x", "k", "m", out, 8000).body.thinking, undefined);
  assert.equal(requestFor("ollama", "http://x", "k", "m", armPromptAt("reasoning", 0, "t"), 16000).body.think, true);
  const c = requestFor("anthropic", "http://x", "k", "m", armPromptAt("cache", 3, "t"), 16).body;
  assert.equal(c.system[0].cache_control.type, "ephemeral");
  assert.equal(armPromptAt("cache", 0, "t").system, armPromptAt("cache", 9, "t").system);
  assert.notEqual(armPromptAt("write", 0, "t").system, armPromptAt("write", 1, "t").system);
  // the mixed workload's requests are unchanged
  assert.equal(requestFor("openai", "http://x", "k", "m", { system: "s", user: "u" }, 4000).body.reasoning_effort, undefined);
  assert.deepEqual(API_ARMS, ["cache", "input", "output", "reasoning", "write"]);
});

// ---------------------------------------------------------------------------------------------
// fake provider runs
// ---------------------------------------------------------------------------------------------

async function startFake(config) {
  const child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_CONFIG: JSON.stringify({ key: KEY, ...config }) }, stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    child.on("exit", (c) => reject(new Error(`fake exited ${c}`)));
  });
  const { port } = JSON.parse(line);
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    get: async (p) => (await fetch(url + p)).json(),
    stop: () =>
      new Promise((r) => {
        child.once("exit", r);
        process.kill(child.pid, "SIGTERM"); // own PID only
      }),
  };
}

function kit(args, { env = {}, dir }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, API_PLAN_SCRATCH: dir, API_PLAN_MIN_POLL_SEC: "0", API_PLAN_FAST_RETRY: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]));

test("GLM fake, cached 3× and reasoning 1.5×: four arms and a mixed holdout, then weights; the cache arm is mostly cache hits", async () => {
  const fake = await startFake({ kind: "glm", price: { input: 1.4, cachedInput: 0.26, output: 4.4 }, beta: { weekly: 0.3, "5h": 0.1 }, start: { weekly: 20.3, "5h": 4.1 }, weights: { cached: 3, reasoning: 1.5 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-plan-weights-"));
  const common = ["--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`, "--window", "5h", "--target", "8", ...FAST];
  try {
    for (const arm of ["cache", "input", "output", "reasoning", null]) {
      const before = (await fake.get("/__requests")).length;
      const r = await kit(["run", ...common, "--tag", `g-${arm ?? "mixed"}`, ...(arm ? ["--arm", arm] : [])], { env: { ZAI_API_KEY: KEY }, dir });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /stopped: target reached/);
      const calls = (await fake.get("/__requests")).slice(before).filter((x) => x.method === "POST");
      if (arm === "cache" || arm === "input") assert.ok(calls.every((c) => c.maxTokens === 16));
      if (arm === "output") assert.ok(calls.every((c) => c.maxTokens === 8000));
      const run = JSON.parse(fs.readFileSync(path.join(dir, "results", "runs", `g-${arm ?? "mixed"}`, "run.json"), "utf8"));
      assert.equal(run.arm, arm);
    }
    const w = await kit(["weights", "--runs", "g-cache,g-input,g-output,g-reasoning,g-mixed", "--boot", "200"], { dir });
    assert.equal(w.code, 0, w.stderr + w.stdout);
    const file = path.join(dir, "results", "weights-glm-coding-lite-118-mixed-glm-5-3.json");
    const out = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(out.schema, "api-plan.weights/1");
    const by = Object.fromEntries(out.runs.map((r) => [r.tag, r]));
    const ct = by["g-cache"].tokens;
    assert.ok(ct.cached / (ct.input + ct.cached) > 0.9, `cache arm cached share ${ct.cached / (ct.input + ct.cached)}`);
    assert.ok(by["g-cache"].apiShare.cached > 0.5);
    assert.ok(by["g-reasoning"].apiShare.reasoning > 0.7);
    assert.equal(by["g-mixed"].role, "holdout");
    const x = out.windows["5h"];
    assert.ok(x.usable, x.reason);
    assert.ok(Math.abs(x.weights.cached.est / 3 - 1) < 0.15, `cached ${x.weights.cached.est}`);
    assert.ok(Math.abs(x.weights.reasoning.est / 1.5 - 1) < 0.15, `reasoning ${x.weights.reasoning.est}`);
    assert.ok(Math.abs(x.weights.output.est - 1) < 0.15, `output ${x.weights.output.est}`);
    assert.equal(x.weights.cacheWrite.est, null, "no cache writes on an OpenAI-style API");
    const h = x.holdout.find((y) => y.tag === "g-mixed");
    assert.ok(h.usable && Math.abs(Math.log(h.ratio.est)) < 0.1, JSON.stringify(h));
    assert.match(w.stdout, /holdout g-mixed/);
    for (const f of filesUnder(dir)) assert.ok(!fs.readFileSync(f, "utf8").includes(KEY), `key in ${f}`);
    assert.ok(!w.stdout.includes(KEY));
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MiniMax fake (Anthropic API): the write arm is cache writes, the reasoning arm sends thinking", async () => {
  const fake = await startFake({ kind: "minimax", price: { input: 0.3, cachedInput: 0.06, output: 1.2, cacheWrite: 0.375 }, beta: { weekly: 0.0007, "5h": 0.0007 }, capacity: { weekly: 3000, "5h": 300 }, start: { weekly: 400, "5h": 10 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-plan-weights-"));
  const common = ["--provider", "minimax", "--model", "MiniMax-M3", "--plan", "MiniMax Token Plan Plus", "--base-url", `${fake.url}/anthropic`, "--meter-url", `${fake.url}/v1/token_plan/remains`, "--max-calls", "6", ...FAST];
  try {
    const r = await kit(["run", ...common, "--arm", "write", "--tag", "mm-write"], { env: { MINIMAX_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const run = JSON.parse(fs.readFileSync(path.join(dir, "results", "runs", "mm-write", "run.json"), "utf8"));
    const u = WT.runFromRecord(run);
    assert.ok(u.tokens[2] / (u.tokens[0] + u.tokens[1] + u.tokens[2]) > 0.9, "write arm input is cache writes");
    const reqs = (await fake.get("/__requests")).filter((x) => x.method === "POST");
    assert.ok(reqs.every((c) => c.systemCache === true));
    const r2 = await kit(["run", ...common, "--arm", "reasoning", "--tag", "mm-reasoning", "--max-calls", "2"], { env: { MINIMAX_API_KEY: KEY }, dir });
    assert.equal(r2.code, 0, r2.stderr + r2.stdout);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--arm on a manual meter, --arm write on an OpenAI API, weights on a missing run: fail with what to do", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-plan-weights-"));
  try {
    const a = await kit(["run", "--provider", "kimi", "--model", "kimi-k3", "--plan", "Kimi Allegretto", "--arm", "cache", "--dry-run"], { env: { KIMI_API_KEY: KEY }, dir });
    assert.equal(a.code, 1);
    assert.match(a.stderr, /needs an automatic meter/);
    const b = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--arm", "write", "--dry-run"], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(b.code, 1);
    assert.match(b.stderr, /--arm write needs the Anthropic API/);
    const c = await kit(["weights", "--runs", "nope"], { dir });
    assert.equal(c.code, 1);
    assert.match(c.stderr, /run nope not found .* --runs-dir/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
