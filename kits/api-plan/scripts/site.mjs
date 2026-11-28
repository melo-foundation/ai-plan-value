/**
 * Site data for the API plan kit: model API prices (entries[].aaPricing), plan fees and the site's
 * subsidy multiple, all from public/data/combined.json.
 *
 * Fees: the site's priceUsd for the plan row. CNY plans keep their CNY fee (BILLING_PERIODS in
 * scripts/billing-periods.mjs); priceUsd is that fee ÷ the build's USD/CNY rate
 * (sources.fxUsdCny.cnyPerUsd, ECB via Frankfurter, Fei2411's dated rate as fallback), so the
 * measured multiple and the site multiple share one conversion. The result records the CNY fee,
 * the USD fee and the rate the two imply.
 *
 * Pricing convention (same as the Codex kit): uncached input at input, cache hits at cachedInput,
 * cache writes at cacheWrite when the site has one (else input), output (incl. reasoning) at output.
 */

import { BILLING_PERIODS, billingKey } from "../../../scripts/billing-periods.mjs";

/** Site baseModelId for an API model name: vendor prefix dropped, lowercase, dots and spaces → hyphens. */
export function siteModelId(model) {
  return String(model || "")
    .trim()
    .replace(/^.*\//, "")
    .toLowerCase()
    .replace(/[.\s_]+/g, "-")
    .replace(/:.*$/, "");
}

const priced = (e) => e?.aaPricing && [e.aaPricing.inputPer1M, e.aaPricing.cacheHitPer1M, e.aaPricing.outputPer1M].every(Number.isFinite);

/** API price per 1M tokens for a baseModelId, or null. */
export function priceFromSite(site, baseId) {
  const e = (site.entries || []).filter((x) => x.baseModelId === baseId && priced(x)).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (!e) return null;
  const p = e.aaPricing;
  const asOf = String(site.sources?.artificialAnalysis?.fetchedAt || site.generatedAt || "").slice(0, 10) || null;
  return {
    source: "public/data/combined.json entries[].aaPricing (Artificial Analysis)",
    baseModelId: baseId,
    input: p.inputPer1M,
    cachedInput: p.cacheHitPer1M,
    output: p.outputPer1M,
    cacheWrite: Number.isFinite(p.cacheWritePer1M) ? p.cacheWritePer1M : null,
    asOf,
  };
}

/** "--price 3,0.3,15" → price object; throws on a bad value. */
export function parsePriceOption(s) {
  const parts = String(s).split(",").map((x) => Number(x.trim()));
  if (parts.length !== 3 || !parts.every((x) => Number.isFinite(x) && x >= 0)) throw new Error(`--price takes input,cached,output in USD per 1M tokens, e.g. --price 3,0.3,15 (got ${s})`);
  if (parts[1] > parts[0]) throw new Error(`--price: cached input (${parts[1]}) above input (${parts[0]})`);
  if (!(parts[0] > 0 && parts[2] > 0)) throw new Error("--price: input and output must be above 0");
  return { source: "--price option", baseModelId: null, input: parts[0], cachedInput: parts[1], output: parts[2], cacheWrite: null, asOf: null };
}

/** Models with a price, closest to a name first (for error messages). */
export function nearModels(site, baseId, n = 6) {
  const ids = [...new Set((site.entries || []).filter(priced).map((e) => e.baseModelId))];
  const stem = baseId.split("-")[0];
  return ids.filter((x) => x.startsWith(stem)).concat(ids.filter((x) => !x.startsWith(stem))).slice(0, n);
}

/** USD cost of one call's normalized usage. */
export function priceUsage(u, p) {
  const parts = {
    uncachedInput: (u.uncached * p.input) / 1e6,
    cachedInput: (u.cached * p.cachedInput) / 1e6,
    cacheWrite: (u.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6,
    output: (u.output * p.output) / 1e6,
  };
  return { usd: parts.uncachedInput + parts.cachedInput + parts.cacheWrite + parts.output, parts };
}

const isVisible = (e) => e.billing === "subscription" && !e.isLegacy && !e.isOffPeak && e.billingOnly !== "yearly";

/** Site plan names an adapter covers (default-visible rows), sorted. */
export function plansFor(site, adapter) {
  return [...new Set((site.entries || []).filter((e) => isVisible(e) && adapter.planTest(e.plan)).map((e) => e.plan))].sort();
}

/** Fee of a site plan: USD as the site uses it, plus the local currency fee. Throws when unknown. */
export function planFee(site, plan) {
  const rows = (site.entries || []).filter((e) => e.plan === plan && e.billing === "subscription");
  if (!rows.length) throw new Error(`no plan "${plan}" in combined.json`);
  const feeUsd = rows[0].priceUsd;
  const rec = BILLING_PERIODS.find((r) => r.plan === billingKey(plan)) || null;
  const currency = rec?.currency || "USD";
  const feeLocal = rec ? rec.monthly : feeUsd;
  const fx = site.sources?.fxUsdCny || {};
  return {
    plan,
    feeUsd,
    currency,
    feeLocal,
    cnyPerUsd: currency === "CNY" && feeUsd > 0 ? Math.round((feeLocal / feeUsd) * 1e4) / 1e4 : null,
    siteCnyPerUsd: currency === "CNY" ? fx.cnyPerUsd ?? null : null,
    fxSource: currency === "CNY" ? `${fx.name || "USD/CNY"}${fx.rateDate ? ` ${fx.rateDate}` : ""}${fx.usedFallback ? " (Fei2411 fallback)" : ""}` : null,
    billingSource: rec?.url || null,
  };
}

/** The site's subsidy multiple for plan × model: the row with the highest Intelligence Index. */
export function siteRef(site, plan, baseId) {
  const rows = (site.entries || []).filter((e) => e.plan === plan && e.baseModelId === baseId && Number.isFinite(e.subsidyMultiple));
  if (!rows.length) return null;
  rows.sort((a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1) || (a.id < b.id ? -1 : 1));
  const e = rows[0];
  const chain = site.stats?.chains?.[e.rel?.chain]?.lines ?? null;
  return { id: e.id.replace(/@.*/, ""), subsidy: e.subsidyMultiple, level: e.rel?.level ?? null, dataDate: e.dataDate ?? null, chain };
}
