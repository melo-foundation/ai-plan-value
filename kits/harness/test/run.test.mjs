// node --test kits/harness/test/*.test.mjs
// End-to-end runs against fake Gemini CLI and Grok Build binaries: manual and automatic meters,
// fallback to manual, token sources, flags, and no secrets / prompts / paths in the result.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TASKS_A } from "../../codex/workload/tasks.mjs";
import { drive, fakeGeminiInstall, fakeGrokInstall, tmpdir } from "./helpers.mjs";

const codes = (r) => r.flags.map((f) => f.code);
const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;

function setup(name, harness, meterStart) {
  const root = tmpdir(name);
  const bin = harness === "gemini" ? fakeGeminiInstall(root) : fakeGrokInstall(root);
  const meter = path.join(root, "meter.json");
  fs.writeFileSync(meter, JSON.stringify({ used: meterStart, n: 0 }));
  const scratch = path.join(root, "scratch");
  const env = { HARNESS_QUOTA_SCRATCH: scratch, FAKE_METER: meter };
  const result = (tag) => JSON.parse(fs.readFileSync(path.join(scratch, "results", `${tag}.json`), "utf8"));
  const resultText = (tag) => fs.readFileSync(path.join(scratch, "results", `${tag}.json`), "utf8");
  return { root, bin, meter, env, scratch, result, resultText };
}

const common = ["--idle-min", "0", "--force"];

function assertClean(text, root) {
  for (const t of TASKS_A) assert.ok(!text.includes(t.prompt.slice(0, 40)), `prompt of ${t.id} in result`);
  assert.ok(!text.includes(root), "temp root path in result");
  assert.ok(!text.includes(process.env.HOME), "home path in result");
  assert.ok(!/Bearer|ya29\.|SECRET|00000000-0000-4000-8000-000000000001/.test(text), "secret or session id in result");
}

test("grok, manual meter every 2 tasks: β recovered, clean, no prompts or paths in the result", async () => {
  const s = setup("grok-manual", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "gm", "--every", "2", "--max-pct", "12", ...common], { env: { ...s.env, FAKE_BETA: "0.5" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("gm");
  assert.equal(res.meter.mode, "manual");
  assert.equal(res.fit.usable, true, JSON.stringify(res.fit));
  assert.ok(within(res.fit.usdPerPp.est, 0.5, 0.2), String(res.fit.usdPerPp.est));
  assert.ok(res.fit.usdPerPp.ci95[0] <= 0.5 && 0.5 <= res.fit.usdPerPp.ci95[1], JSON.stringify(res.fit.usdPerPp));
  assert.ok(!codes(res).includes("model_mismatch"));
  assert.ok(!codes(res).includes("meter_moved_idle"));
  assert.equal(res.planFeeUsd, 30);
  assert.ok(res.subsidy.site.value > 0);
  assert.ok(r.prompts.length >= 6, `${r.prompts.length} prompts`);
  assert.match(r.prompts[0], /idle check before, start/);
  // every task wrote inside its own folder
  const work = path.join(s.scratch, "work", "gm");
  assert.ok(fs.readdirSync(work).every((d) => fs.existsSync(path.join(work, d, "done.txt"))));
  assertClean(s.resultText("gm"), s.root);
});

test("grok, --auto-meter through grok agent stdio: reading after every task, plan detected", async () => {
  const s = setup("grok-auto", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "ga", "--auto-meter", "--max-pct", "6", ...common], { env: { ...s.env, FAKE_BETA: "0.5" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.prompts.length, 0, r.prompts.join("\n"));
  const res = s.result("ga");
  assert.equal(res.meter.mode, "auto");
  assert.ok(within(res.fit.usdPerPp.est, 0.5, 0.1) && res.fit.usdPerPp.ci95[0] <= 0.5 && 0.5 <= res.fit.usdPerPp.ci95[1], JSON.stringify(res.fit.usdPerPp));
  assert.equal(res.verdict, "clean", JSON.stringify(res.flags));
  assertClean(s.resultText("ga"), s.root);
});

test("grok, --auto-meter: unprefixed x.ai/billing fallback; tier mismatch flags plan_mismatch", async () => {
  const s = setup("grok-tier", "grok", 30);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "gt", "--auto-meter", "--max-pct", "3", ...common], { env: { ...s.env, FAKE_BILLING_METHOD: "x.ai/billing", FAKE_TIER: "SuperGrok Heavy" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.prompts.length, 0);
  assert.ok(codes(s.result("gt")).includes("plan_mismatch"));
});

test("grok, --auto-meter failure falls back to manual with a clear message", async () => {
  const s = setup("grok-fallback", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "gf", "--auto-meter", "--every", "2", "--max-pct", "4", ...common], { env: { ...s.env, FAKE_BILLING_FAIL: "1" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /auto meter failed: x\.ai\/billing: Billing data requires auth.*switching to manual/);
  assert.ok(r.prompts.length >= 3);
  const res = s.result("gf");
  assert.equal(res.meter.mode, "manual");
  assert.equal(res.meter.requested, "auto");
  assert.ok(codes(res).includes("meter_mode_switched"));
  assert.ok(res.readings.every((x) => x.mode === "manual"));
});

test("grok: recorded model ≠ --model flags model_mismatch", async () => {
  const s = setup("grok-model", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "gx", "--auto-meter", "--max-pct", "3", ...common], { env: { ...s.env, FAKE_MODEL: "grok-4.6" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("gx");
  assert.ok(codes(res).includes("model_mismatch"));
  assert.equal(res.verdict, "contaminated");
});

test("manual input: bad values are refused and asked again; '% left' accepted", async () => {
  const s = setup("grok-input", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "gi", "--every", "3", "--max-pct", "3", ...common], {
    env: s.env,
    meter: s.meter,
    answer: (used, line, n) => (n === 1 ? "abc" : n === 2 ? "140" : n === 3 ? `${100 - Math.floor(used)}% left` : String(Math.floor(used))),
  });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /not a percentage/);
  assert.match(r.stdout, /140 is outside 0–100/);
  const res = s.result("gi");
  assert.equal(res.readings[0].pct, 20);
});

test("manual: 'stop' at the first reading ends the run without tasks", async () => {
  const s = setup("grok-stop", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "gs", ...common], { env: s.env, meter: s.meter, answer: () => "stop" });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("gs");
  assert.equal(res.run.tasks, 0);
  assert.ok(codes(res).includes("no_calls"));
});

test("gemini, manual meter: per-call tokens from the telemetry file; daily × 30 note", async () => {
  const s = setup("gemini-manual", "gemini", 3.2);
  const r = await drive(["run", "--harness", "gemini", "--plan", "Google AI Pro", "--bin", s.bin, "--tag", "mm", "--every", "2", "--max-pct", "15", "--gemini-sandbox", "sandbox-exec", ...common], { env: { ...s.env, FAKE_BETA: "0.05" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("mm");
  assert.ok(!codes(res).includes("tokens_per_task"), JSON.stringify(res.flags));
  assert.equal(res.meter.window, "daily");
  assert.equal(res.meter.windowsPerMonth, 30);
  assert.match(res.meter.note, /× 30/);
  assert.match(res.subsidy.definition, /daily \$\/pp × 30/);
  assert.ok(within(res.fit.usdPerPp.est, 0.05, 0.2), String(res.fit.usdPerPp.est));
  assert.equal(res.planFeeUsd, 19.99);
  assertClean(s.resultText("mm"), s.root);
});

test("gemini: no telemetry file → tokens from --output-format json stats, flagged per task", async () => {
  const s = setup("gemini-json", "gemini", 3.2);
  const r = await drive(["run", "--harness", "gemini", "--plan", "Google AI Pro", "--bin", s.bin, "--tag", "mj", "--every", "2", "--max-pct", "8", "--gemini-sandbox", "docker", ...common], { env: { ...s.env, FAKE_NO_TELEMETRY: "1" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("mj");
  assert.ok(codes(res).includes("tokens_per_task"));
  assert.ok(res.run.calls > 0);
});

test("gemini, --auto-meter through the installed CLI's core package (quota probe)", async () => {
  const s = setup("gemini-auto", "gemini", 3.2);
  const r = await drive(["run", "--harness", "gemini", "--plan", "Google AI Pro", "--bin", s.bin, "--tag", "ma", "--auto-meter", "--max-pct", "10", "--gemini-sandbox", "sandbox-exec", ...common], { env: { ...s.env, FAKE_BETA: "0.05" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.prompts.length, 0, r.stdout);
  const res = s.result("ma");
  assert.equal(res.meter.mode, "auto");
  assert.ok(within(res.fit.usdPerPp.est, 0.05, 0.1) && res.fit.usdPerPp.ci95[0] <= 0.05 && 0.05 <= res.fit.usdPerPp.ci95[1], JSON.stringify(res.fit.usdPerPp));
  assert.equal(res.verdict, "clean", JSON.stringify(res.flags));
});

test("gemini, --auto-meter with no usable login falls back to manual; the error's token never reaches the result", async () => {
  const s = setup("gemini-noauth", "gemini", 3.2);
  const r = await drive(["run", "--harness", "gemini", "--plan", "Google AI Pro", "--bin", s.bin, "--tag", "mn", "--auto-meter", "--every", "2", "--max-pct", "6", "--gemini-sandbox", "sandbox-exec", ...common], { env: { ...s.env, FAKE_AUTH_FAIL: "1" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /auto meter failed: login not usable.*switching to manual/);
  assert.ok(!r.stdout.includes("ya29.SECRET"), "token-like text printed");
  assert.ok(r.prompts.length >= 3);
  assertClean(s.resultText("mn"), s.root);
  const manifest = fs.readFileSync(path.join(s.scratch, "results", "runs", "mn", "manifest.json"), "utf8");
  assert.ok(!manifest.includes("ya29."), "token-like text in the manifest");
});

test("analyse --run re-reads the manifest and writes the same fit", async () => {
  const s = setup("grok-analyse", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "gr", "--auto-meter", "--max-pct", "3", ...common], { env: s.env, meter: s.meter });
  assert.equal(r.code, 0, r.stderr);
  const before = s.result("gr");
  const r2 = await drive(["analyse", "--run", "gr"], { env: s.env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(s.result("gr").fit.usdPerPp.est, before.fit.usdPerPp.est);
});

// ---- stopping rule: ±10% precision or the +5 pp cap (lib/stop.mjs) ----

test("run, decimal automatic meter: stops at ±10% under 5 pp, no low_precision", async () => {
  const s = setup("stop-auto", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "sa", "--auto-meter", ...common], { env: { ...s.env, FAKE_BETA: "0.5" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("sa");
  assert.equal(res.run.stopReason, "precision reached");
  assert.equal(res.precision.reached, true);
  assert.ok(res.precision.halfWidthAtStop <= 0.1);
  assert.ok(res.precision.usedPp < 5, String(res.precision.usedPp));
  assert.ok(!codes(res).includes("low_precision"));
  assert.match(r.stdout, /stop {5}±10% of the estimate with 3\+ meter steps, or \+5 pp of the weekly meter · ceiling 85%/);
});

test("run, whole-% manual meter every 5 tasks of ~0.4 pp: stops at the 5 pp cap with low_precision, then asks only the closing idle reading", async () => {
  const s = setup("stop-cap", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "sc", ...common], { env: { ...s.env, FAKE_BETA: "0.5" }, meter: s.meter });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("sc");
  assert.equal(res.run.stopReason, "+5 pp cap reached");
  assert.equal(res.precision.reached, false);
  assert.ok(codes(res).includes("low_precision"), JSON.stringify(res.flags));
  assert.match(r.stdout, /low precision: (±[\d.]+%|no 95% interval) at the stop; target ±10%/);
  assert.ok(res.precision.usedPp >= 5 && res.precision.usedPp < 7, String(res.precision.usedPp));
  // after the reading that stopped the run: no task, one closing idle reading, nothing more
  const stopAt = r.prompts.findLastIndex((p) => /reading after task/.test(p));
  assert.deepEqual(r.prompts.slice(stopAt + 1).map((p) => p.replace(/ ·.*/, "")), ["idle check after, end"]);
  const stopTasks = Number(/reading after task (\d+)/.exec(r.prompts[stopAt])[1]);
  assert.equal(res.run.tasks, stopTasks);
});

test("run, whole-% manual meter read after every small task: ±10% reached, manual prompts stop", async () => {
  const s = setup("stop-manual-ok", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "so", "--every", "1", ...common], { env: { ...s.env, FAKE_BETA: "4" }, meter: s.meter, timeoutMs: 300000 });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("so");
  assert.equal(res.run.stopReason, "precision reached", JSON.stringify(res.precision));
  assert.ok(!codes(res).includes("low_precision"));
  assert.ok(res.precision.usedPp <= 5);
  const stopAt = r.prompts.findLastIndex((p) => /reading after task/.test(p));
  assert.equal(r.prompts.length, stopAt + 2, "one closing idle reading after the stop");
  assert.equal(res.run.tasks, Number(/reading after task (\d+)/.exec(r.prompts[stopAt])[1]));
});

test("run, very coarse manual meter (5 pp steps): cap with low_precision", async () => {
  const s = setup("stop-coarse", "grok", 20.3);
  const r = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "sv", ...common], { env: { ...s.env, FAKE_BETA: "0.5" }, meter: s.meter, answer: (used) => String(Math.floor(used / 5) * 5) });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const res = s.result("sv");
  assert.match(res.run.stopReason, /cap reached/);
  assert.ok(codes(res).includes("low_precision"));
});

test("run: --target-pp is refused; meter too close to the ceiling for +5 pp is refused", async () => {
  const s = setup("stop-opts", "grok", 82);
  const old = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "st", "--target-pp", "10", ...common], { env: s.env, meter: s.meter });
  assert.equal(old.code, 1);
  assert.match(old.stderr, /--target-pp is gone/);
  const bad = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "sp", "--precision", "10", ...common], { env: s.env, meter: s.meter });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--precision: a fraction/);
  const high = await drive(["run", "--harness", "grok", "--plan", "SuperGrok", "--bin", s.bin, "--tag", "sh", "--auto-meter", ...common], { env: s.env, meter: s.meter });
  assert.equal(high.code, 1);
  assert.match(high.stderr, /meter at 82%: \+5 pp would pass 85%; run after the weekly reset or pass a smaller --max-pct/);
});
