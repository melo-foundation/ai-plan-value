/**
 * Smoke check shared by the quota kits (kits/codex, kits/api-plan, kits/harness): step records,
 * the report file, the secret / path guard, the summary and the prefilled "Kit check" issue URL.
 *
 * A smoke check sends one short prompt with no tools and no files, then checks that the kit can
 * read what a real run needs: the binary or endpoint, the login or key, the exit code, the token
 * usage, the model, and one meter reading. The report records pass / fail / skipped per step with
 * a one-line reason, and field NAMES only: never token counts or meter values, keys, account ids,
 * prompts, responses, paths or emails. Every string goes through the kit's own redactor, the
 * harness kit's secret patterns, and a path / URL scrubber; the finished report is walked once
 * more and any string that still trips a pattern is replaced.
 *
 * Zero dependencies (Node ≥ 20).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SECRET_RES, redact as patternRedact } from "../harness/scripts/lib/util.mjs";

export const SMOKE_SCHEMA = "kit-smoke/1";
export const SMOKE_PROMPT = "Reply with the single word ok.";
export const REPO_URL = "https://github.com/melo-foundation/ai-plan-value";
export const ISSUE_TEMPLATE = "kit-check.yml";
/** Longest prefilled issue URL printed with the report in it. */
export const URL_LIMIT = 7000;
export const STATUSES = ["pass", "fail", "skipped"];
export const RESULTS = ["works", "partly", "fails"];

export const today = () => new Date().toISOString().slice(0, 10);

/** Short commit of the checkout holding `dir`, or null outside git. */
export function kitCommit(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  const s = r.status === 0 ? r.stdout.trim() : "";
  return /^[0-9a-f]{4,40}$/.test(s) ? s : null;
}

export function osFamily(platform = process.platform) {
  return { linux: "linux", darwin: "macos", win32: "windows" }[platform] || "other";
}

/**
 * One-line cleaner: kit redactor, secret patterns, home dir, URLs reduced to their host, absolute
 * paths replaced with <path>, cut to `max` characters.
 */
export function cleaner(kitRedact = (s) => s, home = os.homedir()) {
  return (s, max = 140) => {
    if (s == null) return null;
    let t = String(s).replace(/\s+/g, " ").trim();
    t = patternRedact(kitRedact(t));
    if (home && home.length > 1) t = t.split(home).join("~");
    t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#]+)[^\s]*/gi, "$1");
    t = t.replace(/(^|[\s(=:"'`[,])~?\/[^\s)"'`\],;]+/g, "$1<path>");
    t = t.replace(/\b[A-Za-z]:\\[^\s"']+/g, "<path>");
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,59}$/;
/** Field names of an object (top level), keeping only plain identifiers: no values, no ids used as keys. */
export function fieldNames(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.keys(obj).filter((k) => FIELD_RE.test(k) && !SECRET_RES.some((re) => re.test(k)));
}

/** Sorted, unique, plain field names. */
export const names = (list) => [...new Set((list || []).filter((k) => typeof k === "string" && FIELD_RE.test(k)))].sort();

/** Step list with add(id, status, reason). */
export function stepList() {
  const steps = [];
  return {
    steps,
    add(id, status, reason) {
      if (!STATUSES.includes(status)) throw new Error(`bad step status ${status}`);
      steps.push({ id, status, reason: reason ?? "" });
      return status;
    },
    get: (id) => steps.find((s) => s.id === id) || null,
  };
}

/** works: no step failed; fails: a step in `critical` failed; partly: another step failed. */
export function verdict(steps, critical = []) {
  if (steps.some((s) => s.status === "fail" && critical.includes(s.id))) return "fails";
  if (steps.some((s) => s.status === "fail")) return "partly";
  return "works";
}

/** Strings that trip a secret pattern, a home path or one of `secrets` → "[removed]". Numbers are dropped. */
export function guard(obj, { secrets = [], home = os.homedir() } = {}) {
  const bad = (s) => SECRET_RES.some((re) => re.test(s)) || (home && home.length > 1 && s.includes(home)) || secrets.some((x) => x && x.length >= 4 && s.includes(x));
  const walk = (v) => {
    if (typeof v === "string") return bad(v) ? "[removed]" : v;
    if (typeof v === "number") return null;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}

/**
 * The report. `steps` from stepList(); `fields` { usage: [...], meter: [...] } names only.
 * `critical` step ids decide "fails"; `secrets` are strings that must not appear (keys).
 */
export function buildReport({ kit, kitDir, adapter, toolVersion = null, plan = null, model = null, steps, fields = {}, critical = [], clean, secrets = [] }) {
  const r = {
    schema: SMOKE_SCHEMA,
    kit,
    kitCommit: kitCommit(kitDir),
    date: today(),
    adapter,
    toolVersion: toolVersion ? clean(toolVersion, 60) : null,
    os: osFamily(),
    plan: plan ? clean(plan, 80) : null,
    model: model ? clean(model, 80) : null,
    result: verdict(steps, critical),
    steps: steps.map((s) => ({ id: s.id, status: s.status, reason: clean(s.reason) })),
    fields: { usage: names(fields.usage), meter: names(fields.meter) },
  };
  return guard(r, { secrets });
}

export function writeReport(resultsDir, report) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const safe = String(report.adapter).replace(/[^\w.-]+/g, "-");
  const file = path.join(resultsDir, `smoke-${safe}-${report.date}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  return file;
}

export const issueTitle = (r) => `[kit-check] ${r.kit} · ${r.adapter}${r.plan ? ` · ${r.plan}` : ""} · ${r.result}`;

/**
 * Prefilled "Kit check" issue URL (issue-form query parameters: template, title, and one per
 * field id). The report goes in the `report` field as compact JSON; when the URL would pass
 * URL_LIMIT it is left out and `attach` is true.
 */
export function issueUrl(r, { limit = URL_LIMIT } = {}) {
  const q = (k, v) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`;
  const base = [q("template", ISSUE_TEMPLATE), q("title", issueTitle(r)), q("kit", r.kit), q("adapter", r.adapter), q("plan", r.plan ?? ""), q("result", r.result)];
  const full = `${REPO_URL}/issues/new?${[...base, q("report", JSON.stringify(r))].join("&")}`;
  if (full.length <= limit) return { url: full, attach: false };
  return { url: `${REPO_URL}/issues/new?${base.join("&")}`, attach: true };
}

/** Summary lines, the report file and the issue link. */
export function printReport(report, file, log = console.log) {
  log(`\nsmoke · ${report.kit} · ${report.adapter}${report.plan ? ` · ${report.plan}` : ""}${report.model ? ` · ${report.model}` : ""} · ${report.result}`);
  for (const s of report.steps) log(`  ${s.status.padEnd(8)} ${s.id.padEnd(12)} ${s.reason}`);
  if (report.fields.usage.length) log(`  usage fields  ${report.fields.usage.join(", ")}`);
  if (report.fields.meter.length) log(`  meter fields  ${report.fields.meter.join(", ")}`);
  log(`\nwrote ${file}`);
  const { url, attach } = issueUrl(report);
  log(attach ? `\nOpen this link and attach ${path.basename(file)} (too long to fill in):` : "\nSend the report: open this link and press Create.");
  log(url);
  return { url, attach };
}
