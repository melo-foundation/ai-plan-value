#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "data", "combined.json"), "utf8"));
const filter = (process.argv[2] || "").toLowerCase();

const byPlan = new Map();
for (const e of data.entries || []) {
  if (filter && !`${e.plan} ${e.vendor} ${e.modelDisplay}`.toLowerCase().includes(filter)) continue;
  const k = `${e.plan} ($${e.priceUsd ?? "API"})`;
  if (!byPlan.has(k)) byPlan.set(k, { origins: new Set(), models: new Set() });
  byPlan.get(k).origins.add(e.origin);
  byPlan.get(k).models.add(e.baseModelId);
}
for (const [k, v] of [...byPlan.entries()].sort()) {
  console.log(`${k} [${[...v.origins].join(",")}]: ${[...v.models].sort().join(", ")}`);
}
