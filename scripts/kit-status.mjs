#!/usr/bin/env node
/**
 * Tested / untested status of every kit and adapter, from kits/status.json, written into the
 * Status cells of kits/README.md and the kit READMEs.
 *
 *   node scripts/kit-status.mjs           # rewrites the Status cells
 *   node scripts/kit-status.mjs --check   # exit 1 when a README cell differs from kits/status.json
 *
 * Tables it fills (the Status column or row must already exist):
 *   kits/README.md            column Status; the row's Harness cell names the adapters
 *   kits/codex/README.md      column Status in the table with a `--plan` column
 *   kits/api-plan/README.md   column Status in the table with a `--provider` column
 *   kits/harness/README.md    row Status in each table whose header names harnesses
 * scripts/measurement-needs.mjs appends " · untested" to kits/NEEDED.md kit cells from the same file.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATUS_PATH = path.join(ROOT, "kits", "status.json");
export const UNTESTED_TEXT = "Untested: run `smoke` first";

export function loadStatus(file = STATUS_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Status entry for kit / adapter id; throws when kits/status.json has no such adapter. */
export function entryOf(status, kit, id) {
  const e = status.kits?.[kit]?.adapters?.[id];
  if (!e) throw new Error(`kits/status.json has no ${kit} / ${id}`);
  return e;
}

export const isTested = (e) => e?.status === "tested";
export const cellText = (e) => (isTested(e) ? `Tested (${e.date})` : UNTESTED_TEXT);

/** One cell for several adapters: one text when they agree, else "label: text; label: text". */
export function groupCell(items) {
  const groups = [];
  for (const it of items) {
    const t = cellText(it.entry);
    const g = groups.find((x) => x.text === t);
    if (g) g.labels.push(it.label);
    else groups.push({ text: t, labels: [it.label] });
  }
  return groups.length === 1 ? groups[0].text : groups.map((g) => `${g.labels.join(", ")}: ${g.text}`).join("; ");
}

// ---------------------------------------------------------------------------------------------
// kit and adapter names
// ---------------------------------------------------------------------------------------------

const CODEX_LABELS = { plus: "Plus", "pro-10x": "Pro 10x", "pro-20x": "Pro 20x", "pro-500": "Pro 500" };
const HARNESS_ALIASES = { Droid: "factory" };

function harnessIds() {
  const kit = JSON.parse(fs.readFileSync(path.join(ROOT, "kits", "harness", "kit.json"), "utf8"));
  const byName = Object.fromEntries(kit.harnesses.map((h) => [h.harness, h.id]));
  return { ...byName, ...HARNESS_ALIASES };
}

/** kits/README.md Harness cell → [{ kit, id, label }]. */
export function itemsForIndexHarness(cell, status) {
  const c = cell.trim();
  if (c === "Claude Code") return [{ kit: "claude-code", id: "claude-code", label: "Claude Code" }];
  if (c === "Codex CLI") return Object.keys(status.kits.codex.adapters).map((id) => ({ kit: "codex", id, label: CODEX_LABELS[id] || id }));
  if (/^API key\b/.test(c)) return Object.keys(status.kits["api-plan"].adapters).map((id) => ({ kit: "api-plan", id, label: id }));
  const ids = harnessIds();
  return c.split(/\s*,\s*/).map((name) => {
    if (!ids[name]) throw new Error(`kits/README.md: no harness adapter named "${name}"`);
    return { kit: "harness", id: ids[name], label: name };
  });
}

/** Codex plan name on the site → codex adapter id ("ChatGPT Pro 20x" → "pro-20x"), or null. */
export function codexIdForPlan(plan) {
  if (plan === "ChatGPT Plus") return "plus";
  const m = /^ChatGPT Pro (10x|20x|500)\b/.exec(plan);
  return m ? `pro-${m[1]}` : null;
}

// ---------------------------------------------------------------------------------------------
// markdown tables
// ---------------------------------------------------------------------------------------------

const splitRow = (line) => line.split(/(?<!\\)\|/);
const cells = (line) => splitRow(line).slice(1, -1).map((x) => x.trim());
const isSep = (line) => /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
const setCell = (line, i, text) => {
  const parts = splitRow(line);
  parts[i + 1] = ` ${text} `;
  return parts.join("|");
};

/** Tables in `lines`: { head (line index), rows: [line indexes] }. */
function tables(lines) {
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith("|") || !isSep(lines[i + 1])) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].startsWith("|")) rows.push(j++);
    out.push({ head: i, rows });
    i = j;
  }
  return out;
}

/** Fill the Status column of every table with a `key` column; idOf(cell) → items. */
function fillColumn(md, keyHeader, idsOf, status) {
  const lines = md.split("\n");
  let filled = 0;
  for (const t of tables(lines)) {
    const h = cells(lines[t.head]);
    const si = h.indexOf("Status");
    const ki = h.findIndex((x) => keyHeader(x));
    if (si < 0 || ki < 0) continue;
    for (const r of t.rows) {
      const items = idsOf(cells(lines[r])[ki]).map((x) => ({ ...x, entry: entryOf(status, x.kit, x.id) }));
      lines[r] = setCell(lines[r], si, groupCell(items));
      filled++;
    }
  }
  return { md: lines.join("\n"), filled };
}

/** Harness README: the Status row of each table whose header row names harnesses. */
function fillHarnessRows(md, status) {
  const lines = md.split("\n");
  const ids = harnessIds();
  let filled = 0;
  for (const t of tables(lines)) {
    const h = cells(lines[t.head]);
    if (h[0] !== "" || !h.slice(1).every((n) => ids[n])) continue;
    const r = t.rows.find((x) => cells(lines[x])[0] === "Status");
    if (r == null) continue;
    h.slice(1).forEach((name, i) => {
      lines[r] = setCell(lines[r], i + 1, cellText(entryOf(status, "harness", ids[name])));
      filled++;
    });
  }
  return { md: lines.join("\n"), filled };
}

const firstCode = (cell) => (/`([^`]+)`/.exec(cell) || [])[1] || cell.trim();

/** README file → its rendered text with Status cells from `status`. */
export const READMES = {
  "kits/README.md": (md, s) => fillColumn(md, (x) => x === "Harness", (c) => itemsForIndexHarness(c, s), s),
  "kits/codex/README.md": (md, s) => fillColumn(md, (x) => x === "`--plan`", (c) => [{ kit: "codex", id: firstCode(c), label: firstCode(c) }], s),
  "kits/api-plan/README.md": (md, s) => fillColumn(md, (x) => x === "`--provider`", (c) => [{ kit: "api-plan", id: firstCode(c), label: firstCode(c) }], s),
  "kits/harness/README.md": (md, s) => fillHarnessRows(md, s),
};

/** { file: { current, rendered, filled } } for every README. */
export function renderAll(status = loadStatus(), root = ROOT) {
  const out = {};
  for (const [rel, fn] of Object.entries(READMES)) {
    const current = fs.readFileSync(path.join(root, rel), "utf8");
    const { md, filled } = fn(current, status);
    if (!filled) throw new Error(`${rel}: no Status cells found`);
    out[rel] = { current, rendered: md, filled };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = renderAll();
  const stale = Object.entries(all).filter(([, v]) => v.current !== v.rendered).map(([k]) => k);
  if (process.argv.includes("--check")) {
    if (stale.length) {
      console.error(`stale Status cells: ${stale.join(", ")} (node scripts/kit-status.mjs)`);
      process.exit(1);
    }
    console.log("Status cells match kits/status.json");
  } else {
    for (const rel of stale) fs.writeFileSync(path.join(ROOT, rel), all[rel].rendered);
    console.log(stale.length ? `Wrote ${stale.join(", ")}` : "Status cells already match kits/status.json");
  }
}
