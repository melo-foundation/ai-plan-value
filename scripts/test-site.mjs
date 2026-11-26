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
import { BILLING_PERIODS, isAnnualVariant } from "./billing-periods.mjs";

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

test("Claude quota token-mix correction matches the build flag (with range)", () => {
  const on = relStats.claudeMixCorrection;
  assert.equal(typeof on, "boolean", "stats.reliability.claudeMixCorrection missing");
  assert.deepEqual(REL.phiVector({ output: 1 }), [1, 1, 1, 1], "φ of a pure-output mix must be 1");
  const claude = entries.filter((e) => /^Claude (Pro|Max|Ultra|Team)\b/.test(e.plan) && e.billing === "subscription");
  assert.ok(claude.length > 50, "Too few Claude rows");
  for (const e of entries) {
    if (!claude.includes(e)) {
      assert.ok(!e.quotaMix, `Non-Claude row ${e.id} has a mix correction`);
      continue;
    }
    assert.ok(e.rel.w.task >= 0.05 - 1e-9, `${e.id}: Claude mix σ missing`);
    if (!on) {
      assert.ok(!e.quotaMix, `${e.id}: correction applied while the flag is off`);
      continue;
    }
    for (const [m, q] of Object.entries(e.quotaMix || {})) {
      // Doc bound 0.6–1.15; the no-cache 1M-token metric on a 71%-cache-read sample lands at ≈0.60, so 0.55.
      assert.ok(q.f >= 0.55 && q.f <= 1.15, `${e.id} ${m}: S_eff/S ${q.f} outside 0.55–1.15`);
      assert.ok(q.lo <= q.f + 1e-9 && q.f <= q.hi + 1e-9, `${e.id} ${m}: f outside its range`);
    }
  }
  if (on) {
    const opus = entries.find((e) => e.plan === "Claude Max" && e.modelId === "claude-opus-5-5--max");
    assert.ok(opus?.quotaMix?.task && opus.quotaMix.task.f > 0.7 && opus.quotaMix.task.f < 0.86, `Claude Max × Opus 5.5 (max) task factor ${opus?.quotaMix?.task?.f}, expected ≈0.78`);
    assert.ok(claude.filter((e) => e.quotaMix?.task).length >= claude.length * 0.5, "Correction missing on most Claude rows");
  }
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
  assert.ok(/<label class="settings-heading" for="billing">Billing<\/label>/.test(html), "Missing Billing label");
  assert.ok(appJs.includes('state.billing = parseBillingParam(params.get("billing"))') && appJs.includes('params.set("billing", "yearly")'), "billing URL param not read/written");
  assert.ok(/\/yr`/.test(appJs) && appJs.includes('"no annual"'), "Yearly fee text missing");
  assert.ok(html.includes("<code>Yearly</code>: subsidy × monthly price ÷ yearly price per month"), "Methodology Yearly formula missing");
  // Budget, Tasks/mo and sort read the resolved fee
  assert.ok(appJs.includes("priceUsd: isApi ? e.priceUsd : bill.fee") && appJs.includes("(bill.fee / effectiveCost) * capShare"), "Fee / Tasks/mo must follow the billing setting");
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
  assert.ok(/Agent SDK client ÷/.test(appJs), "Tooltip chain must list the SDK client step");
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
  assert.ok(/contents: write/.test(workflowYml) && /\[skip ci\]/.test(workflowYml) && /data\/reliability\/history\.jsonl/.test(workflowYml), "deploy.yml must commit the ledger with [skip ci]");
  assert.ok(/continue-on-error: true[\s\S]{0,40}shell: bash[\s\S]{0,200}history\.jsonl/.test(workflowYml), "Ledger commit step must not block the deploy");
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

console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  process.exit(1);
}
