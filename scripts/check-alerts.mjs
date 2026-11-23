#!/usr/bin/env node
/**
 * Post-refresh monitor for GitHub Actions:
 *   1. Opens (or updates) a `[Data Alert]` issue if any upstream source failed
 *      or if the refresh script crashed. Auto-closes open `[Data Alert]` issues
 *      once all sources recover.
 *   2. Opens a deduplicated `[New Model]` issue whenever a new important model
 *      (Intelligence Index >= 45) appears on Artificial Analysis compared to the
 *      previously deployed dataset.
 *
 * Zero external dependencies (Node.js >= 20).
 * Supports --dry-run for local testing without calling GitHub's write API.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CURRENT_DATA_PATH = path.join(ROOT_DIR, "public", "data", "combined.json");

const IMPORTANT_INTEL_THRESHOLD = Number(process.env.IMPORTANT_INTEL_THRESHOLD || 45);
const REPO = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const RUN_URL =
  process.env.GITHUB_SERVER_URL && REPO && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
const LIVE_DATA_URL = process.env.LIVE_DATA_URL || (REPO
  ? `https://${REPO.split("/")[0]}.github.io/${REPO.split("/")[1]}/data/combined.json`
  : null);

const DRY_RUN = process.argv.includes("--dry-run") || !TOKEN || !REPO;
const REFRESH_FAILED = process.env.REFRESH_OUTCOME === "failure";
const PREV_SNAPSHOT_PATH = process.env.PREV_SNAPSHOT_PATH || "";

async function ghApi(endpoint, { method = "GET", body = null } = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ai-plan-value-monitor",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${endpoint} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listRepoIssues() {
  if (DRY_RUN) return [];
  return await ghApi(`/repos/${REPO}/issues?state=all&per_page=100`);
}

async function createIssue(title, body) {
  if (DRY_RUN) {
    console.log(`[alerts][dry-run] WOULD CREATE ISSUE:\n  Title: ${title}\n  Body:\n${body}\n`);
    return;
  }
  const issue = await ghApi(`/repos/${REPO}/issues`, {
    method: "POST",
    body: { title, body },
  });
  console.log(`[alerts] Created issue #${issue.number}: ${issue.html_url}`);
}

async function commentIssue(number, body) {
  if (DRY_RUN) {
    console.log(`[alerts][dry-run] WOULD COMMENT ON #${number}:\n${body}\n`);
    return;
  }
  await ghApi(`/repos/${REPO}/issues/${number}/comments`, {
    method: "POST",
    body: { body },
  });
  console.log(`[alerts] Commented on issue #${number}`);
}

async function closeIssue(number, comment) {
  if (DRY_RUN) {
    console.log(`[alerts][dry-run] WOULD CLOSE #${number}: ${comment}`);
    return;
  }
  if (comment) {
    await commentIssue(number, comment);
  }
  await ghApi(`/repos/${REPO}/issues/${number}`, {
    method: "PATCH",
    body: { state: "closed" },
  });
  console.log(`[alerts] Closed issue #${number}`);
}

async function loadPreviousDataset() {
  // 1. Prefer live deployed JSON (captures models added by earlier scheduled runs even without git commits)
  if (LIVE_DATA_URL && !DRY_RUN) {
    try {
      const res = await fetch(LIVE_DATA_URL, {
        headers: { "user-agent": "ai-plan-value-monitor" },
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json?.entries)) {
          console.log(`[alerts] Loaded previous live dataset from ${LIVE_DATA_URL} (${json.entries.length} entries)`);
          return json;
        }
      }
    } catch (err) {
      console.log(`[alerts] Could not fetch live baseline (${err.message}); falling back to local snapshot.`);
    }
  }

  // 2. Fallback to pre-refresh local file copy if provided
  if (PREV_SNAPSHOT_PATH && fs.existsSync(PREV_SNAPSHOT_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(PREV_SNAPSHOT_PATH, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function summarizeModels(dataset) {
  const map = new Map();
  for (const e of dataset?.entries || []) {
    const key = e.baseModelId || e.modelId;
    const existing = map.get(key);
    const hasSub = e.billing === "subscription";
    if (!existing) {
      map.set(key, {
        modelId: key,
        modelDisplay: String(e.modelDisplay || key).replace(/\s*\((?:max|xhigh|high|medium|low|non-reasoning)\)\s*$/i, ""),
        creator: e.modelCreator || e.vendor,
        intelligenceIndex: e.intelligenceIndex,
        aaCostPerTaskUsd: e.aaCostPerTaskUsd,
        aaPricing: e.aaPricing,
        aaUrl: e.aaUrl,
        aaLive: e.aaLive,
        subscriptionCount: hasSub ? 1 : 0,
      });
    } else {
      if ((e.intelligenceIndex ?? 0) > (existing.intelligenceIndex ?? 0)) {
        existing.intelligenceIndex = e.intelligenceIndex;
        existing.aaCostPerTaskUsd = e.aaCostPerTaskUsd;
      }
      if (hasSub) existing.subscriptionCount += 1;
    }
  }
  return map;
}

async function main() {
  const existingIssues = await listRepoIssues();
  const openDataAlerts = existingIssues.filter(
    (i) => i.state === "open" && !i.pull_request && i.title.startsWith("[Data Alert]")
  );

  let current = null;
  if (fs.existsSync(CURRENT_DATA_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(CURRENT_DATA_PATH, "utf8"));
    } catch {
      current = null;
    }
  }

  // --- 1. Data Fetch Failure Check ---
  const failedSources = [];
  if (REFRESH_FAILED || !current) {
    failedSources.push({
      name: "Refresh script failed",
      error: "scripts/refresh-data.mjs exited with an error or did not produce combined.json.",
    });
  } else {
    for (const [key, src] of Object.entries(current.sources || {})) {
      const empty =
        (key === "fei2411" && !src.rowCount) ||
        (key === "priorsRepo" && !src.itemCount) ||
        (key === "mypriors" && !src.sellerCount) ||
        (key === "artificialAnalysis" && !src.modelCount) ||
        (key === "githubCopilot" && !src.tierCount) ||
        (key === "ollamaCloud" && !src.tierCount);
      if (!src.ok || empty) {
        failedSources.push({
          name: src.name || key,
          url: src.url,
          error: src.error || "Returned 0 records",
        });
      }
    }
  }

  if (failedSources.length > 0) {
    const names = failedSources.map((s) => s.name).join(", ");
    const title = `[Data Alert] Data fetch failed: ${names}`;
    const details = failedSources
      .map((s) => `- **${s.name}**${s.url ? ` (${s.url})` : ""}: \`${s.error}\``)
      .join("\n");
    const body = [
      `Automated data refresh encountered upstream fetch failure(s) on \`${new Date().toISOString()}\`:`,
      "",
      details,
      "",
      RUN_URL ? `Workflow run: ${RUN_URL}` : "",
      "",
      `*(This issue will auto-close once all upstream sources succeed again.)*`,
    ]
      .filter(Boolean)
      .join("\n");

    if (openDataAlerts.length > 0) {
      await commentIssue(
        openDataAlerts[0].number,
        `Still failing on \`${new Date().toISOString()}\`:\n\n${details}${RUN_URL ? `\n\nWorkflow run: ${RUN_URL}` : ""}`
      );
    } else {
      await createIssue(title, body);
    }
  } else if (openDataAlerts.length > 0) {
    for (const alert of openDataAlerts) {
      await closeIssue(
        alert.number,
        `All upstream sources recovered on \`${new Date().toISOString()}\` (${current.stats?.totalEntries || 0} entries across ${current.stats?.uniqueModels || 0} models).${RUN_URL ? ` Run: ${RUN_URL}` : ""}`
      );
    }
  } else {
    console.log("[alerts] All upstream sources healthy.");
  }

  // --- 2. New Important Model Released Check ---
  if (!current || REFRESH_FAILED) {
    console.log("[alerts] Skipping new-model check because refresh failed.");
    return;
  }

  const previous = await loadPreviousDataset();
  if (!previous) {
    console.log("[alerts] No previous dataset baseline available; skipping new-model diff.");
    return;
  }

  const prevModels = summarizeModels(previous);
  const currModels = summarizeModels(current);

  const newImportant = [];
  for (const [slug, m] of currModels.entries()) {
    if (prevModels.has(slug)) continue;
    if (!m.aaLive) continue;
    if ((m.intelligenceIndex ?? 0) < IMPORTANT_INTEL_THRESHOLD) continue;
    newImportant.push(m);
  }

  if (newImportant.length === 0) {
    console.log("[alerts] No new important models detected.");
    return;
  }

  for (const m of newImportant) {
    // Deduplicate against ALL open & closed issues mentioning this model slug
    const alreadyFiled = existingIssues.some(
      (i) =>
        !i.pull_request &&
        i.title.startsWith("[New Model]") &&
        (i.title.toLowerCase().includes(m.modelDisplay.toLowerCase()) ||
          (i.body || "").includes(`\`${m.modelId}\``))
    );
    if (alreadyFiled) {
      console.log(`[alerts] Issue already exists for ${m.modelId}; skipping.`);
      continue;
    }

    const p = m.aaPricing || {};
    const priceStr =
      p.inputPer1M != null && p.outputPer1M != null
        ? `$${p.inputPer1M} / $${p.outputPer1M} per 1M tokens`
        : "Not listed";

    const title = `[New Model] ${m.modelDisplay} (Intelligence ${m.intelligenceIndex.toFixed(1)})`;
    const body = [
      `A new frontier model appeared on Artificial Analysis:`,
      "",
      `- **Model:** ${m.modelDisplay} (\`${m.modelId}\`)`,
      `- **Creator:** ${m.creator}`,
      `- **AA Intelligence Index:** ${m.intelligenceIndex.toFixed(1)}`,
      `- **AA API Cost / Task:** $${m.aaCostPerTaskUsd.toFixed(2)}`,
      `- **API Pricing (In / Out):** ${priceStr}`,
      `- **Matched Subscription Plans:** ${m.subscriptionCount}`,
      `- **Artificial Analysis:** ${m.aaUrl}`,
      "",
      `### Follow-up checklist`,
      `- [ ] Verify model slug alias in \`scripts/refresh-data.mjs\` if subscription plans aren't matching yet`,
      `- [ ] Check [Fei2411/real-api-pricing](https://github.com/Fei2411/real-api-pricing) and [mypriors.com/subsidies](https://mypriors.com/subsidies) for subscription quota measurements`,
      RUN_URL ? `\nDetected during workflow run: ${RUN_URL}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await createIssue(title, body);
  }
}

main().catch((err) => {
  console.error("[alerts] Unexpected error:", err);
  process.exit(1);
});
