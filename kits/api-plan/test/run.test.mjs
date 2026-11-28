// End-to-end runs against the fake provider (test/fake-provider.mjs) on a free random port; the
// fake runs as its own child process and is stopped by its own PID. No call leaves 127.0.0.1.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "api-plan.mjs");
const FAKE = path.join(here, "fake-provider.mjs");
const FAKE_CLI = path.join(here, "fake-cli.mjs");
const KEY = "sk-test-0123456789abcdefSECRET";
const FAST = ["--idle-min", "0.003", "--settle-min", "0.002"];

const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;
const codes = (r) => r.flags.map((f) => f.code);

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
  const { port, pid } = JSON.parse(line);
  assert.equal(pid, child.pid);
  const url = `http://127.0.0.1:${port}`;
  return {
    port,
    url,
    get: async (p) => (await fetch(url + p)).json(),
    stop: () =>
      new Promise((r) => {
        child.once("exit", r);
        process.kill(child.pid, "SIGTERM"); // own PID only
      }),
  };
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "api-plan-test-"));
}

/** Run the kit; onPrompt(stdoutSoFar) is called at each "meter> " prompt and returns the line to type. */
function kit(args, { env = {}, onPrompt = null, dir } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, API_PLAN_SCRATCH: dir, API_PLAN_MIN_POLL_SEC: "0", API_PLAN_FAST_RETRY: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let prompts = 0;
    child.stdout.on("data", async (d) => {
      stdout += d;
      const n = stdout.split("meter> ").length - 1;
      while (onPrompt && prompts < n) {
        prompts++;
        child.stdin.write(`${await onPrompt(stdout, prompts)}\n`);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    if (!onPrompt) child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

function assertNoKey(r, dir) {
  assert.ok(!r.stdout.includes(KEY), "key in stdout");
  assert.ok(!r.stderr.includes(KEY), "key in stderr");
  assert.ok(!r.stdout.includes(KEY.slice(0, 16)) && !r.stderr.includes(KEY.slice(0, 16)), "key prefix printed");
  for (const f of filesUnder(dir)) assert.ok(!fs.readFileSync(f, "utf8").includes(KEY), `key in ${f}`);
}

const resultOf = (dir, tag) => JSON.parse(fs.readFileSync(path.join(dir, "results", `${tag}.json`), "utf8"));

test("GLM, automatic: OpenAI request with Bearer key, meter with the raw key, $/pp near the fake's β, no key anywhere", async () => {
  const fake = await startFake({ kind: "glm", price: { input: 1.4, cachedInput: 0.26, output: 4.4 }, beta: { weekly: 0.06, "5h": 0.03 }, start: { weekly: 20.3, "5h": 4.1 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--tag", "glm1", "--target", "5", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`, ...FAST], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /stopped: target reached/);
    const res = resultOf(dir, "glm1");
    assert.equal(res.schema, "api-plan.result/1");
    assert.ok(within(res.windows.weekly.usdPerUnit.est, 0.05, 0.25), `${res.windows.weekly.usdPerUnit.est}`);
    assert.ok(within(res.windows["5h"].usdPerUnit.est, 0.03, 0.25));
    assert.equal(res.subsidy.window, "weekly");
    assert.ok(res.subsidy.multiple.est > 0);
    assert.ok(res.subsidy.site.ratio > 0);
    assert.equal(res.fee.currency, "CNY");
    assert.equal(res.fee.feeLocal, 118);
    assert.equal(res.prices.baseModelId, "glm-5-3");
    assert.ok(res.cacheShare > 0.3, `cache share ${res.cacheShare}`);
    assert.equal(res.verdict, "clean", JSON.stringify(res.flags));
    const reqs = await fake.get("/__requests");
    const calls = reqs.filter((x) => x.method === "POST");
    const meter = reqs.filter((x) => x.path === "/api/monitor/usage/quota/limit");
    assert.ok(calls.length >= 5);
    for (const c of calls) {
      assert.equal(c.path, "/api/coding/paas/v4/chat/completions");
      assert.equal(c.auth, "bearer");
      assert.equal(c.model, "glm-5.3");
      assert.equal(c.stream, false);
      assert.deepEqual(c.roles, ["system", "user"]);
    }
    assert.ok(meter.length >= calls.length + 4, "a meter read after every call plus the idle checks");
    for (const m of meter) assert.equal(m.auth, "raw", "GLM meter takes the key without Bearer");
    assertNoKey(r, dir);
    const run = JSON.parse(fs.readFileSync(path.join(dir, "results", "runs", "glm1", "run.json"), "utf8"));
    assert.ok(!JSON.stringify(run).includes("src/lib.mjs"), "no prompts in the run file");
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MiniMax, automatic: Anthropic messages with x-api-key and a cache-marked system block; count meter", async () => {
  const fake = await startFake({ kind: "minimax", price: { input: 0.3, cachedInput: 0.06, output: 1.2, cacheWrite: 0.375 }, beta: { weekly: 0.0007, "5h": 0.0007 }, capacity: { weekly: 3000, "5h": 300 }, start: { weekly: 400, "5h": 10 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "minimax", "--model", "MiniMax-M3", "--plan", "MiniMax Token Plan Plus", "--tag", "mm1", "--base-url", `${fake.url}/anthropic`, "--meter-url", `${fake.url}/v1/token_plan/remains`, ...FAST], { env: { MINIMAX_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const res = resultOf(dir, "mm1");
    assert.equal(res.windows.weekly.unit, "count");
    assert.equal(res.windows.weekly.capacity, 3000);
    assert.ok(within(res.windows.weekly.usdPerUnit.est, 0.0007, 0.3), `${res.windows.weekly.usdPerUnit.est}`);
    assert.ok(res.tokens.cacheWrite > 0 && res.tokens.cachedInput > 0);
    const calls = (await fake.get("/__requests")).filter((x) => x.method === "POST");
    for (const c of calls) {
      assert.equal(c.path, "/anthropic/v1/messages");
      assert.equal(c.xApiKey, "raw");
      assert.equal(c.anthropicVersion, "2023-06-01");
      assert.deepEqual(c.roles, ["user"]);
    }
    assert.equal(calls[0].systemCache, true);
    assert.notEqual(calls[2].systemCache, true, "unique prompts carry no cache marker");
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Ollama, automatic: native /api/chat, USD-credit meter", async () => {
  const fake = await startFake({ kind: "ollama", price: { input: 0.3, cachedInput: 0.006, output: 1.2 }, beta: { monthly: 0.5 }, capacity: { monthly: 6 }, resolution: { monthly: 0.01 }, start: { monthly: 0.4 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "ollama", "--model", "deepseek-v4.1-flash-1017", "--plan", "Ollama Pro", "--tag", "ol1", "--target", "2", "--base-url", fake.url, "--meter-url", `${fake.url}/api/balance`, ...FAST], { env: { OLLAMA_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const res = resultOf(dir, "ol1");
    assert.equal(res.windows.monthly.unit, "USD credits");
    assert.ok(within(res.windows.monthly.usdPerUnit.est, 0.5, 0.3), `${res.windows.monthly.usdPerUnit.est}`);
    assert.equal(res.tokens.cachedInput, 0);
    const calls = (await fake.get("/__requests")).filter((x) => x.method === "POST");
    for (const c of calls) assert.equal(c.path, "/api/chat");
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MiMo, automatic: credits meter", async () => {
  const fake = await startFake({ kind: "mimo", price: { input: 0.435, cachedInput: 0.0036, output: 0.87 }, beta: { monthly: 2.4e-5 }, capacity: { monthly: 100000 }, start: { monthly: 1500 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "mimo", "--model", "mimo-v2.6-pro", "--plan", "MiMo Token Plan Lite (peak)", "--tag", "mi1", "--target", "2", "--base-url", `${fake.url}/v1`, "--meter-url", `${fake.url}/v1/platform/token_plan`, ...FAST], { env: { MIMO_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const res = resultOf(dir, "mi1");
    assert.ok(within(res.windows.monthly.usdPerUnit.est, 2.4e-5, 0.2), `${res.windows.monthly.usdPerUnit.est}`);
    assert.ok(res.subsidy.multiple.est > 0);
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bailian, automatic through the bl CLI: monthly, 7-day and 5-hour ratios", async () => {
  const fake = await startFake({ kind: "bailian", price: { input: 1.5, cachedInput: 0.075, output: 4.5 }, beta: { monthly: 0.24, weekly: 0.05, "5h": 0.01 }, resolution: { monthly: 0.01, weekly: 0.01, "5h": 0.01 }, start: { monthly: 3, weekly: 5, "5h": 1 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "bailian", "--model", "qwen4-max", "--plan", "阿里云百炼 Token Plan Lite (¥39)", "--tag", "bl1", "--base-url", `${fake.url}/compatible-mode/v1`, "--bl", FAKE_CLI, ...FAST], { env: { BAILIAN_API_KEY: KEY, FAKE_CLI_KIND: "bailian", FAKE_PORT: String(fake.port) }, dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const res = resultOf(dir, "bl1");
    assert.ok(within(res.windows.monthly.usdPerUnit.est, 0.24, 0.25), `${res.windows.monthly.usdPerUnit.est}`);
    assert.ok(within(res.windows.weekly.usdPerUnit.est, 0.05, 0.25));
    assert.equal(res.subsidy.window, "weekly", "7-day × 4 runs out before the monthly pool here");
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DeepRelay, automatic through the deeprelay CLI: weighted-token windows", async () => {
  const fake = await startFake({ kind: "deeprelay", price: { input: 0.3, cachedInput: 0.006, output: 1.2 }, beta: { "monthly-input": 1, "monthly-output": 1, "weekly-input": 1, "weekly-output": 1 }, capacity: { "monthly-input": 2e6, "monthly-output": 4e5, "weekly-input": 5e5, "weekly-output": 1e5 }, start: { "monthly-input": 1000, "monthly-output": 100, "weekly-input": 500, "weekly-output": 50 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "deeprelay", "--model", "deepseek-v4.1-flash-1017", "--plan", "DeepRelay Base", "--tag", "dr1", "--target", "5", "--base-url", `${fake.url}/v1`, "--deeprelay", FAKE_CLI, ...FAST], { env: { DEEPRELAY_API_KEY: KEY, FAKE_CLI_KIND: "deeprelay", FAKE_PORT: String(fake.port) }, dir });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const res = resultOf(dir, "dr1");
    for (const w of ["monthly-input", "monthly-output", "weekly-input", "weekly-output"]) assert.ok(res.windows[w].usable, `${w}: ${res.windows[w].reason}`);
    assert.equal(res.windows["monthly-input"].unit, "weighted tokens");
    assert.ok(res.subsidy.monthlyApiUsd.est > 0);
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Kimi, manual: the kit asks for the dashboard value, rejects a bad format, and fits the end points", async () => {
  const fake = await startFake({ kind: "kimi", price: { input: 3, cachedInput: 0.3, output: 15 }, beta: { monthly: 0.6 }, resolution: { monthly: 0.01 }, start: { monthly: 12.345 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "kimi", "--model", "kimi-k3", "--plan", "Kimi Allegretto", "--tag", "km1", "--usd-target", "0.4", "--base-url", `${fake.url}/coding/v1`, ...FAST], {
      env: { KIMI_API_KEY: KEY },
      dir,
      onPrompt: async (_out, n) => {
        if (n === 1) return "about twelve";
        const s = await fake.get("/__state");
        return `${s.reading.monthly.toFixed(2)}%`;
      },
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /https:\/\/www\.kimi\.com\/membership\/subscription\?tab=quota/);
    assert.match(r.stdout, /type a number like 37\.5% or 62\.5% left/);
    assert.match(r.stdout, /stopped: target reached \(\$ target\)/);
    const res = resultOf(dir, "km1");
    assert.equal(res.meter.mode, "manual");
    const w = res.windows.monthly;
    assert.equal(w.mode, "manual");
    assert.equal(w.resolution, 0.01);
    assert.ok(within(w.usdPerUnit.est, 0.6, 0.05), `${w.usdPerUnit.est}`);
    assert.ok(w.usdPerUnit.bounds.lo <= 0.6 * 1.02 && 0.6 * 0.98 <= w.usdPerUnit.bounds.hi);
    assert.equal(res.subsidy.window, "monthly");
    assert.ok(within(res.subsidy.multiple.est, (w.usdPerUnit.est * 100) / 39, 1e-4));
    assert.equal(res.verdict, "clean", JSON.stringify(res.flags));
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected key stops the run with the env var named and the echoed key redacted", async () => {
  const fake = await startFake({ kind: "glm", reject: true, beta: { weekly: 0.06, "5h": 0.03 }, start: { weekly: 1, "5h": 1 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--tag", "rej", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`, ...FAST], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /rejected the key in \$ZAI_API_KEY \(HTTP 401\)/);
    assert.match(r.stderr, /\[key\]/, "the fake echoed the key; it must show as [key]");
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown meter shape gives a clear error that names --manual", async () => {
  const fake = await startFake({ kind: "glm", shape: "bad" });
  const dir = scratch();
  try {
    const r = await kit(["check", "--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /GLM meter: unexpected response \(no data\.limits; top-level keys: ok, something\)\. Rerun with --manual/);
    assertNoKey(r, dir);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a different model in the responses is flagged", async () => {
  const fake = await startFake({ kind: "glm", model: "glm-4.7", price: { input: 1.4, cachedInput: 0.26, output: 4.4 }, beta: { weekly: 0.02, "5h": 0.01 }, start: { weekly: 2.5, "5h": 1.5 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--tag", "mm", "--target", "3", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`, ...FAST], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, r.stderr);
    const res = resultOf(dir, "mm");
    assert.ok(codes(res).includes("model_mismatch"));
    assert.equal(res.verdict, "contaminated");
    assert.match(r.stdout, /model_mismatch: .*glm-4\.7/);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("meter moving while idle is flagged", async () => {
  const fake = await startFake({ kind: "glm", price: { input: 1.4, cachedInput: 0.26, output: 4.4 }, beta: { weekly: 0.02, "5h": 0.01 }, start: { weekly: 2.5, "5h": 1.5 }, bumpOnRead: { n: 3, window: "weekly", amount: 2 } });
  const dir = scratch();
  try {
    const r = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--tag", "idle", "--target", "3", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`, ...FAST], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, r.stderr);
    const res = resultOf(dir, "idle");
    const fl = res.flags.find((f) => f.code === "meter_moved_idle");
    assert.ok(fl, JSON.stringify(res.flags));
    assert.equal(fl.severity, "error");
    assert.match(fl.detail, /weekly moved 2 → 4 .*\(before\)/);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dry run needs no key and makes no call; missing key and missing plan fail clearly", async () => {
  const dir = scratch();
  try {
    const env = { ZAI_API_KEY: "" };
    const d = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--dry-run"], { env, dir });
    assert.equal(d.code, 0, d.stderr);
    assert.match(d.stdout, /authorization: Bearer \$ZAI_API_KEY/);
    assert.match(d.stdout, /POST https:\/\/api\.z\.ai\/api\/coding\/paas\/v4\/chat\/completions/);
    assert.match(d.stdout, /No calls made/);
    const k = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)"], { env, dir });
    assert.equal(k.code, 1);
    assert.match(k.stderr, /set ZAI_API_KEY/);
    const p = await kit(["run", "--provider", "glm", "--model", "glm-5.3"], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(p.code, 1);
    assert.match(p.stderr, /--plan <name>/);
    const w = await kit(["run", "--provider", "glm", "--model", "glm-5.3", "--plan", "Kimi Plus", "--dry-run"], { env, dir });
    assert.match(w.stderr, /not a GLM Coding \(Z\.ai\) plan/);
    const m = await kit(["run", "--provider", "glm", "--model", "glm-9", "--plan", "GLM Coding Lite ¥118 (mixed)", "--dry-run"], { env, dir });
    assert.match(m.stderr, /no API price for glm-9 .*--price input,cached,output/);
    const o = await kit(["run", "--provider", "glm", "--model", "glm-9", "--price", "1,0.1,4", "--plan", "GLM Coding Lite ¥118 (mixed)", "--dry-run"], { env, dir });
    assert.equal(o.code, 0, o.stderr);
    assert.match(o.stdout, /--price option/);
    assert.ok(!fs.existsSync(path.join(dir, "results")), "dry run writes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
