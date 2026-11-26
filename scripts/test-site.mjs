#!/usr/bin/env node
/**
 * Automated verification suite for AI Plan Value.
 * Tests dataset integrity, all 8 upstream sources (including OpenRouter, Kilo Pass,
 * and ARC Prize), harness/quota-window classification, HTML/JS DOM wiring,
 * reasoning effort bounds & monotonicity, shareable URL params, and cache-busting.
 *
 * Zero external dependencies (Node.js >= 20). Exits non-zero on any failure.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as REL from "./reliability.mjs";
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

const dataset = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const html = fs.readFileSync(HTML_PATH, "utf8");
const appJs = fs.readFileSync(APP_PATH, "utf8");
const workflowYml = fs.readFileSync(WORKFLOW_PATH, "utf8");
const entries = dataset.entries || [];

// 1. Upstream sources health
test("All 9 upstream sources succeeded with non-zero records", () => {
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
  ];
  for (const [key, countField] of expected) {
    const src = dataset.sources?.[key];
    assert.ok(src, `Missing source entry: ${key}`);
    assert.equal(src.ok, true, `Source ${key} failed: ${src.error}`);
    assert.ok((src[countField] || 0) > 0, `Source ${key}.${countField} must be > 0`);
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

// 1e. Newer AA Intelligence Index scores win over lagging Fei2411 configs
test("Intelligence Index uses the newest AA observation per model+effort", () => {
  const fresh = dataset.stats?.aaIndexFreshness;
  assert.ok(fresh && Array.isArray(fresh.variants), "Missing stats.aaIndexFreshness");
  assert.equal(fresh.keptNewerPriors, fresh.variants.length);
  let checked = 0;
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
  for (const e of entries) {
    if (e.intelligenceIndex == null || e.benchmarks?.intelligenceIndex == null) continue;
    assert.ok(Math.abs(e.intelligenceIndex - e.benchmarks.intelligenceIndex) <= 0.051, `${e.id}: intelligenceIndex ${e.intelligenceIndex} vs benchmarks ${e.benchmarks.intelligenceIndex}`);
  }
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

  const findPlan = (re) => entries.find((e) => e.billing === "subscription" && re.test(e.plan));
  const claude = findPlan(/^Claude\b/i);
  assert.ok(claude && claude.openEndpoint === false && /^Claude (Pro|Max)\b/.test(claude.plan) ? claude.quotaWindows.join() === "5h,weekly" : true, "Claude classification mismatch");
  const chatgpt = findPlan(/^ChatGPT\b/i);
  assert.ok(chatgpt && chatgpt.openEndpoint === false && true, "ChatGPT classification mismatch");
  const copilot = findPlan(/^GitHub Copilot\b/i);
  assert.ok(copilot && copilot.openEndpoint === false && copilot.quotaWindows.join() === "monthly", "Copilot classification mismatch");
  const glm = findPlan(/^GLM Coding\b/i);
  assert.ok(glm && glm.openEndpoint === true && glm.quotaWindows.join() === "weekly,5h", "GLM Coding classification mismatch");
  const plus = findPlan(/^ChatGPT Plus\b/i);
  assert.ok(!plus || plus.quotaWindows.join() === "5h,weekly", "ChatGPT Plus must have 5h + weekly");
  const pro = findPlan(/^ChatGPT Pro\b/i);
  assert.ok(!pro || pro.quotaWindows.join() === "weekly", "ChatGPT Pro must be weekly only");
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
  for (const param of ["bench", "min", "top", "conf", "fable", "range", "mode", "access", "no5h", "noweekly", "minEffort", "maxEffort", "budget", "cost", "plans", "efforts", "nointerp", "extrap", "est", "extra", "q", "group", "sort"]) {
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
  assert.ok(!appJs.includes("CHART_MIN_CONF") && /renderBarChart[\s\S]{0,200}passesConf\(r, state\.minConf\)/.test(appJs), "Bar chart must follow the Min confidence setting");
  // Legacy est= mapping
  for (const [k, v] of [["0", "high"], ["h", "medium"], ["hm", "low"], ["hml", "speculative"]]) {
    assert.ok(appJs.includes(`${k === "0" ? "0" : k}: "${v}"`), `Legacy est=${k} → ${v} mapping missing`);
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
