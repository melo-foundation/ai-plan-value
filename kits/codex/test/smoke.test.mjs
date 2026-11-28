// node --test kits/codex/test/*.test.mjs
// smoke: one prompt through the fake codex; pass and fail paths, nothing private in the report,
// a valid prefilled issue URL. Never runs a real codex.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertIssueUrl, assertReport, readJson } from "../../lib/smoke-assert.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "codex-quota.mjs");
const FAKE = path.join(here, "fake-codex.mjs");
const LEAK = "someone.private@example.org acct-7f3e9c21";
const AUTH_SECRET = "sk-codexAUTHSECRET0123456789abcdef";
// token counts the fake writes for a ping (input 16000, cached 14000, output 5, total 16005)
const NUMBERS = ["16000", "14000", "16005", "2000"];

function setup({ auth = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-smoke-"));
  const home = path.join(root, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  if (auth) fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: AUTH_SECRET }, email: LEAK }));
  const scratch = path.join(root, "scratch");
  const today = new Date().toISOString().slice(0, 10);
  const report = () => readJson(path.join(scratch, "results", `smoke-codex-${today}.json`));
  return { root, home, scratch, report };
}

const smoke = (s, args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, "smoke", "--force", ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, CODEX_HOME: s.home, CODEX_QUOTA_SCRATCH: s.scratch, FAKE_CODEX_LEAK: LEAK, ...env } });

test("smoke, Plus: every step passes; report has names only; issue URL carries it", () => {
  const s = setup();
  try {
    const r = smoke(s, ["--codex", FAKE, "--plan", "plus"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rep = s.report();
    assert.equal(rep.kit, "codex");
    assert.equal(rep.adapter, "codex");
    assert.equal(rep.plan, "plus");
    assert.equal(rep.model, "gpt-6.2-sol");
    assert.equal(rep.toolVersion, "codex-cli 0.172.0");
    assert.equal(rep.result, "works", JSON.stringify(rep.steps));
    assert.deepEqual(rep.steps.map((x) => x.id), ["binary", "login", "prompt", "usage", "model", "meter", "meter-fields", "plan"]);
    for (const st of rep.steps) assert.equal(st.status, "pass", JSON.stringify(st));
    assert.ok(rep.fields.usage.includes("cached_input_tokens"), rep.fields.usage.join(","));
    assert.ok(rep.fields.meter.includes("primary") && rep.fields.meter.includes("plan_type"), rep.fields.meter.join(","));
    assertReport(rep, { secrets: [LEAK, "acct-7f3e9c21", AUTH_SECRET, s.home], numbers: NUMBERS, root: s.root });
    assertIssueUrl(r.stdout, rep);
    assert.ok(!r.stdout.includes(AUTH_SECRET));
    assert.ok(!fs.readdirSync(path.join(s.scratch, "work")).length, "throwaway folder left behind");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke: codex exits 1 → fails; later steps skipped; stderr not in the report", () => {
  const s = setup();
  try {
    const r = smoke(s, ["--codex", FAKE], { FAKE_CODEX_EXIT: "1" });
    assert.equal(r.status, 1);
    const rep = s.report();
    assert.equal(rep.result, "fails");
    const by = Object.fromEntries(rep.steps.map((x) => [x.id, x]));
    assert.equal(by.prompt.status, "fail");
    assert.equal(by.prompt.reason, "exit 1");
    assert.equal(by.usage.status, "fail");
    assertReport(rep, { secrets: [LEAK, "not logged in", AUTH_SECRET], root: s.root });
    assertIssueUrl(r.stdout, rep);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke: no codex binary, no login → fails at binary, rest skipped", () => {
  const s = setup({ auth: false });
  try {
    const r = smoke(s, ["--codex", path.join(s.root, "no-such-codex")]);
    assert.equal(r.status, 1);
    const rep = s.report();
    assert.equal(rep.result, "fails");
    const by = Object.fromEntries(rep.steps.map((x) => [x.id, x]));
    assert.equal(by.binary.status, "fail");
    assert.equal(by.login.status, "fail");
    for (const id of ["prompt", "usage", "model", "meter", "plan"]) assert.equal(by[id].status, "skipped", id);
    assertReport(rep, { root: s.root });
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke: other model in the rollout, no rate_limits, Pro without --plan → partly", () => {
  const s = setup();
  try {
    const a = smoke(s, ["--codex", FAKE], { FAKE_CODEX_MODEL: "gpt-5.5-mini", FAKE_CODEX_NO_RATE: "1" });
    assert.equal(a.status, 0, a.stderr);
    const rep = s.report();
    assert.equal(rep.result, "partly");
    const by = Object.fromEntries(rep.steps.map((x) => [x.id, x]));
    assert.equal(by.model.status, "fail");
    assert.match(by.model.reason, /requested gpt-6\.2-sol, rollout says gpt-5\.5-mini/);
    assert.equal(by.meter.status, "fail");
    assert.equal(by.usage.status, "pass");
    const b = smoke(s, ["--codex", FAKE], { FAKE_CODEX_PLAN: "pro" });
    const rep2 = s.report();
    assert.equal(rep2.result, "partly");
    assert.match(rep2.steps.find((x) => x.id === "plan").reason, /pass --plan/);
    assert.ok(b.stdout.includes("partly"));
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("smoke: unknown --plan stops before any call", () => {
  const s = setup();
  try {
    const r = smoke(s, ["--codex", FAKE, "--plan", "pro-50x"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--plan plus \| pro-10x/);
    assert.ok(!fs.existsSync(path.join(s.home, "sessions")), "a call was made");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
