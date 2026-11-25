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
      if (e.origin === "fei2411" && e.upstreamSubsidyMultiple > 0) {
        const ratio = e.subsidyMultiple / e.upstreamSubsidyMultiple;
        assert.ok(
          ratio >= 0.95 && ratio <= 4,
          `${e.id} (${e.feiWorkload}) subsidy ${e.subsidyMultiple}x is ${ratio.toFixed(2)}x Fei2411's standard-mix ${e.upstreamSubsidyMultiple}x — currency/unit mismatch?`
        );
      }
      if (e.origin === "fei2411" && e.monthlyTokens > 0 && e.priceUsd > 0 && e.listBlendedUsdPerMtok > 0) {
        const implied = ((e.monthlyTokens / 1e6) * e.listBlendedUsdPerMtok) / e.priceUsd;
        const relDiff = Math.abs(implied - e.subsidyMultiple) / e.subsidyMultiple;
        assert.ok(
          relDiff <= 0.1,
          `Subsidy mismatch on ${e.id}: ${e.subsidyMultiple}x vs implied ${implied.toFixed(2)}x (monthlyTokens × listBlended / priceUsd)`
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
    assert.equal(sample.quotaWindow, "monthly", `${planName} should be quotaWindow=monthly`);
  }
});

// 6. Harness & Quota Reset Window classification
test("All entries have valid harness/quotaWindow metadata and zero unclassified plans", () => {
  const validWindows = new Set(["monthly", "weekly", "rolling", "payg"]);
  for (const e of entries) {
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
  assert.ok(claude && claude.openEndpoint === false && claude.quotaWindow === "weekly", "Claude classification mismatch");
  const chatgpt = findPlan(/^ChatGPT\b/i);
  assert.ok(chatgpt && chatgpt.openEndpoint === false && chatgpt.quotaWindow === "weekly", "ChatGPT classification mismatch");
  const copilot = findPlan(/^GitHub Copilot\b/i);
  assert.ok(copilot && copilot.openEndpoint === false && copilot.quotaWindow === "monthly", "Copilot classification mismatch");
  const glm = findPlan(/^GLM Coding\b/i);
  assert.ok(glm && glm.openEndpoint === true && glm.quotaWindow === "rolling", "GLM Coding classification mismatch");
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
  for (const param of ["bench", "min", "mode", "access", "window", "minEffort", "maxEffort", "budget", "cost", "plans", "efforts", "nointerp", "extrap", "extra", "q", "group", "sort"]) {
    assert.ok(appJs.includes(`"${param}"`), `Missing URL param "${param}" in public/app.js`);
  }
  assert.ok(appJs.includes("readCachedDataset") && appJs.includes("writeCachedDataset"), "Missing Cache API stale-while-revalidate in public/app.js");
  assert.ok(appJs.includes("passesEffortBounds") && appJs.includes("passesAccessAndWindow"), "Missing effort/access/window filters in public/app.js");
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

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
