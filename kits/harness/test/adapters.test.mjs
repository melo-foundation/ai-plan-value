// node --test kits/harness/test/*.test.mjs
// Adapter parsers, headless commands with sandbox flags, kit.json, and secret scrubbing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../scripts/adapters/index.mjs";
import { readingFromBuckets, usageFromJson as geminiJson, usageFromTelemetry } from "../scripts/adapters/gemini.mjs";
import { readingFromBilling, usageFromJson as grokJson } from "../scripts/adapters/grok.mjs";
import { scrub, secretHits } from "../scripts/lib/analyse.mjs";
import { feeFor, loadSite, priceFor } from "../scripts/lib/site.mjs";
import { redact, splitJsonStream } from "../scripts/lib/util.mjs";
import { SCRIPT } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIT = JSON.parse(fs.readFileSync(path.join(here, "..", "kit.json"), "utf8"));

test("splitJsonStream: pretty-printed records back to back and JSONL", () => {
  const text = JSON.stringify({ a: { b: "}" } }, null, 2) + "\n" + JSON.stringify({ c: [1, 2] }) + "\n{bad\n";
  const r = splitJsonStream(text);
  assert.deepEqual(r.values, [{ a: { b: "}" } }, { c: [1, 2] }]);
});

test("gemini telemetry: input includes cached; thoughts priced as output; tool tokens as input", () => {
  const rec = { attributes: { "event.name": "gemini_cli.api_response", model: "gemini-3.8-flash", input_token_count: 1000, cached_content_token_count: 600, output_token_count: 50, thoughts_token_count: 30, tool_token_count: 10 } };
  const other = { attributes: { "event.name": "gemini_cli.api_request", model: "x" } };
  const u = usageFromTelemetry(JSON.stringify(other, null, 2) + "\n" + JSON.stringify(rec, null, 2) + "\n");
  assert.deepEqual(u, [{ model: "gemini-3.8-flash", uncached: 410, cached: 600, cacheWrite: 0, output: 80, reasoning: 30, calls: 1 }]);
});

test("gemini JSON stats: per model, totalRequests as calls", () => {
  const out = JSON.stringify({ response: "x", stats: { models: { "gemini-3.8-flash": { api: { totalRequests: 7 }, tokens: { prompt: 900, cached: 300, candidates: 40, thoughts: 20, tool: 0 } } } } }, null, 2);
  assert.deepEqual(geminiJson(out), [{ model: "gemini-3.8-flash", uncached: 600, cached: 300, cacheWrite: 0, output: 60, reasoning: 20, calls: 7 }]);
});

test("gemini quota bucket → % used, reset time, model match by id", () => {
  const r = readingFromBuckets([{ modelId: "gemini-3.1-flash-lite", remainingFraction: 1 }, { modelId: "gemini-3.8-flash", remainingFraction: 0.874, resetTime: "2026-11-29T08:00:00Z", tokenType: "REQUESTS" }], "gemini-3.8-flash");
  assert.equal(r.pct, 12.6);
  assert.equal(r.resetsAt, Date.parse("2026-11-29T08:00:00Z") / 1000);
  assert.throws(() => readingFromBuckets([{ modelId: "other", remainingFraction: 1 }], "gemini-3.8-flash"), /no quota bucket for gemini-3.8-flash/);
});

test("grok JSON: input_tokens are uncached; cache read and creation separate", () => {
  const out = JSON.stringify({ text: "ok", num_turns: 4, usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 40, reasoning_tokens: 10 }, modelUsage: { "grok-4.7": { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 900, modelCalls: 4 } } });
  assert.deepEqual(grokJson(out).usage, [{ model: "grok-4.7", uncached: 100, cached: 900, cacheWrite: 50, output: 40, reasoning: 10, calls: 4 }]);
  const two = JSON.stringify({ usage: { cache_creation_input_tokens: 5 }, modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, modelCalls: 1 }, b: { inputTokens: 4, outputTokens: 5, cacheReadInputTokens: 6, modelCalls: 2 } } });
  assert.equal(grokJson(two).usage.length, 2);
  assert.equal(grokJson(JSON.stringify({ usage_is_incomplete: true })).incomplete, true);
});

test("grok billing → % used, period, plan; legacy used / monthlyLimit; zero-valued proto3", () => {
  const r = readingFromBilling({ config: { creditUsagePercent: 41.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-12-01T00:00:00Z" }, onDemandUsed: { val: 120 }, prepaidBalance: { val: 500 } }, subscription_tier: "SuperGrok Heavy" });
  assert.deepEqual(r, { pct: 41.5, resetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000, periodType: "weekly", extraUsed: -380, plan: "SuperGrok Heavy" });
  assert.equal(readingFromBilling({ config: { used: { val: 250 }, monthlyLimit: { val: 1000 } } }).pct, 25);
  assert.equal(readingFromBilling({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } }).pct, 0);
  assert.equal(readingFromBilling({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } }).periodType, "monthly");
  assert.throws(() => readingFromBilling({}), /no config/);
});

test("headless commands: Gemini --sandbox + yolo, Grok --sandbox strict, prompt as -p", () => {
  const g = ADAPTERS.gemini.command({ dir: "/w/t1", prompt: "P", model: "gemini-3.8-flash", logDir: "/l", taskId: "t1", a: { "gemini-sandbox": "podman" } });
  assert.deepEqual(g.args.slice(0, 2), ["-p", "P"]);
  for (const f of ["--sandbox", "--skip-trust"]) assert.ok(g.args.includes(f));
  assert.equal(g.args[g.args.indexOf("--approval-mode") + 1], "yolo");
  assert.equal(g.env.GEMINI_SANDBOX, "podman");
  assert.equal(g.env.GEMINI_TELEMETRY_LOG_PROMPTS, "false");
  assert.equal(g.cwd, "/w/t1");
  const x = ADAPTERS.grok.command({ dir: "/w/t1", prompt: "P", model: "grok-4.7", effort: "high" });
  assert.equal(x.args[x.args.indexOf("--sandbox") + 1], "strict");
  assert.equal(x.args[x.args.indexOf("--cwd") + 1], "/w/t1");
  assert.equal(x.args[x.args.indexOf("--reasoning-effort") + 1], "high");
  assert.equal(x.args[x.args.indexOf("--output-format") + 1], "json");
});

test("every adapter plan has a fee and every default model a price; kit.json matches the adapters", () => {
  const site = loadSite();
  assert.deepEqual(KIT.harnesses.map((h) => h.id).sort(), Object.keys(ADAPTERS).sort());
  for (const h of KIT.harnesses) {
    const ad = ADAPTERS[h.id];
    assert.deepEqual(h.plans, ad.plans.map((p) => p.plan));
    assert.equal(h.defaultModel, ad.models.default);
    assert.equal(h.window, ad.meter.window);
    assert.equal(h.windowsPerMonth, ad.meter.windows[ad.meter.window].perMonth);
    for (const p of h.plans) {
      assert.ok(feeFor(p, site)?.usd > 0, `fee for ${p}`);
      assert.ok(new RegExp(h.planTest).test(p), `${p} vs ${h.planTest}`);
    }
    assert.ok(priceFor(site, ad.siteModelId(ad.models.default)).input > 0);
    for (const k of ["id", "name", "bin", "install", "login", "version", "procMatch", "preflight", "siteModelId", "sameModel", "command", "parseUsage"]) assert.ok(ad[k] != null, `${h.id}.${k}`);
    assert.ok(ad.meter.manual.where && ad.meter.unit && ad.pacing.targetPp > 0);
  }
});

test("unknown plan, model without a price, or effort on Gemini fail with what to pass", () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, "run", ...args, "--dry-run"], { encoding: "utf8" });
  assert.match(run(["--harness", "grok", "--plan", "ChatGPT Plus"]).stderr, /not a Grok Build plan: "SuperGrok Lite"/);
  assert.match(run(["--harness", "grok", "--plan", "SuperGrok", "--model", "grok-0"]).stderr, /no aaPricing for grok-0/);
  assert.match(run(["--harness", "gemini", "--plan", "Google AI Pro", "--effort", "high"]).stderr, /takes no --effort/);
  assert.match(run(["--harness", "nope", "--plan", "x"]).stderr, /--harness gemini \| grok/);
  assert.match(run(["--harness", "gemini", "--plan", "Google AI Pro"]).stdout, /No calls made/);
});

test("no secrets: scrub and secretHits catch tokens, keys, emails and home paths", () => {
  const home = "/home/someone";
  const dirty = { a: "Bearer abc.def", b: ["ya29.a0AfH6SM", "user@example.com", "xai-ABCDEFGHIJKLMNOPQRST"], c: { d: `${home}/x`, e: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig" }, ok: "grok-4.7 · 12.5%" };
  assert.equal(secretHits(dirty, home).length, 6);
  const clean = scrub(dirty, home);
  assert.equal(secretHits(clean, home).length, 0);
  assert.equal(clean.ok, "grok-4.7 · 12.5%");
  assert.equal(redact("failed (token ya29.XYZ for me@x.org)"), "failed (token [redacted] for [redacted])");
});
