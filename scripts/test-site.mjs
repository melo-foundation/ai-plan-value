#!/usr/bin/env node
/**
 * Automated verification suite for AI Plan Value.
 * Tests dataset integrity, all upstream sources (including OpenRouter, Kilo Pass, CursorBench,
 * and ARC Prize), harness/quota-window classification, HTML/JS DOM wiring,
 * reasoning effort bounds & monotonicity, shareable URL params, and cache-busting.
 *
 * Zero external dependencies (Node.js >= 20). Exits non-zero on any failure.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as REL from "./reliability.mjs";
import { BILLING_PERIODS, UNKNOWN_REASONS, isAnnualVariant } from "./billing-periods.mjs";
import * as PP from "./check-pricing-pages.mjs";
import { INCLUDED_CREDITS, applyIncludedCredits } from "./included-credits.mjs";
import * as QW from "./fit-quota-weights.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_PATH = path.join(ROOT, "public", "data", "combined.json");
const HTML_PATH = path.join(ROOT, "public", "index.html");
const APP_PATH = path.join(ROOT, "public", "app.js");
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "deploy.yml");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    const msg = err?.message || String(err);
    failures.push({ name, msg });
    console.error(`FAIL  ${name}\n      ${msg}`);
  }
}

let skipped = 0;
function skip(name, reason) {
  skipped++;
  console.log(`SKIP  ${name}\n      ${reason}`);
}

const dataset = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const html = fs.readFileSync(HTML_PATH, "utf8");
const appJs = fs.readFileSync(APP_PATH, "utf8");
const workflowYml = fs.readFileSync(WORKFLOW_PATH, "utf8");
const entries = dataset.entries || [];

// 1. Upstream sources health
test("All 10 upstream sources succeeded with non-zero records", () => {
  const expected = [
    ["fei2411", "rowCount"],
    ["priorsRepo", "itemCount"],
    ["artificialAnalysis", "modelCount"],
    ["openRouter", "modelCount"],
    ["githubCopilot", "tierCount"],
    ["ollamaCloud", "tierCount"],
    ["kiloPass", "tierCount"],
    ["arcPrize", "multiEffortModelCount"],
    ["aaCodingAgents", "configCount"],
    ["cursorBench", "rowCount"],
  ];
  for (const [key, countField] of expected) {
    const src = dataset.sources?.[key];
    assert.ok(src, `Missing source entry: ${key}`);
    assert.equal(src.ok, true, `Source ${key} failed: ${src.error}`);
    assert.ok((src[countField] || 0) > 0, `Source ${key}.${countField} must be > 0`);
  }
});

// 1a. CursorBench comes from cursor.com, not the Priors copy
test("CursorBench is read from cursor.com and attached to entries", () => {
  const src = dataset.sources?.cursorBench;
  assert.equal(src?.url, "https://cursor.com/cursorbench");
  assert.equal(src?.usedFallback, false, "CursorBench fell back to the Priors copy");
  assert.ok(src.rowCount >= 20, `CursorBench rowCount ${src.rowCount} < 20`);
  const withCb = entries.filter((e) => e.cursorBench);
  assert.ok(withCb.length > 0, "No entry has CursorBench data");
  for (const e of withCb) {
    assert.ok(e.cursorBench.score > 0 && e.cursorBench.score <= 100, `${e.id}: CursorBench score ${e.cursorBench.score}`);
    assert.ok(e.cursorBench.costPerTaskUsd > 0, `${e.id}: CursorBench cost ${e.cursorBench.costPerTaskUsd}`);
  }
});

// 1b. Coding Agent Index join
test("Coding Agent Index joins only exact agent/model/effort matches with sane values", () => {
  const PINNED = {
    "Claude Code / Web": "claude-code",
    "Codex / Web": "codex",
    "Gemini CLI / Web": "antigravity-cli",
    "Le Chat / Vibe": "mistral-vibe",
    "Grok Web / App": "grok-build",
    "OpenCode / API": "opencode",
    "Devin Agent": "devin-cli",
    "Copilot IDE / CLI": "copilot-cli",
  };
  const UNMEASURED = new Set(["Cursor IDE", "Command Code CLI", "Factory Droid CLI", "First-party app"]);
  const matched = entries.filter((e) => e.codingAgent);
  const measured = matched.filter((e) => !e.codingAgent.estimate);
  assert.ok(measured.length >= 100, `Expected >= 100 entries with measured Coding Agent Index, got ${measured.length}`);
  const estimated = matched.filter((e) => e.codingAgent.estimate);
  assert.ok(estimated.length >= measured.length, `Expected agent estimates to fill unmeasured rows, got ${estimated.length}`);
  for (const e of estimated) {
    assert.ok(["same-model", "terminal-bench"].includes(e.codingAgent.estimate), `Unknown agent estimate on ${e.id}`);
    if (e.codingAgent.estimate === "same-model") assert.ok(e.codingAgent.fromAgent && e.codingAgent.fromEffort, `Missing estimate source on ${e.id}`);
  }
  const acc = dataset.stats?.codingAgentEstimates?.accuracy;
  assert.ok(acc?.sameModel?.pts > 0 && acc.sameModel.pts < 4, `Agent same-model LOOCV out of range: ${acc?.sameModel?.pts}`);
  assert.ok(acc?.model?.pts > 0 && acc.model.pts < 6, `Agent Terminal-Bench LOOCV out of range: ${acc?.model?.pts}`);
  for (const e of matched) {
    const a = e.codingAgent;
    assert.ok(Number.isFinite(a.index) && a.index > 0 && a.index <= 100, `Bad codingAgent.index on ${e.id}: ${a.index}`);
    assert.ok(Number.isFinite(a.costPerTaskUsd) && a.costPerTaskUsd > 0, `Bad codingAgent.costPerTaskUsd on ${e.id}`);
    assert.ok(!UNMEASURED.has(e.harness), `${e.id} (${e.harness}) has an unmeasured harness but got agent ${a.agent}`);
    const pinned = PINNED[e.harness];
    if (pinned) assert.equal(a.agentSlug, pinned, `${e.id} (${e.harness}) must use ${pinned}, got ${a.agentSlug}`);
  }
  const names = new Map();
  for (const e of matched) {
    const prev = names.get(e.codingAgent.agentSlug);
    assert.ok(!prev || prev === e.codingAgent.agent, `Inconsistent agent names for ${e.codingAgent.agentSlug}: ${prev} / ${e.codingAgent.agent}`);
    names.set(e.codingAgent.agentSlug, e.codingAgent.agent);
  }
});

// 1c. T3 Code real-usage turn costs (via Priors)
test("T3 Code $/turn joins exact model+effort with sane telemetry", () => {
  const withT3 = entries.filter((e) => e.t3Turn);
  const variants = new Set(withT3.map((e) => `${e.baseModelId}|${e.effort}`));
  assert.ok(variants.size >= 60, `Expected >= 60 model+effort variants with T3 turn cost, got ${variants.size}`);
  assert.equal(dataset.stats?.t3CodeTurns?.entries, withT3.length, "stats.t3CodeTurns.entries out of sync");
  const byVariant = new Map();
  for (const e of withT3) {
    const t = e.t3Turn;
    assert.ok(Number.isFinite(t.costPerTurnUsd) && t.costPerTurnUsd > 0 && t.costPerTurnUsd < 50, `Bad t3Turn.costPerTurnUsd on ${e.id}: ${t.costPerTurnUsd}`);
    assert.ok(Number.isInteger(t.turns) && t.turns > 0, `Bad t3Turn.turns on ${e.id}`);
    assert.ok(Number.isInteger(t.users) && t.users > 0 && t.users <= t.turns, `Bad t3Turn.users on ${e.id}`);
    assert.ok(t.minutesPerTurn == null || (t.minutesPerTurn > 0 && t.minutesPerTurn < 240), `Bad t3Turn.minutesPerTurn on ${e.id}`);
    assert.match(String(t.window || ""), /^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/, `Bad t3Turn.window on ${e.id}`);
    // Same model+effort must carry identical telemetry across every plan
    const k = `${e.baseModelId}|${e.effort}`;
    const prev = byVariant.get(k);
    if (prev) assert.equal(prev, t.costPerTurnUsd, `Inconsistent T3 cost across plans for ${k}`);
    byVariant.set(k, t.costPerTurnUsd);
  }
  // Higher effort of the same model costs more per turn in nearly all cases
  const ORDER = ["low", "medium", "high", "xhigh", "max"];
  let pairs = 0, inverted = 0;
  for (const [k, cost] of byVariant) {
    const [base, eff] = k.split("|");
    const nextEff = ORDER[ORDER.indexOf(eff) + 1];
    const next = nextEff ? byVariant.get(`${base}|${nextEff}`) : undefined;
    if (next != null) { pairs++; if (next < cost) inverted++; }
  }
  assert.ok(pairs >= 20 && inverted / pairs <= 0.2, `T3 cost not increasing with effort: ${inverted}/${pairs} inverted`);
});

// 1d. CursorBench score and $/task (via Priors)
test("CursorBench joins exact model+effort with sane score and $/task", () => {
  const withCb = entries.filter((e) => e.cursorBench);
  const variants = new Set(withCb.map((e) => `${e.baseModelId}|${e.effort}`));
  assert.ok(variants.size >= 25, `Expected >= 25 model+effort variants with CursorBench, got ${variants.size}`);
  assert.equal(dataset.stats?.cursorBench?.entries, withCb.length, "stats.cursorBench.entries out of sync");
  const byVariant = new Map();
  for (const e of withCb) {
    const c = e.cursorBench;
    assert.ok(Number.isFinite(c.score) && c.score > 0 && c.score <= 100, `Bad cursorBench.score on ${e.id}: ${c.score}`);
    assert.ok(Number.isFinite(c.costPerTaskUsd) && c.costPerTaskUsd > 0 && c.costPerTaskUsd < 200, `Bad cursorBench.costPerTaskUsd on ${e.id}`);
    const k = `${e.baseModelId}|${e.effort}`;
    const prev = byVariant.get(k);
    if (prev) assert.deepEqual(prev, c, `Inconsistent CursorBench data across plans for ${k}`);
    byVariant.set(k, c);
  }
});

// 1e. Newer AA Intelligence Index scores win: the AA API (fetched this run) over Fei2411 / Priors,
// and for levels the API lacks, Priors over lagging Fei2411 configs
test("Intelligence Index uses the newest AA observation per model+effort", () => {
  const fresh = dataset.stats?.aaIndexFreshness;
  assert.ok(fresh && Array.isArray(fresh.variants) && Array.isArray(fresh.apiVariants), "Missing stats.aaIndexFreshness");
  assert.equal(fresh.keptNewerPriors, fresh.variants.length);
  assert.equal(fresh.apiOverrides, fresh.apiVariants.length);
  const apiKeys = new Set(fresh.apiVariants.map((v) => v.key));
  for (const v of fresh.variants) assert.ok(!apiKeys.has(v.key), `${v.key} is listed as both Priors-kept and API-sourced`);
  if (dataset.sources?.aaApi?.ok) {
    assert.ok(fresh.apiVariants.length > 0, "AA API ok but no API values replaced older ones");
    const fetched = dataset.sources.aaApi.fetchedAt.slice(0, 10);
    for (const v of fresh.apiVariants) {
      assert.equal(v.keptDate, fetched, `${v.key}: API value date ${v.keptDate} is not the fetch date ${fetched}`);
      if (v.droppedDate) assert.ok(v.keptDate >= v.droppedDate, `${v.key}: API value older than the ${v.droppedSource} one it replaced`);
    }
  } else {
    assert.equal(fresh.apiVariants.length, 0, "AA API failed but API values are listed");
  }
  let checked = 0;
  for (const v of fresh.apiVariants) {
    const [base, eff] = v.key.split("|");
    for (const e of entries.filter((x) => x.baseModelId === base && (x.effort || "default") === eff && !x.effortEstimate)) {
      checked++;
      assert.equal(e.aaSource, "api", `${e.id} should be API-sourced`);
      assert.ok(Math.abs(e.intelligenceIndex - v.kept) < 0.01, `${e.id} shows ${e.intelligenceIndex}, expected API ${v.kept}`);
      assert.ok(Math.abs(e.aaCostPerTaskUsd - v.keptCost) < 1e-4, `${e.id} cost/task ${e.aaCostPerTaskUsd}, expected API ${v.keptCost}`);
    }
  }
  if (fresh.apiVariants.length) assert.ok(checked > 0, "No entries matched the API variants");
  for (const v of fresh.variants) {
    assert.ok(v.keptDate > v.droppedDate, `Kept score for ${v.key} is not newer (${v.keptDate} vs ${v.droppedDate})`);
    const [base, eff] = v.key.split("|");
    const rows = entries.filter((e) => e.baseModelId === base && (e.effort || "default") === eff && !e.effortEstimate);
    for (const e of rows) {
      checked++;
      assert.ok(Math.abs(e.intelligenceIndex - v.kept) < 0.01, `${e.id} shows ${e.intelligenceIndex}, expected newer ${v.kept} (stale ${v.dropped})`);
    }
  }
  if (fresh.variants.length) assert.ok(checked > 0, "No entries matched the refreshed variants");
  // Meaningful only if some kept score differs from the stale one: those rows must not show the stale value.
  const moved = [...fresh.variants, ...fresh.apiVariants].filter((v) => Math.abs(v.kept - v.dropped) >= 0.05);
  assert.ok(moved.length >= 5, `Only ${moved.length} refreshed variants change the score; the freshness check has nothing to bite on`);
  for (const v of moved) {
    const [base, eff] = v.key.split("|");
    for (const e of entries.filter((x) => x.baseModelId === base && (x.effort || "default") === eff && !x.effortEstimate)) {
      assert.ok(Math.abs(e.intelligenceIndex - v.dropped) >= 0.04, `${e.id} shows the stale ${v.droppedSource || "Fei"} score ${v.dropped}`);
    }
  }
  for (const e of entries) {
    if (e.intelligenceIndex == null || e.benchmarks?.intelligenceIndex == null) continue;
    assert.ok(Math.abs(e.intelligenceIndex - e.benchmarks.intelligenceIndex) <= 0.051, `${e.id}: intelligenceIndex ${e.intelligenceIndex} vs benchmarks ${e.benchmarks.intelligenceIndex}`);
  }
});

// 1e2. Artificial Analysis free API: source status, coverage, parser and merge on a recorded fixture (no network)
const RD = await import("./refresh-data.mjs");
const AA_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "aa-api-free.json"), "utf8"));
const AA_FREE_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
const approx = (a, b, tol = 1e-6) => a === b || Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const aaFixtureItems = () => structuredClone(AA_FIXTURE.pages.flatMap((p) => p.data));

test("sources.aaApi: shape and status", () => {
  const s = dataset.sources?.aaApi;
  assert.ok(s, "Missing sources.aaApi");
  for (const k of ["name", "url", "ok", "fetchedAt", "modelCount", "pages", "tier", "intelligenceIndexVersion", "error"]) {
    assert.ok(k in s, `sources.aaApi.${k} missing`);
  }
  assert.equal(s.url, AA_FREE_URL);
  assert.equal(typeof s.ok, "boolean");
  if (s.ok) {
    assert.ok(s.modelCount > 0 && s.pages >= 1, `ok but ${s.modelCount} models over ${s.pages} pages`);
    assert.equal(s.tier, "free");
    assert.ok(s.intelligenceIndexVersion != null, "intelligenceIndexVersion missing");
    assert.ok(!Number.isNaN(Date.parse(s.fetchedAt)), "fetchedAt is not a date");
    assert.equal(s.error, null);
  } else {
    assert.ok(s.error, "failed without an error");
    assert.equal(s.modelCount, 0);
  }
});

test("AA API is the source of ≥ 90% of measured AA variants", () => {
  const src = new Map();
  for (const e of entries) {
    if (e.intelligenceIndex == null || e.effortEstimate) continue;
    assert.ok(["api", "priors", "fei", "scrape"].includes(e.aaSource), `${e.id}: aaSource ${e.aaSource}`);
    const prev = src.get(e.modelId);
    if (prev) assert.equal(prev, e.aaSource, `${e.modelId}: aaSource differs across plans`);
    src.set(e.modelId, e.aaSource);
  }
  for (const e of entries) if (e.effortEstimate) assert.equal(e.aaSource, "estimate", `${e.id}: estimated level marked ${e.aaSource}`);
  const st = dataset.stats?.aaApi;
  assert.ok(st, "Missing stats.aaApi");
  const count = (s) => [...src.values()].filter((x) => x === s).length;
  assert.equal(st.variantsFromApi, count("api"));
  assert.equal(st.variantsFromPriors, count("priors"));
  assert.equal(st.variantsFromFei, count("fei"));
  assert.equal(st.variantsFromScrape, count("scrape"));
  assert.equal(st.notInApi.length, src.size - count("api"));
  if (!dataset.sources?.aaApi?.ok) {
    assert.equal(count("api"), 0, "API failed but variants are marked api");
    return;
  }
  const share = count("api") / src.size;
  assert.ok(share >= 0.9, `Only ${count("api")}/${src.size} (${(share * 100).toFixed(0)}%) measured variants come from the AA API: ${st.notInApi.join(", ")}`);
  for (const e of entries.filter((x) => x.aaSource === "api")) {
    assert.ok(e.aaModelId, `${e.id}: API-sourced without aaModelId`);
    assert.ok(e.aaPricing?.inputPer1M != null || e.aaPricing?.blended3to1Per1M != null, `${e.id}: API-sourced without prices`);
  }
});

test("AA API fixture: name and slug map to base slug + level", () => {
  const cases = [
    ["Claude Opus 5.5 (High, Default Fallback)", "claude-opus-5-5-high", "claude-opus-5-5", "high", false, "Claude Opus 5.5"],
    ["Claude Opus 5.5 (Max, Default Fallback)", "claude-opus-5-5", "claude-opus-5-5", "max", true, "Claude Opus 5.5"],
    ["GPT-6.2 Sol (Low)", "gpt-6-2-sol-low", "gpt-6-2-sol", "low", false, "GPT-6.2 Sol"],
    ["GLM-4.5V (Non-reasoning)", "glm-4-5v", "glm-4-5v", "none", true, "GLM-4.5V"],
    ["MiMo-V2.5-Pro (Reasoning)", "mimo-v2-5-pro", "mimo-v2-5-pro", "default", true, "MiMo-V2.5-Pro"],
    ["Kimi K3.1 Pro", "kimi-k3-1-pro", "kimi-k3-1-pro", "default", true, "Kimi K3.1 Pro"],
    ["Qwen4 Max", "qwen4-max", "qwen4-max", "default", true, "Qwen4 Max"],
    ["Claude 4.5 Haiku (Reasoning)", "claude-4-5-haiku-reasoning", "claude-4-5-haiku", "default", false, "Claude 4.5 Haiku"],
    ["DeepSeek V4 Pro 0813 (Non-reasoning)", "deepseek-v4-pro-non-reasoning", "deepseek-v4-pro", "none", false, "DeepSeek V4 Pro 0813"],
    ["Claude Sonnet 4.6 (Non-reasoning, High)", "claude-sonnet-4-6", "claude-sonnet-4-6", "none", true, "Claude Sonnet 4.6"],
    ["Qwen3.8 Max (0902)", "qwen3-8-max", "qwen3-8-max", "default", true, "Qwen3.8 Max (0902)"],
    ["Inkling (Xhigh)", "inkling", "inkling", "xhigh", true, "Inkling"],
  ];
  for (const [name, slug, base, effort, headline, baseName] of cases) {
    const r = RD.parseAaApiLevel(name, slug);
    assert.deepEqual([r.baseSlug, r.effort, r.isHeadline, r.baseName], [base, effort, headline, baseName], `${name} / ${slug}`);
  }
  assert.ok(!/fallback/i.test(RD.normalizeBaseDisplay(RD.parseAaApiLevel("Claude Opus 5.5 (Max, Default Fallback)", "claude-opus-5-5").baseName)));
});

test("AA API fixture: parsed values match the recorded response", () => {
  const recs = RD.parseAaApiModels({ data: aaFixtureItems() });
  const by = new Map(recs.map((r) => [r.slug, r]));
  const opusHigh = by.get("claude-opus-5-5-high");
  assert.ok(opusHigh, "claude-opus-5-5-high missing from fixture");
  assert.equal(opusHigh.baseSlug, "claude-opus-5-5");
  assert.equal(opusHigh.effort, "high");
  assert.ok(approx(opusHigh.intelligenceIndex, 51.8), `Opus 5.5 high II ${opusHigh.intelligenceIndex}`);
  assert.ok(approx(opusHigh.costPerTaskUsd, 3.4647), `Opus 5.5 high cost/task ${opusHigh.costPerTaskUsd}`);
  assert.ok(opusHigh.id && opusHigh.creatorId, "id / creatorId missing");
  assert.equal(opusHigh.creatorName, "Anthropic");
  assert.ok(approx(opusHigh.pricing.blended3to1Per1M, (3 * opusHigh.pricing.inputPer1M + opusHigh.pricing.outputPer1M) / 4));
  assert.ok(approx(opusHigh.pricing.blended7to2to1Per1M, 0.7 * opusHigh.pricing.cacheHitPer1M + 0.2 * opusHigh.pricing.inputPer1M + 0.1 * opusHigh.pricing.outputPer1M));
  const raw = aaFixtureItems().find((m) => m.slug === "claude-opus-5-5-high");
  assert.equal(opusHigh.speed.outputTokPerSec, raw.performance_v3.mean_output_tokens_per_second, "speed must come from performance_v3");
  for (const k of ["engineering", "financeAndAccounting", "strategyAndOps", "legal", "healthcareAndMedical", "economics"]) {
    assert.ok(opusHigh.benchmarks[k] != null, `Opus 5.5 high ${k} missing`);
  }
  // performance goes null on 2026-12-10: speed still comes from performance_v3
  const noLegacy = RD.parseAaApiModels({ data: [{ ...raw, performance: null }] })[0];
  assert.equal(noLegacy.speed.outputTokPerSec, raw.performance_v3.mean_output_tokens_per_second);
  assert.deepEqual(RD.parseAaApiModels({}), []);
  assert.deepEqual(RD.parseAaApiModels(null), []);
});

test("AA API fixture: merge — API wins, Priors sub-tests kept, levels matched, fallback untouched", () => {
  const recs = RD.parseAaApiModels({ data: aaFixtureItems() });
  const pv = (base, effort, ii, cpt, extra = {}) => ({
    variantKey: effort === "default" ? base : `${base}--${effort}`, baseSlug: base, effort, baseDisplay: extra.baseDisplay || base,
    intelligenceIndex: ii, costPerTaskUsd: cpt, iiDate: "2026-11-20", aaSource: "priors",
    benchmarks: { intelligenceIndex: Math.round(ii * 10) / 10, hle: 55.6, ...(extra.benchmarks || {}) },
    pricing: { inputPer1M: 1, outputPer1M: 1, blended3to1Per1M: 1 }, speed: null, ...extra,
  });
  const map = new Map([
    ["claude-opus-5-5", new Map([["high", pv("claude-opus-5-5", "high", 51.79, 3.46, { baseDisplay: "Claude Opus 5.5" })], ["medium", pv("claude-opus-5-5", "medium", 48.26, 2.45)]])],
    ["qwen4-max", new Map([["xhigh", pv("qwen4-max", "xhigh", 42.79, 3.2681)]])],
    ["claude-haiku-4-5", new Map([["default", pv("claude-haiku-4-5", "default", 7.43, 0.5318)]])],
  ]);
  const { stats, replaced } = RD.mergeAaApiVariants(map, recs, new Map(), "2026-11-27");
  const opus = map.get("claude-opus-5-5");
  const h = opus.get("high");
  assert.equal(h.aaSource, "api");
  assert.ok(approx(h.intelligenceIndex, 51.8) && approx(h.costPerTaskUsd, 3.4647), `Opus high ${h.intelligenceIndex} / ${h.costPerTaskUsd}`);
  assert.equal(h.benchmarks.hle, 55.6, "Priors per-test score dropped");
  assert.ok(h.benchmarks.engineering != null, "API capability index missing");
  assert.equal(h.pricing.inputPer1M, recs.find((r) => r.slug === "claude-opus-5-5-high").pricing.inputPer1M, "API price must win");
  assert.equal(h.displayName, "Claude Opus 5.5 (high)");
  assert.equal(h.iiDate, "2026-11-27");
  assert.equal(opus.get("max").aaSource, "api", "headline Max level missing");
  assert.equal(opus.get("max").variantKey, "claude-opus-5-5--max");
  assert.equal(opus.get("low").aaSource, "api");
  assert.equal(opus.get("medium").aaSource, "priors", "a level the API lacks keeps its Priors value");
  assert.ok(!opus.has("default"), "Opus must not gain a default level");
  // "Qwen4 Max" (no level) matches the existing xhigh level by score; "Claude 4.5 Haiku (Reasoning)" aliases to claude-haiku-4-5
  assert.deepEqual([...map.get("qwen4-max").keys()], ["xhigh"]);
  assert.equal(map.get("qwen4-max").get("xhigh").aaSource, "api");
  assert.equal(map.get("claude-haiku-4-5").get("default").aaSource, "api");
  assert.ok(!map.has("qwen4") && !map.has("claude-4-5-haiku"), "API slug split into a wrong base");
  // DeepSeek V4 Pro 0813 maps to the existing key via MODEL_ALIASES; Mistral Large 4 Preview is a new base
  assert.equal(map.get("deepseek-v4-pro-0813")?.get("none")?.aaSource, "api");
  assert.equal(map.get("mistral-large-4-preview")?.get("default")?.displayName, "Mistral Large 4 Preview");
  // unscored / no cost per task / minimal are skipped
  assert.ok(!map.has("gemini-3-5-flash") && !map.has("muse-wonder-full") && !map.has("glm-4-5v"));
  assert.ok(stats.skipped.noScore + stats.skipped.noCostPerTask >= 3, JSON.stringify(stats.skipped));
  const r = replaced.find((x) => x.key === "claude-opus-5-5|high");
  assert.ok(r && r.droppedSource === "priors" && approx(r.dropped, 51.79) && approx(r.kept, 51.8), JSON.stringify(r));
  // No API data (key missing or request failed): variants keep their Fei2411 / Priors values
  const fb = new Map([["claude-opus-5-5", new Map([["high", pv("claude-opus-5-5", "high", 51.79, 3.46)]])]]);
  const before = structuredClone([...fb.get("claude-opus-5-5").entries()]);
  const none = RD.mergeAaApiVariants(fb, RD.parseAaApiModels({ data: [] }), new Map(), "2026-11-27");
  assert.equal(none.stats.variantsFromApi, 0);
  assert.deepEqual([...fb.get("claude-opus-5-5").entries()], before);
});

// fetchAaApiModels is async and test() is not: run the fake-fetch scripts first, assert below.
const aaClientRun = async (script) => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, key: opts.headers["x-api-key"] });
    const step = script.shift();
    if (step instanceof Error) throw step;
    if (typeof step === "number") return { ok: false, status: step, headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => structuredClone(step) };
  };
  const out = await RD.fetchAaApiModels("test-key", { fetchImpl, sleep: async () => {} }).catch((e) => e);
  return { out, calls };
};
const [aaP1, aaP2] = AA_FIXTURE.pages;
const aaClient = {
  ok: await aaClientRun([429, 503, aaP1, new Error("socket hang up"), aaP2]),
  denied: await aaClientRun([403]),
  exhausted: await aaClientRun([500, 500, 500, 500, 500]),
  noKey: await RD.fetchAaApiModels("").catch((e) => e),
};
test("AA API client: all pages, retries 429/5xx, stops on 403, key only in the header", () => {
  const [p1, p2] = [aaP1, aaP2];
  const { ok, denied, exhausted, noKey } = aaClient;
  assert.ok(!(ok.out instanceof Error), ok.out?.message);
  assert.equal(ok.out.pages, 2);
  assert.equal(ok.out.data.length, p1.data.length + p2.data.length);
  assert.equal(ok.out.tier, "free");
  assert.equal(ok.calls.length, 5);
  assert.ok(ok.calls.every((c) => c.key === "test-key" && !c.url.includes("test-key")), "key must travel only in the x-api-key header");
  assert.ok(ok.calls[0].url.startsWith(`${AA_FREE_URL}?page=1`) && ok.calls[4].url.endsWith("page=2"));
  assert.ok(denied.out instanceof Error && /HTTP 403/.test(denied.out.message) && denied.calls.length === 1, "403 must fail without retry");
  assert.ok(!/test-key/.test(denied.out.message), "error message leaks the key");
  assert.ok(exhausted.out instanceof Error && exhausted.calls.length === 5);
  assert.ok(noKey instanceof Error && /AA_API_KEY not set/.test(noKey.message));
});

test("Dead AA v2 data URL is gone", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "refresh-data.mjs"), "utf8");
  assert.ok(!src.includes("api/v2/data/llms"), "refresh-data.mjs still references /api/v2/data/llms/models (HTTP 410)");
  assert.ok(!/usedApiV2/.test(src), "usedApiV2 flag still present");
  assert.equal(RD.SOURCES.aaApi, AA_FREE_URL);
  assert.ok(!("usedApiV2" in (dataset.sources?.artificialAnalysis || {})), "combined.json still has artificialAnalysis.usedApiV2");
});

// 1f. Cost metric menu matches the app's cost modes, each mode has data
test("Cost metric options match COST_MODES and every mode has priced entries", () => {
  const sel = html.match(/<select id="costMode"[\s\S]*?<\/select>/)?.[0] || "";
  const opts = [...sel.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]).sort();
  const block = appJs.match(/const COST_MODES = \{([\s\S]*?)\n\};/)?.[1] || "";
  const modes = [...block.matchAll(/^\s+(\w+): \{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(opts, modes, `costMode options ${opts} != COST_MODES ${modes}`);
  const has = {
    task: (e) => e.aaCostPerTaskUsd > 0,
    agent: (e) => e.codingAgent?.costPerTaskUsd > 0,
    cursor: (e) => e.cursorBench?.costPerTaskUsd > 0,
    turn: (e) => e.t3Turn?.costPerTurnUsd > 0,
    tokens: (e) => (e.aaPricing?.blended3to1Per1M ?? e.listBlendedUsdPerMtok) > 0,
  };
  for (const m of modes) {
    assert.ok(has[m], `No data check for cost mode ${m}`);
    const n = entries.filter(has[m]).length;
    assert.ok(n >= 100, `Cost mode ${m} has only ${n} priced entries`);
  }
});

// 1z. One creator per model, one colour per creator (bars of a vendor share its colour)
test("Each model has one creator and each creator one colour", () => {
  const creatorsByModel = new Map(), colorsByCreator = new Map();
  for (const e of entries) {
    if (!e.baseModelId) continue;
    (creatorsByModel.get(e.baseModelId) || creatorsByModel.set(e.baseModelId, new Set()).get(e.baseModelId)).add(e.modelCreator);
    (colorsByCreator.get(e.modelCreator) || colorsByCreator.set(e.modelCreator, new Set()).get(e.modelCreator)).add(e.color);
  }
  const multiCreator = [...creatorsByModel].filter(([, v]) => v.size > 1).map(([k, v]) => `${k}: ${[...v].join("/")}`);
  assert.deepEqual(multiCreator, [], "models with several creators");
  const multiColor = [...colorsByCreator].filter(([, v]) => v.size > 1).map(([k, v]) => `${k}: ${[...v].join("/")}`);
  assert.deepEqual(multiColor, [], "creators with several colours");
  const argon = entries.filter((e) => e.baseModelId === "gemini-4-argon");
  assert.ok(argon.length && argon.every((e) => e.modelCreator === "Google"), "Gemini 4 Argon is Google's on every plan");
});

// 2. Dataset size & uniqueness
test("Dataset has expected scale and zero duplicate entry IDs", () => {
  assert.ok(entries.length >= 500, `Expected >= 500 entries, got ${entries.length}`);
  assert.ok((dataset.stats?.uniqueModels || 0) >= 50, `Expected >= 50 models, got ${dataset.stats?.uniqueModels}`);
  assert.ok((dataset.stats?.uniqueVariants || 0) >= 100, `Expected >= 100 variants, got ${dataset.stats?.uniqueVariants}`);
  const ids = new Set();
  for (const e of entries) {
    assert.ok(e.id, "Entry missing id");
    assert.ok(!ids.has(e.id), `Duplicate entry id: ${e.id}`);
    ids.add(e.id);
  }
});

// 3. Pricing, subsidy bounds, and benchmark sanity
test("All entries have valid AA cost/task, intelligence, token pricing, and sane subsidies", () => {
  let missingTokenPrice = 0;
  for (const e of entries) {
    assert.ok(Number.isFinite(e.aaCostPerTaskUsd) && e.aaCostPerTaskUsd > 0, `Invalid aaCostPerTaskUsd on ${e.id}`);
    assert.ok(Number.isFinite(e.intelligenceIndex), `Invalid intelligenceIndex on ${e.id}`);
    if (e.billing === "subscription" && !e.unmetered) {
      assert.ok(
        Number.isFinite(e.subsidyMultiple) && e.subsidyMultiple >= 0.85,
        `Suspicious subsidyMultiple (${e.subsidyMultiple}x) on ${e.id} — possible unit/workload mismatch`
      );
      if (e.subsidyMultiple > 100) console.log(`     Note: ${e.id} subsidyMultiple ${e.subsidyMultiple}x (>100x, upstream value)`);
      // Workload-mix corrections only rescale Fei2411's standard-mix multiple by a blend ratio
      // (~1.0-2.3x today; cheap-cache models can go higher); beyond 4x is a currency/unit error (e.g. CNY list price read as USD).
      // Fei-native value: the "Fable only" reading where Fei measured that one; pooled cells moved by the pool.
      const feiNative = e.subsidyReadings && Math.abs(e.subsidyReadings.own * 2 - e.subsidyMultiple) < 0.01 * e.subsidyMultiple && !/周帽不套/.test(e.decisionNote || "")
        ? e.subsidyReadings.own
        : e.subsidyMultiple;
      if (e.origin === "fei2411" && e.upstreamSubsidyMultiple > 0 && !e.pooled) {
        const ratio = feiNative / e.upstreamSubsidyMultiple;
        assert.ok(
          ratio >= 0.95 && ratio <= 4,
          `${e.id} (${e.feiWorkload}) subsidy ${e.subsidyMultiple}x is ${ratio.toFixed(2)}x Fei2411's standard-mix ${e.upstreamSubsidyMultiple}x — currency/unit mismatch?`
        );
      }
      if (e.origin === "fei2411" && e.monthlyTokens > 0 && e.priceUsd > 0 && e.listBlendedUsdPerMtok > 0) {
        const implied = ((e.monthlyTokens / 1e6) * e.listBlendedUsdPerMtok) / e.priceUsd;
        const relDiff = Math.abs(implied - feiNative) / feiNative;
        assert.ok(
          relDiff <= 0.1,
          `Subsidy mismatch on ${e.id}: ${feiNative}x vs implied ${implied.toFixed(2)}x (monthlyTokens × listBlended / priceUsd)`
        );
      }
    }
    const p = e.aaPricing || {};
    const mtok = p.blended3to1Per1M ?? p.blended7to2to1Per1M ?? e.listBlendedUsdPerMtok;
    if (mtok == null || !Number.isFinite(mtok) || mtok <= 0) missingTokenPrice++;
  }
  assert.equal(missingTokenPrice, 0, `${missingTokenPrice} entries missing blended token pricing`);
});

// 4. OpenRouter context window & domain backfill
test("OpenRouter backfilled context windows across >= 60% of models", () => {
  assert.ok(
    (dataset.stats?.openRouterBackfilledContext || 0) > 0,
    "Expected openRouterBackfilledContext > 0"
  );
  const byModel = new Map();
  for (const e of entries) {
    if (!byModel.has(e.baseModelId)) byModel.set(e.baseModelId, e.contextWindowTokens);
  }
  const withCtx = [...byModel.values()].filter((v) => v != null && v > 0).length;
  const pct = (withCtx / byModel.size) * 100;
  assert.ok(pct >= 60, `Context window coverage too low: ${withCtx}/${byModel.size} (${pct.toFixed(1)}%)`);
});

// 5. Kilo Pass live tiers & net multiple (50% bonus / 5% fee = 1.4286x)
test("Kilo Pass tiers are present with exact fee-adjusted 1.43x multiple", () => {
  const kilo = entries.filter((e) => e.origin === "kilo-pass");
  assert.ok(kilo.length > 0, "No Kilo Pass entries found");
  const expectedTiers = new Map([
    ["Kilo Pass Starter (Annual)", 19.95],
    ["Kilo Pass Pro (Annual)", 51.45],
    ["Kilo Pass Expert (Annual)", 208.95],
  ]);
  for (const [planName, expectedFee] of expectedTiers.entries()) {
    const matches = kilo.filter((e) => e.plan === planName);
    assert.ok(matches.length > 0, `Missing Kilo Pass tier: ${planName}`);
    const sample = matches[0];
    assert.ok(Math.abs(sample.priceUsd - expectedFee) < 0.02, `${planName} fee ${sample.priceUsd} !== ${expectedFee}`);
    assert.ok(Math.abs(sample.subsidyMultiple - 1.4286) < 0.01, `${planName} multiple ${sample.subsidyMultiple} !== 1.4286`);
    assert.equal(sample.openEndpoint, true, `${planName} should be openEndpoint=true`);
    assert.deepEqual(sample.quotaWindows, [], `${planName} should have no time windows (credit balance)`);
  }
});

// 6. Harness & Quota Reset Window classification
test("All entries have valid harness/quotaWindow metadata and zero unclassified plans", () => {
  const validWindows = new Set(["5h", "daily", "weekly", "7d", "30d", "monthly", "payg", "none"]);
  for (const e of entries) {
    assert.ok(Array.isArray(e.quotaWindows) && e.quotaWindows.every((w) => validWindows.has(w)), `Invalid quotaWindows on ${e.id}`);
    assert.equal(typeof e.openEndpoint, "boolean", `Missing openEndpoint on ${e.id}`);
    assert.ok(e.harness && typeof e.harness === "string", `Missing harness on ${e.id}`);
    assert.ok(validWindows.has(e.quotaWindow), `Invalid quotaWindow "${e.quotaWindow}" on ${e.id}`);
    assert.ok(e.quotaWindowLabel && typeof e.quotaWindowLabel === "string", `Missing quotaWindowLabel on ${e.id}`);
  }
  const unclassified = dataset.stats?.unclassifiedPlans || [];
  if (unclassified.length > 0) {
    console.warn(`WARN  Unclassified plans (will trigger [New Plan] issue in CI): ${unclassified.join(", ")}`);
  }

  // Every row of a plan family carries the same windows; the primary window is one of them.
  const plansOf = (re) => entries.filter((e) => e.billing === "subscription" && re.test(e.plan));
  const expectPlans = (re, windows, openEndpoint, label) => {
    const rows = plansOf(re);
    assert.ok(rows.length > 0, `No ${label} rows`);
    for (const e of rows) {
      assert.equal(e.quotaWindows.join(), windows, `${e.id}: quotaWindows ${e.quotaWindows} (want ${windows})`);
      assert.equal(e.openEndpoint, openEndpoint, `${e.id}: openEndpoint`);
    }
  };
  expectPlans(/^Claude (Pro|Max)$/, "5h,weekly", false, "Claude Pro/Max");
  expectPlans(/^ChatGPT Plus\b/, "5h,weekly", false, "ChatGPT Plus");
  expectPlans(/^ChatGPT Pro\b/, "weekly", false, "ChatGPT Pro");
  expectPlans(/^GitHub Copilot\b/, "monthly", false, "GitHub Copilot");
  expectPlans(/^GLM Coding\b/, "weekly,5h", true, "GLM Coding");
  const byPlan = new Map();
  for (const e of entries) {
    if (!["none", "payg"].includes(e.quotaWindow)) assert.ok(e.quotaWindows.includes(e.quotaWindow), `${e.id}: primary window ${e.quotaWindow} not in ${e.quotaWindows}`);
    const prev = byPlan.get(e.plan);
    assert.ok(prev == null || prev === e.quotaWindows.join(), `${e.plan}: rows disagree on quotaWindows (${prev} vs ${e.quotaWindows})`);
    byPlan.set(e.plan, e.quotaWindows.join());
  }
  const api = entries.find((e) => e.billing === "metered");
  assert.ok(api && api.openEndpoint === true && api.quotaWindow === "payg", "Metered API classification mismatch");
});

// 7. DOM ID wiring between public/app.js and public/index.html
test("Every $('id') selector in public/app.js exists in public/index.html", () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = [...new Set([...appJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  assert.ok(jsIds.length >= 25, `Unexpectedly few DOM selectors found: ${jsIds.length}`);
  const missing = jsIds.filter((id) => !htmlIds.has(id));
  assert.equal(missing.length, 0, `DOM IDs referenced in app.js missing from index.html: ${missing.join(", ")}`);
});

// 8. Interpolated & extrapolated reasoning effort invariants
test("Interpolated efforts are strictly bracketed and extrapolated efforts are valid", () => {
  const rank = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
  const measuredByModel = new Map();
  const interpEntries = [];
  const extrapEntries = [];
  for (const e of entries) {
    if (e.effortEstimate === "interpolated") {
      interpEntries.push(e);
    } else if (e.effortEstimate === "extrapolated") {
      extrapEntries.push(e);
    } else if (rank[e.effort] != null) {
      if (!measuredByModel.has(e.baseModelId)) measuredByModel.set(e.baseModelId, []);
      measuredByModel.get(e.baseModelId).push(rank[e.effort]);
    }
  }
  for (const e of interpEntries) {
    const r = rank[e.effort];
    assert.ok(r != null, `Invalid interpolated effort "${e.effort}" on ${e.id}`);
    const mRanks = measuredByModel.get(e.baseModelId) || [];
    assert.ok(mRanks.some((x) => x < r), `Interpolated ${e.id} has no lower measured effort`);
    assert.ok(mRanks.some((x) => x > r), `Interpolated ${e.id} has no higher measured effort`);
  }
  assert.ok(extrapEntries.length > 0, "Expected extrapolated experimental effort variants > 0");
  for (const e of extrapEntries) {
    assert.ok(rank[e.effort] != null, `Invalid extrapolated effort "${e.effort}" on ${e.id}`);
    assert.ok(Number.isFinite(e.intelligenceIndex) && e.intelligenceIndex >= 1 && e.intelligenceIndex <= 95);
    assert.ok(Number.isFinite(e.aaCostPerTaskUsd) && e.aaCostPerTaskUsd > 0);
  }
  // Guard extrapolated monotonicity (catches benchmark clamping bugs like gdpval floor)
  const byModelEff = new Map();
  for (const e of entries) {
    if (rank[e.effort] == null) continue;
    if (!byModelEff.has(e.baseModelId)) byModelEff.set(e.baseModelId, new Map());
    if (!byModelEff.get(e.baseModelId).has(e.effort)) byModelEff.get(e.baseModelId).set(e.effort, e);
  }
  const orderedEffs = ["none", "low", "medium", "high", "xhigh", "max"];
  for (const [slug, m] of byModelEff.entries()) {
    const seq = orderedEffs.filter((ef) => m.has(ef)).map((ef) => m.get(ef));
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      if (!a.effortEstimate && !b.effortEstimate) continue;
      assert.ok(
        b.intelligenceIndex >= a.intelligenceIndex - 0.5,
        `Extrapolated intelligence drop on ${slug} (${a.effort} ${a.intelligenceIndex} -> ${b.effort} ${b.intelligenceIndex})`
      );
      if (a.benchmarks?.gdpval != null && b.benchmarks?.gdpval != null) {
        assert.ok(
          b.benchmarks.gdpval >= a.benchmarks.gdpval - 15,
          `Extrapolated gdpval drop on ${slug} (${a.effort} ${a.benchmarks.gdpval} -> ${b.effort} ${b.benchmarks.gdpval})`
        );
      }
    }
  }
  const interpModels = [...new Map(interpEntries.map((e) => [e.modelId, `${e.modelDisplay} (II ${e.intelligenceIndex})`])).values()];
  const extrapModels = new Set(extrapEntries.map((e) => e.modelId));
  const arcModels = [...new Map(extrapEntries.filter((e) => e.effortEstimateSource === "arc-agi-2").map((e) => [e.modelId, e.modelDisplay])).values()];
  const acc = dataset.stats?.effortAccuracy;
  assert.ok(acc?.interp?.intelPts != null && acc.interp.intelPts <= 3.0, `Interp LOOCV error drifted: ${acc?.interp?.intelPts}`);
  assert.ok(acc?.extrap?.intelPts1 != null && acc.extrap.intelPts1 <= 3.5, `Extrap 1-step LOOCV error drifted: ${acc?.extrap?.intelPts1}`);
  assert.ok(acc?.extrap?.intelPtsAll != null && acc.extrap.intelPtsAll <= 5.0, `Extrap all-step LOOCV error drifted: ${acc?.extrap?.intelPtsAll}`);
  console.log(`     Interpolated (${interpModels.length}): ${interpModels.join(", ") || "none"}`);
  console.log(`     Extrapolated (${extrapModels.size} variants across ${extrapEntries.length} rows; ARC-AGI-2 fallback: ${arcModels.length}${arcModels.length ? " — " + arcModels.join(", ") : ""})`);
});

// 10. Shareable URL params, reasoning effort bounds, stale-while-revalidate & CI cache-busting wiring
test("Shareable URL params, effort bounds, stale-while-revalidate cache, and CI cache-busting are wired", () => {
  for (const param of ["bench", "min", "top", "conf", "fable", "billing", "range", "mode", "access", "no5h", "noweekly", "minEffort", "maxEffort", "budget", "cost", "plans", "efforts", "nointerp", "extrap", "est", "extra", "q", "group", "sort"]) {
    assert.ok(appJs.includes(`"${param}"`), `Missing URL param "${param}" in public/app.js`);
  }
  assert.ok(appJs.includes("readCachedDataset") && appJs.includes("writeCachedDataset"), "Missing Cache API stale-while-revalidate in public/app.js");
  assert.ok(appJs.includes("passesEffortBounds") && appJs.includes("passesAccessAndWindow"), "Missing effort/access/window filters in public/app.js");
  assert.ok(html.includes('id="rankMode"') && appJs.includes("pickTopModels"), "Missing Min/Top rank mode (rankMode select + pickTopModels)");
  assert.ok(html.includes('href="./styles.css"') && html.includes('src="./app.js"'), "index.html must reference ./styles.css and ./app.js");
  assert.ok(workflowYml.includes("GITHUB_SHA") && workflowYml.includes("?v="), "deploy.yml missing ?v=${GITHUB_SHA} cache-busting step");
});

// 11. Regression guard: pricing fallbacks recover rows missing upstream listPrice
test("Pricing fallbacks recover Fei2411 and Priors rows with omitted listPrice", () => {
  const has = (planRe, baseModel) =>
    entries.some((e) => e.billing === "subscription" && planRe.test(e.plan) && e.baseModelId === baseModel);
  assert.ok(has(/^Google AI Ultra 20x$/i, "gemini-3-8-flash"), "Missing gemini-3-8-flash on Google AI Ultra 20x");
  assert.ok(has(/^Google AI Ultra 20x$/i, "gemini-4-carbon"), "Missing gemini-4-carbon on Google AI Ultra 20x");
  assert.ok(has(/^Google AI Ultra 20x$/i, "gemini-4-hydrogen"), "Missing gemini-4-hydrogen on Google AI Ultra 20x");
  assert.ok(has(/^GitHub Copilot Pro\+$/i, "claude-sonnet-5-5"), "GitHub Copilot Pro+ must inherit Pro models (claude-sonnet-5-5)");
  assert.ok(has(/^Claude Ultra$/i, "claude-fable-5-2"), "Missing claude-fable-5-2 on Claude Ultra");
  assert.ok(has(/^ChatGPT Pro 20x$/i, "gpt-6-sol"), "Missing gpt-6-sol on ChatGPT Pro 20x");
  assert.ok(has(/^ChatGPT Pro 500$/i, "gpt-6-astra"), "Missing gpt-6-astra on ChatGPT Pro 500");
  assert.ok(has(/^ChatGPT Pro 500$/i, "gpt-6-sol"), "Missing gpt-6-sol on ChatGPT Pro 500");
  assert.ok(has(/^ChatGPT Pro 20x$/i, "gpt-6-1-sol"), "Missing gpt-6-1-sol on ChatGPT Pro 20x");

  // Guard against duplicate active subscription rows (e.g. dated model aliases on the same plan)
  const replaced = new Set(entries.map((e) => e.replacesId).filter(Boolean));
  const activeSubKeys = new Set();
  const modelsByPlan = new Map();
  for (const e of entries) {
    if (e.billing !== "subscription" || replaced.has(e.id)) continue;
    const key = `${e.plan}::${e.baseModelId}::${e.effort}::${e.isOffPeak ? "offpeak" : "std"}`;
    assert.ok(!activeSubKeys.has(key), `Duplicate active subscription entry: ${key}`);
    activeSubKeys.add(key);
    if (!modelsByPlan.has(e.plan)) modelsByPlan.set(e.plan, new Set());
    modelsByPlan.get(e.plan).add(e.baseModelId);
  }

  // Guard tier inheritance across multi-tier subscription ladders
  const ladders = [
    ["GitHub Copilot Pro", "GitHub Copilot Pro+", "GitHub Copilot Max"],
    ["Google AI Pro", "Google AI Ultra 5x", "Google AI Ultra 20x"],
    ["Claude Pro", "Claude Max", "Claude Ultra"],
    ["ChatGPT Plus", "ChatGPT Pro 10x", "ChatGPT Pro 20x", "ChatGPT Pro 500"],
    ["Kimi Plus", "Kimi Pro", "Kimi Max", "Kimi Ultra"],
  ];
  for (const ladder of ladders) {
    for (let i = 0; i < ladder.length - 1; i++) {
      const lo = modelsByPlan.get(ladder[i]) || new Set();
      const hi = modelsByPlan.get(ladder[i + 1]) || new Set();
      const missing = [...lo].filter((m) => !hi.has(m));
      assert.equal(
        missing.length,
        0,
        `${ladder[i + 1]} missing lower-tier models from ${ladder[i]}: ${missing.join(", ")}`
      );
    }
  }
});

// 12. Reliability model (docs/RELIABILITY.md)
const relStats = dataset.stats?.reliability || {};
const chains = dataset.stats?.chains || {};
const LEVEL_RANK = { high: 0, medium: 1, low: 2, speculative: 3 };
const genDate = String(dataset.generatedAt || "").slice(0, 10);
const baseOf = (id) => id.split("@")[0];
const byId = new Map(entries.map((e) => [e.id, e]));
const COST_OF = {
  task: (e) => e.aaCostPerTaskUsd > 0,
  agent: (e) => e.codingAgent?.costPerTaskUsd > 0,
  cursor: (e) => e.cursorBench?.costPerTaskUsd > 0,
  turn: (e) => e.t3Turn?.costPerTurnUsd > 0,
  tokens: () => true,
};

test("Every entry has rel with a valid level, finite σ terms, and a chain in stats.chains", () => {
  for (const e of entries) {
    const r = e.rel;
    assert.ok(r, `Missing rel on ${e.id}`);
    assert.ok(REL.LEVELS.includes(r.level), `Bad rel.level on ${e.id}: ${r.level}`);
    assert.ok(Number.isFinite(r.s) && r.s >= 0, `Bad rel.s on ${e.id}`);
    assert.ok(Number.isFinite(r.sigma) && r.sigma >= r.s - 1e-9, `Bad rel.sigma on ${e.id}`);
    assert.ok(chains[r.chain], `rel.chain ${r.chain} of ${e.id} missing from stats.chains`);
    for (const [m, has] of Object.entries(COST_OF)) {
      if (!has(e)) continue;
      assert.ok(Number.isFinite(r.c?.[m]) && r.c[m] > 0, `Missing rel.c.${m} on ${e.id}`);
      assert.ok(Number.isFinite(r.w?.[m]) && r.w[m] >= 0, `Missing rel.w.${m} on ${e.id}`);
    }
    assert.ok(Number.isFinite(r.score?.ii) && r.score.ii >= 0, `Missing rel.score.ii on ${e.id}`);
    if (Number.isFinite(r.lo)) assert.ok(r.lo < r.hi, `rel range inverted on ${e.id}`);
  }
});

test("Chain arithmetic: rel.s² = Σ step σ²; default level and range follow σ", () => {
  for (const e of entries) {
    const c = chains[e.rel.chain];
    const sum = c.steps.reduce((a, x) => a + x.s * x.s, 0);
    assert.ok(Math.abs(Math.sqrt(sum) - e.rel.s) < 2e-3, `${e.id}: rel.s ${e.rel.s} vs √Σσ² ${Math.sqrt(sum).toFixed(4)}`);
    const sigma = REL.qsum(e.rel.s, e.rel.w.task, e.rel.c.task);
    assert.ok(Math.abs(sigma - e.rel.sigma) < 2e-3, `${e.id}: rel.sigma mismatch`);
    const lvl = REL.worseLevel(REL.levelFromSigma(sigma), REL.levelFromScore(e.rel.score.ii), e.rel.cap);
    assert.equal(e.rel.level, lvl, `${e.id}: level ${e.rel.level} != ${lvl}`);
    if (c.steps.some((x) => x.k === "M4" || x.k === "M5")) assert.equal(e.rel.level, "speculative", `${e.id}: M4/M5 step must be Speculative`);
    const S = e.billing === "metered" ? 1 : e.subsidyMultiple * (e.quotaMix?.task?.f ?? 1);
    if (!e.unmetered && S > 0 && Number.isFinite(e.rel.lo)) {
      const real = e.aaCostPerTaskUsd / S;
      assert.ok(Math.abs(e.rel.lo / (real * Math.exp(-REL.Z80 * sigma)) - 1) < 2e-3, `${e.id}: rel.lo off`);
      assert.ok(Math.abs(e.rel.hi / (real * Math.exp(REL.Z80 * sigma)) - 1) < 2e-3, `${e.id}: rel.hi off`);
    }
  }
});

test("A derived value is never above its source's level; upstream grade is a ceiling", () => {
  let checked = 0;
  for (const e of entries) {
    const c = chains[e.rel.chain];
    const anchorId = c.anchors?.[0];
    if (anchorId && REL.chainDerived(c)) {
      const effId = e.effort && e.id.includes("@") ? `${anchorId}@${e.effort}` : anchorId;
      const a = byId.get(effId) || entries.find((x) => baseOf(x.id) === anchorId);
      if (a) {
        checked++;
        const drop = c.drop || 0;
        assert.ok(e.rel.s * e.rel.s + drop >= a.rel.s * a.rel.s - 1e-6, `${e.id} σ_S ${e.rel.s} below its anchor ${a.id} ${a.rel.s}`);
        const lvl = (x, d = 0) => REL.levelFromSigma(Math.sqrt(x.rel.s * x.rel.s + d));
        assert.ok(LEVEL_RANK[lvl(e, drop)] >= LEVEL_RANK[lvl(a)], `${e.id} subsidy level above anchor ${a.id}`);
      }
    }
    if ((e.origin === "fei2411" || e.origin === "priors-repo") && LEVEL_RANK[e.confidence] != null) {
      assert.ok(LEVEL_RANK[e.rel.level] >= LEVEL_RANK[e.confidence], `${e.id}: level ${e.rel.level} above upstream ${e.confidence}`);
    }
  }
  assert.ok(checked >= 50, `Too few derived rows checked: ${checked}`);
});

test("Placeholder (M4) carryovers are Speculative; no ChatGPT 10x→20x or Fable 5.1→5.2 placeholder remains", () => {
  let m4 = 0;
  for (const e of entries) {
    const c = chains[e.rel.chain];
    if (c.steps.some((x) => x.k === "M4" || x.k === "M5")) {
      m4++;
      assert.equal(e.rel.level, "speculative", `${e.id} has an M4/M5 step but level ${e.rel.level}`);
    }
    assert.ok(!(e.origin === "shared-pool-assumed" && /^ChatGPT Pro 20x$/.test(e.plan)), `ChatGPT 10x→20x carryover still present: ${e.id}`);
    assert.ok(!(e.origin === "shared-pool-assumed" && /claude-fable/.test(e.baseModelId)), `Fable carryover placeholder still present: ${e.id}`);
  }
  console.log(`     M4/M5 rows (Speculative): ${m4}`);
});

test("Expired promotions and stale quota rows are absent", () => {
  for (const p of relStats.promoExpiry || []) {
    if (genDate <= p.until) continue;
    const hit = entries.filter((e) => e.plan === p.plan && e.baseModelId === p.model);
    assert.equal(hit.length, 0, `Expired promo still listed: ${p.plan} × ${p.model}`);
  }
  assert.ok(!entries.some((e) => e.plan === "Claude Pro" && e.baseModelId === "claude-fable-5-2"), "Claude Pro × Fable 5.2 launch-week row must be gone");
  for (const q of relStats.quotaChanges || []) {
    for (const e of entries.filter((x) => x.plan === q.plan && x.baseModelId === q.model && !REL.chainDerived(chains[x.rel.chain]))) {
      const d = REL.lastDate(e.dataDate);
      assert.ok(!(d && d < q.date) || e.rel.level === "speculative", `${e.id} predates quota change ${q.date}`);
    }
  }
  for (const r of relStats.modelRetirements || []) {
    if (genDate > r.after) assert.ok(!entries.some((e) => e.baseModelId === r.model), `Retired model ${r.model} still listed`);
  }
  for (const e of entries) {
    const d = REL.lastDate(e.dataDate);
    const sampled = chains[e.rel.chain].steps.some((x) => ["S3", "S4", "S5", "S6", "T", "prelim"].includes(x.k));
    if (sampled && d && REL.daysBetween(d, genDate) > 90) assert.notEqual(e.rel.level, "high", `${e.id}: data older than 90 days is High`);
  }
});

test("Cross-plan consistency quads: fails are flagged and allow-listed", () => {
  const cons = relStats.consistency || [];
  const quads = cons.filter((x) => x.type === "quad");
  assert.ok(quads.length >= 5, `Expected informative quads, got ${quads.length}`);
  // Known pending Fei2411 case: Opus 5 vs Opus 5.5 multiples move ×1.8–2.1 across Claude plans
  // (Fei notes it on claude_pro::claude-opus-5 as 张力 … 待裁定).
  const ALLOW = [/^Claude:claude-opus-5\/claude-opus-5-5:/];
  for (const q of cons) {
    if (q.verdict !== "fail") continue;
    const flagged = entries.find((e) => baseOf(e.id) === q.flagged);
    assert.ok(flagged, `Fail without a flagged cell: ${JSON.stringify(q)}`);
    assert.ok(chains[flagged.rel.chain].flags.includes("inconsistent"), `${q.flagged} not flagged inconsistent`);
    if (q.type === "quad") {
      const key = `${q.family}:${q.a}/${q.b}:${q.p}/${q.q}`;
      assert.ok(ALLOW.some((re) => re.test(key)), `Consistency fail not allow-listed: ${key} ×${q.ratio}`);
    }
  }
  for (const q of quads) {
    if (Math.abs(q.D) > Math.log(1.6)) assert.equal(q.verdict, "fail", `|D| > ln 1.6 not failed: ${JSON.stringify(q)}`);
  }
  const warns = cons.filter((x) => x.verdict === "warn");
  console.log(`     Quads: ${quads.length} informative, ${quads.filter((x) => x.verdict === "fail").length} fail, ${warns.length} warn; pool checks: ${cons.filter((x) => x.type === "pool").length}`);
});

test("Priors records with plans: [] are parsed (ratio, readings, sameAs, paid); free tiers are not plans", () => {
  const fable = entries.filter((e) => e.plan === "Claude Ultra" && e.baseModelId === "claude-fable-5-2");
  assert.ok(fable.length > 0, "Missing Fable 5.2 × Claude Ultra");
  for (const e of fable) {
    assert.ok(e.subsidyMultiple > 25 && e.subsidyMultiple < 30, `Fable 5.2 × Ultra ${e.subsidyMultiple}× not ≈27×`);
    assert.ok(e.subsidyReadings && Math.abs(e.subsidyReadings.own - 13.6) < 0.5, `Fable 5.2 × Ultra "own" reading ${e.subsidyReadings?.own}`);
    assert.equal(e.origin, "priors-repo");
  }
  const max = entries.filter((e) => e.plan === "Claude Max" && e.baseModelId === "claude-fable-5-2");
  assert.ok(max.length > 0 && max.every((e) => e.origin === "ratio-transfer" && e.subsidyMultiple > 25 && e.subsidyMultiple < 37), "Fable 5.2 × Claude Max must come from ratio transfer (≈31×)");
  assert.ok(entries.some((e) => /^Command Code Max/.test(e.plan) && e.baseModelId === "muse-wonder"), "Missing Priors ratio record Command Code Max 10× × Muse Wonder");
  assert.ok(!entries.some((e) => /free tier/i.test(e.plan)), "A free tier became a paid plan");
  const ALLOWED = new Set(["free tier", "carried by shared-pool rule", "no list price"]);
  for (const sk of relStats.priorsSkipped || []) {
    assert.ok(ALLOWED.has(sk.reason) || /^sameAs .* has no plans$/.test(sk.reason), `Priors record skipped for "${sk.reason}": ${sk.modelId} ${sk.plan}`);
  }
});

test("Neon anchor pools Fei direct and Priors preliminary by 1/σ²", () => {
  for (const plan of ["Google AI Pro", "Google AI Ultra 5x", "Google AI Ultra 20x"]) {
    const rows = entries.filter((e) => e.plan === plan && e.baseModelId === "gemini-4-neon");
    assert.ok(rows.length > 0, `Missing Neon on ${plan}`);
    assert.ok(rows.every((e) => e.origin === "fei2411" && e.pooled), `Neon on ${plan} is not a pooled Fei row`);
    const p = rows[0].pooled;
    const lo = Math.min(p.fei, p.priors), hi = Math.max(p.fei, p.priors);
    assert.ok(rows[0].subsidyMultiple >= lo - 1e-6 && rows[0].subsidyMultiple <= hi + 1e-6, `Pooled Neon on ${plan} outside its sources`);
    assert.ok(p.weightFei > 0 && p.weightFei < 1, `Bad pooling weight on ${plan}`);
    assert.ok(chains[rows[0].rel.chain].flags.includes("pooled"));
    for (const t of ["gemini-4-carbon", "gemini-4-hydrogen"]) {
      const c = entries.find((e) => e.plan === plan && e.baseModelId === t);
      assert.ok(c && Math.abs(c.subsidyMultiple - rows[0].subsidyMultiple) < 1e-3, `${t} on ${plan} must carry the pooled Neon multiple`);
    }
  }
});

test("Kimi K3.1 Pro carries K3's token pool × list-price blend ratio (≈0.667)", () => {
  for (const plan of ["Kimi Plus", "Kimi Pro", "Kimi Max", "Kimi Ultra"]) {
    const k3 = entries.find((e) => e.plan === plan && e.baseModelId === "kimi-k3");
    const k31 = entries.find((e) => e.plan === plan && e.baseModelId === "kimi-k3-1-pro");
    if (!k3 || !k31) continue;
    const r = k31.subsidyMultiple / k3.subsidyMultiple;
    assert.ok(Math.abs(r - 2 / 3) < 0.01, `${plan}: K3.1 Pro / K3 = ${r.toFixed(3)}`);
  }
});

test("Fable on Claude plans: capShare 0.5, both readings, own = shared × capShare", () => {
  for (const e of entries.filter((x) => /^Claude (Pro|Max|Ultra)$/.test(x.plan) && /^claude-fable-/.test(x.baseModelId))) {
    assert.equal(e.capShare, 0.5, `capShare on ${e.id}`);
    assert.ok(e.subsidyReadings, `readings on ${e.id}`);
    assert.ok(Math.abs(e.subsidyReadings.own / (e.subsidyReadings.shared * 0.5) - 1) < 0.01, `own ≠ shared × 0.5 on ${e.id}`);
    assert.equal(e.subsidyMultiple, e.subsidyReadings.shared, `default reading must be Shared on ${e.id}`);
  }
  assert.ok(/capShare/.test(appJs), "Tasks/mo must use capShare");
});

// ---- Quota weights (docs/QUOTA-WEIGHTS.md) ----
const QW_FIT_PATH = path.join(ROOT, "data", "quota-weights", "fit.json");
const qwFit = fs.existsSync(QW_FIT_PATH) ? JSON.parse(fs.readFileSync(QW_FIT_PATH, "utf8")) : null;
const QW_KINDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
const QW_GATES = ["coverage", "loso", "agreement", "holdout", "simulation"];

test("Quota weights: submissions validate; fit.json schema, gate consistency, identifiability", () => {
  assert.ok(qwFit, "data/quota-weights/fit.json missing");
  assert.equal(qwFit.schema, "quota-weights.fit/1");
  assert.ok(Number.isFinite(Date.parse(qwFit.generatedAt)), "generatedAt");
  assert.equal(typeof qwFit.simulation?.pass, "boolean", "simulation result missing");
  const prices = QW.loadPrices();
  const subs = QW.loadSubmissions(QW.SUBMISSIONS_DIR, prices);
  assert.ok(subs.length >= 4, `expected the seed submissions, found ${subs.length}`);
  for (const s of subs) assert.equal(s.error, null, `${s.file} rejected: ${s.error}`);
  assert.deepEqual(qwFit.submissions.map((s) => s.file).sort(), subs.map((s) => s.file).sort(), "fit.json submissions differ from the files on disk");
  const keys = new Set();
  for (const c of qwFit.cells) {
    assert.match(c.key, /^[a-z]+\/[a-z0-9-]+\/(5h|7d)\/(interactive|sdk)$/, `cell key ${c.key}`);
    assert.ok(!keys.has(c.key), `duplicate cell ${c.key}`);
    keys.add(c.key);
    assert.ok(["validated", "provisional", "unmeasured"].includes(c.status), `${c.key}: status ${c.status}`);
    assert.deepEqual(Object.keys(c.gate).sort(), [...QW_GATES].sort(), `${c.key}: gate keys`);
    for (const g of QW_GATES) assert.equal(typeof c.gate[g], "boolean", `${c.key}: gate.${g}`);
    assert.equal(c.status === "validated", QW_GATES.every((g) => c.gate[g]), `${c.key}: validated iff all five gates pass`);
    const anyId = Object.values(c.identified).some(Boolean);
    if (c.status !== "validated") assert.equal(c.status === "provisional", anyId, `${c.key}: provisional iff some kind identified`);
    assert.equal(c.weights.input, 1, `${c.key}: weights.input must be 1`);
    assert.deepEqual(c.drawKinds, QW_KINDS, `${c.key}: drawKinds`);
    assert.ok(c.draws.length <= 200, `${c.key}: too many draws`);
    for (const k of QW_KINDS.slice(1)) {
      if (!c.identified[k]) {
        assert.equal(c.weights[k], null, `${c.key}: unidentified ${k} reported as a number`);
        assert.ok(!c.ci95[k], `${c.key}: interval on unidentified ${k}`);
        for (const d of c.draws) assert.equal(d[QW_KINDS.indexOf(k)], null, `${c.key}: draw value on unidentified ${k}`);
      } else {
        assert.ok(c.weights[k] >= 0, `${c.key}: ${k} weight`);
        assert.ok(Array.isArray(c.ci95[k]), `${c.key}: identified ${k} has no interval`);
        assert.ok(c.ci95[k][0] <= c.weights[k] + 1e-6 && c.weights[k] <= c.ci95[k][1] + 1e-6, `${c.key}: ${k} outside its interval`);
      }
    }
    for (const d of c.draws) assert.equal(d[0], 1, `${c.key}: draw input weight`);
    // φ of a pure-input mix is 1 in every cell
    assert.equal(REL.phiQuota({ input: 5 }, c.weights), 1, `${c.key}: φ(pure input) ≠ 1`);
    assert.ok(Number.isInteger(c.n.sessions) && Number.isInteger(c.n.segments), `${c.key}: n`);
  }
  for (const m of Object.keys(prices.models)) for (const b of ["5h", "7d"]) for (const cl of ["interactive", "sdk"]) assert.ok(keys.has(`anthropic/${m}/${b}/${cl}`), `cell anthropic/${m}/${b}/${cl} missing`);
  // Seeds are public single-account measurements: never validated.
  assert.ok(!qwFit.cells.some((c) => c.status === "validated" && c.n.sessions && subs.every((s) => s.header.seed)), "a cell built only from seed data is validated");
  // fit.json is current: point estimates, identification and counts from the files on disk (bootstrap-independent)
  const segs = QW.buildSegments(subs, prices);
  for (const c of qwFit.cells.filter((x) => x.n.segments)) {
    const r = QW.fitCell(c.key, segs, { boot: 40, perm: 0, simulationPass: qwFit.simulation.pass });
    for (const k of QW_KINDS) assert.ok(r.weights[k] === c.weights[k] || Math.abs(r.weights[k] - c.weights[k]) < 1e-6, `${c.key}: ${k} ${r.weights[k]} ≠ fit.json ${c.weights[k]} (rerun node scripts/fit-quota-weights.mjs)`);
    assert.deepEqual(r.identified, c.identified, `${c.key}: identified differs from fit.json`);
    assert.deepEqual({ ...r.n }, { ...c.n }, `${c.key}: counts differ from fit.json`);
    for (const g of ["coverage", "loso", "holdout", "simulation"]) assert.equal(r.gate[g], c.gate[g], `${c.key}: gate.${g} differs from fit.json`);
  }
  // docs table equals fit.json
  const doc = fs.readFileSync(path.join(ROOT, "docs", "QUOTA-WEIGHTS.md"), "utf8");
  assert.ok(doc.includes(QW.docTableBlock(qwFit)), "docs/QUOTA-WEIGHTS.md table differs from fit.json (rerun node scripts/fit-quota-weights.mjs)");
});

test("Quota weights: simulation recovers known weights (|bias| ≤ 1%, 95% half-width ≤ 7%)", () => {
  const a = QW.simulationAssertion({ runs: 200, seed: 1 });
  for (const k of QW_KINDS.slice(1)) {
    const r = a.recovery[k];
    assert.ok(Math.abs(r.bias) <= 0.01, `${k}: bias ${(100 * r.bias).toFixed(2)}%`);
    assert.ok(r.half95 <= 0.07, `${k}: 95% half-width ${(100 * r.half95).toFixed(2)}%`);
  }
  assert.equal(a.pass, true);
  // the probe's dry-run path: sessions it writes are segmented and fitted back to the truth
  const rand = QW.rng(5);
  const sub = QW.simulateSession({ rand, pointsPerArm: 5, noise: 0 });
  const price = QW.priceFor({ models: { "claude-opus-5-5": Object.fromEntries(QW_KINDS.map((k) => [k, QW.SIM_PRICE[k] * 1e6])) } }, "claude-opus-5-5");
  const segs = QW.sessionSegments(sub, price, "5h").map((s) => ({ ...s, group: "g", session: "s", r: (s.boundary[0] ** 2 + s.boundary[1] ** 2) / 12 + 1e-4 }));
  assert.equal(segs.length, 5, "one anchored segment per arm");
  const f = QW.fitSegments(segs);
  for (const k of QW_KINDS.slice(1)) assert.ok(Math.abs(f.w[k] / QW.SIM_TRUE_W[k] - 1) < 0.03, `no-noise recovery of ${k}: ${f.w[k]}`);
});

test("Quota weights: gate logic (validated / provisional / unmeasured)", () => {
  const all = Object.fromEntries(QW_GATES.map((g) => [g, true]));
  assert.equal(QW.gateStatus({ ...all, anyIdentified: true }).status, "validated");
  for (const g of QW_GATES) {
    assert.equal(QW.gateStatus({ ...all, [g]: false, anyIdentified: true }).status, "provisional", `${g} failing must block validation`);
    assert.equal(QW.gateStatus({ ...all, [g]: false, anyIdentified: false }).status, "unmeasured");
  }
  // End to end on simulated protocol sessions: 3 sessions, 2 accounts, 2 submitters, a holdout.
  const prices = { models: { "claude-opus-5-5": { vendor: "anthropic", input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } } };
  const rand = QW.rng(11);
  const mk = (o) => {
    const s = o.holdout ? QW.simulateHoldoutSession({ rand, ...o }) : QW.simulateSession({ rand, pointsPerArm: 3, noise: 0.01, ...o });
    const sub = { file: o.sessionId, header: { ...s.header, simulated: false, raw: { url: "sim" }, label_emulated: Boolean(o.emulated) }, rows: s.rows };
    sub.error = QW.validateSubmission(sub, prices);
    return sub;
  };
  const a1 = mk({ sessionId: "a1", account: "acctA", submitter: "alice" });
  const a2 = mk({ sessionId: "a2", account: "acctA", submitter: "alice" });
  const b1 = mk({ sessionId: "b1", account: "acctB", submitter: "bob" });
  const h1 = mk({ sessionId: "h1", account: "acctH", submitter: "carol", holdout: true });
  const key = "anthropic/claude-opus-5-5/5h/sdk";
  const run = (subs, simulationPass = true) => QW.fitCell(key, QW.buildSegments(subs, prices), { boot: 100, perm: 30, simulationPass });
  const v = run([a1, a2, b1, h1]);
  assert.equal(v.status, "validated", `expected validated, gate ${JSON.stringify(v.gate)}`);
  for (const k of QW_KINDS.slice(1)) assert.ok(Math.abs(v.weights[k] / QW.SIM_TRUE_W[k] - 1) < 0.05, `${k}: ${v.weights[k]}`);
  assert.equal(run([a1, a2, b1]).status, "provisional", "no holdout must not validate");
  assert.equal(run([a1, a2, h1]).gate.coverage, false, "one account must fail G1");
  assert.equal(run([a1, a2, b1, h1], false).status, "provisional", "failed simulation must not validate");
  const e1 = mk({ sessionId: "e1", account: "acctE", submitter: "erin", emulated: true });
  assert.equal(run([e1]).gate.coverage, false, "emulated-label sessions alone must fail G1");
  assert.equal(run([a1, a2, b1, h1, e1]).n.excludedEmulated, 1, "emulated sessions excluded when real ones exist");
  const shared = mk({ sessionId: "s1", account: "acctS", submitter: "sam" });
  shared.header.shared_account = true;
  assert.ok(QW.validateSubmission(shared, prices), "shared_account must be rejected");
  const sim = mk({ sessionId: "d1", account: "acctD", submitter: "dan" });
  sim.header.simulated = true;
  assert.ok(QW.validateSubmission(sim, prices), "dry-run files must be rejected");
  assert.equal(QW.fitCell("anthropic/claude-opus-5-5/7d/interactive", [], {}).status, "unmeasured");
});

test("Quota weights: the build applies the Claude mix correction only for validated cells", () => {
  const q = relStats.claudeMixCorrection;
  assert.ok(q && typeof q === "object", "stats.reliability.claudeMixCorrection missing");
  assert.equal(typeof q.forcedOff, "boolean");
  assert.equal(typeof q.fit?.present, "boolean");
  assert.ok(q.cells && Object.values(q.cells).every((s) => ["validated", "provisional", "unmeasured"].includes(s)), "cell statuses");
  if (qwFit) for (const c of qwFit.cells) assert.equal(q.cells[c.key], c.status, `${c.key}: build status differs from fit.json`);
  const claude = entries.filter((e) => /^Claude (Pro|Max|Ultra|Team)\b/.test(e.plan) && e.billing === "subscription" && !e.unmetered);
  assert.ok(claude.length > 50, "Too few Claude rows");
  let applied = 0;
  for (const e of entries) {
    if (!claude.includes(e)) {
      assert.ok(!e.quotaMix, `Non-Claude row ${e.id} has a mix correction`);
      continue;
    }
    // σ_mix floor: 0.03 where the fitted correction is applied, the uncorrected range (≥ 0.05) elsewhere
    assert.ok(e.rel.w.task >= (e.quotaMix?.task ? 0.03 : 0.05) - 1e-9, `${e.id}: Claude mix σ missing`);
    assert.ok(e.rel.mix && Array.isArray(e.rel.mix.cells), `${e.id}: rel.mix missing`);
    const statuses = e.rel.mix.cells.map((k) => q.cells[k] || "unmeasured");
    if (e.quotaMix) {
      applied++;
      assert.ok(!q.forcedOff, `${e.id}: correction applied while forced off`);
      assert.ok(statuses.every((s) => s === "validated"), `${e.id}: correction applied with cells ${JSON.stringify(e.rel.mix.cells)} → ${statuses}`);
      for (const [m, x] of Object.entries(e.quotaMix)) {
        assert.ok(x.f >= 0.5 && x.f <= 1.5, `${e.id} ${m}: F ${x.f} outside 0.5–1.5`);
        assert.ok(x.lo <= x.f + 1e-9 && x.f <= x.hi + 1e-9, `${e.id} ${m}: F outside its range`);
        assert.ok(e.rel.w[m] >= 0.03 - 1e-9, `${e.id} ${m}: applied σ_mix below 0.03`);
      }
    } else if (statuses.every((s) => s === "validated") && !q.forcedOff) {
      // validated but not applicable (no own token breakdown, several sample models): uncorrected
      assert.equal(e.rel.mix.applied, false);
    }
  }
  assert.equal(applied, q.rows.applied, "rows.applied out of sync");
  // Decision rule
  const V = { status: "validated" };
  const P = { status: "provisional" };
  const U = { status: "unmeasured" };
  assert.equal(REL.quotaMixDecision({ cells: [V, V] }).apply, true);
  assert.equal(REL.quotaMixDecision({ cells: [V, P] }).apply, false);
  assert.equal(REL.quotaMixDecision({ cells: [V, U] }).status, "unmeasured");
  assert.equal(REL.quotaMixDecision({ cells: [V], forcedOff: true }).apply, false);
  assert.equal(REL.quotaMixDecision({ cells: [V], sampleKnown: false }).apply, false);
  assert.equal(REL.quotaMixDecision({ cells: [V], singleSampleModel: false }).apply, false);
  assert.equal(REL.quotaMixDecision({ cells: [] }).apply, false);
  assert.equal(REL.parseQuotaFit("not json").present, false, "unreadable fit.json → no cells");
  // Fitted correction on a synthetic validated cell (reads 0.5, 1h writes 0.6)
  const rand = QW.rng(3);
  const cell = {
    status: "validated",
    weights: { input: 1, output: 1, cacheRead: 0.5, cacheWrite5m: 0.9, cacheWrite1h: 0.6 },
    drawKinds: QW_KINDS,
    draws: Array.from({ length: 200 }, () => [1, 1 + 0.01 * (rand() - 0.5), 0.5 + 0.02 * (rand() - 0.5), 0.9, 0.6 + 0.02 * (rand() - 0.5)]),
    tauBetween: { cacheRead: 0.02 },
  };
  const sample = { read: 260, w1h: 44.8, input: 0.092, output: 60 }; // Fei Max 5x × Opus 5.5 sample, list $
  const aa = { read: 4.738, w5m: 1.796, input: 0.036, output: 3.466 }; // AA Opus 5.5 breakdown, list $
  const r = REL.quotaMixFromCells({ sampleMix: sample, metricMix: aa, sampleCell: cell, metricCell: cell, p1hOver5m: 1.6 });
  const ps = (0.5 * 260 + 0.6 * 44.8 + 0.092 + 60) / (260 + 44.8 + 0.092 + 60);
  const pm = (0.5 * 4.738 + 0.6 * 1.6 * 1.796 + 0.036 + 3.466) / (4.738 + 1.796 + 0.036 + 3.466);
  assert.ok(Math.abs(r.f - ps / pm) < 1e-3, `F ${r.f} vs ${ps / pm}`);
  assert.ok(r.lo <= r.f && r.f <= r.hi && r.sigma >= 0.03, `range / σ floor: ${JSON.stringify(r)}`);
  const wide = { ...cell, draws: cell.draws.map((d, i) => [1, 1, i % 2 ? 0.2 : 1.6, 0.9, 0.6]) };
  assert.equal(REL.quotaMixFromCells({ sampleMix: sample, metricMix: aa, sampleCell: wide, metricCell: wide }).f, 1, "G6: a range containing 1 sets F = 1");
  assert.equal(REL.quotaMixFromCells({ sampleMix: sample, metricMix: aa, sampleCell: { ...cell, weights: { ...cell.weights, cacheWrite1h: null } }, metricCell: cell }), null, "a needed weight that is null blocks the correction");
});

test("AA cost breakdowns sum to total; T3 harness ratios present", () => {
  let n = 0;
  for (const e of entries) {
    const b = e.aaCostPerTaskBreakdown;
    if (!b?.total) continue;
    n++;
    const sum = (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.nonCacheInput || 0) + (b.output || 0);
    assert.ok(Math.abs(sum / b.total - 1) < 0.01, `${e.id}: breakdown sums to ${sum} of ${b.total}`);
  }
  assert.ok(n > 0, "No AA cost breakdowns");
  const h = relStats.t3Harness || {};
  for (const slug of ["codex", "claude-code"]) {
    assert.ok(h[slug]?.n >= 5, `t3Harness.${slug} n = ${h[slug]?.n}`);
    assert.ok(h[slug].ratio > 0 && h[slug].ratio < 5, `t3Harness.${slug} ratio ${h[slug].ratio}`);
  }
});

test("Parser coverage: Fei derived rows resolve an anchor; no silent carry", () => {
  const unresolved = relStats.unresolved || [];
  assert.ok(relStats.feiDerived > 0, "No Fei derived rows counted");
  assert.ok(unresolved.length / relStats.feiDerived <= 0.05, `${unresolved.length}/${relStats.feiDerived} Fei derived rows unresolved: ${unresolved.join(", ")}`);
  for (const e of entries) {
    if (["shared-pool-assumed", "ratio-transfer", "priors-assumed"].includes(e.origin)) {
      assert.ok(REL.chainDerived(chains[e.rel.chain]), `${e.id} carries a subsidy without a transfer step`);
    }
    assert.ok(!e.replacesId, `${e.id} still uses replacesId`);
  }
});

test("Level counts and UI wiring (Min confidence, Cost, Fable cap, glyphs)", () => {
  const counts = { high: 0, medium: 0, low: 0, speculative: 0 };
  for (const e of entries) counts[e.rel.level]++;
  assert.deepEqual(counts, relStats.counts, "stats.reliability.counts out of sync");
  if (counts.speculative > entries.length * 0.08) console.warn(`WARN  Speculative ${counts.speculative} > 8% of entries`);
  if (counts.high < entries.length * 0.3) console.warn(`WARN  High ${counts.high} < 30% of entries`);
  console.log(`     Levels: ${JSON.stringify(counts)}`);
  for (const id of ["minConf", "costView", "fableCap", "relLegend"]) assert.ok(html.includes(`id="${id}"`), `Missing #${id}`);
  for (const id of ["hideEstimated", "showTier-high", "estFootnote"]) assert.ok(!html.includes(`id="${id}"`), `Old control #${id} still present`);
  const opts = (id) => [...(html.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`))?.[0] || "").matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(opts("minConf"), ["high", "medium", "low", "speculative"]);
  assert.deepEqual(opts("costView"), ["point", "range"]);
  assert.deepEqual(opts("fableCap"), ["shared", "own"]);
  assert.ok(/<option value="medium" selected>/.test(html.match(/<select id="minConf"[\s\S]*?<\/select>/)[0]), "Min confidence default must be Medium");
  assert.ok(appJs.includes('speculative: "◌"') && appJs.includes('high: "●"'), "Level glyphs missing");
  assert.ok(!/est-star|estMark|interpMark/.test(appJs), "Old * / tier markers still rendered");
  // Bar chart follows Min confidence like the table (a fixed Medium floor hid every Claude first-party plan).
  assert.ok(!appJs.includes("CHART_MIN_CONF") && /renderBarChart[\s\S]{0,500}passesConf\(r, state\.minConf\)/.test(appJs), "Bar chart must follow the Min confidence setting");
  // Legacy est= mapping
  for (const [k, v] of [["0", "high"], ["h", "medium"], ["hm", "low"], ["hml", "speculative"]]) {
    assert.ok(appJs.includes(`${k === "0" ? "0" : k}: "${v}"`), `Legacy est=${k} → ${v} mapping missing`);
  }
});

// 13. Site: phone card table, self-hosted font, T3 Hours/mo, drawer provenance
const cssText = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const fnBody = (name) => {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `Missing function ${name}`);
  const next = appJs.indexOf("\nfunction ", start + 1);
  return appJs.slice(start, next === -1 ? undefined : next);
};

test("Full table cells carry data-label (phone card rows) with Sort and Show 50 more", () => {
  const body = fnBody("renderTable");
  const tds = [...body.matchAll(/<td\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(tds.length >= 20, `Too few <td> templates in renderTable: ${tds.length}`);
  const unlabeled = tds.filter((t) => !t.includes("${dl(") && !/class="(card-sub|empty)"/.test(t));
  assert.equal(unlabeled.length, 0, `Table cells without data-label: ${unlabeled.join(" | ")}`);
  assert.ok(/const dl = \(key\) => ` data-label="\$\{esc\(labelOf\[key\]\)\}"`/.test(body), "dl() must emit the column label");
  assert.ok(/<tr class="group-row"[\s\S]*?\$\{dl\("model"\)\}/.test(body), "Group rows must carry data-label");
  assert.ok(/td\[data-label\]::before\s*\{\s*content:\s*attr\(data-label\)/.test(cssText), "Missing td[data-label]::before { content: attr(data-label) }");
  assert.ok(/@media \(max-width: 600px\)[\s\S]*\.data-table thead\s*\{\s*display: none;/.test(cssText), "Phone card view must hide the table header");
  for (const id of ["tableSort", "tableSortDir", "tableMore", "tableMoreBtn"]) assert.ok(html.includes(`id="${id}"`), `Missing #${id}`);
  assert.ok(/TABLE_PAGE = 50/.test(appJs) && /state\.tableLimit \+= TABLE_PAGE/.test(appJs), "Show 50 more must page by 50");
  assert.ok(/tr\.group-row\s*\{[^}]*min-height: 44px/.test(cssText), "Phone group rows must be >= 44px");
});

test("DejaVu Sans subset is self-hosted, licensed, and follows Verdana in the font stacks", () => {
  const faces = [...cssText.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(faces.length >= 1, "No @font-face in styles.css");
  let total = 0;
  for (const face of faces) {
    assert.ok(/font-family:\s*"DejaVu Sans"/.test(face), "@font-face must define DejaVu Sans");
    const url = face.match(/url\("\.\/(fonts\/[^"]+\.woff2)"\)/)?.[1];
    assert.ok(url, `@font-face without a ./fonts/*.woff2 url: ${face}`);
    const file = path.join(ROOT, "public", url);
    assert.ok(fs.existsSync(file), `Font file missing: ${url}`);
    const buf = fs.readFileSync(file);
    assert.equal(buf.subarray(0, 4).toString("latin1"), "wOF2", `${url} is not woff2`);
    total += buf.length;
  }
  assert.ok(total <= 60 * 1024, `Font files total ${total} bytes (> 60 KB)`);
  assert.ok(fs.existsSync(path.join(ROOT, "public", "fonts", "LICENSE")), "Missing public/fonts/LICENSE");
  const stacks = [...cssText.matchAll(/font(?:-family)?:[^;]*Verdana[^;]*;/g)].map((m) => m[0]);
  assert.ok(stacks.length >= 5, "Too few Verdana font stacks");
  for (const s of stacks) assert.ok(/Verdana, "DejaVu Sans"/.test(s), `DejaVu Sans must follow Verdana: ${s}`);
});

test("Hours/mo column appears in T3 turn mode only, = fee ÷ real $/turn × min/turn ÷ 60", () => {
  const body = fnBody("renderTable");
  assert.ok(/isTurn \? \[\{ key: "hoursPerMonth", label: "Hours\/mo"/.test(body), "Hours/mo column must be gated on turn mode");
  assert.ok(/isTurn \? `<td[^`]*\$\{dl\("hoursPerMonth"\)\}/.test(body), "Hours/mo cell must be gated on turn mode");
  assert.ok(/const isTurn = state\.costMode === "turn"/.test(body));
  assert.ok(/mode === "turn" && minPerTurn > 0/.test(appJs) && /\(volumePerMonth \* minPerTurn\) \/ 60/.test(appJs), "hoursPerMonth formula changed");
  const withMin = entries.filter((e) => e.billing === "subscription" && !e.unmetered && e.t3Turn?.minutesPerTurn > 0 && e.priceUsd > 0);
  assert.ok(withMin.length >= 50, `Only ${withMin.length} subscription rows have minutesPerTurn`);
  for (const e of withMin) {
    const realTurn = e.t3Turn.costPerTurnUsd / (e.subsidyMultiple * (e.quotaMix?.turn?.f ?? 1));
    const hours = ((e.priceUsd / realTurn) * (e.capShare ?? 1) * e.t3Turn.minutesPerTurn) / 60;
    assert.ok(Number.isFinite(hours) && hours > 0 && hours < 1e6, `Implausible Hours/mo ${hours} on ${e.id}`);
  }
});

test("Plan drawer lists subsidy provenance from stats.chains", () => {
  const body = fnBody("renderProvenance");
  assert.ok(/subsidySources\(e\)/.test(body) && /subsidyText\(e\)/.test(body), "Provenance must reuse the tooltip's subsidy sources");
  assert.ok(/renderProvenance\(planEntries, models\)/.test(fnBody("renderPlanDrawer")), "Drawer must render provenance");
  assert.ok(/chain\?\.lines/.test(fnBody("subsidySources")), "Sources must come from stats.chains lines");
  const missing = entries.filter((e) => e.billing === "subscription" && !(chains[e.rel.chain]?.lines?.length));
  assert.ok(missing.length <= entries.length * 0.05, `${missing.length} subscription rows have no chain lines`);
});

// Billing period (Monthly | Yearly): app.js billingView() is evaluated against the dataset.
const subsEntries = entries.filter((e) => e.billing === "subscription");
const extractFn = (re, name) => {
  const m = appJs.match(re);
  assert.ok(m, `Missing ${name} in public/app.js`);
  return m[0];
};
const billingSrc = [
  extractFn(/const parseBillingParam = [^\n]+\n/, "parseBillingParam"),
  extractFn(/function billingView\(e, billing\) \{[\s\S]*?\n\}\n/, "billingView"),
].join("\n");
const { parseBillingParam, billingView } = new Function(`${billingSrc}; return { parseBillingParam, billingView };`)();

test("Billing: every subscription entry has priceUsdMonthly; yearly ≤ monthly; table rows are complete", () => {
  for (const e of subsEntries) {
    assert.ok(e.priceUsdMonthly > 0, `${e.id} lacks priceUsdMonthly`);
    assert.ok(e.priceUsdYearly === null || e.priceUsdYearly > 0, `${e.id} priceUsdYearly must be > 0 or null`);
    if (e.priceUsdYearly != null) assert.ok(e.priceUsdYearly <= e.priceUsdMonthly + 1e-6, `${e.id} yearly ${e.priceUsdYearly} > monthly ${e.priceUsdMonthly}`);
    assert.ok(["official", "none", "unknown", "variant"].includes(e.billingYearly), `${e.id} billingYearly ${e.billingYearly}`);
  }
  for (const r of BILLING_PERIODS) {
    assert.ok(["official", "none", "unknown"].includes(r.status), `${r.plan} status ${r.status}`);
    assert.ok(/^https:\/\//.test(r.url) && /^\d{4}-\d{2}-\d{2}$/.test(r.checked), `${r.plan} needs a source URL and a checked date`);
    if (r.status === "official") assert.ok(r.annual > 0 && r.annual <= r.monthly * 12 + 1e-6, `${r.plan} annual ${r.annual} vs 12 × ${r.monthly}`);
    else assert.ok(!(r.annual > 0), `${r.plan} is ${r.status} but has an annual price`);
  }
  const unmatched = dataset.stats?.billing?.unmatched || [];
  assert.deepEqual(unmatched, [], `Plans without a billing record: ${unmatched.join("; ")}`);
});

test("Billing: no plan × model appears twice in Monthly or Yearly mode", () => {
  for (const mode of ["monthly", "yearly"]) {
    const seen = new Map();
    for (const e of subsEntries) {
      const v = billingView(e, mode);
      if (v.hidden) continue;
      if (mode === "monthly") assert.ok(e.billingOnly !== "yearly", `${e.id} annual-only row shown in Monthly`);
      // Same plan name once the annual marker is removed = same subscription
      const k = `${e.plan.replace(/\s*\(CN Annual\)/, " (CN)").replace(/\s*\(Annual\)|\s*年付/, "")}|${e.modelId}`;
      assert.ok(!seen.has(k), `${mode}: ${e.id} and ${seen.get(k)} are the same plan × model`);
      seen.set(k, e.id);
    }
  }
  const variants = subsEntries.filter((e) => isAnnualVariant(e.plan));
  assert.ok(variants.length > 0 && variants.every((e) => e.billingOnly === "yearly"), "Annual-variant rows must be yearly-only");
});

test("Billing: Yearly subsidy = monthly subsidy × monthly fee ÷ yearly fee per month", () => {
  let n = 0;
  for (const e of subsEntries) {
    if (!(e.subsidyMultiple > 0) || e.billingOnly) continue;
    const m = billingView(e, "monthly");
    const y = billingView(e, "yearly");
    assert.ok(Math.abs(m.fee - e.priceUsdMonthly) < 1e-9 && Math.abs(m.scale - 1) < 1e-9, `${e.id} Monthly must use the stored fee and subsidy`);
    const sM = e.subsidyMultiple * m.scale;
    const sY = e.subsidyMultiple * y.scale;
    if (e.priceUsdYearly > 0) {
      assert.ok(Math.abs(sY - (sM * e.priceUsdMonthly) / e.priceUsdYearly) < 1e-6 * sM, `${e.id} subsidy identity fails`);
      assert.ok(Math.abs(sY * y.fee - sM * m.fee) < 1e-6 * sM * m.fee, `${e.id} yearly quota (subsidy × fee) must equal monthly`);
      assert.ok(y.yearly && y.fee === e.priceUsdYearly, `${e.id} Yearly fee must be priceUsdYearly`);
      assert.equal(e.rel?.y, REL.BILLING_STEP_SIGMA, `${e.id} official yearly price must carry the list-price σ`);
      n++;
    } else {
      assert.ok(y.fee === e.priceUsdMonthly && Math.abs(sY - sM) < 1e-9, `${e.id} without an annual price must keep the monthly fee`);
      assert.ok(y.mark === (e.billingYearly === "none" ? "no annual" : "annual ?"), `${e.id} fee mark ${y.mark}`);
    }
  }
  assert.ok(n > 0, "No row has an official yearly price");
  for (const e of subsEntries.filter((x) => x.billingOnly === "yearly")) {
    const y = billingView(e, "yearly");
    assert.ok(Math.abs(y.scale - 1) < 1e-9 && y.fee === e.priceUsd, `${e.id} annual-variant row must keep its own fee and subsidy`);
  }
});

test("Billing: Settings row, URL param and fee text are wired", () => {
  assert.equal(parseBillingParam("yearly"), "yearly");
  for (const v of [null, "", "monthly", "YEARLY", "annual"]) assert.equal(parseBillingParam(v), "monthly", `billing=${v}`);
  const sel = html.match(/<select id="billing"[\s\S]*?<\/select>/)?.[0] || "";
  assert.deepEqual([...sel.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]), ["monthly", "yearly"]);
  assert.ok(/<option value="monthly" selected>Monthly<\/option>/.test(sel), "Billing default must be Monthly");
  assert.ok(/<input id="billingYearly" type="checkbox" \/>\s*<span>Use cheaper yearly billing where available<\/span>/.test(html), "Missing yearly-billing tick box");
  assert.ok(appJs.includes('state.billing = parseBillingParam(params.get("billing"))') && appJs.includes('params.set("billing", "yearly")'), "billing URL param not read/written");
  assert.ok(/\/yr`/.test(appJs) && appJs.includes('"no annual"'), "Yearly fee text missing");
  assert.ok(html.includes("<code>Yearly</code>: subsidy × monthly price ÷ yearly price per month"), "Methodology Yearly formula missing");
  // Budget, Tasks/mo and sort read the resolved fee
  assert.ok(appJs.includes("priceUsd: isApi ? e.priceUsd : bill.fee") && appJs.includes("(bill.fee / effectiveCost) * capShare"), "Fee / Tasks/mo must follow the billing setting");
});

// Bundled credits (scripts/included-credits.mjs): recorded and shown, never counted in the subsidy.
const CREDIT_STATUSES = ["listed", "none", "unknown"];
const creditsSrc = [
  extractFn(/function fmtFee\(n\) \{[\s\S]*?\n\}\n/, "fmtFee"),
  extractFn(/const creditItemText = [^\n]+\n/, "creditItemText"),
  extractFn(/function creditsText\(r\) \{[\s\S]*?\n\}\n/, "creditsText"),
].join("\n");
const { creditsText } = new Function(`${creditsSrc}; return { creditsText };`)();

test("Included credits: every subscription row has a status; listed records cite a URL and a check date", () => {
  for (const e of subsEntries) {
    assert.ok(CREDIT_STATUSES.includes(e.includedCreditsStatus), `${e.id} includedCreditsStatus ${e.includedCreditsStatus}`);
    assert.ok(Array.isArray(e.includedCredits), `${e.id} lacks includedCredits`);
    assert.equal(e.includedCredits.length > 0, e.includedCreditsStatus === "listed", `${e.id} credits vs status`);
    for (const c of e.includedCredits) {
      assert.ok(/^https:\/\//.test(c.url) && /^\d{4}-\d{2}-\d{2}$/.test(c.checked), `${e.id} credit needs url + checked`);
      assert.ok(c.kind && c.text && (c.usdPerMonth === null || c.usdPerMonth > 0), `${e.id} credit record incomplete`);
    }
  }
  for (const e of entries.filter((x) => x.billing !== "subscription")) assert.ok(!("includedCredits" in e), `${e.id} metered row has includedCredits`);
  for (const r of INCLUDED_CREDITS) {
    assert.ok(CREDIT_STATUSES.includes(r.status), `${r.plan} status ${r.status}`);
    assert.equal(r.credits.length > 0, r.status === "listed", `${r.plan} credits vs status`);
    assert.ok(/^https:\/\//.test(r.url || r.credits[0]?.url || "") && /^\d{4}-\d{2}-\d{2}$/.test(r.checked), `${r.plan} needs a source URL and a checked date`);
  }
  const unmatched = dataset.stats?.includedCredits?.unmatched || [];
  assert.deepEqual(unmatched, [], `Plans without an included-credits record: ${unmatched.join("; ")}`);
});

test("Unknown billing / credit records carry a valid reason and tried date; listed / official records cite a URL and checked date", () => {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const rows = [...BILLING_PERIODS.map((r) => ["billing", r]), ...INCLUDED_CREDITS.map((r) => ["credits", r])];
  let unknowns = 0;
  for (const [table, r] of rows) {
    const id = `${table}: ${r.plan}`;
    if (r.status === "unknown") {
      unknowns++;
      assert.ok(UNKNOWN_REASONS.includes(r.reason), `${id} reason ${r.reason} not in ${UNKNOWN_REASONS.join("/")}`);
      assert.ok(DATE.test(r.tried || ""), `${id} needs a tried date`);
      assert.ok(/^https:\/\//.test(r.url || ""), `${id} needs the URL that was tried`);
    } else {
      assert.ok(!("reason" in r) && !("tried" in r), `${id} is ${r.status} but has an unknown reason`);
    }
    if (r.status === "listed" || r.status === "official") {
      assert.ok(/^https:\/\//.test(r.url || "") && DATE.test(r.checked || ""), `${id} (${r.status}) needs url + checked`);
      for (const c of r.credits || []) assert.ok(/^https:\/\//.test(c.url || "") && DATE.test(c.checked || ""), `${id} credit ${c.kind} needs url + checked`);
    }
  }
  assert.ok(unknowns > 0, "No unknown records found (reason check would be vacuous)");
  assert.deepEqual(UNKNOWN_REASONS, ["blocked", "login", "dns", "not-stated", "js-only"]);
});

test("Pricing page watch: baseline schema; every table URL is watched and in the baseline", () => {
  const baseline = JSON.parse(fs.readFileSync(PP.BASELINE_PATH, "utf8"));
  assert.equal(baseline.version, 1);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(baseline.generated), `baseline.generated ${baseline.generated}`);
  const urls = PP.watchUrls();
  assert.equal(new Set(urls).size, urls.length, "watch list has duplicates");
  const tableUrls = new Set([...BILLING_PERIODS.map((r) => r.url), ...INCLUDED_CREDITS.flatMap((r) => [r.url, ...r.credits.map((c) => c.url)])].filter(Boolean));
  for (const u of tableUrls) {
    assert.ok(urls.includes(u), `${u} is cited in a table but not watched`);
    assert.ok(baseline.pages[u], `${u} is not in data/pricing-pages/baseline.json (run --update-baseline)`);
  }
  for (const [u, p] of Object.entries(baseline.pages)) {
    assert.ok(/^https:\/\//.test(u), `baseline key ${u}`);
    assert.ok(PP.PAGE_STATES.includes(p.state), `${u} state ${p.state}`);
    if (p.state === "ok") assert.ok(/^[0-9a-f]{16}$/.test(p.hash) && Number.isInteger(p.priceLines) && p.priceLines >= 0, `${u} ok needs a 16-hex hash and priceLines`);
    else assert.equal(p.hash, null, `${u} ${p.state} must have hash null`);
  }
  const ok = Object.values(baseline.pages).filter((p) => p.state === "ok").length;
  assert.ok(ok >= urls.length * 0.6, `only ${ok}/${urls.length} baseline pages loaded`);
});

test("Pricing page watch: diff reports readable / changed / stopped; hash ignores layout, keeps prices", () => {
  const baseline = {
    version: 1,
    generated: "2026-01-01",
    pages: {
      "https://a.example/pricing": { state: "blocked", hash: null, priceLines: 0 },
      "https://b.example/pricing": { state: "ok", hash: "1111111111111111", priceLines: 3 },
      "https://c.example/pricing": { state: "ok", hash: "2222222222222222", priceLines: 3 },
      "https://d.example/pricing": { state: "ok", hash: "3333333333333333", priceLines: 3 },
      "https://e.example/pricing": { state: "dns", hash: null, priceLines: 0 },
    },
  };
  const report = {
    pages: {
      "https://a.example/pricing": { state: "ok", hash: "aaaaaaaaaaaaaaaa" },
      "https://b.example/pricing": { state: "ok", hash: "bbbbbbbbbbbbbbbb" },
      "https://c.example/pricing": { state: "ok", hash: "2222222222222222" },
      "https://d.example/pricing": { state: "login", hash: null },
      "https://e.example/pricing": { state: "dns", hash: null },
      "https://f.example/pricing": { state: "ok", hash: "ffffffffffffffff" },
    },
  };
  const d = PP.diffPages(baseline, report, { "https://a.example/pricing": ["Plan A (annual)"] });
  assert.deepEqual(d.readable.map((r) => [r.url, r.was]), [["https://a.example/pricing", "blocked"], ["https://f.example/pricing", "missing"]]);
  assert.deepEqual(d.readable[0].unknownPlans, ["Plan A (annual)"]);
  assert.deepEqual(d.changed, [{ url: "https://b.example/pricing", was: "1111111111111111", now: "bbbbbbbbbbbbbbbb" }]);
  assert.deepEqual(d.stopped, [{ url: "https://d.example/pricing", now: "login" }]);
  assert.ok(PP.hasChanges(d) && !PP.hasChanges(PP.diffPages(baseline, { pages: { "https://c.example/pricing": { state: "ok", hash: "2222222222222222" } } })));
  assert.match(PP.issueBody(d), /Readable now \(2\)[\s\S]*Prices changed \(1\)[\s\S]*Stopped loading \(1\)[\s\S]*--update-baseline/);
  // Hash: whitespace / non-price lines do not matter; a price change does.
  const page = "Plans\nPlus\n$8/month\nBilled annually $80\nGet started";
  assert.equal(PP.textHash(page).hash, PP.textHash("Menu\n  Plus \n$8/month\n\nBilled   annually $80\nSign up").hash);
  assert.notEqual(PP.textHash(page).hash, PP.textHash(page.replace("$80", "$90")).hash);
  assert.equal(PP.textHash(page).hash, PP.textHash("Billed annually $80\nPlus\n$8/month\n$8/month").hash, "line order / repeats must not change the hash");
  assert.equal(PP.textHash(page).priceLines, 2);
  // Classification
  assert.equal(PP.classify({ errorText: "net::ERR_NAME_NOT_RESOLVED" }), "dns");
  assert.equal(PP.classify({ status: 403, text: "x".repeat(500) }), "blocked");
  assert.equal(PP.classify({ status: 200, title: "Just a moment...", text: "x".repeat(500) }), "blocked");
  assert.equal(PP.classify({ status: 200, text: "登录" }), "login");
  assert.equal(PP.classify({ status: 200, text: "" }), "empty");
  assert.equal(PP.classify({ status: 200, text: page.repeat(10) }), "ok");
});

test("Pricing page watch: deploy.yml step is scheduled-only, continue-on-error, after tests, and opens one issue", () => {
  const steps = workflowYml.split(/\n      - name: /);
  const names = steps.map((s) => s.split("\n")[0]);
  const step = steps.find((s) => /scripts\/check-pricing-pages\.mjs/.test(s) && /^Watch/.test(s)) || "";
  assert.ok(step, "deploy.yml has no pricing page watch step");
  assert.match(step, /\n\s+if: github\.event_name == 'schedule'\n/, "watch step must run on scheduled runs only");
  assert.match(step, /\n\s+continue-on-error: true\n/, "watch step must not fail the deploy");
  assert.match(step, /--issue/, "watch step must open/update the issue");
  assert.match(step, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.ok(!/--update-baseline/.test(step), "baseline updates are manual");
  const iTests = names.findIndex((n) => /^Run automated site and data tests/.test(n));
  const iWatch = names.indexOf(step.split("\n")[0]);
  assert.ok(iTests >= 0 && iWatch > iTests, "watch step must come after the tests");
  assert.ok(/^\s+issues: write$/m.test(workflowYml), "deploy.yml needs issues: write");
  assert.equal(PP.ISSUE_TITLE, "Pricing pages changed");
  const src = fs.readFileSync(path.join(ROOT, "scripts", "check-pricing-pages.mjs"), "utf8");
  assert.ok(!/^import .* from "(?!node:|\.\/)/m.test(src), "check-pricing-pages.mjs must have zero dependencies");
});

test("Included credits: Claude Max $100 and Claude Ultra $200 API credits per month", () => {
  for (const [plan, usd] of [["Claude Max", 100], ["Claude Ultra", 200]]) {
    const rows = subsEntries.filter((e) => e.plan === plan);
    assert.ok(rows.length > 0, `No ${plan} rows`);
    for (const e of rows) {
      assert.equal(e.includedCreditsStatus, "listed", `${e.id} status`);
      const api = e.includedCredits.find((c) => c.kind === "API credits");
      assert.ok(api && api.usdPerMonth === usd && api.url === "https://claude.com/pricing", `${e.id} API credits ${JSON.stringify(api)}`);
    }
    assert.equal(creditsText(rows[0]), `+$${usd}/mo API credits (not counted)`);
  }
});

test("Included credits: subsidyMultiple is independent of includedCredits", () => {
  // 1. Applying the table changes only the two credit fields.
  const sample = subsEntries.filter((e, i) => i % 7 === 0 || e.includedCreditsStatus === "listed").map((e) => structuredClone(e));
  const before = sample.map((e) => JSON.stringify({ ...e, includedCredits: undefined, includedCreditsStatus: undefined }));
  for (const e of sample) e.includedCredits = [{ kind: "API credits", usdPerMonth: 1e6, text: "x", url: "https://x", checked: "2026-01-01" }];
  applyIncludedCredits(sample);
  sample.forEach((e, i) => assert.equal(JSON.stringify({ ...e, includedCredits: undefined, includedCreditsStatus: undefined }), before[i], `${e.id} fields changed`));
  // 2. Recompute: Fei rows' subsidy = list ÷ real $/Mtok, with no credit term.
  const fei = subsEntries.filter((e) => /^Claude (Max|Ultra)$/.test(e.plan) && e.origin === "fei2411" && !e.subsidyReadings && !e.pooled && e.realUsdPerMtok > 0);
  assert.ok(fei.length > 0, "No Fei Claude Max/Ultra rows to recompute");
  for (const e of fei) {
    const s = e.listBlendedUsdPerMtok / e.realUsdPerMtok;
    // Credits would add usdPerMonth ÷ fee (1× on Max and Ultra, about 2% of the subsidy); later steps move Fei rows < 0.5%.
    const withCredits = s + e.includedCredits.reduce((a, c) => a + (c.usdPerMonth || 0), 0) / e.priceUsd;
    assert.ok(Math.abs(s - e.subsidyMultiple) < 0.005 * s, `${e.id} subsidy ${e.subsidyMultiple} ≠ list/real ${s}`);
    assert.ok(Math.abs(withCredits - e.subsidyMultiple) > 0.01 * s, `${e.id} subsidy includes credits`);
  }
  // 3. The page's subsidy and cost path never reads the credits.
  const resolve = fnBody("getAllEntriesResolved");
  assert.ok(!/includedCredits|creditsText/.test(resolve), "getAllEntriesResolved must not read includedCredits");
  assert.ok(dataset.stats?.includedCredits?.subsidyUnchanged === true, "Build invariant subsidyUnchanged missing");
});

test("Included credits: meta line, tooltips, drawer, table row and Methodology show the note", () => {
  assert.ok(/credits-note" title="\$\{esc\(creditsFullText\(r\)\)\}"> · \$\{esc\(credits\)\}/.test(fnBody("renderBarChart")), "Bar meta line must show credits with the full list on hover");
  // Popups can't be hovered further: the plan popup must list every bundled item, not a summary
  assert.ok(/planText = [^;]*creditsFullText|creditItems = creditsFullText\(r\)[\s\S]{0,300}Bundled \(not counted in the subsidy\)/.test(fnBody("renderBarChart")), "Bar plan popup must list every bundled item");
  assert.ok(/includedCredits/.test(fnBody("relTooltip")) && /not counted in the subsidy/.test(fnBody("relTooltip")), "Reliability tooltip must list every bundled item");
  assert.ok(/includedCredits/.test(fnBody("renderProvenance")) && /Bundled extras, not counted in the subsidy/.test(fnBody("renderProvenance")), "Drawer provenance must list credits");
  assert.ok((fnBody("renderTable").match(/creditsDiv\(/g) || []).length >= 2, "Table row and group row must show credits");
  assert.ok(html.includes("Bundled credits (API, cloud) are listed per plan and not counted in the subsidy."), "Methodology credits line missing");
  assert.equal(creditsText({ includedCredits: [] }), "");
  assert.equal(creditsText({ isApi: true, includedCredits: [{ kind: "API credits", usdPerMonth: 5 }] }), "");
  assert.equal(creditsText({ includedCredits: [{ kind: "API credits", usdPerMonth: 10 }, { kind: "2 TB storage", usdPerMonth: null }] }), "+$10/mo API credits and 1 other bundled extra (not counted)");
  assert.equal(creditsText({ includedCredits: [{ kind: "web search", usdPerMonth: null }] }), "+web search (not counted)");
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);

test("Agent SDK client step: Claude first-party T3 rows only, ÷2.1, σ from 1.8–2.9, behind the flag", () => {
  const sdk = relStats.sdkClient;
  assert.ok(sdk && typeof sdk.on === "boolean", "stats.reliability.sdkClient missing");
  assert.ok(sdk.lo < sdk.central && sdk.central < sdk.hi, `sdkClient range ${sdk.lo}–${sdk.hi} around ${sdk.central}`);
  assert.ok(Math.abs(sdk.sigma - Math.log(sdk.hi / sdk.lo) / (2 * REL.Z80)) < 1e-3, `sdkClient σ ${sdk.sigma}`);
  let n = 0;
  for (const e of entries) {
    const claudeT3 = /^Claude (Pro|Max|Ultra|Team)\b/.test(e.plan) && e.billing === "subscription" && !e.unmetered && e.t3Turn?.costPerTurnUsd > 0;
    if (!claudeT3 || !sdk.on) {
      assert.ok(!e.clientFactor && !e.rel.x, `${e.id} has an SDK client step`);
      continue;
    }
    n++;
    assert.ok(Math.abs(e.clientFactor?.turn?.f * sdk.central - 1) < 1e-3, `${e.id}: clientFactor.turn.f ${e.clientFactor?.turn?.f}`);
    assert.ok(e.clientFactor.turn.lo < e.clientFactor.turn.f && e.clientFactor.turn.f < e.clientFactor.turn.hi, `${e.id}: clientFactor range`);
    assert.ok(Math.abs(e.rel.x?.turn - sdk.sigma) < 1e-3, `${e.id}: rel.x.turn ${e.rel.x?.turn}`);
    assert.deepEqual(Object.keys(e.clientFactor), ["turn"], `${e.id}: SDK factor outside T3 turn mode`);
  }
  assert.equal(n, sdk.rows, "sdkClient.rows out of sync");
  if (sdk.on) assert.ok(n >= 20, `Only ${n} Claude T3 rows carry the SDK step`);
  assert.ok(/clientFactor/.test(appJs) && /rl\.x\?\.\[mode\]/.test(appJs), "app.js must apply clientFactor and rel.x");
  assert.ok(/SDK client uses the limit faster/.test(appJs), "Tooltip chain must list the SDK client step");
  for (const u of sdk.sources) assert.match(u, /^https:\/\/github\.com\/anthropics\/claude-code\/issues\/(97074|111890)$/);
});

test("T3 cross-harness σ follows stats.reliability.t3Harness (0.15–0.35)", () => {
  const fit = REL.t3HarnessSigma(relStats.t3Harness);
  assert.ok(Math.abs(relStats.costSteps.t3Harness - fit.sigma) < 1e-6, `costSteps.t3Harness ${relStats.costSteps.t3Harness} != fit ${fit.sigma}`);
  assert.ok(fit.sigma >= 0.15 && fit.sigma <= 0.35, `T3 harness σ ${fit.sigma}`);
  for (const e of entries.filter((x) => x.t3Turn?.costPerTurnUsd > 0)) {
    const want = REL.qsum(REL.costSteps(null, null, fit.sigma).t3(e.t3Turn.turns || 0), fit.sigma);
    assert.ok(Math.abs(e.rel.c.turn - want) < 2e-3, `${e.id}: rel.c.turn ${e.rel.c.turn} vs ${want.toFixed(4)}`);
  }
});

test("Methodology and RELIABILITY.md show step σ in buckets 0.05 / 0.1 / 0.2 / 0.35 / 0.5 / 0.7", () => {
  assert.deepEqual(REL.SIGMA_BUCKETS, [0.05, 0.1, 0.2, 0.35, 0.5, 0.7]);
  assert.deepEqual(relStats.sigmaBuckets, REL.SIGMA_BUCKETS);
  const block = html.match(/<summary>How the trust levels are calculated<\/summary>[\s\S]*?<\/details>/)?.[0] || "";
  assert.ok(block, "Methodology trust-level section missing");
  assert.match(block, /starting estimates/i, "Methodology must say the step values are starting estimates");
  assert.match(block, /independent/i, "Methodology must say the steps are treated as independent");
  const table = block.match(/<table class="method-table">[\s\S]*?<\/table>/)?.[0] || "";
  const cells = [...table.matchAll(/<tr><td>[^<]*<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m[1]);
  assert.ok(cells.length >= 15, `Too few σ rows in the Methodology table: ${cells.length}`);
  const allowed = new Set(REL.SIGMA_BUCKETS.map((b) => String(b)));
  for (const c of cells) {
    for (const num of c.match(/\d+(?:\.\d+)?/g) || []) {
      if (num === "2" || num === "1.6") continue; // "|ln D| / 2", "×1.6" are not σ values
      assert.ok(allowed.has(String(Number(num))), `Methodology σ "${c}" contains ${num}, not a bucket`);
    }
  }
  const S = REL.STEP_SIGMA;
  for (const [k, shown] of [["S1", 0.05], ["S2", 0.1], ["S6", 0.5], ["P1", 0.2], ["M1", 0.2], ["M3far", 0.5], ["T90", 0.35]]) {
    assert.equal(REL.bucketSigma(S[k]), shown, `${k} ${S[k]} should show as ${shown}`);
  }
  const doc = fs.readFileSync(path.join(ROOT, "docs", "RELIABILITY.md"), "utf8");
  const stepRows = [...doc.matchAll(/^\| (S\d|T|P\d|X1|M\d) \| [^|]+ \| ([^|]+) \|$/gm)];
  assert.ok(stepRows.length >= 15, `RELIABILITY.md step rows: ${stepRows.length}`);
  for (const [, id, val] of stepRows) {
    for (const num of val.match(/\d+(?:\.\d+)?/g) || []) assert.ok(allowed.has(String(Number(num))), `RELIABILITY.md ${id} σ "${val.trim()}" not a bucket`);
  }
});

// ---- Tests that need deploy history (data/reliability/history.jsonl) ----
const HISTORY_PATH = path.join(ROOT, "data", "reliability", "history.jsonl");
const historyLines = fs.existsSync(HISTORY_PATH)
  ? fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const lastDeploy = relStats.lastDeploy;
const cal = relStats.calibration;

test("Calibration ledger lines are well formed; workflow commits the ledger back", () => {
  for (const l of historyLines) {
    if (l.t === "deploy") {
      assert.ok(l.d && l.counts && Number.isInteger(l.quadFails), `Bad deploy line ${JSON.stringify(l)}`);
      continue;
    }
    assert.ok(l.id && l.d && Number.isFinite(l.v) && Number.isFinite(l.s) && Array.isArray(l.k) && (l.x === 0 || l.x === 1), `Bad ledger line ${JSON.stringify(l)}`);
    assert.ok(l.lo <= l.v && l.v <= l.hi, `Ledger range excludes its value: ${JSON.stringify(l)}`);
    assert.match(l.id, /^[^|]+\|[a-z0-9][a-z0-9.-]*(\|offpeak)?$/, `Bad ledger cell id ${l.id}`);
  }
  // One line per cell per recorded run (runs end with their deploy line).
  let run = new Set();
  for (const l of historyLines) {
    if (l.t === "deploy") {
      run = new Set();
      continue;
    }
    assert.ok(!run.has(l.id), `Cell ${l.id} recorded twice in one run`);
    run.add(l.id);
  }
  assert.ok(cal && Number.isInteger(cal.cases) && cal.minN === 15 && cal.minCoverage === 0.6, "stats.reliability.calibration missing");
  assert.ok(/^\s+contents: write$/m.test(workflowYml), "deploy.yml needs contents: write to push the ledger");
  const step = workflowYml.split(/\n      - name: /).find((s) => /^Commit reliability history/.test(s)) || "";
  assert.ok(step, "deploy.yml has no 'Commit reliability history' step");
  assert.match(step, /^\s+if: github\.ref == 'refs\/heads\/main'$/m, "Ledger commit must run on main only");
  assert.match(step, /^\s+continue-on-error: true$/m, "Ledger commit step must not block the deploy");
  assert.match(step, /F=data\/reliability\/history\.jsonl/, "Ledger commit must add data/reliability/history.jsonl");
  assert.match(step, /git -C \/tmp\/hist-wt add "\$F"/);
  assert.match(step, /git -C \/tmp\/hist-wt commit [^\n]*\[skip ci\]/, "Ledger commit message must carry [skip ci]");
  assert.match(step, /git -C \/tmp\/hist-wt push [^\n]*origin HEAD:main/, "Ledger commit must push to main");
  const order = workflowYml.split(/\n      - name: /).map((s) => s.split("\n")[0]);
  assert.ok(order.findIndex((n) => /^Commit reliability history/.test(n)) > order.findIndex((n) => /^Abort deploy/.test(n)), "Ledger commit must run after the test gate");
  console.log(`     Ledger: ${historyLines.length} lines, ${historyLines.filter((l) => l.t === "deploy").length} deploys; calibration cases ${cal.cases}`);
});

{
  const due = Object.entries(cal?.kinds || {}).filter(([, v]) => v.n >= REL.CALIBRATION_MIN_N);
  const name = "Calibration: coverage ≥ 60% for every step kind with n ≥ 15";
  if (!due.length) {
    skip(name, `history too short: ${cal?.cases ?? 0} cases, largest kind n = ${Math.max(0, ...Object.values(cal?.kinds || {}).map((v) => v.n))}`);
  } else {
    test(name, () => {
      for (const [k, v] of due) {
        assert.ok(v.refitDue, `${k}: refitDue flag missing at n = ${v.n}`);
        assert.ok(v.coverage >= REL.CALIBRATION_MIN_COVERAGE, `${k}: coverage ${(v.coverage * 100).toFixed(0)}% at n = ${v.n} (prior ${v.prior}, fitted ${v.fitted})`);
      }
      console.log(`     Refit due: ${due.map(([k, v]) => `${k} n=${v.n} cov=${v.coverage} prior=${v.prior} fitted=${v.fitted}`).join("; ")}`);
    });
  }
}

{
  const name = "T3 harness ratios within ×1.5 of the last deploy";
  const prev = lastDeploy?.t3 || {};
  const pairs = ["codex", "claude-code"].filter((k) => prev[k] > 0 && relStats.t3Harness?.[k]?.ratio > 0);
  if (!pairs.length) {
    skip(name, "no previous deploy with T3 harness ratios");
  } else {
    test(name, () => {
      for (const k of pairs) {
        const r = relStats.t3Harness[k].ratio / prev[k];
        assert.ok(r >= 1 / 1.5 && r <= 1.5, `t3Harness.${k} ratio ${relStats.t3Harness[k].ratio} vs last deploy ${prev[k]} (×${r.toFixed(2)})`);
      }
    });
  }
}

{
  const name = "Consistency quad fails ≤ last deploy + 2";
  if (!Number.isInteger(lastDeploy?.quadFails)) {
    skip(name, "no previous deploy recorded");
  } else {
    test(name, () => {
      const now = (relStats.consistency || []).filter((q) => q.type === "quad" && q.verdict === "fail").length;
      assert.ok(now <= lastDeploy.quadFails + 2, `${now} quad fails vs ${lastDeploy.quadFails} at ${lastDeploy.d}`);
    });
  }
}

// ---- Behavioural tests: public/app.js runs in a VM against a stub DOM and the real dataset ----
const HTML_IDS = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
class StubEl {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.listeners = {};
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    const props = {};
    this.style = { setProperty: (k, v) => { props[k] = v; }, getPropertyValue: (k) => props[k] ?? "" };
    this.dataset = {};
    this.attrs = {};
    this.children = [];
    const cls = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    };
  }
  addEventListener(t, f) {
    (this.listeners[t] ||= []).push(f);
  }
  removeEventListener() {}
  dispatchEvent(ev) {
    this.fire(ev.type);
    return true;
  }
  fire(type, props = {}) {
    for (const f of this.listeners[type] || []) f({ type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...props });
  }
  closest() {
    return new StubEl();
  }
  querySelector() {
    return new StubEl();
  }
  querySelectorAll() {
    return [];
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  insertAdjacentHTML() {}
  remove() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {}
}

/** Runs public/app.js with ?search in a fresh VM. Data loading never resolves; pass data to set state.dataset. */
function loadApp(search = "", { phone = false, data = null } = {}) {
  const els = new Map();
  const created = [];
  const docListeners = {};
  const document = {
    documentElement: new StubEl("html"),
    body: new StubEl("body"),
    head: new StubEl("head"),
    getElementById: (id) => {
      if (!HTML_IDS.has(id)) return null;
      if (!els.has(id)) els.set(id, new StubEl("div", id));
      return els.get(id);
    },
    createElement: (tag) => {
      const el = new StubEl(tag);
      created.push(el);
      return el;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, f) => (docListeners[t] ||= []).push(f),
  };
  const location = { search: search ? `?${search.replace(/^\?/, "")}` : "", pathname: "/", hash: "", hostname: "test.invalid", reload() {} };
  const mqs = new Map();
  const g = {
    document,
    location,
    console,
    Event: class { constructor(type) { this.type = type; } },
    history: { replaceState: (_s, _t, url) => (location.search = new URL(url, "http://test.invalid").search) },
    matchMedia: (q) => {
      if (!mqs.has(q)) mqs.set(q, { matches: q === "(max-width: 600px)" ? phone : false, media: q, addEventListener() {}, removeEventListener() {} });
      return mqs.get(q);
    },
    localStorage: (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; })(),
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}),
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout() {},
    performance,
    URL,
    URLSearchParams,
    Audio: class {
      play() {
        return Promise.resolve();
      }
      pause() {}
    },
    innerWidth: 1280,
    innerHeight: 800,
  };
  g.window = g;
  const ctx = vm.createContext(g);
  vm.runInContext(appJs.replace(/\bimport\.meta\.url\b/g, JSON.stringify("http://localhost/app.js?v=test")), ctx, { filename: "public/app.js" });
  const api = vm.runInContext(
    "({ state, render, renderMeta, getAllEntriesResolved, getFilteredRows, chartBars, relTooltip, plainSource, renderProvenance, fmtUsd, syncUrlFromState, pairedBench, pairedCost, COST_MODES, BENCHMARKS, LEVELS, LEVEL_LABEL, LEVEL_GLYPH, LEVEL_RANK, TABLE_PAGE })",
    ctx
  );
  const app = { ...api, $: document.getElementById, document, location, localStorage: g.localStorage, created, keydown: (props) => (docListeners.keydown || []).forEach((f) => f({ repeat: false, ...props })) };
  if (data) {
    app.state.dataset = data;
    app.render();
  }
  return app;
}
const appWithData = (search = "", opts = {}) => loadApp(search, { ...opts, data: dataset });
const near = (a, b, tol = 1e-6) => a === b || Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const countOf = (s, re) => (s.match(re) || []).length;

const API_OF = {
  task: (e) => e.aaCostPerTaskUsd,
  agent: (e) => e.codingAgent?.costPerTaskUsd,
  cursor: (e) => e.cursorBench?.costPerTaskUsd,
  turn: (e) => e.t3Turn?.costPerTurnUsd,
  tokens: (e) => e.aaPricing?.blended3to1Per1M ?? e.aaPricing?.blended7to2to1Per1M ?? e.listBlendedUsdPerMtok,
};

test("App: each cost metric uses its own API cost, subsidy factor and σ; heading and column follow", () => {
  const app = appWithData();
  assert.deepEqual(Object.keys(app.COST_MODES).sort(), Object.keys(API_OF).sort());
  for (const m of Object.keys(API_OF)) {
    app.state.costMode = m;
    const byIdR = new Map(app.getAllEntriesResolved().map((r) => [r.id, r]));
    let priced = 0;
    for (const e of entries) {
      const r = byIdR.get(e.id);
      assert.ok(r, `${e.id} not resolved`);
      const api = API_OF[m](e) ?? null;
      assert.equal(r.apiMetric, api, `${m}: ${e.id} apiMetric ${r.apiMetric} != ${api}`);
      if (api > 0 && e.billing === "subscription" && !e.unmetered && e.subsidyMultiple > 0) {
        const S = e.subsidyMultiple * billingView(e, "monthly").scale * (e.quotaMix?.[m]?.f ?? 1) * (e.clientFactor?.[m]?.f ?? 1);
        assert.ok(near(r.effectiveCost, api / S), `${m}: ${e.id} real ${r.effectiveCost} != ${api} / ${S}`);
        assert.ok(near(r.subsidy, S), `${m}: ${e.id} subsidy ${r.subsidy} != ${S}`);
        priced++;
      }
      if (e.billing === "metered" && api > 0) assert.ok(near(r.effectiveCost, api), `${m}: API row ${e.id} must cost its list price`);
      const rl = e.rel;
      const sigma = Math.hypot(rl.s, rl.w?.[m] ?? 0, rl.c?.[m] ?? 0, rl.x?.[m] ?? 0);
      assert.ok(near(r.sigma, sigma, 1e-9), `${m}: ${e.id} σ ${r.sigma} != ${sigma}`);
    }
    assert.ok(priced >= 50, `${m}: only ${priced} subscription rows priced`);
    app.render();
    assert.equal(app.$("chartHeading").textContent, app.COST_MODES[m].heading, `${m}: chart heading`);
    assert.ok(app.$("tableHead").innerHTML.includes(`>Real $/${app.COST_MODES[m].unit}</th>`), `${m}: Real $/${app.COST_MODES[m].unit} column`);
    assert.equal(app.$("maxCostLabel").textContent, app.COST_MODES[m].maxLabel, `${m}: max-cost label`);
  }
  // Per-mode subsidy factors (no row carries one while the correction and SDK step are off): inject them
  const claude = entries.find((e) => e.plan === "Claude Max" && e.t3Turn?.costPerTurnUsd > 0 && e.aaCostPerTaskUsd > 0);
  assert.ok(claude, "no Claude Max row with T3 data");
  const probe = { ...claude, quotaMix: { task: { f: 0.8, lo: 0.7, hi: 0.9 } }, clientFactor: { turn: { f: 0.5, lo: 0.4, hi: 0.6 } } };
  const synth = loadApp("", { data: { ...dataset, entries: [probe] } });
  const at = (m) => {
    synth.state.costMode = m;
    return synth.getAllEntriesResolved()[0];
  };
  const S0 = claude.subsidyMultiple * billingView(claude, "monthly").scale;
  assert.ok(near(at("task").effectiveCost, claude.aaCostPerTaskUsd / (S0 * 0.8)), "task mode must apply quotaMix.task");
  assert.ok(near(at("turn").effectiveCost, claude.t3Turn.costPerTurnUsd / (S0 * 0.5)), "turn mode must apply clientFactor.turn only");
  if (claude.codingAgent?.costPerTaskUsd > 0) assert.ok(near(at("agent").effectiveCost, claude.codingAgent.costPerTaskUsd / S0), "agent mode must not apply task / turn factors");
});

test("Auto-pair: pairedBench / pairedCost on every transition; custom benchmarks are kept", () => {
  const app = loadApp();
  const PAIR = { task: "intelligenceIndex", agent: "codingAgentIndex", cursor: "cursorBench" };
  const COST_FOR = Object.fromEntries(Object.entries(PAIR).map(([c, b]) => [b, c]));
  const costs = Object.keys(app.COST_MODES);
  const benches = Object.keys(app.BENCHMARKS);
  for (const b of ["intelligenceIndex", "codingAgentIndex", "cursorBench", "hle"]) assert.ok(benches.includes(b), `benchmark ${b} missing`);
  // Rule: the other control follows only if it is at its default or still paired with the previous choice.
  for (const prev of costs) for (const next of costs) for (const bench of benches) {
    const want = PAIR[next] && (bench === "intelligenceIndex" || bench === PAIR[prev]) ? PAIR[next] : bench;
    assert.equal(app.pairedBench(prev, next, bench), want, `cost ${prev} → ${next} with benchmark ${bench}`);
  }
  for (const prev of benches) for (const next of benches) for (const cost of costs) {
    const want = COST_FOR[next] && (cost === "task" || cost === COST_FOR[prev]) ? COST_FOR[next] : cost;
    assert.equal(app.pairedCost(prev, next, cost), want, `benchmark ${prev} → ${next} with cost ${cost}`);
  }
  // Hand-written cases: [prev cost, next cost, benchmark, expected benchmark]
  for (const [p, n, b, want] of [
    ["task", "agent", "intelligenceIndex", "codingAgentIndex"],
    ["agent", "cursor", "codingAgentIndex", "cursorBench"],
    ["cursor", "task", "cursorBench", "intelligenceIndex"],
    ["agent", "task", "codingAgentIndex", "intelligenceIndex"],
    ["task", "agent", "hle", "hle"],
    ["agent", "cursor", "hle", "hle"],
    ["task", "turn", "intelligenceIndex", "intelligenceIndex"],
    ["agent", "tokens", "codingAgentIndex", "codingAgentIndex"],
    ["task", "cursor", "codingAgentIndex", "codingAgentIndex"],
  ]) assert.equal(app.pairedBench(p, n, b), want, `cost ${p} → ${n}, benchmark ${b}`);
  // [prev benchmark, next benchmark, cost, expected cost]
  for (const [p, n, c, want] of [
    ["intelligenceIndex", "codingAgentIndex", "task", "agent"],
    ["codingAgentIndex", "cursorBench", "agent", "cursor"],
    ["cursorBench", "intelligenceIndex", "cursor", "task"],
    ["codingAgentIndex", "hle", "agent", "agent"],
    ["intelligenceIndex", "codingAgentIndex", "turn", "turn"],
    ["intelligenceIndex", "cursorBench", "agent", "agent"],
    ["hle", "codingAgentIndex", "task", "agent"],
  ]) assert.equal(app.pairedCost(p, n, c), want, `benchmark ${p} → ${n}, cost ${c}`);

  // The change handlers apply it
  const ui = appWithData();
  const pick = (id, value) => {
    ui.$(id).value = value;
    ui.$(id).fire("change");
  };
  pick("costMode", "agent");
  assert.equal(ui.state.benchKey, "codingAgentIndex");
  assert.equal(ui.$("benchSelect").value, "codingAgentIndex");
  assert.equal(ui.state.minScore, ui.BENCHMARKS.codingAgentIndex.def, "paired benchmark resets its threshold");
  pick("benchSelect", "hle");
  assert.equal(ui.state.costMode, "agent", "hle has no paired cost");
  pick("costMode", "cursor");
  assert.equal(ui.state.benchKey, "hle", "a custom benchmark is never overwritten");
  pick("benchSelect", "cursorBench");
  pick("benchSelect", "intelligenceIndex");
  assert.equal(ui.state.costMode, "task", "cost paired with the previous benchmark follows back to task");
  assert.equal(ui.$("costMode").value, "task");
  pick("benchSelect", "cursorBench");
  assert.equal(ui.state.costMode, "cursor");
  assert.equal(ui.state.maxCostIdx, 4, "paired cost resets Max cost");
});

test("Legacy URL params: bench implies mode, mode=task written when needed, est/noest/nointerp/extrap → conf", () => {
  const st = (q) => loadApp(q).state;
  assert.equal(st("bench=codingAgentIndex").costMode, "agent");
  assert.equal(st("bench=cursorBench").costMode, "cursor");
  assert.equal(st("bench=codingAgentIndex&mode=task").costMode, "task");
  assert.equal(st("bench=cursorBench&mode=turn").costMode, "turn");
  assert.equal(st("bench=hle").costMode, "task");
  assert.equal(st("mode=bogus").costMode, "task");
  // Every benchmark × cost metric survives a write → read round trip, and mode= appears only when needed
  const app0 = loadApp();
  for (const bench of ["intelligenceIndex", "codingAgentIndex", "cursorBench", "hle"]) {
    for (const mode of Object.keys(app0.COST_MODES)) {
      const a = loadApp();
      a.state.benchKey = bench;
      a.state.minScore = a.BENCHMARKS[bench].def;
      a.state.costMode = mode;
      a.syncUrlFromState();
      const p = new URLSearchParams(a.location.search);
      const implied = bench === "codingAgentIndex" ? "agent" : bench === "cursorBench" ? "cursor" : "task";
      assert.equal(p.get("mode"), mode === implied ? null : mode, `bench=${bench} mode=${mode}: URL ${a.location.search}`);
      const b = loadApp(a.location.search);
      assert.equal(b.state.benchKey, bench, `round trip bench ${a.location.search}`);
      assert.equal(b.state.costMode, mode, `round trip mode ${a.location.search}`);
    }
  }
  // Min confidence: default Medium; legacy estimate params; conf= wins
  for (const [q, want] of [
    ["", "medium"],
    ["conf=bogus", "medium"],
    ["est=0", "high"],
    ["est=h", "medium"],
    ["est=hm", "low"],
    ["est=hml", "speculative"],
    ["nointerp=1", "high"],
    ["extrap=1", "speculative"],
    ["noest=1", "medium"],
    ["extrap=1&noest=1", "medium"],
    ["est=hml&noest=1", "medium"],
    ["est=0&noest=1", "high"],
    ["est=hm&conf=h", "high"],
    ["conf=h", "high"],
    ["conf=m", "medium"],
    ["conf=l", "low"],
    ["conf=s", "speculative"],
  ]) assert.equal(st(q).minConf, want, `?${q} → minConf ${want}`);
  // Legacy params are rewritten as conf= (and dropped at the default)
  for (const [q, want] of [["est=hm", "?conf=l"], ["extrap=1", "?conf=s"], ["nointerp=1", "?conf=h"], ["est=h", ""], ["noest=1", ""]]) {
    const a = loadApp(q);
    a.syncUrlFromState();
    assert.equal(a.location.search, want, `?${q} rewritten as ${a.location.search}`);
  }
});

test("Reliability display: glyph after the model name, tooltip on the whole name, footer wording, chart follows Min confidence", () => {
  const app = appWithData();
  assert.equal(app.state.minConf, "medium", "Min confidence default must be Medium");
  const checkNames = (htmlText, cls, where) => {
    const names = [...htmlText.matchAll(new RegExp(`<div class="${cls}"( title="([^"]*)")?>([\\s\\S]*?)</div>`, "g"))];
    assert.ok(names.length > 0, `${where}: no model names rendered`);
    for (const [, hasTitle, title, inner] of names) {
      const m = inner.match(/^(?:<a [^>]*>[^<]*<\/a>|[^<]+)<span class="tier-glyph rel-glyph rel-(\w+)" title="([^"]*)">([^<]+)<\/span>(?:<span class="sub-derived" title="[^"]+">†<\/span>)?$/);
      assert.ok(m, `${where}: glyph must follow the model name: ${inner}`);
      assert.ok(hasTitle, `${where}: tooltip must be on the whole model name`);
      assert.equal(m[3], app.LEVEL_GLYPH[m[1]], `${where}: glyph for ${m[1]}`);
      assert.ok(title.startsWith(`${app.LEVEL_LABEL[m[1]]} confidence\n`), `${where}: tooltip must open with "${app.LEVEL_LABEL[m[1]]} confidence": ${title.slice(0, 60)}`);
    }
    return names.length;
  };
  const chart = app.$("barChart").innerHTML;
  const nBars = checkNames(chart, "bar-model", "bar chart");
  assert.equal(countOf(chart, /<span class="bar-val">[^<]*<\/span>/g), nBars, "cost cell must hold only the cost (no glyph)");
  checkNames(app.$("rows").innerHTML, "model", "table");
  assert.ok(!/rel-(low|speculative)/.test(chart + app.$("rows").innerHTML), "Low and Speculative rows must be hidden by default");

  // Tooltip text
  for (const mode of ["task", "turn"]) {
    app.state.costMode = mode;
    app.state.minConf = "speculative";
    let banded = 0;
    for (const r of app.getAllEntriesResolved()) {
      const lines = app.relTooltip(r).split("\n");
      assert.equal(lines[0], `${app.LEVEL_LABEL[r.level]} confidence`, `${r.id}: first tooltip line`);
      if (Number.isFinite(r.relLo) && Number.isFinite(r.relHi)) {
        banded++;
        assert.equal(lines[1], `Real cost is likely ${app.fmtUsd(r.relLo)} to ${app.fmtUsd(r.relHi)} (80% chance)`, `${r.id}: band line`);
        assert.match(lines[1], /^Real cost is likely \$[\d.,]+ to \$[\d.,]+ \(80% chance\)$/);
      }
      const factor = `×${Math.exp(1.2816 * r.sigma).toFixed(1)}`;
      assert.ok(!lines.slice(0, Number.isFinite(r.relLo) ? 2 : 1).some((l) => l.includes("×")), `${r.id}: no ×factor in the header lines: ${JSON.stringify(lines.slice(0, 3))}`);
      assert.ok(!lines.some((l) => /^\s*Range\b/.test(l) || l.includes(`· ${factor}`)), `${r.id}: old ${factor} / Range line in tooltip`);
    }
    assert.ok(banded > 100, `${mode}: only ${banded} tooltips carry the band line`);
  }

  // Footer: rows at the next level down (one level per "Show"); banner: rows below Medium on view
  app.state.costMode = "task";
  const NEXT = { high: "medium", medium: "low", low: "speculative" };
  const WORD = { medium: "medium-confidence", low: "low-confidence", speculative: "speculative" };
  for (const level of ["high", "medium", "low", "speculative"]) {
    app.state.minConf = level;
    app.render();
    const all = app.getAllEntriesResolved();
    // Counts follow the chart's deduplicated bars, not the full table rows
    const shownRows = app.chartBars(app.getFilteredRows(all));
    const below = shownRows.filter((r) => app.LEVEL_RANK[r.level] > app.LEVEL_RANK.medium);
    assert.equal(app.$("barChart").innerHTML.split('<div class="bar-row').length - 1, shownRows.length, `${level}: chart bars != chartBars()`);
    assert.equal(app.$("extrapBanner").hidden, below.length === 0, `${level}: banner visibility`);
    if (below.length) assert.ok(app.$("extrapBannerText").textContent.startsWith(`${below.length} `), `${level}: banner counts every row below Medium`);
    if (level === "speculative") {
      assert.equal(app.$("extrapFooter").hidden, true, "no footer when everything is shown");
      continue;
    }
    const nextLevel = NEXT[level];
    const hidden = app.chartBars(app.getFilteredRows(all, nextLevel)).filter((r) => r.level === nextLevel).length;
    if (hidden === 0) {
      assert.equal(app.$("extrapFooter").hidden, true, `${level}: no footer when no chart bar would change`);
      continue;
    }
    assert.equal(app.$("extrapFooter").hidden, false, `${level}: footer must show`);
    assert.equal(app.$("extrapFooterText").textContent, `${hidden} ${WORD[nextLevel]} ${hidden === 1 ? "row" : "rows"} hidden`, `${level}: footer text`);
    // "Show" reveals exactly the next level
    app.$("enableExtrapBtn").fire("click");
    assert.equal(app.state.minConf, nextLevel, `${level}: Show must step to ${nextLevel}`);
    app.state.minConf = level;
  }

  // Bar chart follows Min confidence (one bar per row when both dedupe toggles are off)
  app.state.cheapestPlanOnly = false;
  app.state.cheapestEffortOnly = false;
  for (const level of ["high", "medium", "low", "speculative"]) {
    app.state.minConf = level;
    app.render();
    const rows = app.getFilteredRows(app.getAllEntriesResolved());
    const html2 = app.$("barChart").innerHTML;
    assert.equal(countOf(html2, /<div class="bar-row/g), rows.length, `${level}: bar count != filtered rows`);
    const shown = new Set([...html2.matchAll(/rel-glyph rel-(\w+)/g)].map((m) => m[1]));
    assert.deepEqual([...shown].sort(), [...new Set(rows.map((r) => r.level))].sort(), `${level}: chart levels`);
  }
});

test("Methodology: sections, collapsed trust-level details, glyph table, plain language, renderMeta counts", () => {
  const dlg = html.match(/<dialog id="methodDialog"[\s\S]*?<\/dialog>/)?.[0] || "";
  assert.ok(dlg, "Missing #methodDialog");
  const headings = [...dlg.matchAll(/class="settings-heading"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  for (const h of ["Real cost", "Cost metrics", "Reliability"]) assert.ok(headings.includes(h), `Methodology section "${h}" missing (have ${headings})`);
  const sources = dlg.match(/<div class="method-sources"><b>Sources:<\/b>([\s\S]*?)<\/div>/)?.[1] || "";
  for (const name of ["Artificial Analysis", "Real API Pricing", "Priors", "GitHub Copilot", "Ollama Cloud", "Kilo Pass", "OpenRouter", "ARC Prize", "CursorBench"]) assert.ok(sources.includes(`>${name}</a>`), `Sources line must link ${name}`);
  const details = dlg.match(/<details class="method-details"([^>]*)>\s*<summary>How the trust levels are calculated<\/summary>[\s\S]*?<\/details>/);
  assert.ok(details, "Collapsed 'How the trust levels are calculated' section missing");
  assert.ok(!/\bopen\b/.test(details[1]), "Trust-level details must start collapsed");
  for (const href of ["github.com/Fei2411/real-api-pricing", "github.com/adamholter/priors", "openrouter.ai", "arcprize.org"]) assert.ok(dlg.includes(href), `Source link ${href} missing`);
  // Metrics table lists every cost metric
  const metrics = dlg.match(/<table class="method-table method-metrics">[\s\S]*?<\/table>/)?.[0] || "";
  assert.equal(countOf(metrics, /<tr><td>/g), Object.keys(API_OF).length, "Cost metrics table must have one row per cost metric");
  // Level table rows match the app's glyphs and labels, in order
  const app = appWithData();
  const levelsTable = dlg.match(/<table class="method-table method-levels">[\s\S]*?<\/table>/)?.[0] || "";
  const rows = [...levelsTable.matchAll(/<tr><td class="tier-glyph">([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td id="relCount-(\w+)">/g)];
  assert.deepEqual(rows.map((r) => r[4]), [...app.LEVELS], "Level table rows / relCount ids");
  for (const [, glyph, label, , level] of rows) {
    assert.equal(glyph, app.LEVEL_GLYPH[level], `Glyph for ${level}`);
    assert.equal(label, app.LEVEL_LABEL[level], `Label for ${level}`);
  }
  const legend = html.match(/<p id="relLegend"[\s\S]*?<\/p>/)?.[0] || "";
  // The legend explains each mark in a full sentence (terse "◐ medium" labels were flagged as a regression twice)
  for (const phrase of ["next to a circle: the plan's subsidy was worked out from a related plan or model", "before a score: the benchmark didn't run this reasoning level", "Usually within 1–3 points", "High confidence:", "usually within 25%", "Medium confidence:", "−40% to +70%", "Low confidence:", "2.5× higher or lower", "Speculative:", "Hidden by default"])
    assert.ok(legend.includes(phrase), `Legend lost its description: "${phrase}"`);
  assert.deepEqual([...legend.matchAll(/<span class="tier-glyph">([^<]+)<\/span>/g)].map((m) => m[1]), [...app.LEVELS].map((l) => app.LEVEL_GLYPH[l]), "Legend glyph order");
  for (const l of ["low", "speculative"]) assert.match(rows.find((r) => r[4] === l)[3], /Hidden by default/, `${l} row must say Hidden by default`);
  // Plain language: formulas and σ live only inside the collapsed details
  const outside = dlg.replace(details[0], "");
  for (const jargon of ["σ", "ln(", "e<sup>", "1/σ²", "quota-weight"]) assert.ok(!outside.includes(jargon), `Jargon "${jargon}" outside the collapsed details`);
  assert.ok(outside.includes("What a piece of work actually costs you on a plan"), "Plain-language Real cost text missing");
  assert.ok(outside.includes("50× means a $20 plan covers $1,000 of API usage"), "Subsidy example missing");
  assert.ok(/<code>Real cost<\/code> = API price of the work ÷ plan subsidy/.test(outside), "Real cost formula missing");
  // renderMeta fills the Rows column from stats.reliability.counts
  app.renderMeta();
  for (const l of app.LEVELS) assert.equal(app.$(`relCount-${l}`).textContent, relStats.counts[l].toLocaleString(), `relCount-${l}`);
});

// Minimal CSS reader: top-level and @media rules with their declarations (comments stripped).
const cssRules = (() => {
  const out = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (depth && j < text.length) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head.replace(/^@media\s*/, ""));
      else if (!head.startsWith("@")) {
        const decls = {};
        for (const d of body.split(";")) {
          const k = d.indexOf(":");
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        out.push({ media, selectors: head.split(",").map((s) => s.trim().replace(/\s+/g, " ")), decls });
      }
      i = j;
    }
  };
  walk(cssText.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return out;
})();
/** Last value of prop for selector inside @media query (null = top level), as the cascade would apply it. */
const cssDecl = (media, selector, prop) => {
  let v;
  for (const r of cssRules) if (r.media === media && r.selectors.includes(selector) && r.decls[prop] != null) v = r.decls[prop];
  return v;
};
const PHONE = "(max-width: 600px)";
const NARROW = "(max-width: 780px)";
const px = (v) => (v == null ? NaN : parseFloat(v));

test("Methodology CSS: wraps instead of overflowing (min-width 0, white-space rules, dialog width)", () => {
  assert.equal(cssDecl(null, "#methodDialog", "width"), "min(1040px, calc(100vw - 28px))");
  assert.equal(cssDecl(null, "#methodDialog .method-body > *", "min-width"), "0");
  assert.equal(cssDecl(null, "#methodDialog .method-levels td:nth-child(3)", "white-space"), "normal");
  assert.equal(cssDecl(null, "#methodDialog .method-metrics td:nth-child(2)", "white-space"), "normal");
  assert.equal(cssDecl(null, ".method-table td:not(:first-child)", "white-space"), "nowrap");
  assert.equal(cssDecl(PHONE, "#methodDialog .method-table td", "white-space"), "normal");
  assert.equal(cssDecl(PHONE, "#methodDialog .method-table th", "white-space"), "normal");
  assert.equal(cssDecl(PHONE, "#methodDialog .method-metrics td:first-child", "white-space"), "normal");
  for (const r of cssRules) {
    if (!r.selectors.some((s) => /method/.test(s))) continue;
    for (const p of ["min-width", "width"]) {
      const v = r.decls[p];
      if (v && /^\d+(\.\d+)?px$/.test(v)) assert.ok(px(v) <= 320, `${r.selectors.join(", ")} { ${p}: ${v} } can overflow a phone`);
    }
  }
});

test("Mobile CSS: full-screen dialogs ≤600px, card rows, tap targets ≤780px, no grid overflow", () => {
  for (const sel of [".dialog", "#methodDialog"]) {
    assert.equal(cssDecl(PHONE, sel, "width"), "100vw", `${sel} width`);
    assert.equal(cssDecl(PHONE, sel, "max-width"), "100vw", `${sel} max-width`);
    assert.equal(cssDecl(PHONE, sel, "height"), "100dvh", `${sel} height`);
    assert.equal(cssDecl(PHONE, sel, "max-height"), "100dvh", `${sel} max-height`);
    assert.equal(cssDecl(PHONE, sel, "margin"), "0", `${sel} margin`);
  }
  assert.equal(cssDecl(PHONE, ".data-table thead", "display"), "none");
  assert.equal(cssDecl(PHONE, ".data-table tbody td[data-label]::before", "content"), 'attr(data-label) " "');
  assert.equal(cssDecl(PHONE, ".toolbar-sort", "display"), "inline-flex", "Sort select shows on phones");
  assert.equal(cssDecl(null, ".toolbar-sort", "display"), "none", "Sort select hidden on wide screens");
  for (const [sel, prop, min] of [
    [".btn", "min-height", 40],
    [".select", "min-height", 36],
    [".search-input", "min-height", 36],
    [".select", "font-size", 16],
    [".search-input", "font-size", 16],
    [".head-check", "min-height", 32], // floor: tightened by design to 32px; WCAG 2.5.8 minimum is 24px
    [".settings-check", "min-height", 32], // floor: tightened by design to 32px; WCAG 2.5.8 minimum is 24px
    [".toolbar-check", "min-height", 32], // floor: tightened by design to 32px; WCAG 2.5.8 minimum is 24px
    ['input[type="checkbox"]', "width", 18],
    ['input[type="range"]', "height", 40],
    ["tr.group-row td", "height", 44],
  ]) assert.ok(px(cssDecl(NARROW, sel, prop)) >= min, `${sel} { ${prop} } at ≤780px is ${cssDecl(NARROW, sel, prop)}, want ≥ ${min}px`);
  // Plan expand button: tap area = box + invisible ::after hit box (negative inset), ≥ 32 × 32.
  {
    const inset = String(cssDecl(NARROW, ".plan-exp-btn::after", "inset") || "0").split(/\s+/).map((v) => -Math.min(0, px(v) || 0));
    const [iv, ih] = [inset[0] || 0, inset[1] ?? inset[0] ?? 0];
    const w = px(cssDecl(NARROW, ".plan-exp-btn", "min-width")) + 2 * ih;
    const h = px(cssDecl(NARROW, ".plan-exp-btn", "min-height")) + 2 * iv;
    assert.ok(w >= 32 && h >= 32, `.plan-exp-btn tap area at ≤780px is ${w}×${h}px, want ≥ 32×32`);
    if (inset.some((v) => v > 0)) assert.equal(cssDecl(NARROW, ".plan-exp-btn", "position"), "relative", ".plan-exp-btn needs position: relative for its hit box");
  }
  assert.equal(cssDecl(NARROW, ".workspace", "grid-template-columns"), "minmax(0, 1fr)");
  assert.equal(cssDecl(NARROW, ".workspace > *", "min-width"), "0");
  let grids = 0;
  for (const r of cssRules) {
    const g = r.decls["grid-template-columns"];
    if (!g || !r.selectors.some((s) => /^\.workspace\b/.test(s))) continue;
    grids++;
    assert.ok(!/(^|[\s(,])1fr/.test(g.replace(/minmax\(0, 1fr\)/g, "")), `${r.selectors.join(", ")} uses a bare 1fr track (${g}); use minmax(0, 1fr)`);
  }
  assert.ok(grids >= 1, "no .workspace grid rule found");
});

test("Marks: † exactly on derived subsidies, no ~ on any cost, Fable wording, phone layout rules, legend hint", () => {
  const app = loadApp("?conf=s", { data: dataset });
  app.state.cheapestPlanOnly = false;
  app.state.cheapestEffortOnly = false;
  app.render();
  const rows = app.getFilteredRows(app.getAllEntriesResolved());
  const chart = app.$("barChart").innerHTML;
  const bars = chart.split('<div class="bar-row').slice(1);
  assert.equal(bars.length, rows.length, "one bar per row");
  const sorted = app.chartBars(rows);
  sorted.forEach((r, i) => {
    assert.equal(/class="sub-derived"[^>]*>†</.test(bars[i]), Boolean(r.subDerived), `${r.id}: † must appear exactly when the subsidy is derived`);
    assert.ok(!/~\$/.test(bars[i]), `${r.id}: costs never carry ~`);
  });
  assert.ok(sorted.some((r) => r.subDerived) && sorted.some((r) => !r.subDerived), "both derived and measured subsidies on view");
  // Table and drawer costs carry no ~ either
  const tableHtml = app.$("rows").innerHTML;
  assert.ok(!/~\$/.test(tableHtml), "table costs never carry ~");
  // Fable use wording
  assert.ok(/<span>With other models<\/span><\/label>/.test(html) && /<span>Fable only<\/span><\/label>/.test(html), "Fable use options");
  assert.ok(/id="fableCap-label">Fable use</.test(html), "Fable use label");
  assert.ok(appJs.includes("Fable-only use: counts Fable's half of the weekly limit; the other half is for other Claude models"), "Fable-only tooltip wording");
  assert.ok(!/Halved: Fable|halved: Fable/.test(appJs), "no 'halved' wording");
  // Phone: credits note leaves the bar rows; source dates move under the source text
  assert.equal(cssDecl(PHONE, ".bar-meta .credits-note", "display"), "none");
  assert.equal(cssDecl(PHONE, ".prov-table .prov-date-inline", "display"), "block");
  assert.equal(cssDecl(null, ".prov-table .prov-date-inline", "display"), "none");
  assert.ok(/class="prov-date-inline"/.test(appJs), "inline date rendered for phones");
  // Legend: one hover hint for all marks
  const legend = html.match(/<p id="relLegend"[\s\S]*?<\/p>/)?.[0] || "";
  assert.ok(/<span class="rel-legend-hint">Hover a model name, or tap ▸ next to a plan, to see where its numbers come from\.<\/span>/.test(legend), "legend hover hint");
  assert.equal((legend.match(/Hover a model name/g) || []).length, 1, "hover hint appears once, not per mark");
});

test("Methodology states the Claude cache correction plainly, and only while it matches the data", () => {
  const dlg = html.match(/<dialog id="methodDialog"[\s\S]*?<\/dialog>/)?.[0] || "";
  for (const jargon of ["φ", "quota-weight cells", "quotaCellCounts", "Claude token mix"]) assert.ok(!dlg.includes(jargon), `Methodology jargon "${jargon}"`);
  const sentence = "No correction is applied until our own quota measurements confirm it";
  const applied = dataset.stats?.reliability?.claudeMixCorrection?.rows?.applied ?? 0;
  if (applied === 0) assert.ok(dlg.includes(sentence), "Methodology must say the Claude cache correction is not applied");
  else assert.ok(!dlg.includes(sentence), `The correction now applies to ${applied} rows: update the Methodology sentence`);
});

test("Claude models are named 'Claude …'; Fable whole-week conversion is worded as a conversion", () => {
  const bare = [...new Set(entries.map((e) => e.modelDisplay).filter((n) => /^(?:Opus|Sonnet|Haiku|Fable)\s+\d/i.test(n || "")))];
  assert.deepEqual(bare, [], "Claude model names without 'Claude'");
  for (const c of Object.values(chains)) for (const l of c.lines || []) assert.ok(!/^Fable only ÷/.test(l), `chain line reads like the Fable-only setting: ${l}`);
  const f51 = entries.filter((e) => e.baseModelId === "claude-fable-5-1" && e.plan === "Claude Max" && e.subsidyReadings);
  for (const e of f51) assert.ok(Math.abs(e.subsidyMultiple - e.subsidyReadings.shared) < 1e-6 && Math.abs(e.subsidyReadings.own * 2 - e.subsidyReadings.shared) < 0.01, `${e.id}: default subsidy must be the whole-week reading`);
});

test("Range mode reserves room beside the bars so the range label never wraps under the bar", () => {
  assert.match(cssDecl(null, ".bar-fill", "width") || "", /var\(--bar-label-room, 100px\)/);
  assert.ok(px(cssDecl(null, ".bar-chart.range-view", "--bar-label-room")) >= 160, "range labels need ≥ 160px beside the bar");
  const app = loadApp("?cost=range", { data: dataset });
  app.render();
  assert.ok(app.$("barChart").classList.contains("range-view"), "chart gets range-view in Range mode");
  app.state.costView = "point";
  app.render();
  assert.ok(!app.$("barChart").classList.contains("range-view"), "no range-view in Point mode");
});

test("?blackout gives a near-black dark theme, stays in the URL, and saves nothing", () => {
  const app = loadApp("?blackout", { data: dataset });
  app.render();
  const root = app.document.documentElement;
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.ok(root.classList.contains("blackout"));
  assert.equal(root.style.getPropertyValue("--outer-bg"), "#010101");
  assert.equal(app.localStorage.getItem("ai-plan-value-theme"), null, "blackout must not change the saved theme");
  app.state.minScore = 50;
  app.syncUrlFromState();
  assert.match(app.location.search, /(\?|&)blackout(&|$)/);
  for (const v of ["--shell-bg", "--panel-head-top", "--filter-bg", "--zebra", "--title-top"]) {
    const hex = cssDecl(null, 'html.blackout[data-theme="dark"]', v) || "";
    const n = parseInt(hex.slice(1), 16);
    const lum = ((n >> 16) + ((n >> 8) & 255) + (n & 255)) / 3;
    assert.ok(/^#[0-9a-f]{6}$/i.test(hex) && lum < 32, `${v} is near-black (${hex})`);
  }
  const plain = loadApp("", { data: dataset });
  plain.render();
  assert.ok(!plain.document.documentElement.classList.contains("blackout"));
});

test("Chart model names are never cut off with an ellipsis", () => {
  for (const r of cssRules) {
    if (!r.selectors.some((x) => /^\.bar-model$/.test(x))) continue;
    assert.notEqual(r.decls["text-overflow"], "ellipsis", `.bar-model${r.media ? ` in ${r.media}` : ""} must not truncate`);
    assert.notEqual(r.decls["white-space"], "nowrap", `.bar-model${r.media ? ` in ${r.media}` : ""} must wrap`);
  }
});

test("Plan drawer sources: a table with plain-language sources and a date column", () => {
  const app = loadApp("", { data: dataset });
  // Shorthand → plain words
  for (const [raw, want] of [
    ["Priors medium, 2026-11-09", "Priors dataset (medium), 2026-11-09"],
    ["1 screenshot, 19 pp, 2026-10-03", "one user's screenshot, 19% of the limit, 2026-10-03"],
    ["= GPT-6.1 Sol (same pool, rate card)", "estimated from GPT-6.1 Sol (same quota, priced by rate card)"],
    ["GPT 5.6 Luna Plus × 2 (ruled plan ratio)", "estimated from GPT 5.6 Luna Plus (×2, Fei's plan ratio)"],
    ["gateway panel, 2026-10-06", "third-party gateway's usage panel, 2026-10-06"],
    ["Priors, tweet, large sample, 2026-11-11", "Priors dataset, a tweet, large sample, 2026-11-11"],
    ["1 account, 19.633 pp, 2026-09-27", "1 account, 20% of the limit, 2026-09-27"],
    ["Fable-only reading ÷ 0.5 (converted to whole week)", "source assumed Fable alone (half the week); doubled to count the whole week"],
    ["pooled 17.1× Fei + 20.8× Priors", "average of Fei (17.1×) and Priors (20.8×)"],
    ["Opus 5.5 tokens × 2 (price ratio)", "same quota as Opus 5.5: 2× the tokens, since each costs 1/2 as much"],
    ["GPT-6 Astra Pro 10x: GPT 5.6 Sol tokens × 0.295 (price ratio)", "GPT-6 Astra Pro 10x: same quota as GPT 5.6 Sol: 0.295× the tokens, since each costs 3.39× as much"],
  ]) assert.equal(app.plainSource(raw), want);
  // Rendered table for a plan with a chain and bundled credits
  const plan = "ChatGPT Pro 20x";
  const planEntries = app.getAllEntriesResolved().filter((e) => e.plan === plan);
  assert.ok(planEntries.length > 0, `no ${plan} rows`);
  const models = [...new Set(planEntries.map((e) => String(e.modelDisplay).replace(/\s*\(.*\)$/, "")))].map((baseName) => ({ baseName }));
  const html = app.renderProvenance(planEntries, models);
  assert.ok(/<details class="prov-details"[^>]*><summary>[^<]+<\/summary><table class="prov-table"/.test(html), "sources must render as a table, collapsed by default");
  assert.ok(!/<details class="prov-details"[^>]* open/.test(html), "sources collapsed by default");
  // Open state survives re-renders (theme switch, filter changes)
  app.state.openSources.add(plan);
  assert.ok(/<details class="prov-details"[^>]* open>/.test(app.renderProvenance(planEntries, models)), "an opened sources table stays open after re-render");
  app.state.openSources.delete(plan);
  // Hover lights every cell, including zebra cells and the sticky model column
  assert.equal(cssDecl(null, ".prov-table tbody tr:hover > td", "background-color"), "var(--row-hover)");
  assert.equal(cssDecl(null, ".plan-matrix tbody tr:hover > td", "background-color"), "var(--row-hover)");
  assert.deepEqual([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]).slice(0, 4), ["Model", "Subsidy", "Source", "Data date"]);
  assert.ok(/class="prov-date">\d{4}-\d{2}-\d{2}</.test(html), "dates must sit in their own column");
  const visible = html.replace(/ title="[^"]*"/g, ""); // the page's own wording stays on hover only
  assert.ok(!/Priors medium|\bpp\b|\| \$/.test(visible), "shorthand or raw source cells leaked into the drawer");
  assert.ok(/Bundled extras, not counted in the subsidy/.test(html) && /developers\.openai\.com/.test(html), "bundled credits row with its source host");
  // Phone: the Checked column hides, but the bundled-extras sub-header (a <th colspan> in tbody) must not
  assert.equal(cssDecl("(max-width: 600px)", ".prov-table thead th:last-child", "display"), "none");
  assert.ok(!cssRules.some((r) => r.media === "(max-width: 600px)" && r.selectors.includes(".prov-table th:last-child")), "phone rule must not hide every last <th> (it hid the bundled sub-header)");
});

test("Two-option settings are radio pairs over the hidden select; segmented buttons on phones", () => {
  for (const [id, values] of [["costView", ["point", "range"]], ["fableCap", ["shared", "own"]]]) {
    const group = html.match(new RegExp(`<span class="radio-pair"[^>]*data-for="${id}">[\\s\\S]*?</span>\\s*\\n\\s*</div>`))?.[0] || "";
    assert.deepEqual([...group.matchAll(/type="radio" name="([\w-]+)" value="(\w+)"/g)].map((m) => m[2]), values, `${id}: radio values`);
    assert.ok(new RegExp(`<select id="${id}" class="pair-source"`).test(html), `${id}: hidden select stays for URLs and reset`);
    assert.ok(new RegExp(`aria-labelledby="${id}-label"`).test(group) && /role="radiogroup"/.test(group), `${id}: labelled radiogroup`);
  }
  assert.equal(cssDecl(null, ".pair-source", "display"), "none");
  const PHONE = "(max-width: 600px)";
  assert.ok(px(cssDecl(PHONE, ".radio-opt", "min-height")) >= 36, "phone segments ≥ 36px tall");
  assert.ok(/inset/.test(cssDecl(PHONE, ".radio-opt:has(input:checked)", "box-shadow") || ""), "checked segment looks pressed");
  assert.equal(cssDecl(PHONE, ".radio-opt input[type=\"radio\"]", "opacity"), "0", "radio dots hidden on phones");
  // Behaviour: render() checks the radio that matches the select; clicking a radio drives the select's handler
  const body = fnBody("syncRadioPairs");
  assert.ok(/input\.checked = input\.value === sel\.value/.test(body), "syncRadioPairs must mirror the select");
  assert.ok(/syncRadioPairs\(\);[\s\S]{0,160}syncUrlFromState\(\);/.test(appJs), "render() must sync the radio pairs");
  assert.ok(/sel\.value = e\.target\.value;\s*\n\s*sel\.dispatchEvent\(new Event\("change"\)\)/.test(appJs), "a radio change must drive the select's change handler");
});

test("Settings help tips explain Cost metric, Min confidence, Cost and Fable use; yearly billing is a tick box", () => {
  const tips = [...html.matchAll(/<button class="help-tip" type="button" aria-label="What this means" title="([^"]+)">\?<\/button><span class="help-pop" hidden>([^<]+)<\/span>/g)];
  assert.ok(tips.length >= 4, `only ${tips.length} help tips`);
  for (const [, title, pop] of tips) assert.equal(title, pop, "hover text and tap text must match");
  const byLabel = (label) => new RegExp(`${label}</(?:label|span)><button class="help-tip"`).test(html);
  for (const label of ["Cost metric", "Min confidence", "Cost", "Fable use"]) assert.ok(byLabel(label), `${label} needs a help tip`);
  assert.ok(tips.some(([, t]) => /other half goes unused/.test(t)), "Fable use tip must explain the half-week cap");
  assert.ok(tips.some(([, t]) => /80% chance/.test(t)), "Cost tip must explain Range");
  // Behaviour: tapping a tip toggles its text; the yearly tick box drives billing and follows state
  const app = loadApp("", { data: dataset });
  assert.ok(/pop\.hidden = !pop\.hidden/.test(appJs), "a tap must toggle the inline help text");
  app.$("billingYearly").checked = true;
  app.$("billingYearly").fire("change");
  assert.equal(app.state.billing, "yearly", "ticking the box switches to yearly billing");
  const app2 = loadApp("?billing=yearly", { data: dataset });
  app2.render();
  assert.equal(app2.$("billingYearly").checked, true, "?billing=yearly ticks the box");
});

test("Phone table: every cell carries its column's data-label; Sort select and Show 50 more page the rows", () => {
  for (const group of [false, true]) {
    const app = appWithData("", { phone: true });
    app.state.groupByPlan = group;
    app.render();
    if (group) {
      const first = app.$("rows").innerHTML.match(/data-group="([^"]+)"/)[1];
      app.state.expandedTableGroups.add(first.replace(/&amp;/g, "&"));
      app.render();
      assert.ok(/class="grouped-item/.test(app.$("rows").innerHTML), "expanded group rows missing");
    }
    const cols = [...app.$("tableHead").innerHTML.matchAll(/<th data-sort="([^"]+)" class="[^"]*">([^<]*)<\/th>/g)].map((m) => ({ key: m[1], label: m[2] }));
    assert.ok(cols.length >= 9, `Too few columns: ${cols.length}`);
    for (const tr of app.$("rows").innerHTML.split("</tr>").filter((t) => /<td/.test(t))) {
      const tds = [...tr.matchAll(/<td\b([^>]*)>/g)].map((m) => m[1]);
      const labelled = tds.filter((a) => /data-label="/.test(a)).map((a) => a.match(/data-label="([^"]*)"/)[1]);
      for (const a of tds) assert.ok(/data-label="/.test(a) || /class="card-sub"/.test(a), `cell without data-label: <td${a}>`);
      assert.deepEqual(labelled, cols.map((c) => c.label), `row cells must follow the columns in order (group=${group})`);
    }
    // Sort select mirrors the columns
    const opts = [...app.$("tableSort").innerHTML.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map((m) => m[1]);
    assert.deepEqual(opts, cols.map((c) => c.key), "Sort options must equal the columns");
    assert.equal(app.$("tableSort").value, app.state.sortKey);
  }
  const app = appWithData("", { phone: true });
  app.$("tableSort").value = "score";
  app.$("tableSort").fire("change");
  assert.equal(app.state.sortKey, "score");
  assert.equal(app.state.sortDir, "desc", "score sorts high → low");
  assert.equal(app.$("tableSortDir").textContent, "▼");
  app.$("tableSortDir").fire("click");
  assert.equal(app.state.sortDir, "asc");
  app.$("tableSort").value = "fee";
  app.$("tableSort").fire("change");
  assert.equal(app.state.sortDir, "asc", "fee sorts low → high");
  // Show 50 more
  const total = app.getFilteredRows(app.getAllEntriesResolved()).length;
  assert.ok(total > 2 * app.TABLE_PAGE, `need > ${2 * app.TABLE_PAGE} rows, got ${total}`);
  const shown = () => countOf(app.$("rows").innerHTML, /<tr[\s>]/g);
  assert.equal(shown(), 50);
  assert.equal(app.$("tableMore").hidden, false);
  assert.equal(app.$("tableMoreCount").textContent, `50 / ${total.toLocaleString()}`);
  app.$("tableMoreBtn").fire("click");
  assert.equal(shown(), 100);
  assert.equal(app.$("tableMoreCount").textContent, `100 / ${total.toLocaleString()}`);
  app.$("tableSort").value = "subsidy";
  app.$("tableSort").fire("change");
  assert.equal(shown(), 50, "changing the sort returns to the first page");
  const desk = appWithData();
  assert.equal(countOf(desk.$("rows").innerHTML, /<tr[\s>]/g), total, "wide screens render every row");
  assert.equal(desk.$("tableMore").hidden, true);
});

test("Hours/mo: column only in T3 turn mode; = fee ÷ real $/turn × share × min/turn ÷ 60", () => {
  const app = appWithData();
  for (const m of Object.keys(API_OF)) {
    app.state.costMode = m;
    app.render();
    assert.equal(app.$("tableHead").innerHTML.includes(">Hours/mo</th>"), m === "turn", `${m}: Hours/mo column`);
  }
  app.state.costMode = "turn";
  let n = 0;
  for (const r of app.getAllEntriesResolved()) {
    const min = r.t3Turn?.minutesPerTurn;
    if (!(min > 0) || r.isApi) {
      assert.equal(r.hoursPerMonth, null, `${r.id}: Hours/mo without minutes per turn`);
      continue;
    }
    if (r.unmetered) {
      assert.equal(r.hoursPerMonth, Infinity);
      continue;
    }
    n++;
    const turns = (r.priceUsd / r.effectiveCost) * (r.capShare ?? 1);
    assert.ok(near(r.tasksPerMonth, turns), `${r.id}: turns/mo ${r.tasksPerMonth} != ${turns}`);
    assert.ok(near(r.hoursPerMonth, (turns * min) / 60), `${r.id}: hours ${r.hoursPerMonth}`);
  }
  assert.ok(n >= 50, `only ${n} rows with Hours/mo`);
  app.state.costMode = "task";
  assert.ok(app.getAllEntriesResolved().every((r) => r.hoursPerMonth == null), "Hours/mo outside turn mode");
});

test("Billing: ?billing=yearly resolves yearly fees in the app and survives the URL round trip", () => {
  const app = appWithData("billing=yearly");
  assert.equal(app.state.billing, "yearly");
  let n = 0;
  for (const r of app.getAllEntriesResolved()) {
    if (r.isApi || r.billingOnly || !(r.priceUsdYearly > 0)) continue;
    n++;
    assert.equal(r.priceUsd, r.priceUsdYearly, `${r.id}: yearly fee`);
    assert.equal(r.feeYearly, true);
  }
  assert.ok(n > 0);
  app.syncUrlFromState();
  assert.equal(new URLSearchParams(app.location.search).get("billing"), "yearly");
  assert.ok(app.$("rows").innerHTML.includes("/yr<"), "Yearly fee text in the table");
});

test("Usage-limit windows: filters No 5h / No weekly drop plans with those windows", () => {
  const app = appWithData();
  app.state.minConf = "speculative";
  const base = app.getFilteredRows(app.getAllEntriesResolved());
  app.state.no5h = true;
  const no5h = app.getFilteredRows(app.getAllEntriesResolved());
  assert.ok(no5h.length < base.length && no5h.every((r) => r.isApi || !r.quotaWindows.some((w) => w === "5h" || w === "daily")), "No 5h filter");
  app.state.no5h = false;
  app.state.noWeekly = true;
  const noWk = app.getFilteredRows(app.getAllEntriesResolved());
  assert.ok(noWk.length < base.length && noWk.every((r) => r.isApi || !r.quotaWindows.some((w) => w === "weekly" || w === "7d")), "No weekly filter");
  assert.ok(base.some((r) => /^Claude (Pro|Max)$/.test(r.plan)) && !no5h.some((r) => /^Claude (Pro|Max)$/.test(r.plan)), "Claude Pro/Max have a 5h window");
});

test("Easter egg: Slopstrap loads only after Shift ×5 in a row", () => {
  assert.ok(!/slopstrap|confetti/i.test(html), "index.html must not load Slopstrap or confetti up front");
  for (const f of ["slopstrap.css", "site-slop.css", "slopstrap.js"]) assert.ok(fs.existsSync(path.join(ROOT, "public", "vendor", "slopstrap", f)), `public/vendor/slopstrap/${f} missing`);
  assert.ok(fs.existsSync(path.join(ROOT, "public", "vendor", "canvas-confetti", "confetti.browser.js")), "confetti missing");
  const app = loadApp();
  const loaded = () => app.created.filter((el) => /slopstrap|confetti/.test(`${el.href || ""} ${el.src || ""}`));
  assert.equal(loaded().length, 0, "nothing loaded at start-up");
  for (let i = 0; i < 4; i++) app.keydown({ key: "Shift" });
  app.keydown({ key: "a" });
  for (let i = 0; i < 4; i++) app.keydown({ key: "Shift" });
  app.keydown({ key: "Shift", repeat: true });
  assert.equal(loaded().length, 0, "4 presses, an interruption or a key repeat must not trigger it");
  app.keydown({ key: "Shift" });
  const urls = loaded().map((el) => el.href || el.src).sort();
  // Asset URLs carry app.js's deploy stamp (?v=…) so each deploy refetches them.
  assert.deepEqual(urls, ["./vendor/canvas-confetti/confetti.browser.js", "./vendor/slopstrap/site-slop.css", "./vendor/slopstrap/slopstrap.css", "./vendor/slopstrap/slopstrap.js"].map((u) => `${u}?v=test`));
});

test("OG card: public/og.png is a 1200×630 PNG; og:* / twitter:* tags use absolute URLs", () => {
  const png = fs.readFileSync(path.join(ROOT, "public", "og.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "og.png is not a PNG");
  assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(png.readUInt32BE(16), 1200, "og.png width");
  assert.equal(png.readUInt32BE(20), 630, "og.png height");
  const meta = {};
  for (const m of html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)"/g)) meta[m[1]] = m[2];
  for (const k of ["og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image", "og:image:width", "og:image:height", "og:image:alt", "twitter:card", "twitter:title", "twitter:description", "twitter:image"]) assert.ok(meta[k], `Missing <meta> ${k}`);
  for (const k of ["og:url", "og:image", "twitter:image"]) assert.match(meta[k], /^https:\/\/[^/]+\//, `${k} must be an absolute https URL`);
  assert.ok(meta["og:image"].startsWith(meta["og:url"]) && /\/og\.png$/.test(meta["og:image"]), "og:image must be og.png under og:url");
  assert.equal(meta["twitter:image"], meta["og:image"]);
  assert.equal(meta["twitter:card"], "summary_large_image");
  assert.equal(Number(meta["og:image:width"]), png.readUInt32BE(16));
  assert.equal(Number(meta["og:image:height"]), png.readUInt32BE(20));
});

test("Deploy: OG render step runs after the test gate, cannot block the deploy; og.png gets a cache-busting ?v=", () => {
  const steps = workflowYml.split(/\n      - name: /).slice(1).map((s) => ({ name: s.split("\n")[0].trim(), body: s }));
  const idx = (re) => steps.findIndex((s) => re.test(s.name));
  const render = idx(/link-preview image/i);
  assert.ok(render !== -1, "deploy.yml has no link-preview render step");
  const r = steps[render].body;
  assert.match(r, /scripts\/og\/render\.sh/);
  assert.match(r, /continue-on-error: true/, "render step must not block the deploy");
  assert.ok(render > idx(/Abort deploy/) && render < idx(/Upload public/), "render step must run after the test gate and before the upload");
  const sh = fs.readFileSync(path.join(ROOT, "scripts", "og", "render.sh"), "utf8");
  assert.ok(sh.includes('--window-size=1200,630 --screenshot="$ROOT/public/og.png"'), "render.sh must write a 1200×630 public/og.png");
  assert.ok((fs.statSync(path.join(ROOT, "scripts", "og", "render.sh")).mode & 0o111) !== 0, "render.sh must be executable");
  for (const f of ["card.html", "inject.html"]) assert.ok(fs.existsSync(path.join(ROOT, "scripts", "og", f)), `scripts/og/${f} missing`);
  // Apply the stamp step's sed expression to index.html
  const stampStep = steps[idx(/cache-busting/i)]?.body || "";
  const sed = stampStep.match(/sed -i -E "s\|(\(\/og\\\.png\)[^|]*)\|\\1\?v=\$\{STAMP\}\|g" public\/index\.html/);
  assert.ok(sed, "Stamp step must version /og.png in public/index.html");
  const re = new RegExp(sed[1].replace(/\\"/g, '"'), "g");
  const stamped = html.replace(re, "$1?v=2026010100");
  assert.equal(countOf(stamped, /\/og\.png\?v=2026010100"/g), 2, "og:image and twitter:image both stamped");
});

test("Quota probe: --dry-run needs no credentials; plans pro | max | ultra | team; max_5x / max_20x aliases", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qp-test-"));
  try {
    // Empty PATH and HOME: no claude binary, no ~/.claude credentials, no API keys
    const env = { PATH: path.join(tmp, "no-bin"), HOME: tmp, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(tmp, "xdg") };
    const subsDir = path.join(ROOT, "data", "quota-weights", "submissions");
    const before = fs.readdirSync(subsDir).sort();
    const probe = (args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "quota-probe.mjs"), ...args], { env, cwd: tmp, encoding: "utf8", timeout: 60000 });
    const run = (plan, out) => probe(["run", "--dry-run", "--bar", "7d", "--class", "interactive", "--plan", plan, "--out", out]);
    const readSub = (dir) => {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".raw.jsonl"));
      assert.equal(files.length, 1, `expected one submission in ${dir}: ${files}`);
      const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return { header: lines[0], rows: lines.slice(1) };
    };
    const prices = QW.loadPrices();
    for (const [plan, want, price] of [["ultra", "ultra", 200], ["max_5x", "max", 100]]) {
      const out = path.join(tmp, `out-${plan}`);
      const r = run(plan, out);
      assert.equal(r.status, 0, `dry run --plan ${plan} failed: ${r.stderr || r.stdout}`);
      const sub = readSub(out);
      assert.equal(sub.header.plan, want, `--plan ${plan} recorded as ${sub.header.plan}`);
      assert.equal(sub.header.plan_price_usd, price);
      assert.equal(sub.header.simulated, true, "dry-run file must be marked simulated");
      assert.equal(sub.header.bar_under_test, "7d");
      assert.equal(sub.header.client_class, "interactive");
      assert.ok(QW.validateSubmission({ file: "dry", ...sub }, prices), "the fitter must reject dry-run files");
      // The fitter normalises old plan names the same way
      for (const [alias, norm] of [["max_5x", "max"], ["max_20x", "ultra"], ["ultra", "ultra"], ["team", "team"]]) {
        const segs = QW.buildSegments([{ file: "dry", error: null, header: { ...sub.header, plan: alias, simulated: false }, rows: sub.rows }], prices);
        assert.ok(segs.length > 0 && segs.every((s) => s.plan === norm && s.group.includes(`|${norm}|`)), `fitter plan ${alias} → ${norm}`);
      }
    }
    const bad = run("max_10x", path.join(tmp, "out-bad"));
    assert.notEqual(bad.status, 0, "an unknown plan must fail");
    assert.match(bad.stderr + bad.stdout, /unknown plan max_10x/);
    const help = probe(["help"]);
    assert.match(help.stdout + help.stderr, /--plan\s+pro \| max \(default\) \| ultra \| team/);
    assert.ok(!fs.existsSync(path.join(tmp, ".claude")) && !fs.existsSync(path.join(tmp, ".claude.json")), "dry run must not touch Claude credentials");
    assert.deepEqual(fs.readdirSync(subsDir).sort(), before, "dry run wrote into data/quota-weights/submissions");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Agent SDK client step flag in refresh-data.mjs matches the dataset", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "refresh-data.mjs"), "utf8");
  const flag = src.match(/^const APPLY_SDK_CLIENT_MULTIPLIER = (true|false);$/m)?.[1];
  assert.ok(flag, "APPLY_SDK_CLIENT_MULTIPLIER missing from scripts/refresh-data.mjs");
  assert.equal(relStats.sdkClient.on, flag === "true", `flag ${flag} but stats.reliability.sdkClient.on ${relStats.sdkClient.on} (rerun refresh-data.mjs)`);
  const app = appWithData();
  app.state.costMode = "turn";
  const withStep = app.getAllEntriesResolved().filter((r) => r.clientFactor);
  if (flag === "false") assert.equal(withStep.length, 0, "SDK step applied while the flag is off");
  else assert.ok(withStep.length > 0 && withStep.every((r) => near(r.subsidy, r.subsidyMultiple * (r.quotaMix?.turn?.f ?? 1) * r.clientFactor.turn.f)));
});

test("Fable 5.2 on Claude Max / Ultra does not reuse the Fable 5.1 multiplier", () => {
  for (const plan of ["Claude Max", "Claude Ultra"]) {
    const m = (id) => [...new Set(entries.filter((e) => e.plan === plan && e.baseModelId === id).map((e) => e.subsidyMultiple))];
    const f52 = m("claude-fable-5-2");
    const f51 = m("claude-fable-5-1");
    assert.equal(f52.length, 1, `${plan}: Fable 5.2 multiples ${f52}`);
    if (f51.length) assert.ok(Math.abs(f52[0] / f51[0] - 1) > 0.05, `${plan}: Fable 5.2 ${f52[0]}× equals Fable 5.1 ${f51[0]}×`);
    assert.ok(!entries.some((e) => e.plan === plan && e.baseModelId === "claude-fable-5-2" && chains[e.rel.chain].steps.some((x) => x.k === "M4" || x.k === "M5")), `${plan}: Fable 5.2 still on a placeholder step`);
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  process.exit(1);
}
