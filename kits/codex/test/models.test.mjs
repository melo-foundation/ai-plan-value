// node --test kits/codex/test/*.test.mjs
// Model selection: --model passthrough, per-model prices, model taken from the manifest.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as RF from "../scripts/rollout-fit.mjs";
import { DEFAULT_MODEL, expectedFrom, priceFor, pricesFromSite, siteRefFor, fiveHourPause } from "../scripts/codex-quota.mjs";
import { simulateRun, PRICES, ASTRA_PRICE } from "./sim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "codex-quota.mjs");
const FAKE = path.join(here, "fake-codex.mjs");
const REAL_PRICES = JSON.parse(fs.readFileSync(path.join(here, "..", "prices.json"), "utf8"));
const parseSim = (sim) => sim.sessions.map((s) => RF.parseRolloutText(s.text, s.name));
const codes = (r) => r.flags.map((f) => f.code);
const within = (x, truth, rel) => Math.abs(x - truth) / truth <= rel;
const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 });
const execLines = (out) => out.split("\n").filter((l) => / exec /.test(l));

test("dry run passes --model to every codex exec as -m; default gpt-6.2-sol", () => {
  for (const [args, model] of [[["--model", "gpt-6.2-astra"], "gpt-6.2-astra"], [["--model", "gpt-6.1-sol"], "gpt-6.1-sol"], [[], DEFAULT_MODEL]]) {
    const r = cli(["run", "--arm", "A", "--tag", "dry-model-test", "--dry-run", ...args]);
    assert.equal(r.status, 0, r.stderr);
    const lines = execLines(r.stdout);
    assert.ok(lines.length >= 4, r.stdout);
    for (const l of lines) assert.ok(l.includes(` -m ${model} `), l);
    assert.ok(r.stdout.includes(`model ${model}`));
    const p = REAL_PRICES.models[model];
    assert.ok(r.stdout.includes(`${model} $${p.input} / $${p.cachedInput} / $${p.output} per 1M`), r.stdout);
  }
  assert.equal(DEFAULT_MODEL, "gpt-6.2-sol");
});

test("dry run fails with a clear error for a model with no price", () => {
  const r = cli(["run", "--arm", "A", "--model", "gpt-0-nothing", "--dry-run"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no price for gpt-0-nothing in prices\.json/);
  assert.match(r.stderr, /codex-quota\.mjs prices --models /);
});

test("prices.json holds per-model prices and site Plus multiples for the three models", () => {
  assert.deepEqual(priceFor(REAL_PRICES, "gpt-6.2-sol"), { ...REAL_PRICES.models["gpt-6.2-sol"] });
  assert.equal(REAL_PRICES.models["gpt-6.2-astra"].input, 8);
  assert.equal(REAL_PRICES.models["gpt-6.2-astra"].cachedInput, 0.4);
  assert.equal(REAL_PRICES.models["gpt-6.2-astra"].output, 40);
  assert.equal(REAL_PRICES.models["gpt-6.1-sol"].input, 2);
  for (const m of ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.2-astra"]) assert.match(REAL_PRICES.models[m].asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(within(siteRefFor(REAL_PRICES, "gpt-6.1-sol").subsidy, 14.93, 0.001));
  assert.ok(within(siteRefFor(REAL_PRICES, "gpt-6.2-astra").subsidy, 6.26, 0.001));
  assert.equal(siteRefFor(REAL_PRICES, "gpt-0-nothing"), null);
  assert.throws(() => priceFor(REAL_PRICES, "gpt-0-nothing"), /no price for gpt-0-nothing/);
});

test("pricesFromSite reads aaPricing and the Plus row per model and dates them; fails on a model with no price", () => {
  const aa = (i, c, o) => ({ inputPer1M: i, cacheHitPer1M: c, outputPer1M: o });
  const site = {
    generatedAt: "2026-11-26T08:28:17.753Z",
    sources: { artificialAnalysis: { fetchedAt: "2026-11-25T07:00:00.000Z" } },
    stats: { chains: { cA: { lines: ["= GPT-6 Astra (same pool, rate card)"] } } },
    entries: [
      { id: "x::pro::gpt-6-2-astra@low", plan: "ChatGPT Pro 20x", baseModelId: "gpt-6-2-astra", aaPricing: aa(8, 0.4, 40), subsidyMultiple: 30 },
      { id: "p::chatgpt-plus::gpt-6-2-astra@low", plan: "ChatGPT Plus", baseModelId: "gpt-6-2-astra", aaPricing: aa(8, 0.4, 40), subsidyMultiple: 6.2646, rel: { chain: "cA", level: "medium", s: 0.364 }, dataDate: "2026-11-17" },
      { id: "chatgpt_plus::gpt-6.1-sol@low", plan: "ChatGPT Plus", baseModelId: "gpt-6-1-sol", aaPricing: aa(2, 0.1, 10), subsidyMultiple: 14.9326 },
      { id: "chatgpt_plus::gpt-6.2-sol@low", plan: "ChatGPT Plus", baseModelId: "gpt-6-2-sol", aaPricing: { inputPer1M: 2, outputPer1M: 10 }, subsidyMultiple: 14.9326 },
    ],
  };
  const p = pricesFromSite(site, ["gpt-6.2-astra", "gpt-6.1-sol"]);
  assert.equal(p.asOf, "2026-11-25");
  assert.deepEqual(p.models["gpt-6.2-astra"], { input: 8, cachedInput: 0.4, output: 40, asOf: "2026-11-25", baseModelId: "gpt-6-2-astra" });
  assert.deepEqual(p.models["gpt-6.1-sol"], { input: 2, cachedInput: 0.1, output: 10, asOf: "2026-11-25", baseModelId: "gpt-6-1-sol" });
  assert.equal(p.site["gpt-6.2-astra"].subsidy, 6.2646, "Plus row, not the Pro row");
  assert.equal(p.site["gpt-6.2-astra"].id, "p::chatgpt-plus::gpt-6-2-astra");
  assert.deepEqual(p.site["gpt-6.2-astra"].chain, ["= GPT-6 Astra (same pool, rate card)"]);
  assert.throws(() => pricesFromSite(site, ["gpt-6.2-astra", "gpt-6.2-sol"]), /no aaPricing .* gpt-6\.2-sol \(baseModelId gpt-6-2-sol\)/, "row without cacheHitPer1M has no price");
  assert.throws(() => pricesFromSite(site, ["gpt-9"]), /gpt-9/);
});

test("calls are priced at their own model's rate", () => {
  const usage = { input: 40000, cached: 30000, cacheWrite: 0, output: 1000, reasoning: 400, total: 41000 };
  const ev = (model, ts) => ({ kind: "call", ts, ord: ts, usage, includesReasoning: true, model, effort: "medium", rate: null });
  const priced = RF.priceTimeline([ev("gpt-6.2-sol", 1), ev("gpt-6.2-astra", 2)], PRICES.models, "gpt-6.2-sol");
  const sol = (10000 * 2 + 30000 * 0.1 + 1000 * 10) / 1e6;
  assert.ok(Math.abs(priced[0].usd - sol) < 1e-12);
  assert.ok(Math.abs(priced[1].usd - 4 * sol) < 1e-12);
});

test("Astra run: $/pp recovered at Astra prices, compared with the Astra site multiple", () => {
  const beta = (6.2646 * 20) / 400; // $0.31323 per weekly pp
  const sim = simulateRun({ seed: 8, model: "gpt-6.2-astra", price: ASTRA_PRICE, calls: 120, sessions: 20, beta: { "5h": 0.05, weekly: beta } });
  const r = RF.analyse({ sessions: parseSim(sim), prices: PRICES, expected: { model: "gpt-6.2-astra", effort: "medium" }, site: siteRefFor(REAL_PRICES, "gpt-6.2-astra") });
  assert.ok(!codes(r).includes("model_mismatch"));
  assert.equal(r.prices.model, "gpt-6.2-astra");
  assert.equal(r.prices.input, 8);
  assert.ok(within(r.windows.weekly.usdPerPp.est, beta, 0.03), String(r.windows.weekly.usdPerPp.est));
  assert.ok(within(r.subsidy.site.ratio, 1, 0.03), String(r.subsidy.site.ratio));
  assert.match(r.subsidy.site.source, /gpt-6-2-astra/);
});

test("analyse takes the expected model from the manifest and flags rollouts on another model", () => {
  assert.deepEqual(expectedFrom({}, { model: "gpt-6.2-astra", effort: "medium" }), { model: "gpt-6.2-astra", effort: "medium" });
  assert.deepEqual(expectedFrom({ model: "gpt-6.1-sol" }, { model: "gpt-6.2-astra" }), { model: "gpt-6.1-sol", effort: null });
  assert.deepEqual(expectedFrom({}, null), { model: "gpt-6.2-sol", effort: null });
  const manifest = { tag: "t", arm: "A", model: "gpt-6.2-astra", effort: "medium", idle: [] };
  const sim = simulateRun({ seed: 12, model: "gpt-6.2-sol", calls: 120, sessions: 20 });
  const r = RF.analyse({ sessions: parseSim(sim), prices: PRICES, manifest, expected: expectedFrom({}, manifest) });
  const f = r.flags.find((x) => x.code === "model_mismatch");
  assert.ok(f, JSON.stringify(r.flags));
  assert.match(f.detail, /120 of 120 calls not on gpt-6\.2-astra: gpt-6\.2-sol/);
  assert.equal(r.verdict, "contaminated");
  const ok = RF.analyse({ sessions: parseSim(sim), prices: PRICES, manifest: { ...manifest, model: "gpt-6.2-sol" }, expected: expectedFrom({}, { ...manifest, model: "gpt-6.2-sol" }) });
  assert.ok(!codes(ok).includes("model_mismatch"));
});

test("5h pause keeps room for the largest task", () => {
  assert.equal(fiveHourPause({ pct: 94 }, 1), false);
  assert.equal(fiveHourPause({ pct: 95 }, 0), true);
  assert.equal(fiveHourPause({ pct: 87 }, 12), false);
  assert.equal(fiveHourPause({ pct: 88 }, 12), true);
  assert.equal(fiveHourPause(null, 50), false);
  assert.equal(fiveHourPause({ pct: 10 }, 0, "primary"), true);
});

// Full `run` against fake-codex.mjs: no real codex, no network; everything under a temp dir.
function fakeRun({ model, tag, targetPp, env = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-run-"));
  const home = path.join(tmp, "codex-home");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const r = cli(["run", "--arm", "A", "--model", model, "--tag", tag, "--target-pp", String(targetPp), "--codex", FAKE, "--idle-min", "0", "--settle-min", "0", "--force"], {
    CODEX_HOME: home,
    CODEX_QUOTA_SCRATCH: path.join(tmp, "scratch"),
    ...env,
  });
  const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
  const out = { r, tmp, manifest: read(path.join(tmp, "scratch", "runs", tag, "manifest.json")), result: read(path.join(tmp, "scratch", "results", `${tag}.json`)) };
  return out;
}

test("run with --model gpt-6.2-astra stops on the meter at the target, not on Sol's $/pp", () => {
  // Astra prices; meter at the site's Astra multiple: each task moves weekly ≈ 1.2 pp (Sol: ≈ 0.1)
  const betaWk = (6.2646 * 20) / 400;
  const { r, tmp, manifest, result } = fakeRun({
    model: "gpt-6.2-astra",
    tag: "astra-e2e",
    targetPp: 12,
    env: { FAKE_CODEX_PRICE: JSON.stringify(ASTRA_PRICE), FAKE_CODEX_BETA: JSON.stringify({ "5h": 0.06, weekly: betaWk }), FAKE_CODEX_CALLS: "4" },
  });
  try {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(manifest.model, "gpt-6.2-astra");
    assert.equal(manifest.stopReason, "target reached");
    const n = manifest.tasks.length;
    assert.ok(n >= 9 && n <= 12, `${n} tasks`);
    const usdPerTask = manifest.tasks.reduce((s, t) => s + t.usd, 0) / n;
    assert.ok(usdPerTask > 0.3 && usdPerTask < 0.45, `task $ ${usdPerTask} (Astra prices)`);
    const wk = result.windows.weekly;
    const moved = wk.lastReading - wk.firstReading;
    assert.ok(moved >= 12 && moved <= 12 + 3, `moved ${moved} pp`);
    assert.equal(result.model, "gpt-6.2-astra");
    assert.ok(!codes(result).includes("model_mismatch"));
    assert.ok(within(wk.usdPerPp.est, betaWk, 0.05), String(wk.usdPerPp.est));
    assert.ok(within(result.subsidy.site.ratio, 1, 0.05), String(result.subsidy.site.ratio));
    assert.ok(r.stdout.includes("site gpt-6.2-astra Plus 6.26×"), r.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("run flags model_mismatch when the rollouts are not on the manifest's model", () => {
  const { r, tmp, manifest, result } = fakeRun({ model: "gpt-6.2-astra", tag: "mismatch-e2e", targetPp: 3, env: { FAKE_CODEX_MODEL: "gpt-6.1-sol", FAKE_CODEX_BETA: JSON.stringify({ "5h": 0.03, weekly: 0.15 }) } });
  try {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(manifest.model, "gpt-6.2-astra");
    assert.ok(codes(result).includes("model_mismatch"), JSON.stringify(result.flags));
    assert.equal(result.verdict, "contaminated");
    assert.deepEqual(Object.keys(result.models), ["gpt-6.1-sol"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
