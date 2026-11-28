/**
 * Site data for the harness kit: API list prices (combined.json entries[].aaPricing), plan fees
 * (scripts/billing-periods.mjs, monthly list price) and the site's subsidyMultiple per plan and
 * model, for "measured ÷ site".
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BILLING_PERIODS } from "../../../../scripts/billing-periods.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");
export const DEFAULT_SITE = path.join(REPO_ROOT, "public", "data", "combined.json");

export function loadSite(file = DEFAULT_SITE) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found: pass --site <path to public/data/combined.json>`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const finite = (p) => p && [p.inputPer1M, p.cacheHitPer1M, p.outputPer1M].every(Number.isFinite);

/** API price per 1M tokens for a site baseModelId: { input, cachedInput, output, asOf, source }. Throws when absent. */
export function priceFor(site, baseModelId) {
  const e = site.entries.find((x) => x.baseModelId === baseModelId && finite(x.aaPricing));
  if (!e) {
    const known = [...new Set(site.entries.filter((x) => finite(x.aaPricing)).map((x) => x.baseModelId))].filter(Boolean).sort();
    throw new Error(`no aaPricing for ${baseModelId} in combined.json (models with prices include: ${known.slice(0, 12).join(", ")}…)`);
  }
  const at = site.sources?.artificialAnalysis?.fetchedAt || site.generatedAt || null;
  return {
    input: e.aaPricing.inputPer1M,
    cachedInput: e.aaPricing.cacheHitPer1M,
    output: e.aaPricing.outputPer1M,
    asOf: at ? at.slice(0, 10) : null,
    baseModelId,
    source: "combined.json entries[].aaPricing (Artificial Analysis list prices)",
  };
}

/** Monthly fee in USD from scripts/billing-periods.mjs, else the site entry's priceUsd. */
export function feeFor(plan, site = null) {
  const rec = BILLING_PERIODS.find((r) => r.plan === plan && r.currency === "USD");
  if (rec && Number.isFinite(rec.monthly)) return { usd: rec.monthly, source: `scripts/billing-periods.mjs (${rec.url})` };
  const e = site?.entries?.find((x) => x.plan === plan && Number.isFinite(x.priceUsd));
  if (e) return { usd: e.priceUsd, source: "combined.json priceUsd" };
  return null;
}

/** Site subsidyMultiple for plan + model, the requested effort first. null when the site has no row. */
export function siteMultiple(site, plan, baseModelId, effort = null) {
  const rows = site.entries.filter((e) => e.plan === plan && e.baseModelId === baseModelId && Number.isFinite(e.subsidyMultiple));
  if (!rows.length) return null;
  const e = rows.find((x) => effort && x.effort === effort) || rows.find((x) => x.effort === "medium") || rows[0];
  const chain = site.stats?.chains?.[e.rel?.chain]?.lines ?? null;
  return { value: e.subsidyMultiple, id: e.id.replace(/@.*/, ""), effort: e.effort ?? null, level: e.rel?.level ?? null, dataDate: e.dataDate ?? null, quotaWindow: e.quotaWindow ?? null, chain };
}

/** Plans in the site data, by exact name. */
export function sitePlans(site) {
  return [...new Set(site.entries.map((e) => e.plan))];
}
