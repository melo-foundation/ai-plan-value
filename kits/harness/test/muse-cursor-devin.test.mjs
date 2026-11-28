// node --test kits/harness/test/*.test.mjs
// Muse Code, Cursor CLI and Devin: command shape, usage and meter parsing, end-to-end runs against
// fake binaries and a fake Devin API, and no secrets / prompts / paths in results.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TASKS_A } from "../../codex/workload/tasks.mjs";
import { ADAPTERS } from "../scripts/adapters/index.mjs";
import { planFromMeter, readingFromUsage, usageFromJsonl } from "../scripts/adapters/muse.mjs";
import { parseDollars, pctOfIncluded, usageFromJson as cursorJson } from "../scripts/adapters/cursor.mjs";
import { cloudPrompt, parseAcus } from "../scripts/adapters/devin.mjs";
import { drive, fakeBinInstall, SCRIPT, tmpdir } from "./helpers.mjs";

const codes = (r) => r.flags.map((f) => f.code);
const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;
const common = ["--idle-min", "0", "--force"];
const API_KEY = "cog_TESTKEY0123456789abcdef";

function setup(name, fake, binName, meterStart) {
  const root = tmpdir(name);
  const bin = fake ? fakeBinInstall(root, fake, binName) : null;
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
  assert.ok(!/Bearer|cog_|SECRET|00000000-0000-4000-8000-000000000001/.test(text), "secret or session id in result");
}

// ---- unit: Muse Code ----

test("muse command: exec --json, approval off with the sandbox kept, contributor mode per run", () => {
  const c = ADAPTERS.muse.command({ dir: "/w/t1", prompt: "P", model: "muse-spark-1.3", effort: "high", inputs: { contributor: "off" } });
  assert.deepEqual(c.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(c.args.includes("--disable-approval"));
  for (const f of ["--yolo", "--disable-sandbox"]) assert.ok(!c.args.includes(f), f);
  assert.equal(c.args[c.args.indexOf("--model") + 1], "muse-spark-1.3");
  assert.equal(c.args[c.args.indexOf("--reasoning-effort") + 1], "high");
  assert.equal(c.args[c.args.indexOf("--contributor-mode") + 1], "off");
  assert.equal(c.args[c.args.length - 1], "P");
  assert.equal(c.cwd, "/w/t1");
  assert.ok(!ADAPTERS.muse.efforts.values.includes("none"));
});

test("muse JSONL: run.usage per task (input includes cache), model_completed per call", () => {
  const ru = { payload_type: "run.usage", payload: { model: "muse-spark-1.3", model_calls: 4, usage: { input_tokens: 1000, cache_read_tokens: 700, cache_write_tokens: 100, output_tokens: 50, reasoning_tokens: 20 } } };
  assert.deepEqual(usageFromJsonl("noise\n" + JSON.stringify(ru) + "\n"), { usage: [{ model: "muse-spark-1.3", uncached: 200, cached: 700, cacheWrite: 100, output: 50, reasoning: 20, calls: 4 }], tokenSource: "per-task" });
  const call = (n) => ({ payload_type: "runtime.session", payload: { kind: "run", event: { kind: "model_completed", model: "muse-spark-1.3", usage: { input_tokens: n, cached_input_tokens: 10, output_tokens: 5 } } } });
  const r = usageFromJsonl([call(100), call(200), ru].map((x) => JSON.stringify(x)).join("\n"));
  assert.equal(r.tokenSource, "per-call");
  assert.deepEqual(r.usage.map((u) => u.uncached), [90, 190]);
  // camelCase, and an input that does not include the cache
  assert.equal(usageFromJsonl(JSON.stringify({ payload_type: "run.usage", payload: { usage: { inputTokens: 5, cacheReadTokens: 900, outputTokens: 1 } } })).usage[0].uncached, 5);
  assert.deepEqual(usageFromJsonl("{}"), { usage: [], tokenSource: "none" });
});

test("muse usage --json → weekly %, reset, tier; no_allowance says why", () => {
  const out = JSON.stringify({ schemaVersion: 1, allowance: { tier: "Muse Code High Usage", window: { usedPercent: 25, resetsAtMs: 1e7 }, weekly: { usedPercent: 41.5, resetsAtMs: 2e7 }, asOfMs: 999000 }, reason: null });
  assert.deepEqual(readingFromUsage(out), { pct: 41.5, resetsAt: 20000, periodType: "weekly", plan: "Muse Code High Usage" });
  assert.throws(() => readingFromUsage('{"schemaVersion":1,"allowance":null,"reason":"no_allowance"}'), /no Muse Code allowance/);
  assert.throws(() => readingFromUsage("Usage: …"), /not JSON/);
  assert.equal(planFromMeter("Everyday Usage"), "Muse Code Everyday Usage");
});

test("muse: --contributor is required and recorded; plans not on the site use the kit's fees", () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, "run", "--harness", "muse", ...args, "--dry-run"], { encoding: "utf8" });
  assert.match(run(["--plan", "Muse Code Power Usage"]).stderr, /Muse Code needs --contributor on \| off/);
  assert.match(run(["--plan", "Muse Code Power Usage", "--contributor", "maybe"]).stderr, /--contributor on \| off/);
  const ok = run(["--plan", "Muse Code Power Usage", "--contributor", "on"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /fee {8}\$50\/month/);
  assert.match(ok.stdout, /--contributor on/);
  assert.match(ok.stdout, /--contributor-mode on/);
  const plans = spawnSync(process.execPath, [SCRIPT, "plans", "--harness", "muse"], { encoding: "utf8" });
  assert.match(plans.stdout, /Muse Code Maximum Usage\s+\$200/);
});

// ---- unit: Cursor ----

test("cursor command: -p json, sandbox enabled, --trust, --workspace is the task folder", () => {
  const c = ADAPTERS.cursor.command({ dir: "/w/t1", prompt: "P", model: "grok-4.6" });
  assert.equal(c.args[0], "-p");
  assert.equal(c.args[c.args.indexOf("--output-format") + 1], "json");
  assert.equal(c.args[c.args.indexOf("--sandbox") + 1], "enabled");
  assert.equal(c.args[c.args.indexOf("--workspace") + 1], "/w/t1");
  assert.equal(c.args[c.args.indexOf("--model") + 1], "grok-4.6");
  for (const f of ["--trust", "--force"]) assert.ok(c.args.includes(f), f);
  assert.equal(c.args[c.args.length - 1], "P");
  assert.equal(ADAPTERS.cursor.siteModelId("grok-4.6"), "grok-4-6");
});

test("cursor JSON usage: inputTokens uncached, cache read and write separate", () => {
  const out = JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: { inputTokens: 7, outputTokens: 548, cacheReadTokens: 147695, cacheWriteTokens: 39331 } });
  assert.deepEqual(cursorJson(out, "grok-4.6"), [{ model: "grok-4.6", uncached: 7, cached: 147695, cacheWrite: 39331, output: 548, reasoning: 0, calls: 1 }]);
  assert.deepEqual(cursorJson(JSON.stringify({ type: "result", result: "ok" })), []);
});

test("cursor dashboard $ → % of included; bad amounts refused", () => {
  assert.deepEqual(parseDollars("$12.34"), { usd: 12.34 });
  assert.deepEqual(parseDollars("12,5"), { usd: 12.5 });
  assert.deepEqual(parseDollars("skip"), { skip: true });
  for (const s of ["", "abc", "-3", "12%"]) assert.ok(parseDollars(s).error, s);
  assert.equal(pctOfIncluded(30, 400), 7.5);
  assert.equal(pctOfIncluded(450, 400), 112.5); // past the included $ (bonus)
  const run = spawnSync(process.execPath, [SCRIPT, "run", "--harness", "cursor", "--plan", "Cursor Pro", "--dry-run"], { encoding: "utf8" });
  assert.match(run.stderr, /needs --included-usd <number>/);
  const bad = spawnSync(process.execPath, [SCRIPT, "run", "--harness", "cursor", "--plan", "Cursor Ultra (Fast)", "--included-usd", "400", "--dry-run"], { encoding: "utf8" });
  assert.match(bad.stderr, /not a Cursor CLI plan/);
});

// ---- unit: Devin ----

test("devin: starter files inlined in the cloud prompt; ACU input forms", () => {
  const t = TASKS_A.find((x) => Object.keys(x.files).length);
  const p = cloudPrompt(t);
  for (const f of Object.keys(t.files)) assert.ok(p.includes(`--- ${f} ---`), f);
  assert.ok(p.endsWith(t.prompt));
  assert.equal(cloudPrompt({ prompt: "x", files: {} }), "x");
  assert.deepEqual(parseAcus("2.5"), { acus: 2.5, failed: false });
  assert.deepEqual(parseAcus("3 ACUs"), { acus: 3, failed: false });
  assert.deepEqual(parseAcus("fail 1,5"), { acus: 1.5, failed: true });
  assert.deepEqual(parseAcus("stop"), { stop: true });
  assert.ok(parseAcus("lots").error);
  assert.equal(ADAPTERS.devin.meter.windowFor("Devin Pro"), "daily");
  assert.equal(ADAPTERS.devin.meter.windowFor("Devin Max"), "weekly");
});

test("devin --devin-api without DEVIN_API_KEY / DEVIN_ORG_ID fails with what to set", () => {
  const env = { ...process.env };
  delete env.DEVIN_API_KEY;
  delete env.DEVIN_ORG_ID;
  const r = spawnSync(process.execPath, [SCRIPT, "check", "--harness", "devin", "--plan", "Devin Max", "--devin-api"], { encoding: "utf8", env });
  assert.match(r.stdout, /set DEVIN_API_KEY \(cog_…\) and DEVIN_ORG_ID/);
  assert.equal(r.status, 1);
});

// ---- runs: Muse Code ----

test("muse, manual meter: per-task tokens from run.usage, contributor recorded, fee from kit.json", async () => {
  const s = setup("muse-manual", "muse", "muse", 20.3);
  const r = await drive(["run", "--harness", "muse", "--plan", "Muse Code Power Usage", "--contributor", "off", "--bin", s.bin, "--tag", "um", "--every", "2", "--target-pp", "12", ...common], { env: { ...s.env, FAKE_BETA: "0.5" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("um");
  assert.equal(res.inputs.contributor, "off");
  assert.equal(res.planFeeUsd, 50);
  assert.equal(res.planNotOnSite, true);
  assert.match(res.planFeeSource, /not on the site/);
  assert.ok(codes(res).includes("tokens_per_task"));
  assert.ok(!codes(res).includes("model_mismatch"), JSON.stringify(res.flags));
  assert.ok(within(res.fit.usdPerPp.est, 0.5, 0.2), String(res.fit.usdPerPp.est));
  assert.equal(res.subsidy.windowsPerMonth, 4);
  assert.equal(res.subsidy.site, undefined);
  assert.match(r.prompts[0], /muse usage/);
  assertClean(s.resultText("um"), s.root);
});

test("muse, --auto-meter through muse usage --json; per-call records; tier mismatch flagged", async () => {
  const s = setup("muse-auto", "muse", "muse", 20.3);
  const r = await drive(["run", "--harness", "muse", "--plan", "Muse Code Power Usage", "--contributor", "on", "--bin", s.bin, "--tag", "ua", "--auto-meter", "--target-pp", "6", ...common], { env: { ...s.env, FAKE_BETA: "0.5", FAKE_PER_CALL: "1" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.prompts.length, 0, r.prompts.join("\n"));
  const res = s.result("ua");
  assert.equal(res.meter.mode, "auto");
  assert.ok(!codes(res).includes("tokens_per_task"));
  assert.ok(within(res.fit.usdPerPp.est, 0.5, 0.05), String(res.fit.usdPerPp.est));
  assert.equal(res.verdict, "clean", JSON.stringify(res.flags));
  const s2 = setup("muse-tier", "muse", "muse", 30);
  const r2 = await drive(["run", "--harness", "muse", "--plan", "Muse Code Power Usage", "--contributor", "on", "--bin", s2.bin, "--tag", "ut", "--auto-meter", "--target-pp", "3", ...common], { env: { ...s2.env, FAKE_TIER: "Muse Code Everyday Usage" }, meter: s2.meter });
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(codes(s2.result("ut")).includes("plan_mismatch"));
});

test("muse, --auto-meter with no allowance falls back to manual", async () => {
  const s = setup("muse-noallow", "muse", "muse", 20.3);
  const r = await drive(["run", "--harness", "muse", "--plan", "Muse Code Everyday Usage", "--contributor", "on", "--bin", s.bin, "--tag", "un", "--auto-meter", "--every", "2", "--target-pp", "4", ...common], { env: { ...s.env, FAKE_NO_ALLOWANCE: "1" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /auto meter failed: muse usage: no Muse Code allowance on this login; switching to manual/);
  assert.ok(codes(s.result("un")).includes("meter_mode_switched"));
});

// ---- runs: Cursor ----

test("cursor, manual dashboard $: converted to % of --included-usd; on-demand movement flagged", async () => {
  const s = setup("cursor-manual", "cursor", "agent", 10);
  const included = 400;
  const dollars = (used) => ((Math.floor(used * 100) / 100) * included) / 100; // dashboard shows cents
  const r = await drive(["run", "--harness", "cursor", "--plan", "Cursor Pro+", "--included-usd", String(included), "--bin", s.bin, "--tag", "cm", "--every", "2", "--target-pp", "4", ...common], {
    env: { ...s.env, FAKE_BETA: "0.5" },
    meter: s.meter,
    answer: (used, line) => (/on-demand/.test(line) ? "0" : `$${dollars(used).toFixed(2)}`),
  });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("cm");
  assert.equal(res.inputs["included-usd"], 400);
  assert.equal(res.meter.window, "monthly");
  assert.equal(res.meter.windowsPerMonth, 1);
  assert.ok(res.fit.usable, JSON.stringify(res.fit));
  assert.ok(within(res.fit.usdPerPp.est, 0.5, 0.2), String(res.fit.usdPerPp.est));
  assert.equal(res.planFeeUsd, 60);
  assert.ok(res.subsidy.site?.value > 0, "site multiple for Cursor Pro+ on grok-4-6");
  assert.ok(!codes(res).includes("on_demand"));
  assert.ok(r.prompts.some((p) => /included usage \$ used: $/.test(p)));
  assertClean(s.resultText("cm"), s.root);

  const s2 = setup("cursor-od", "cursor", "agent", 10);
  let od = 0;
  const r2 = await drive(["run", "--harness", "cursor", "--plan", "Cursor Pro", "--included-usd", "100", "--bin", s2.bin, "--tag", "co", "--every", "2", "--target-pp", "4", ...common], {
    env: { ...s2.env, FAKE_BETA: "2" },
    meter: s2.meter,
    answer: (used, line) => (/on-demand/.test(line) ? String((od += 1.5)) : String(Math.floor(used))),
  });
  assert.equal(r2.code, 0, r2.stderr + r2.stdout);
  assert.ok(codes(s2.result("co")).includes("on_demand"));
});

// ---- runs: Devin ----

test("devin, paste mode: prompts printed, ACUs typed per task, ACU/pp fitted, $ at --acu-usd, no API-$ subsidy", async () => {
  const s = setup("devin-paste", null, null, 12);
  const acuPerPp = 2;
  const r = await drive(["run", "--harness", "devin", "--plan", "Devin Max", "--acu-usd", "2.25", "--tag", "dp", "--every", "2", "--target-pp", "10", ...common], {
    env: s.env,
    meter: s.meter,
    answer: (used, line, n) => {
      if (!/ACUs used/.test(line)) return String(Math.floor(used));
      const acus = 1 + ((n * 7) % 5) * 0.5;
      const st = JSON.parse(fs.readFileSync(s.meter, "utf8"));
      st.used += acus / acuPerPp;
      fs.writeFileSync(s.meter, JSON.stringify(st));
      return String(acus);
    },
  });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /==== task r1-\S+: paste everything between the lines into a new Devin session ====/);
  const res = s.result("dp");
  assert.equal(res.costUnit, "acu");
  assert.equal(res.subsidy, null);
  assert.equal(res.meter.window, "weekly");
  assert.ok(res.acu.total > 0 && res.acu.perTask > 0);
  assert.ok(within(res.acu.perPp.est, acuPerPp, 0.25), JSON.stringify(res.acu));
  assert.ok(Math.abs(res.acu.monthlyAcus.est - 100 * res.acu.perPp.est * 4) < 1e-3);
  assert.ok(Math.abs(res.acu.monthlyUsd.est - 2.25 * res.acu.monthlyAcus.est) < 1e-3);
  assert.equal(res.workload.note, "cloud sessions: starter files inlined in the prompt");
  assert.ok(!codes(res).includes("no_calls"));
  assertClean(s.resultText("dp"), s.root);
});

test("devin, --devin-api against a fake API: sessions started, acus_consumed read; the key never printed or written", async () => {
  const s = setup("devin-api", null, null, 5);
  const sessions = new Map();
  let seq = 0;
  let badAuth = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        badAuth++;
        res.writeHead(401).end('{"detail":"bad key"}');
        return;
      }
      const send = (o) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(o));
      const base = "/v3/organizations/org-test/sessions";
      if (req.method === "POST" && req.url === base) {
        const j = JSON.parse(body);
        assert.ok(j.prompt.length > 20 && j.tags.includes("harness-quota"));
        const id = `devin-${++seq}`;
        sessions.set(id, { polls: 0, acus: 1 + (seq % 4) * 0.75 });
        return send({ session_id: id, url: "https://app.devin.ai/sessions/x", status: "new", acus_consumed: 0, org_id: "org-test", tags: [], created_at: 0, updated_at: 0, pull_requests: [] });
      }
      const m = req.method === "GET" && req.url.startsWith(base + "/") ? sessions.get(decodeURIComponent(req.url.slice(base.length + 1))) : null;
      if (!m) return res.writeHead(404).end("{}");
      m.polls++;
      if (m.polls < 2) return send({ status: "running", status_detail: "working", acus_consumed: m.acus / 2 });
      if (m.polls === 2) {
        const st = JSON.parse(fs.readFileSync(s.meter, "utf8"));
        st.used += m.acus / 2;
        fs.writeFileSync(s.meter, JSON.stringify(st));
      }
      send({ status: "suspended", status_detail: "finished", acus_consumed: m.acus });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); // free random port, this process only
  const { port } = server.address();
  try {
    const env = { ...s.env, DEVIN_API_KEY: API_KEY, DEVIN_ORG_ID: "org-test", DEVIN_API_BASE: `http://127.0.0.1:${port}`, DEVIN_POLL_S: "0.01" };
    const r = await drive(["run", "--harness", "devin", "--plan", "Devin Pro", "--devin-api", "--tag", "da", "--every", "2", "--target-pp", "12", ...common], { env, meter: s.meter });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(badAuth, 0);
    assert.ok(!r.stdout.includes(API_KEY) && !r.stderr.includes(API_KEY), "key printed");
    assert.ok(!r.stdout.includes("paste everything"), "paste prompt in API mode");
    const res = s.result("da");
    assert.equal(res.meter.window, "daily");
    assert.equal(res.meter.windowsPerMonth, 30);
    assert.ok(res.acu.tasksWithAcus === res.run.tasks && res.run.tasks > 0);
    assert.ok(within(res.acu.perPp.est, 2, 0.25), JSON.stringify(res.acu));
    assert.equal(res.acu.usdPerAcu, null);
    assertClean(s.resultText("da"), s.root);
    assert.ok(!s.manifestText("da").includes(API_KEY), "key in the manifest");
    for (const f of fs.readdirSync(path.join(s.scratch, "results", "runs", "da", "logs"))) assert.ok(!fs.readFileSync(path.join(s.scratch, "results", "runs", "da", "logs", f), "utf8").includes(API_KEY));

    // a rejected key: the error is reported without the key
    const s2 = setup("devin-badkey", null, null, 5);
    const r2 = await drive(["run", "--harness", "devin", "--plan", "Devin Max", "--devin-api", "--tag", "db", ...common], { env: { ...s2.env, ...env, FAKE_METER: s2.meter, HARNESS_QUOTA_SCRATCH: s2.scratch, DEVIN_API_KEY: "cog_WRONGKEY0123456789" }, meter: s2.meter });
    assert.equal(r2.code, 0, r2.stderr + r2.stdout);
    assert.match(r2.stdout, /HTTP 401/);
    assert.ok(!r2.stdout.includes("cog_WRONGKEY"), "rejected key printed");
    assert.equal(s2.result("db").run.stopReason, "first task made no calls");
  } finally {
    server.close();
  }
});
