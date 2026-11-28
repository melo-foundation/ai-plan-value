// node --test kits/harness/test/*.test.mjs
// Factory Droid, Kimi Code, Qwen Code and Mistral Vibe: parsers, headless commands, meters (manual
// and automatic, against fake binaries and a local fake API), and no secrets in output.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { TASKS_A } from "../../codex/workload/tasks.mjs";
import { ADAPTERS } from "../scripts/adapters/index.mjs";
import { SETTINGS, usageFromJson as droidJson } from "../scripts/adapters/factory.mjs";
import { readingFromUsages, sessionIdFrom, usageFromWire, usagesToken } from "../scripts/adapters/kimi.mjs";
import { readingFromBl, siteModelId as qwenSite, usageFromJson as qwenJson, usageFromTelemetry as qwenTelemetry } from "../scripts/adapters/qwen.mjs";
import { readingFromBudget, siteModelId as mistralSite, usageFromExport } from "../scripts/adapters/mistral.mjs";
import { drive, fakeBin, tmpdir } from "./helpers.mjs";

const codes = (r) => r.flags.map((f) => f.code);
const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;
const common = ["--idle-min", "0", "--force"];
const SECRET = "sk-kimiTESTSECRET0123456789abcdef";

function setup(name, binName, fake, meterStart) {
  const root = tmpdir(name);
  const bin = fakeBin(root, binName, fake);
  const meter = path.join(root, "meter.json");
  fs.writeFileSync(meter, JSON.stringify({ used: meterStart, n: 0 }));
  const scratch = path.join(root, "scratch");
  const env = { HARNESS_QUOTA_SCRATCH: scratch, FAKE_METER: meter };
  const resultText = (tag) => fs.readFileSync(path.join(scratch, "results", `${tag}.json`), "utf8");
  const manifestText = (tag) => fs.readFileSync(path.join(scratch, "results", "runs", tag, "manifest.json"), "utf8");
  return { root, bin, meter, env, scratch, result: (tag) => JSON.parse(resultText(tag)), resultText, manifestText };
}

function assertClean(text, root) {
  for (const t of TASKS_A) assert.ok(!text.includes(t.prompt.slice(0, 40)), `prompt of ${t.id} in result`);
  assert.ok(!text.includes(root), "temp root path in result");
  assert.ok(!text.includes(process.env.HOME), "home path in result");
  assert.ok(!/Bearer|sk-|SECRET|00000000-0000-4000-8000-000000000001|@example\.com/.test(text), "secret or session id in result");
}

/** Local fake API on a free port: GET <path> answers body(meter) with the given status. Records auth headers. */
async function fakeApi(meterFile, { path: p, body, status = 200 }) {
  const auth = [];
  const srv = http.createServer((req, res) => {
    auth.push(req.headers.authorization || "");
    if (req.url !== p) {
      res.writeHead(404).end();
      return;
    }
    const used = JSON.parse(fs.readFileSync(meterFile, "utf8")).used;
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body(used)));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, auth, close: () => new Promise((r) => srv.close(r)) };
}

// ---------------------------------------------------------------------------------------------
// parsers and commands
// ---------------------------------------------------------------------------------------------

test("droid -o json: input_tokens uncached, cache read / creation separate, num_turns as calls, requested model", () => {
  const out = JSON.stringify({ type: "result", subtype: "success", num_turns: 3, session_id: "s", usage: { input_tokens: 4, output_tokens: 18, cache_read_input_tokens: 13528, cache_creation_input_tokens: 17913, factory_credits: 36947 } });
  assert.deepEqual(droidJson(out, "claude-opus-5-5"), [{ model: "claude-opus-5-5", uncached: 4, cached: 13528, cacheWrite: 17913, output: 18, reasoning: 0, calls: 3, credits: 36947 }]);
  assert.deepEqual(droidJson("not json"), []);
});

test("droid command: exec --cwd, --auto medium, sandbox settings file, -o json, prompt last; dry run writes nothing", () => {
  const logDir = path.join(tmpdir("droid-cmd"), "logs");
  const dry = ADAPTERS.factory.command({ dir: "/w/t1", prompt: "P", model: "claude-opus-5-5", effort: "high", logDir, taskId: "t1", a: { "dry-run": true } });
  assert.ok(!fs.existsSync(logDir));
  const c = ADAPTERS.factory.command({ dir: "/w/t1", prompt: "P", model: "claude-opus-5-5", effort: "high", logDir, taskId: "t1", a: {} });
  assert.deepEqual(dry.args, c.args);
  assert.equal(c.args[0], "exec");
  assert.equal(c.args[c.args.indexOf("--cwd") + 1], "/w/t1");
  assert.equal(c.args[c.args.indexOf("--auto") + 1], "medium");
  assert.equal(c.args[c.args.indexOf("-o") + 1], "json");
  assert.equal(c.args[c.args.indexOf("-r") + 1], "high");
  assert.equal(c.args[c.args.length - 1], "P");
  assert.deepEqual(JSON.parse(fs.readFileSync(c.args[c.args.indexOf("--settings") + 1], "utf8")), SETTINGS);
  assert.equal(SETTINGS.sandbox.enabled, true);
  assert.equal(ADAPTERS.factory.meter.auto, null);
});

test("kimi wire.jsonl: one record per step.end; usage.record turns only when no step has usage", () => {
  const u = { inputOther: 10, output: 5, inputCacheRead: 100, inputCacheCreation: 2 };
  const step = JSON.stringify({ type: "context.append_loop_event", event: { type: "step.end", usage: u } });
  const turn = JSON.stringify({ type: "usage.record", model: "kimi-k3", usage: { ...u, output: 10 }, usageScope: "turn" });
  const r = usageFromWire([step, step, turn, "{bad"].join("\n"));
  assert.equal(r.perCall, true);
  assert.deepEqual(r.usage, [0, 1].map(() => ({ model: "kimi-k3", uncached: 10, cached: 100, cacheWrite: 2, output: 5, reasoning: 0, calls: 1 })));
  const t = usageFromWire(turn, "x");
  assert.equal(t.perCall, false);
  assert.equal(t.usage[0].output, 10);
  assert.equal(sessionIdFrom([JSON.stringify({ role: "assistant", content: "x" }), JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "ses_1" })].join("\n")), "ses_1");
});

test("kimi /usages → % for the window; reset time; unexpected shape names keys only", () => {
  const j = { usages: { limit_5h: { used_ratio: 0.3, reset_time: "2026-11-28T15:00:00Z" }, limit_7d: { used_ratio: 0.1 }, limit_month_total: { used_ratio: 0.125, reset_time: "2026-12-01T00:00:00Z" } }, boosterWallet: {} };
  assert.deepEqual(readingFromUsages(j), { pct: 12.5, resetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000, periodType: "monthly" });
  assert.equal(readingFromUsages(j, "5h").pct, 30);
  assert.equal(readingFromUsages(j, "weekly").pct, 10);
  assert.throws(() => readingFromUsages({ token: SECRET }), (e) => /top-level keys: token/.test(e.message) && !e.message.includes(SECRET));
});

test("kimi meter token: env key first; CLI access token while fresh; expired or missing say what to run", () => {
  const home = tmpdir("kimi-cred");
  const keep = { k: process.env.KIMI_CODE_API_KEY, b: process.env.KIMI_CODE_BASE_URL };
  delete process.env.KIMI_CODE_API_KEY;
  delete process.env.KIMI_CODE_BASE_URL;
  try {
    assert.throws(() => usagesToken(home), /run `kimi login`/);
    fs.mkdirSync(path.join(home, "credentials"));
    const f = path.join(home, "credentials", "kimi-code.json");
    fs.writeFileSync(f, JSON.stringify({ access_token: SECRET, refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 900 }));
    assert.equal(usagesToken(home), SECRET);
    fs.writeFileSync(f, JSON.stringify({ access_token: SECRET, expires_at: Math.floor(Date.now() / 1000) - 10 }));
    assert.throws(() => usagesToken(home), (e) => /expired: run `kimi`/.test(e.message) && !e.message.includes(SECRET));
    process.env.KIMI_CODE_API_KEY = "env-key";
    assert.equal(usagesToken(home), "env-key");
    delete process.env.KIMI_CODE_API_KEY;
    process.env.KIMI_CODE_BASE_URL = "http://127.0.0.1:1";
    assert.throws(() => usagesToken(home), /export KIMI_CODE_API_KEY/);
  } finally {
    for (const [k, v] of [["KIMI_CODE_API_KEY", keep.k], ["KIMI_CODE_BASE_URL", keep.b]]) v == null ? delete process.env[k] : (process.env[k] = v);
  }
});

test("kimi command: -p, stream-json, kimi-code/<model> alias; no effort", () => {
  const c = ADAPTERS.kimi.command({ dir: "/w/t1", prompt: "P", model: "kimi-k3" });
  assert.deepEqual(c.args, ["-p", "P", "--output-format", "stream-json", "-m", "kimi-code/kimi-k3"]);
  assert.equal(c.cwd, "/w/t1");
  assert.ok(ADAPTERS.kimi.sameModel("kimi-code/kimi-k3", "kimi-k3"));
});

test("qwen telemetry: input includes cached; thoughts inside output; JSON stats array fallback", () => {
  const rec = { attributes: { "event.name": "qwen-code.api_response", model: "qwen4-max", input_token_count: 1000, cached_content_token_count: 600, output_token_count: 50, thoughts_token_count: 20 } };
  assert.deepEqual(qwenTelemetry(JSON.stringify({ attributes: { "event.name": "qwen-code.api_request" } }) + JSON.stringify(rec, null, 2)), [{ model: "qwen4-max", uncached: 400, cached: 600, cacheWrite: 0, output: 50, reasoning: 20, calls: 1 }]);
  const out = JSON.stringify([{ type: "system" }, { type: "result", stats: { models: { "qwen4-max": { api: { totalRequests: 4 }, tokens: { prompt: 900, cached: 300, candidates: 40, thoughts: 10 } } } } }]);
  assert.deepEqual(qwenJson(out), [{ model: "qwen4-max", uncached: 600, cached: 300, cacheWrite: 0, output: 40, reasoning: 10, calls: 4 }]);
  assert.equal(qwenSite("qwen3.8-max"), "qwen-3-8-max");
  assert.equal(qwenSite("qwen4-max"), "qwen4-max");
  assert.equal(qwenSite("deepseek-v4.1-flash-1017"), "deepseek-v4-1-flash-1017");
});

test("qwen bl token-plan → window %; hasQuotaData false and missing window fail", () => {
  const j = { per5HourPercentage: 0.02, per1WeekPercentage: 0.2, per1MonthPercentage: 0.0875, per1MonthResetTime: Date.parse("2026-12-01T00:00:00Z"), hasQuotaData: true };
  assert.deepEqual(readingFromBl(j), { pct: 8.75, resetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000, periodType: "monthly" });
  assert.equal(readingFromBl(j, "weekly").pct, 20);
  assert.throws(() => readingFromBl({ hasQuotaData: false }), /bl auth login/);
  assert.throws(() => readingFromBl({ per5HourPercentage: 0.1 }, "monthly"), /no monthly window/);
});

test("qwen command: -p, yolo, --sandbox with QWEN_SANDBOX, JSON output, telemetry file without prompts", () => {
  const c = ADAPTERS.qwen.command({ dir: "/w/t1", prompt: "P", model: "qwen4-max", logDir: "/l", taskId: "t1", a: { "qwen-sandbox": "podman" } });
  assert.deepEqual(c.args.slice(0, 2), ["-p", "P"]);
  assert.ok(c.args.includes("--sandbox"));
  assert.equal(c.args[c.args.indexOf("--approval-mode") + 1], "yolo");
  assert.equal(c.args[c.args.indexOf("--output-format") + 1], "json");
  assert.equal(c.env.QWEN_SANDBOX, "podman");
  assert.equal(c.env.QWEN_TELEMETRY_OUTFILE, "/l/t1.telemetry.log");
  assert.equal(c.env.QWEN_TELEMETRY_LOG_PROMPTS, "false");
});

test("vibe export.json: input includes cached; root and subagents; requested model when unrecorded", () => {
  const ex = JSON.stringify({ outcome: "finished", steps: 5, usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 50, total_tokens: 1050 }, subagents: [{ model: "mistral-medium-3.5", steps: 2, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, total_tokens: 105 } }] });
  assert.deepEqual(usageFromExport(ex, "mistral-large-4-0"), [
    { model: "mistral-large-4-0", uncached: 300, cached: 700, cacheWrite: 0, output: 50, reasoning: 0, calls: 5 },
    { model: "mistral-medium-3.5", uncached: 100, cached: 0, cacheWrite: 0, output: 5, reasoning: 0, calls: 2 },
  ]);
  assert.equal(mistralSite("mistral-large-4-0"), "mistral-large-4");
  assert.equal(mistralSite("mistral-medium-3.5"), "mistral-medium-3-5");
});

test("vibe billing/budget → % used (0–100), reset; no vibe_budget fails", () => {
  assert.deepEqual(readingFromBudget({ vibe_budget: { usage_percentage: 37.5, initial_budget: 25, reset_at: "2026-12-01T00:00:00Z", payg_enabled: false } }), { pct: 37.5, resetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000, periodType: "monthly" });
  assert.throws(() => readingFromBudget({}), /no vibe_budget/);
});

test("vibe command: -p, --workdir, accept-edits, --output-dir per task; --thinking only when asked", () => {
  const c = ADAPTERS.mistral.command({ dir: "/w/t1", prompt: "P", model: "mistral-large-4-0", effort: "default", logDir: "/l", taskId: "t1" });
  assert.deepEqual(c.args, ["-p", "P", "--workdir", "/w/t1", "--model", "mistral-large-4-0", "--approval-policy", "accept-edits", "--output-dir", "/l/t1.vibe"]);
  const h = ADAPTERS.mistral.command({ dir: "/w/t1", prompt: "P", model: "mistral-large-4-0", effort: "high", logDir: "/l", taskId: "t1" });
  assert.equal(h.args[h.args.indexOf("--thinking") + 1], "high");
});

// ---------------------------------------------------------------------------------------------
// end-to-end runs against the fakes
// ---------------------------------------------------------------------------------------------

test("droid, manual meter: β recovered, tasks in their folders, clean result", async () => {
  const s = setup("droid-manual", "droid", "fake-droid.mjs", 10.2);
  const r = await drive(["run", "--harness", "factory", "--plan", "Droid Pro", "--bin", s.bin, "--tag", "dm", "--every", "2", "--target-pp", "12", ...common], { env: { ...s.env, FAKE_BETA: "0.15" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("dm");
  assert.equal(res.meter.mode, "manual");
  assert.equal(res.meter.window, "7d");
  assert.equal(res.planFeeUsd, 20);
  assert.ok(within(res.fit.usdPerPp.est, 0.15, 0.2), String(res.fit.usdPerPp.est));
  assert.ok(!codes(res).includes("model_mismatch"));
  assert.match(r.prompts[0], /\/limits/);
  const work = path.join(s.scratch, "work", "dm");
  assert.ok(fs.readdirSync(work).every((d) => fs.existsSync(path.join(work, d, "done.txt"))));
  assertClean(s.resultText("dm"), s.root);
});

test("droid: --auto-meter is refused (no machine-readable meter)", async () => {
  const s = setup("droid-auto", "droid", "fake-droid.mjs", 10);
  const r = await drive(["run", "--harness", "factory", "--plan", "Droid Pro", "--bin", s.bin, "--tag", "da", "--auto-meter", ...common], { env: s.env, meter: s.meter });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has no automatic meter/);
});

test("kimi, manual meter: per-call tokens from the session wire.jsonl (main + subagent)", async () => {
  const s = setup("kimi-manual", "kimi", "fake-kimi.mjs", 20.1);
  const home = path.join(s.root, "kimi-home");
  const r = await drive(["run", "--harness", "kimi", "--plan", "Kimi Pro", "--bin", s.bin, "--tag", "km", "--every", "2", "--target-pp", "12", ...common], { env: { ...s.env, KIMI_CODE_HOME: home, FAKE_BETA: "0.2" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("km");
  assert.ok(!codes(res).includes("tokens_per_task"), JSON.stringify(res.flags));
  assert.ok(within(res.fit.usdPerPp.est, 0.2, 0.2), String(res.fit.usdPerPp.est));
  assert.equal(res.run.calls, res.run.tasks * 6);
  assertClean(s.resultText("km"), s.root);
});

test("kimi, --auto-meter through /usages with $KIMI_CODE_API_KEY: key sent, never printed or stored", async () => {
  const s = setup("kimi-auto", "kimi", "fake-kimi.mjs", 20.1);
  const home = path.join(s.root, "kimi-home");
  const api = await fakeApi(s.meter, { path: "/coding/v1/usages", body: (used) => ({ usages: { limit_5h: { used_ratio: 0.01 }, limit_month_total: { used_ratio: used / 100, reset_time: new Date(Date.now() + 9 * 86400000).toISOString() } } }) });
  try {
    const r = await drive(["run", "--harness", "kimi", "--plan", "Kimi Pro", "--bin", s.bin, "--tag", "ka", "--auto-meter", "--target-pp", "4", ...common], { env: { ...s.env, KIMI_CODE_HOME: home, KIMI_CODE_BASE_URL: `${api.url}/coding/v1`, KIMI_CODE_API_KEY: SECRET, FAKE_BETA: "0.2" }, meter: s.meter });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.prompts.length, 0, r.stdout);
    assert.ok(api.auth.length > 0 && api.auth.every((h) => h === `Bearer ${SECRET}`));
    const res = s.result("ka");
    assert.equal(res.meter.mode, "auto");
    assert.ok(within(res.fit.usdPerPp.est, 0.2, 0.05), String(res.fit.usdPerPp.est));
    for (const t of [r.stdout, r.stderr, s.resultText("ka"), s.manifestText("ka")]) assert.ok(!t.includes(SECRET), "token leaked");
    assertClean(s.resultText("ka"), s.root);
  } finally {
    await api.close();
  }
});

test("kimi, --auto-meter HTTP 401 falls back to manual with what to run", async () => {
  const s = setup("kimi-401", "kimi", "fake-kimi.mjs", 20.1);
  const api = await fakeApi(s.meter, { path: "/coding/v1/usages", status: 401, body: () => ({ error: `bad token ${SECRET}` }) });
  try {
    const r = await drive(["run", "--harness", "kimi", "--plan", "Kimi Pro", "--bin", s.bin, "--tag", "kf", "--auto-meter", "--every", "2", "--target-pp", "3", ...common], { env: { ...s.env, KIMI_CODE_HOME: path.join(s.root, "h"), KIMI_CODE_BASE_URL: `${api.url}/coding/v1`, KIMI_CODE_API_KEY: SECRET, FAKE_BETA: "0.2" }, meter: s.meter });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /auto meter failed: Kimi \/usages HTTP 401: run `kimi login`.*switching to manual/);
    assert.ok(!r.stdout.includes(SECRET));
    assert.ok(codes(s.result("kf")).includes("meter_mode_switched"));
  } finally {
    await api.close();
  }
});

test("qwen, manual meter: per-call tokens from telemetry; CNY plan fee from the site in USD", async () => {
  const s = setup("qwen-manual", "qwen", "fake-qwen.mjs", 3.4);
  const r = await drive(["run", "--harness", "qwen", "--plan", "阿里云百炼 Token Plan Standard (¥139)", "--bin", s.bin, "--tag", "qm", "--every", "2", "--target-pp", "12", "--qwen-sandbox", "sandbox-exec", ...common], { env: { ...s.env, FAKE_BETA: "0.2" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("qm");
  assert.ok(!codes(res).includes("tokens_per_task"), JSON.stringify(res.flags));
  assert.ok(within(res.fit.usdPerPp.est, 0.2, 0.2), String(res.fit.usdPerPp.est));
  assert.ok(res.planFeeUsd > 20 && res.planFeeUsd < 22);
  assertClean(s.resultText("qm"), s.root);
});

test("qwen: no telemetry file → tokens from the JSON stats, flagged per task", async () => {
  const s = setup("qwen-json", "qwen", "fake-qwen.mjs", 3.4);
  const r = await drive(["run", "--harness", "qwen", "--plan", "Qwen Token Plan Standard", "--bin", s.bin, "--tag", "qj", "--every", "2", "--target-pp", "6", "--qwen-sandbox", "docker", ...common], { env: { ...s.env, FAKE_NO_TELEMETRY: "1", FAKE_BETA: "0.2" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("qj");
  assert.ok(codes(res).includes("tokens_per_task"));
  assert.ok(res.run.calls > 0);
});

test("qwen, --auto-meter through bl usage token-plan; bl failure falls back to manual, redacted", async () => {
  const s = setup("qwen-auto", "qwen", "fake-qwen.mjs", 3.4);
  const bl = fakeBin(s.root, "bl", "fake-bl.mjs");
  const r = await drive(["run", "--harness", "qwen", "--plan", "阿里云百炼 Token Plan Lite (¥39)", "--bin", s.bin, "--bl", bl, "--tag", "qa", "--auto-meter", "--target-pp", "4", "--qwen-sandbox", "sandbox-exec", ...common], { env: { ...s.env, FAKE_BETA: "0.2" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.prompts.length, 0, r.stdout);
  const res = s.result("qa");
  assert.equal(res.meter.mode, "auto");
  assert.ok(within(res.fit.usdPerPp.est, 0.2, 0.05), String(res.fit.usdPerPp.est));
  assert.ok(!codes(res).includes("period_mismatch"));

  const f = await drive(["run", "--harness", "qwen", "--plan", "阿里云百炼 Token Plan Lite (¥39)", "--bin", s.bin, "--bl", bl, "--tag", "qf", "--auto-meter", "--every", "2", "--target-pp", "3", "--qwen-sandbox", "sandbox-exec", ...common], { env: { ...s.env, FAKE_BETA: "0.2", FAKE_BL_FAIL: "1" }, meter: s.meter });
  assert.equal(f.code, 0, f.stderr + f.stdout);
  assert.match(f.stdout, /auto meter failed: bl usage token-plan --output json exited 1: .*\[redacted\].*switching to manual/);
  assert.ok(!/sk-sp-|user@example\.com/.test(f.stdout + s.resultText("qf") + s.manifestText("qf")), "secret leaked");
});

test("vibe, manual meter: per-task tokens from export.json (root + subagent)", async () => {
  const s = setup("vibe-manual", "vibe", "fake-vibe.mjs", 5.3);
  const r = await drive(["run", "--harness", "mistral", "--plan", "Mistral Vibe Pro", "--bin", s.bin, "--tag", "vm", "--every", "2", "--target-pp", "12", ...common], { env: { ...s.env, FAKE_BETA: "0.1" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("vm");
  assert.ok(codes(res).includes("tokens_per_task"));
  assert.ok(!codes(res).includes("model_mismatch"), JSON.stringify(res.flags));
  assert.ok(within(res.fit.usdPerPp.est, 0.1, 0.2), String(res.fit.usdPerPp.est));
  assert.equal(res.planFeeUsd, 14.99);
  assertClean(s.resultText("vm"), s.root);
});

test("vibe, --auto-meter through billing/budget with $MISTRAL_API_KEY; 403 falls back to manual", async () => {
  const s = setup("vibe-auto", "vibe", "fake-vibe.mjs", 5.3);
  const ok = await fakeApi(s.meter, { path: "/v1/billing/budget", body: (used) => ({ vibe_budget: { usage_percentage: used, initial_budget: 25, reset_at: new Date(Date.now() + 9 * 86400000).toISOString(), payg_enabled: false } }) });
  try {
    const r = await drive(["run", "--harness", "mistral", "--plan", "Mistral Vibe Pro", "--bin", s.bin, "--tag", "va", "--auto-meter", "--target-pp", "4", ...common], { env: { ...s.env, HARNESS_QUOTA_MISTRAL_BASE: `${ok.url}/v1`, MISTRAL_API_KEY: SECRET, FAKE_BETA: "0.1" }, meter: s.meter });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.prompts.length, 0, r.stdout);
    assert.ok(ok.auth.every((h) => h === `Bearer ${SECRET}`));
    const res = s.result("va");
    assert.equal(res.meter.mode, "auto");
    assert.ok(within(res.fit.usdPerPp.est, 0.1, 0.05), String(res.fit.usdPerPp.est));
    for (const t of [r.stdout, s.resultText("va"), s.manifestText("va")]) assert.ok(!t.includes(SECRET), "key leaked");
  } finally {
    await ok.close();
  }
  const no = await fakeApi(s.meter, { path: "/v1/billing/budget", status: 403, body: () => ({ detail: "forbidden" }) });
  try {
    const r = await drive(["run", "--harness", "mistral", "--plan", "Mistral Vibe Pro", "--bin", s.bin, "--tag", "vf", "--auto-meter", "--every", "2", "--target-pp", "3", ...common], { env: { ...s.env, HARNESS_QUOTA_MISTRAL_BASE: `${no.url}/v1`, MISTRAL_API_KEY: SECRET, FAKE_BETA: "0.1" }, meter: s.meter });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /auto meter failed: Mistral billing\/budget HTTP 403: the key lacks see_org_inference_usage; switching to manual/);
  } finally {
    await no.close();
  }
  const none = await drive(["check", "--harness", "mistral", "--bin", s.bin, "--auto-meter"], { env: { ...s.env, MISTRAL_API_KEY: "" } });
  assert.match(none.stdout, /auto meter failed: MISTRAL_API_KEY is not set/);
});
