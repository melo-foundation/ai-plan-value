#!/usr/bin/env node
/**
 * Full upstream-to-output coverage audit:
 * Checks EVERY subscription row in Fei2411/points.csv and adamholter/priors
 * against public/data/combined.json and reports every dropped row with its exact reason.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, "..", "public", "data", "combined.json");
const UA = "ai-plan-value-audit/1.0";

function normSlug(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const headers = rows[0] || [];
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
}

const combined = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const presentIds = new Set((combined.entries || []).map((e) => e.id.split("@")[0]));
const presentPlanModels = new Set(
  (combined.entries || []).map((e) => `${normSlug(e.plan)}::${normSlug(e.baseModelId)}`)
);
const presentVendorFeeModels = new Set(
  (combined.entries || [])
    .filter((e) => e.billing === "subscription" && e.priceUsd != null)
    .map((e) => `${normSlug(e.vendor)}::${Math.round(e.priceUsd)}::${normSlug(e.baseModelId)}`)
);
const presentModels = new Set((combined.entries || []).map((e) => normSlug(e.baseModelId)));

const [feiRes, priRes] = await Promise.all([
  fetch("https://raw.githubusercontent.com/Fei2411/real-api-pricing/main/derived/points.csv", { headers: { "user-agent": UA } }),
  fetch("https://raw.githubusercontent.com/adamholter/priors/main/data/snapshots/latest.json.gz", { headers: { "user-agent": UA } }),
]);

const feiRows = parseCsv(await feiRes.text());
const droppedFei = [];
for (const r of feiRows) {
  if (r.billing === "metered") continue;
  const idBase = String(r.id || "").split("@")[0];
  if (presentIds.has(idBase)) continue;
  const reasons = [];
  if (!r.aa_intelligence_index__score && !presentModels.has(normSlug(r.model))) reasons.push("no_intel");
  if (!r.aa_intelligence_index__mean_cost_usd_per_task && !presentModels.has(normSlug(r.model))) reasons.push("no_cpt");
  if (r.unmetered !== "true" && !r.d && !r.list_blended_usd_per_mtok) reasons.push("no_d_or_list_blended");
  if (!presentModels.has(normSlug(r.model))) reasons.push("model_not_in_combined");
  droppedFei.push({
    id: r.id,
    plan: r.plan_en || r.plan,
    model: r.model,
    price: r.price_usd,
    realMtok: r.real_usd_per_mtok,
    d: r.d,
    reasons: reasons.join(",") || "unknown",
  });
}

console.log(`=== DROPPED Fei2411 SUBSCRIPTION ROWS (${droppedFei.length} of ${feiRows.filter((r) => r.billing !== "metered").length}) ===`);
for (const d of droppedFei) {
  console.log(`  ${d.id} | plan="${d.plan}" | model=${d.model} | $${d.price} | real=${d.realMtok} | d=${d.d || "-"} | WHY: ${d.reasons}`);
}

const gz = Buffer.from(await priRes.arrayBuffer());
const snap = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
const droppedPriors = [];
for (const obs of snap.observations || []) {
  if (obs.benchmarkId !== "subscription-token-price") continue;
  const modelId = String(obs.variantId || "").split("@")[0];
  const det = obs.details || {};
  for (const p of det.plans || []) {
    const planKey = `${normSlug(p.plan)}::${normSlug(modelId)}`;
    const hasExact = presentPlanModels.has(planKey);
    // Rough check if covered under normalized plan name or vendor+fee
    let covered = hasExact;
    if (!covered) {
      for (const e of combined.entries || []) {
        if (e.billing !== "subscription") continue;
        if (
          (normSlug(e.baseModelId) === normSlug(modelId) || normSlug(e.baseModelId).includes(normSlug(modelId))) &&
          (normSlug(e.planLocal) === normSlug(p.plan) ||
            (e.priceUsd != null && p.feeUsd != null && Math.abs(e.priceUsd - p.feeUsd) < 1.5))
        ) {
          covered = true;
          break;
        }
      }
    }
    if (!covered) {
      droppedPriors.push({
        model: modelId,
        plan: p.plan,
        fee: p.feeUsd,
        usdPerMtok: p.usdPerMtok,
        conf: p.confidence || det.confidence,
        hasListPrice: Boolean(det.listPrice || det.sameAs),
        inCombinedModels: presentModels.has(normSlug(modelId)),
      });
    }
  }
}

console.log(`\n=== DROPPED Priors SUBSCRIPTION ITEMS (${droppedPriors.length}) ===`);
for (const d of droppedPriors) {
  console.log(`  model=${d.model} | plan="${d.plan}" | $${d.fee} | conf=${d.conf} | listPrice=${d.hasListPrice} | modelInCombined=${d.inCombinedModels}`);
}
