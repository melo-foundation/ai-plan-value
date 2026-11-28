// node --test kits/harness/test/*.test.mjs
// smoke: one prompt through each fake harness (and Devin paste mode); pass and fail paths, the
// automatic meter with its field names, nothing private in the report, a valid prefilled issue URL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertIssueUrl, assertReport, readJson } from "../../lib/smoke-assert.mjs";
import { SMOKE_PROMPT } from "../../lib/smoke.mjs";
import { ADAPTERS } from "../scripts/adapters/index.mjs";
import { drive, fakeBin, fakeBinInstall, fakeGeminiInstall, fakeGrokInstall, tmpdir } from "./helpers.mjs";

const LEAK = "grok.owner@example.com";
const LOGIN_SECRET = "ya29.LOGINSECRETabcdef0123456789";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const today = new Date().toISOString().slice(0, 10);

/** Temp HOME with login files holding secrets, fake binaries, a stand-in bwrap on PATH. */
function setup(name) {
  const root = tmpdir(`smoke-${name}`);
  for (const [dir, file] of [[".grok", "auth.json"], [".gemini", "oauth_creds.json"], [".vibe", ".env"], ["kimi-home/credentials", "kimi-code.json"]]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, file), JSON.stringify({ access_token: LOGIN_SECRET, email: LEAK }));
  }
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const meter = path.join(root, "meter.json");
  fs.writeFileSync(meter, JSON.stringify({ used: 41.37, n: 0 }));
  const scratch = path.join(root, "scratch");
  const env = { HOME: root, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, HARNESS_QUOTA_SCRATCH: scratch, FAKE_METER: meter, KIMI_CODE_HOME: path.join(root, "kimi-home"), MISTRAL_API_KEY: "", KIMI_CODE_API_KEY: "", CURSOR_API_KEY: "", META_API_KEY: "" };
  const report = (id) => readJson(path.join(scratch, "results", `smoke-${id}-${today}.json`));
  return { root, meter, env, scratch, report };
}

const byId = (rep) => Object.fromEntries(rep.steps.map((s) => [s.id, s]));
const noCounts = (rep) => {
  const reasons = rep.steps.filter((s) => s.id !== "binary").map((s) => s.reason).join(" | ");
  assert.ok(!/\d{3,}/.test(reasons), reasons);
};

/** Per harness: fake install, extra flags, typed answers. */
const CASES = {
  gemini: { install: (r) => fakeGeminiInstall(r), args: ["--gemini-sandbox", "sandbox-exec"] },
  grok: { install: (r) => fakeGrokInstall(r) },
  factory: { install: (r) => fakeBin(r, "droid", "fake-droid.mjs") },
  kimi: { install: (r) => fakeBin(r, "kimi", "fake-kimi.mjs") },
  qwen: { install: (r) => fakeBin(r, "qwen", "fake-qwen.mjs"), args: ["--qwen-sandbox", "sandbox-exec"] },
  mistral: { install: (r) => fakeBin(r, "vibe", "fake-vibe.mjs") },
  muse: { install: (r) => fakeBinInstall(r, "muse", "muse"), args: ["--contributor", "on"] },
  cursor: { install: (r) => fakeBinInstall(r, "cursor", "agent"), args: ["--included-usd", "20"], answers: ["3.5", "0"] },
  devin: { install: () => null, answers: ["2.5", "41"] },
};

test("every adapter has a smoke case", () => assert.deepEqual(Object.keys(CASES).sort(), Object.keys(ADAPTERS).sort()));

for (const [id, c] of Object.entries(CASES)) {
  test(`smoke ${id}, manual meter: works; one prompt; names only in the report; URL valid`, async () => {
    const s = setup(id);
    try {
      const bin = c.install(s.root);
      const answers = c.answers || ["41.37%"];
      const r = await drive(["smoke", "--harness", id, ...(bin ? ["--bin", bin] : []), "--manual", "--force", ...(c.args || [])], { env: s.env, answer: (_u, _l, n) => answers[n - 1] ?? "skip" });
      assert.equal(r.code, 0, r.stderr + r.stdout);
      const rep = s.report(id);
      assert.equal(rep.kit, "harness");
      assert.equal(rep.adapter, id);
      assert.equal(rep.model, ADAPTERS[id].models.default);
      assert.equal(rep.result, "works", JSON.stringify(rep.steps));
      const st = byId(rep);
      for (const k of ["binary", "preflight", "prompt", "usage", "meter-manual"]) assert.equal(st[k].status, "pass", `${k}: ${st[k].reason}`);
      assert.ok(["pass", "skipped"].includes(st.model.status), st.model.reason);
      assert.ok(["pass", "skipped"].includes(st.login.status), st.login.reason);
      if (ADAPTERS[id].meter.auto) assert.equal(st["meter-auto"].reason, "--manual");
      if (id === "devin") assert.match(r.stdout, /==== task smoke/);
      else assert.ok(rep.fields.usage.length > 0, "no usage field names");
      assert.equal(r.prompts.length, answers.length, r.prompts.join("\n"));
      assertReport(rep, { secrets: [LEAK, LOGIN_SECRET, SESSION_ID, s.root], numbers: ["41.37", "3.5"], root: s.root });
      noCounts(rep);
      assertIssueUrl(r.stdout, rep);
      assert.ok(!fs.readdirSync(path.join(s.scratch, "work")).length, "throwaway folder left behind");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
}

test("smoke grok, automatic meter: x.ai/billing field names, plan from the meter, no manual prompt", async () => {
  const s = setup("grok-auto");
  try {
    const bin = fakeGrokInstall(s.root);
    const r = await drive(["smoke", "--harness", "grok", "--plan", "SuperGrok", "--bin", bin, "--force"], { env: { ...s.env, FAKE_LEAK: LEAK } });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.prompts.length, 0);
    const rep = s.report("grok");
    assert.equal(rep.result, "works", JSON.stringify(rep.steps));
    const st = byId(rep);
    assert.equal(st["meter-auto"].status, "pass");
    assert.equal(st["meter-fields"].status, "pass");
    assert.equal(st.plan.status, "pass");
    assert.equal(st["meter-manual"].status, "skipped");
    assert.deepEqual(rep.fields.meter, ["account_email", "config", "on_demand_enabled", "subscription_tier"]);
    assert.deepEqual(rep.fields.usage, ["cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"]);
    assertReport(rep, { secrets: [LEAK, LOGIN_SECRET, SESSION_ID], numbers: ["41.37"], root: s.root });
    noCounts(rep);
    assert.ok(!r.stdout.includes(SMOKE_PROMPT + "\n==="), "prompt echoed as a task");
    assertIssueUrl(r.stdout, rep);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke gemini, automatic meter through the CLI's core package: bucket field names", async () => {
  const s = setup("gemini-auto");
  try {
    const bin = fakeGeminiInstall(s.root);
    const r = await drive(["smoke", "--harness", "gemini", "--bin", bin, "--gemini-sandbox", "sandbox-exec", "--force"], { env: s.env });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const rep = s.report("gemini");
    assert.equal(rep.result, "works", JSON.stringify(rep.steps));
    assert.deepEqual(rep.fields.meter, ["buckets", "buckets.modelId", "buckets.remainingAmount", "buckets.remainingFraction", "buckets.resetTime", "buckets.tokenType"]);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke grok: automatic meter fails → partly; the manual reading is asked; the error is redacted", async () => {
  const s = setup("grok-autofail");
  try {
    const bin = fakeGrokInstall(s.root);
    const r = await drive(["smoke", "--harness", "grok", "--plan", "SuperGrok Heavy", "--bin", bin, "--force"], { env: { ...s.env, FAKE_BILLING_FAIL: "1", FAKE_LEAK: LEAK }, answer: () => "58% left" });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const rep = s.report("grok");
    assert.equal(rep.result, "partly");
    const st = byId(rep);
    assert.equal(st["meter-auto"].status, "fail");
    assert.match(st["meter-auto"].reason, /grok login/);
    assert.equal(st["meter-manual"].status, "pass");
    assert.equal(r.prompts.length, 1);
    assertReport(rep, { secrets: [LEAK, LOGIN_SECRET], numbers: ["58", "42"], root: s.root });
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke grok: the task exits 1 → fails; stderr (with the account) stays out of the report", async () => {
  const s = setup("grok-exit");
  try {
    const bin = fakeGrokInstall(s.root);
    fs.rmSync(path.join(s.root, ".grok"), { recursive: true });
    const r = await drive(["smoke", "--harness", "grok", "--bin", bin, "--manual", "--force"], { env: { ...s.env, FAKE_EXIT: "1", FAKE_LEAK: LEAK }, answer: () => "skip" });
    assert.equal(r.code, 1);
    const rep = s.report("grok");
    assert.equal(rep.result, "fails");
    const st = byId(rep);
    assert.equal(st.prompt.status, "fail");
    assert.equal(st.prompt.reason, "exit 1");
    assert.equal(st.login.status, "fail");
    assert.match(st.login.reason, /run grok login/);
    assert.equal(st.usage.status, "fail");
    assert.equal(st["meter-manual"].status, "skipped");
    assertReport(rep, { secrets: [LEAK, "signed in as"], root: s.root });
    assertIssueUrl(r.stdout, rep);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke: harness not installed → fails at binary; no prompt, no meter call", async () => {
  const s = setup("nobin");
  try {
    const r = await drive(["smoke", "--harness", "factory", "--bin", path.join(s.root, "no-droid"), "--force"], { env: s.env, answer: () => "stop" });
    assert.equal(r.code, 1);
    const rep = s.report("factory");
    assert.equal(rep.result, "fails");
    const st = byId(rep);
    assert.equal(st.binary.status, "fail");
    assert.match(st.binary.reason, /droid not found/);
    assert.equal(st.prompt.status, "skipped");
    assert.equal(st.usage.status, "skipped");
    assertReport(rep, { root: s.root });
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke devin: a failed session typed as fail → fails; Devin with --devin-api and no token → login fails", async () => {
  const s = setup("devin-fail");
  try {
    const r = await drive(["smoke", "--harness", "devin", "--force"], { env: s.env, answer: (_u, _l, n) => (n === 1 ? "fail 1.5" : "skip") });
    assert.equal(r.code, 1);
    const rep = s.report("devin");
    assert.equal(rep.result, "fails");
    assert.equal(byId(rep).prompt.status, "fail");
    assert.equal(byId(rep).login.status, "skipped");
    const r2 = await drive(["smoke", "--harness", "devin", "--devin-api", "--force"], { env: { ...s.env, DEVIN_API_KEY: "", DEVIN_ORG_ID: "" }, answer: () => "skip" });
    assert.equal(r2.code, 1);
    const rep2 = s.report("devin");
    assert.equal(byId(rep2).binary.status, "fail");
    assert.equal(byId(rep2).login.status, "fail");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
