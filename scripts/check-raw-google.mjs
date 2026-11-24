#!/usr/bin/env node
/**
 * Dump every raw row mentioning Google/Gemini/Ultra from upstream
 * Fei2411/points.csv and adamholter/priors latest.json.gz.
 */
import zlib from "node:zlib";

const UA = "ai-plan-value-debug/1.0";
const RE = /google|gemini/i;

const [feiRes, priRes] = await Promise.all([
  fetch("https://raw.githubusercontent.com/Fei2411/real-api-pricing/main/derived/points.csv", { headers: { "user-agent": UA } }),
  fetch("https://raw.githubusercontent.com/adamholter/priors/main/data/snapshots/latest.json.gz", { headers: { "user-agent": UA } }),
]);

console.log("=== RAW Fei2411 points.csv (Google / Gemini rows) ===");
const feiText = await feiRes.text();
const lines = feiText.split(/\r?\n/);
console.log("  Header:", lines[0]);
for (const line of lines.slice(1)) {
  if (RE.test(line)) console.log(" ", line.slice(0, 180));
}

console.log("\n=== RAW Priors latest.json.gz (subscription-token-price Google / Gemini) ===");
const gz = Buffer.from(await priRes.arrayBuffer());
const snap = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
for (const obs of snap.observations || []) {
  if (obs.benchmarkId !== "subscription-token-price") continue;
  const det = obs.details || {};
  const plans = det.plans || [];
  const matchModel = RE.test(obs.variantId || "");
  for (const p of plans) {
    if (matchModel || RE.test(p.plan || "")) {
      console.log(
        `  model=${obs.variantId} | plan="${p.plan}" | fee=${p.feeUsd} | usdPerMtok=${p.usdPerMtok} | conf=${p.confidence || det.confidence} | sameAs=${det.sameAs || "-"} | listPrice=${Boolean(det.listPrice)}`
      );
    }
  }
}
