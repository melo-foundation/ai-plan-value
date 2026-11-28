// node --test kits/api-plan/test/*.test.mjs
// smoke: one request to the fake provider (test/fake-provider.mjs, free random port, own PID);
// pass and fail paths, nothing private in the report, a valid prefilled issue URL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertIssueUrl, assertReport, readJson } from "../../lib/smoke-assert.mjs";
import { SMOKE_PROMPT } from "../../lib/smoke.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "api-plan.mjs");
const FAKE = path.join(here, "fake-provider.mjs");
const FAKE_CLI = path.join(here, "fake-cli.mjs");
const KEY = "sk-test-0123456789abcdefSMOKESECRET";
const LEAK = "plan.owner@example.net";
const today = new Date().toISOString().slice(0, 10);

async function startFake(config) {
  const child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_CONFIG: JSON.stringify({ key: KEY, leak: LEAK, ...config }) }, stdio: ["ignore", "pipe", "inherit"] });
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

/** Run smoke; answer each "used: " prompt with answers[n] (stdin closed after the last). */
function smoke(args, { env = {}, dir, answers = [] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "smoke", ...args], { env: { ...process.env, API_PLAN_SCRATCH: dir, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let asked = 0;
    child.stdout.on("data", (d) => {
      stdout += d;
      const n = stdout.split("used: ").length - 1;
      while (asked < n) {
        const a = answers[asked++];
        if (a == null) child.stdin.end();
        else child.stdin.write(`${a}\n`);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    if (!answers.length) child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "api-plan-smoke-"));
const reportOf = (dir, id) => readJson(path.join(dir, "results", `smoke-${id}-${today}.json`));
const byId = (rep) => Object.fromEntries(rep.steps.map((s) => [s.id, s]));
const allOut = (r) => r.stdout + r.stderr;

test("GLM, automatic meter: one call, no system prompt; report has field names only; URL valid", async () => {
  const fake = await startFake({ kind: "glm", price: { input: 1.4, cachedInput: 0.26, output: 4.4 }, beta: { weekly: 0.06, "5h": 0.03 }, start: { weekly: 20.3, "5h": 4.1 } });
  const dir = scratch();
  try {
    const r = await smoke(["--provider", "glm", "--model", "glm-5.3", "--plan", "GLM Coding Lite ¥118 (mixed)", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(r.code, 0, allOut(r));
    const rep = reportOf(dir, "glm");
    assert.equal(rep.kit, "api-plan");
    assert.equal(rep.plan, "GLM Coding Lite ¥118 (mixed)");
    assert.equal(rep.result, "works", JSON.stringify(rep.steps));
    const s = byId(rep);
    for (const id of ["endpoint", "key", "prompt", "usage", "model", "meter-auto", "meter-fields"]) assert.equal(s[id].status, "pass", JSON.stringify(s[id]));
    assert.equal(s["meter-manual"].status, "skipped");
    assert.match(s["meter-auto"].reason, /weekly, 5h|5h, weekly/);
    assert.ok(rep.fields.usage.includes("prompt_tokens") && rep.fields.usage.includes("prompt_tokens_details.cached_tokens"), rep.fields.usage.join(","));
    assert.deepEqual(rep.fields.meter, ["account_email", "code", "data", "msg", "success"]);
    const reqs = (await fake.get("/__requests")).filter((x) => x.method === "POST");
    assert.equal(reqs.length, 1, "exactly one model call");
    assert.deepEqual(reqs[0].roles, ["user"]);
    assert.equal(reqs[0].maxTokens, 256);
    // the fake's first call: 700 output tokens; meter at 20.3 % weekly, 4.1 % 5h
    assertReport(rep, { secrets: [KEY, LEAK, String(fake.port)], numbers: ["700", "20.3", "4.1"], root: dir });
    assertIssueUrl(r.stdout, rep);
    assert.ok(!allOut(r).includes(KEY) && !allOut(r).includes(LEAK), "key or account printed");
    assert.ok(!JSON.stringify(rep).includes(SMOKE_PROMPT));
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Kimi, manual meter: one typed reading parsed, unit recorded, value not stored", async () => {
  const fake = await startFake({ kind: "kimi", price: { input: 3, cachedInput: 0.3, output: 15 }, beta: { monthly: 0.6 }, start: { monthly: 12.345 } });
  const dir = scratch();
  try {
    const r = await smoke(["--provider", "kimi", "--model", "kimi-k3", "--base-url", `${fake.url}/coding/v1`], { env: { KIMI_API_KEY: KEY }, dir, answers: ["about a third", "37.25%"] });
    assert.equal(r.code, 0, allOut(r));
    const rep = reportOf(dir, "kimi");
    assert.equal(rep.result, "works", JSON.stringify(rep.steps));
    const s = byId(rep);
    assert.equal(s["meter-auto"].status, "skipped");
    assert.equal(s["meter-manual"].status, "pass");
    assert.match(s["meter-manual"].reason, /unit %/);
    assert.match(r.stdout, /kimi\.com\/membership/);
    assertReport(rep, { secrets: [KEY, LEAK], numbers: ["37.25", "12.345"], root: dir });
    assertIssueUrl(r.stdout, rep);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bailian through the bl CLI: meter fields from the CLI's JSON", async () => {
  const fake = await startFake({ kind: "bailian", price: { input: 1.5, cachedInput: 0.075, output: 4.5 }, beta: { monthly: 0.24, weekly: 0.05, "5h": 0.01 }, start: { monthly: 3, weekly: 5, "5h": 1 } });
  const dir = scratch();
  try {
    const r = await smoke(["--provider", "bailian", "--model", "qwen4-max", "--base-url", `${fake.url}/compatible-mode/v1`, "--bl", FAKE_CLI], { env: { BAILIAN_API_KEY: KEY, FAKE_CLI_KIND: "bailian", FAKE_PORT: String(fake.port) }, dir });
    assert.equal(r.code, 0, allOut(r));
    const rep = reportOf(dir, "bailian");
    assert.equal(rep.result, "works", JSON.stringify(rep.steps));
    assert.deepEqual(rep.fields.meter, ["account_email", "data", "hasQuotaData", "requestId"]);
    assertReport(rep, { secrets: [KEY, LEAK, "00000000-test"], root: dir });
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejected key → fails; the echoed key appears nowhere", async () => {
  const fake = await startFake({ kind: "glm", reject: true, beta: { weekly: 0.06, "5h": 0.03 }, start: { weekly: 1, "5h": 1 } });
  const dir = scratch();
  try {
    const r = await smoke(["--provider", "glm", "--model", "glm-5.3", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`], { env: { ZAI_API_KEY: KEY }, dir });
    assert.equal(r.code, 1);
    const rep = reportOf(dir, "glm");
    assert.equal(rep.result, "fails");
    const s = byId(rep);
    assert.equal(s.prompt.status, "fail");
    assert.match(s.prompt.reason, /key rejected \(HTTP 401\)/);
    assert.equal(s.usage.status, "skipped");
    assertReport(rep, { secrets: [KEY, KEY.slice(0, 16), LEAK], root: dir });
    assertIssueUrl(r.stdout, rep);
    assert.ok(!allOut(r).includes(KEY));
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown meter shape and another model → partly; manual reading asked as a fallback", async () => {
  const fake = await startFake({ kind: "glm", shape: "bad", model: "glm-4.9-air", beta: { weekly: 0.06, "5h": 0.03 }, start: { weekly: 1, "5h": 1 } });
  const dir = scratch();
  try {
    const r = await smoke(["--provider", "glm", "--model", "glm-5.3", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`], { env: { ZAI_API_KEY: KEY }, dir, answers: ["12%"] });
    assert.equal(r.code, 0, allOut(r));
    const rep = reportOf(dir, "glm");
    assert.equal(rep.result, "partly");
    const s = byId(rep);
    assert.equal(s["meter-auto"].status, "fail");
    assert.match(s["meter-auto"].reason, /unexpected response/);
    assert.equal(s.model.status, "fail");
    assert.match(s.model.reason, /response says glm-4\.9-air/);
    assert.equal(s["meter-manual"].status, "pass");
    assertReport(rep, { secrets: [KEY, LEAK], root: dir });
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no key → fails at key; no call made; no reading typed is skipped", async () => {
  const fake = await startFake({ kind: "glm", beta: { weekly: 0.06 }, start: { weekly: 1 } });
  const dir = scratch();
  try {
    const r = await smoke(["--provider", "glm", "--model", "glm-5.3", "--base-url", `${fake.url}/api/coding/paas/v4`, "--meter-url", `${fake.url}/api/monitor/usage/quota/limit`], { env: { ZAI_API_KEY: "" }, dir });
    assert.equal(r.code, 1);
    const rep = reportOf(dir, "glm");
    const s = byId(rep);
    assert.equal(s.key.status, "fail");
    assert.equal(s.prompt.status, "skipped");
    assert.equal(s["meter-manual"].status, "skipped");
    assert.equal((await fake.get("/__requests")).length, 0);
  } finally {
    await fake.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
