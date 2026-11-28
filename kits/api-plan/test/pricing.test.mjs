// Pricing: site prices, --price, per-call cost, plan fees (CNY plans at the site's rate), site multiple.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { siteModelId, priceFromSite, parsePriceOption, priceUsage, planFee, siteRef, plansFor } from "../scripts/site.mjs";
import { ADAPTERS } from "../scripts/adapters.mjs";
import { estimates } from "../scripts/api-plan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "public", "data", "combined.json"), "utf8"));
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test("API model names map to site baseModelIds", () => {
  assert.equal(siteModelId("glm-5.3"), "glm-5-3");
  assert.equal(siteModelId("MiniMax-M3"), "minimax-m3");
  assert.equal(siteModelId("moonshotai/Kimi-K3"), "kimi-k3");
  assert.equal(siteModelId("deepseek-v4.1-flash-1017"), "deepseek-v4-1-flash-1017");
  assert.equal(siteModelId("qwen4-max:cloud"), "qwen4-max");
});

test("priceFromSite reads aaPricing and dates it; cache-write price when the site has one", () => {
  const p = priceFromSite(SITE, "glm-5-3");
  const row = SITE.entries.find((e) => e.baseModelId === "glm-5-3" && e.aaPricing);
  assert.equal(p.input, row.aaPricing.inputPer1M);
  assert.equal(p.cachedInput, row.aaPricing.cacheHitPer1M);
  assert.equal(p.output, row.aaPricing.outputPer1M);
  assert.match(p.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(p.source, /combined\.json/);
  const mm = priceFromSite(SITE, "minimax-m3");
  assert.ok(mm.cacheWrite > 0);
  assert.equal(priceFromSite(SITE, "no-such-model"), null);
});

test("--price input,cached,output; bad values rejected", () => {
  assert.deepEqual(parsePriceOption("3,0.3,15"), { source: "--price option", baseModelId: null, input: 3, cachedInput: 0.3, output: 15, cacheWrite: null, asOf: null });
  assert.throws(() => parsePriceOption("3,15"), /input,cached,output/);
  assert.throws(() => parsePriceOption("3,4,15"), /cached input .* above input/);
  assert.throws(() => parsePriceOption("0,0,1"), /above 0/);
  assert.throws(() => parsePriceOption("a,b,c"), /input,cached,output/);
});

test("priceUsage: uncached, cached, cache write (at its own price or input), output", () => {
  const p = { input: 2, cachedInput: 0.2, output: 10, cacheWrite: null };
  const r = priceUsage({ uncached: 1e6, cached: 1e6, cacheWrite: 1e6, output: 1e6, reasoning: 0 }, p);
  assert.ok(close(r.usd, 2 + 0.2 + 2 + 10));
  assert.ok(close(priceUsage({ uncached: 0, cached: 0, cacheWrite: 1e6, output: 0 }, { ...p, cacheWrite: 2.5 }).usd, 2.5));
  assert.ok(close(r.parts.cachedInput, 0.2));
});

test("CNY plans keep the CNY fee and use the site's USD fee (fee ÷ the build's USD/CNY rate)", () => {
  const f = planFee(SITE, "GLM Coding Lite ¥118 (mixed)");
  assert.equal(f.currency, "CNY");
  assert.equal(f.feeLocal, 118);
  const row = SITE.entries.find((e) => e.plan === "GLM Coding Lite ¥118 (mixed)");
  assert.equal(f.feeUsd, row.priceUsd);
  assert.ok(close(f.cnyPerUsd, SITE.sources.fxUsdCny.cnyPerUsd, 1e-3), `${f.cnyPerUsd} vs ${SITE.sources.fxUsdCny.cnyPerUsd}`);
  assert.equal(f.siteCnyPerUsd, SITE.sources.fxUsdCny.cnyPerUsd);
  const k = planFee(SITE, "Kimi Allegretto");
  assert.equal(k.currency, "USD");
  assert.equal(k.feeUsd, 39);
  assert.equal(k.cnyPerUsd, null);
  assert.throws(() => planFee(SITE, "Nope Plan"), /no plan/);
});

test("siteRef: the site's multiple for plan × model", () => {
  const r = siteRef(SITE, "Kimi Allegretto", "kimi-k3");
  const row = SITE.entries.find((e) => e.plan === "Kimi Allegretto" && e.baseModelId === "kimi-k3");
  assert.equal(r.subsidy, row.subsidyMultiple);
  assert.equal(siteRef(SITE, "Kimi Allegretto", "glm-5-3"), null);
});

test("every adapter covers at least one site plan; estimates exist for each", () => {
  for (const ad of Object.values(ADAPTERS)) assert.ok(plansFor(SITE, ad).length > 0, ad.id);
  const rows = estimates(SITE);
  for (const ad of Object.keys(ADAPTERS)) assert.ok(rows.some((r) => r.adapter === ad), ad);
  for (const r of rows) assert.ok(r.usd > 0 && r.calls > 0 && r.minutes > 0, r.plan);
});
