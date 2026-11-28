#!/usr/bin/env node
/**
 * codex-quota: measures API-priced usage per percentage point of the Codex usage meter (ChatGPT
 * Plus, Pro 10x / 20x / 500; GPT-6.2 Sol by default, any model via --model) from Codex CLI rollout
 * files, and the monthly API value and subsidy multiple the site uses. Usage: kits/codex/README.md.
 *
 *   node kits/codex/scripts/codex-quota.mjs smoke [--plan <plan>] [--model <slug>]
 *   node kits/codex/scripts/codex-quota.mjs check [--plan <plan>]
 *   node kits/codex/scripts/codex-quota.mjs run --arm A|B [--plan <plan>] [--model <slug>] [--tag <tag>] [--target-pp N] [--dry-run] [options]
 *   node kits/codex/scripts/codex-quota.mjs analyse --run <tag> | --dir <folder> | --from <ISO> --to <ISO> [options]
 *   node kits/codex/scripts/codex-quota.mjs compare <result-a.json> <result-b.json>
 *   node kits/codex/scripts/codex-quota.mjs prices [--site <combined.json>] [--models a,b]
 *
 * Runs `codex exec` headless in a throwaway directory under ~/.cache/codex-quota-runs/<tag>/, one
 * subdirectory per task, with the workspace-write sandbox limited to that subdirectory (no /tmp,
 * no $TMPDIR, no network) for arm A and the read-only sandbox for arm B and the idle pings.
 *
 * Privacy: ~/.codex/auth.json is never opened. Result files hold no prompts, paths or account ids;
 * other sessions are listed by session id only. Run manifests, rollout copies and results stay in kits/codex/results/ (git-ignored).
 * Zero dependencies (Node ≥ 20).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as RF from "./rollout-fit.mjs";
import { TASKS_A, taskB, WORKLOAD_VERSION, workloadHash, B_ROWS } from "../workload/tasks.mjs";
import { PLANS, PLAN_IDS, DEFAULT_PLAN_ID, planById, planFee, resolvePlan } from "./plans.mjs";
import * as Smoke from "../../lib/smoke.mjs";

const __filename = fileURLToPath(import.meta.url);
const KIT_VERSION = "1.1.0";
const KIT_DIR = path.resolve(path.dirname(__filename), "..");
const REPO_ROOT = path.resolve(KIT_DIR, "..", "..");
const DEFAULT_SITE = path.join(REPO_ROOT, "public", "data", "combined.json");
// CODEX_QUOTA_SCRATCH (tests): runs, results and work dirs go under it; prices.json is still read
// from the kit folder.
const SCRATCH = process.env.CODEX_QUOTA_SCRATCH ? path.resolve(process.env.CODEX_QUOTA_SCRATCH) : null;
const LOCAL_DIR = path.join(KIT_DIR, "results");
const RUNS_DIR = SCRATCH ? path.join(SCRATCH, "runs") : path.join(LOCAL_DIR, "runs");
const RESULTS_DIR = SCRATCH ? path.join(SCRATCH, "results") : LOCAL_DIR;
const PRICES_PATH = path.join(KIT_DIR, "prices.json");
const WORK_BASE = SCRATCH ? path.join(SCRATCH, "work") : path.join(os.homedir(), ".cache", "codex-quota-runs");
const SESSIONS_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
export const DEFAULT_MODEL = "gpt-6.2-sol";
/** Models `prices` reads from the site by default. Codex slug → site baseModelId: dots become hyphens. */
export const PRICED_MODELS = ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6-astra"];
const siteBaseId = (slug) => slug.replace(/\./g, "-");
// targetPp: the most weekly pp a run uses by default. maxHours: the run stops at this time once the
// weekly meter has made MIN_STEPS steps. usdPerHour: API $ one task stream spends per hour on
// DEFAULT_MODEL, from the 2026-11-27 Plus runs (A $7.43 in about 2 h, B $4.00 in about 1.25 h);
// only used to size the default target and parallel streams before the run.
export const ARMS = {
  A: { targetPp: 12, maxHours: 3, usdPerHour: 3.7, effort: "medium", sandbox: "workspace-write", label: "coding tasks, medium effort" },
  B: { targetPp: 8, maxHours: 2, usdPerHour: 3.2, effort: "medium", sandbox: "read-only", label: "low-cache prompts, medium effort" },
};
export const MAX_PARALLEL = 6;
const READING_LOOKBACK_MS = 8 * 86400000;
const FIVE_H_PAUSE_PCT = 95;
// A task cannot be stopped part-way on the meter, so the 5h pause also keeps room for the largest
// 5h move one task has made so far. Sol arm A tasks move the 5h meter < 1.5 pp; Astra (≈4× the API
// price per token, ≈0.4× the $ per pp) moves it about 9× as much per task, enough to hit 100%
// mid-task when the fixed 95% threshold alone decides.
const FIVE_H_HARD_PCT = 100;

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const sq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[k] = true;
    else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

function loadPrices() {
  if (!fs.existsSync(PRICES_PATH)) fail(`${PRICES_PATH} missing: run \`node kits/codex/scripts/codex-quota.mjs prices\``);
  return JSON.parse(fs.readFileSync(PRICES_PATH, "utf8"));
}

/** API price of one model from prices.json; throws when the model has none. */
export function priceFor(prices, model) {
  const p = prices?.models?.[model];
  if (!p || ![p.input, p.cachedInput, p.output].every(Number.isFinite)) {
    throw new Error(`no price for ${model} in prices.json (priced: ${Object.keys(prices?.models || {}).join(", ") || "none"}): run \`node kits/codex/scripts/codex-quota.mjs prices --models ${[...new Set([...Object.keys(prices?.models || {}), model])].join(",")}\``);
  }
  return p;
}

/** Site subsidy multiple for one model on one plan (site plan name), as analyse() takes it; null when absent. */
export function siteRefFor(prices, model, planName = "ChatGPT Plus") {
  const s = prices?.sites ? prices.sites[planName]?.[model] : planName === "ChatGPT Plus" ? prices?.site?.[model] : null;
  return s?.subsidy ? { subsidy: s.subsidy, source: `${s.id}: ${(s.chain || []).join("; ")}` } : null;
}

/**
 * Default pacing of one run on one plan: the site's $ per weekly pp for the model on the plan
 * (subsidy × fee ÷ 400), the arm's API $ per hour per task stream scaled by the model's price, and
 * from them the parallel task streams (fewest that reach MIN_STEPS pp within maxHours, at most
 * MAX_PARALLEL), the target pp (arm target, cut to what fits in maxHours, at least MIN_STEPS), and
 * the expected hours and API $. Explicit targetPp / parallel / maxHours are kept as given.
 */
export function pacing({ arm, plan, model, prices, targetPp = null, parallel = null, maxHours = null }) {
  const cfg = ARMS[arm];
  const fee = planFee(plan);
  const ref = siteRefFor(prices, model, plan.name);
  const usdPerPp = ref && fee ? (ref.subsidy * fee) / (100 * RF.WEEKS_PER_MONTH) : null;
  const base = prices?.models?.[DEFAULT_MODEL];
  const m = prices?.models?.[model];
  const scale = base && m ? (m.input + m.output) / (base.input + base.output) : 1;
  const usdPerHour = cfg.usdPerHour * scale;
  const hours = maxHours ?? cfg.maxHours;
  const ppPerHour = usdPerPp ? usdPerHour / usdPerPp : null;
  let par = parallel;
  if (par == null) {
    par = 1;
    if (ppPerHour) while (par < MAX_PARALLEL && par * ppPerHour * hours < RF.MIN_STEPS) par++;
  }
  let target = targetPp;
  if (target == null) target = ppPerHour ? Math.max(RF.MIN_STEPS, Math.min(cfg.targetPp, Math.floor(par * ppPerHour * hours))) : cfg.targetPp;
  let estHours = null;
  let estPp = null;
  if (ppPerHour) {
    const rate = par * ppPerHour;
    estHours = Math.max(Math.min(target / rate, hours), Math.min(RF.MIN_STEPS, target) / rate);
    estPp = Math.min(target, rate * estHours);
  }
  return {
    usdPerPp,
    usdPerHour: usdPerHour * par,
    parallel: par,
    targetPp: target,
    maxHours: hours,
    est: estHours != null ? { hours: RF.round(estHours, 2), pp: RF.round(estPp, 2), usd: RF.round(estPp * usdPerPp, 2) } : null,
  };
}

/** Latest plan_type in a reading list, as resolvePlan takes it. */
const typesOf = (reading) => (reading?.rate?.planType ? [reading.rate.planType] : []);

/** Expected model and effort for analyse: flags first, then the run manifest, then the default. */
export function expectedFrom(a, manifest) {
  return { model: a.model || manifest?.model || DEFAULT_MODEL, effort: a.effort || manifest?.effort || null };
}

const MODEL_SLUG = /^[a-z0-9][a-z0-9.-]*$/;

/** Pause before the next task: limit reached, 5h at the pause threshold, or no room left for the largest task so far. */
export function fiveHourPause(fh, maxTask5h, reachedType = null) {
  return !!reachedType || (fh != null && (fh.pct >= FIVE_H_PAUSE_PCT || fh.pct + maxTask5h >= FIVE_H_HARD_PCT));
}

function codexVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().replace(/^codex-cli\s*/, "") : null;
}

/** Other Codex or pi processes (read from /proc; nothing is signalled). */
function otherAgentProcesses() {
  const out = [];
  if (!fs.existsSync("/proc")) return out;
  const mine = new Set([process.pid, process.ppid]);
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || mine.has(Number(d))) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!cmd.length) continue;
    const joined = cmd.join(" ");
    if (joined.includes("codex-quota.mjs")) continue;
    const base = (s) => path.basename(s || "");
    const isCodex = cmd.slice(0, 3).some((x) => /^codex(\.js)?$/.test(base(x))) || /@openai\/codex/.test(joined);
    const isPi = cmd.slice(0, 3).some((x) => base(x) === "pi") || /pi-coding-agent|@mariozechner\/pi/.test(joined);
    if (isCodex || isPi) out.push({ pid: Number(d), kind: isCodex ? "codex" : "pi", cmd: base(cmd[0]) + (cmd[1] ? ` ${base(cmd[1])}` : "") });
  }
  return out;
}

/** Latest reading in the newest rollout file, without any API call. */
function latestReading(sinceMs = null) {
  const files = RF.listRolloutFiles(SESSIONS_DIR, sinceMs);
  let best = null;
  for (const f of files) {
    const s = RF.parseRolloutFile(f);
    for (const e of s.events) if (e.rate && (!best || e.ts > best.ts)) best = { ts: e.ts, rate: e.rate };
  }
  return best;
}

function fmtRate(rate) {
  if (!rate) return "—";
  const w = rate.windows || {};
  const f = (x) => (x ? `${x.pct}% (resets ${x.resetsAt ? new Date(x.resetsAt * 1000).toLocaleString() : "—"})` : "—");
  return `5h ${f(w["5h"])} · weekly ${f(w.weekly)} · plan ${rate.planType ?? "—"}`;
}

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

function cmdCheck(a) {
  const bin = a.codex || "codex";
  const model = typeof a.model === "string" ? a.model : DEFAULT_MODEL;
  const v = codexVersion(bin);
  const warn = [];
  log(`node ${process.versions.node}${Number(process.versions.node.split(".")[0]) < 20 ? "  (needs 20+)" : ""}`);
  log(`codex ${v ?? "not found"}`);
  if (!v) warn.push(`codex not found: install codex-cli or pass --codex <path>`);
  log(`sessions ${fs.existsSync(SESSIONS_DIR) ? SESSIONS_DIR : "missing"}`);
  if (!fs.existsSync(SESSIONS_DIR)) warn.push("no ~/.codex/sessions: run codex once and log in");
  const procs = otherAgentProcesses();
  log(`other codex / pi processes ${procs.length ? procs.map((p) => `${p.kind} pid ${p.pid} (${p.cmd})`).join(", ") : "none"}`);
  if (procs.length) warn.push("close the processes listed above");
  const last = latestReading(Date.now() - READING_LOOKBACK_MS);
  log(`last meter reading ${last ? `${new Date(last.ts).toLocaleString()}: ${fmtRate(last.rate)}` : "none"}`);
  const p = fs.existsSync(PRICES_PATH) ? JSON.parse(fs.readFileSync(PRICES_PATH, "utf8")) : null;
  let plan = null;
  try {
    plan = resolvePlan({ planTypes: typesOf(last), requested: a.plan ?? null });
  } catch (err) {
    warn.push(err.message);
  }
  if (plan) {
    const fee = planFee(plan);
    log(`plan ${plan.name} · ${fee != null ? `$${fee}/month` : "no fee"}`);
    if (fee == null) warn.push(`${plan.name}: no monthly fee in scripts/billing-periods.mjs`);
  }
  const wk = last?.rate?.windows?.weekly?.pct;
  const need = plan && p && planFee(plan) != null ? ["A", "B"].reduce((s, arm) => s + pacing({ arm, plan, model, prices: p }).targetPp, 0) : ARMS.A.targetPp + ARMS.B.targetPp;
  if (wk != null && wk + need > 85) warn.push(`weekly at ${wk}%: A + B need about ${need} pp; start below ${85 - need}%`);
  if (p) for (const [id, m] of Object.entries(p.models)) log(`prices ${id} $${m.input} / $${m.cachedInput} / $${m.output} per 1M (input / cached / output), as of ${m.asOf ?? p.asOf}`);
  else log("prices missing");
  if (!p) warn.push("prices.json missing");
  else if (!p.models[DEFAULT_MODEL]) warn.push(`prices.json has no ${DEFAULT_MODEL}`);
  log(`workload v${WORKLOAD_VERSION} ${workloadHash()}`);
  if (warn.length) {
    log("\nwarnings:");
    for (const w of warn) log(`  ${w}`);
    process.exitCode = 1;
  } else log("\nok");
}

// ---------------------------------------------------------------------------------------------
// prices
// ---------------------------------------------------------------------------------------------

/**
 * prices.json content from the site's combined.json: per model, the Artificial Analysis list
 * prices on that model's rows and the ChatGPT Plus subsidyMultiple. Throws when a model has no
 * aaPricing row.
 */
export function pricesFromSite(d, models = PRICED_MODELS, siteLabel = "combined.json") {
  const aaAt = d.sources?.artificialAnalysis?.fetchedAt || d.generatedAt;
  if (!aaAt) throw new Error(`${siteLabel}: no sources.artificialAnalysis.fetchedAt or generatedAt`);
  const asOf = aaAt.slice(0, 10);
  const pick = (base) => d.entries.find((e) => e.baseModelId === base && [e.aaPricing?.inputPer1M, e.aaPricing?.cacheHitPer1M, e.aaPricing?.outputPer1M].every(Number.isFinite));
  const onPlan = (name, base) => d.entries.find((e) => e.plan === name && e.baseModelId === base);
  const chain = (e) => d.stats?.chains?.[e?.rel?.chain] || null;
  const ref = (e) => (e ? { id: e.id.replace(/@.*/, ""), subsidy: e.subsidyMultiple, level: e.rel?.level ?? null, sigma: e.rel?.s ?? null, dataDate: e.dataDate, chain: chain(e)?.lines ?? null } : null);
  const out = {
    source:
      "AI Plan Value public/data/combined.json, entries[].aaPricing (Artificial Analysis: price1mInputTokens → inputPer1M, cacheHitPrice → cacheHitPer1M, price1mOutputTokens → outputPer1M)",
    asOf,
    fetchedAt: aaAt,
    siteGeneratedAt: d.generatedAt,
    unit: "USD per 1M tokens",
    convention: "input_tokens includes cached_input_tokens (priced at cachedInput); uncached = input − cached (priced at input); output_tokens includes reasoning (priced at output)",
    models: {},
    site: {},
    sites: {},
  };
  const planNames = PLANS.map((p) => p.name).filter((n) => d.entries.some((e) => e.plan === n));
  for (const n of planNames) out.sites[n] = {};
  const missing = [];
  for (const id of models) {
    const base = siteBaseId(id);
    const e = pick(base);
    if (!e) {
      missing.push(`${id} (baseModelId ${base})`);
      continue;
    }
    out.models[id] = { input: e.aaPricing.inputPer1M, cachedInput: e.aaPricing.cacheHitPer1M, output: e.aaPricing.outputPer1M, asOf, baseModelId: base };
    out.site[id] = ref(onPlan("ChatGPT Plus", base));
    for (const n of planNames) out.sites[n][id] = ref(onPlan(n, base));
  }
  if (missing.length) throw new Error(`no aaPricing (inputPer1M, cacheHitPer1M, outputPer1M) in ${siteLabel} for ${missing.join(", ")}`);
  out.site.definition = "subsidyMultiple = monthlyTokens × listBlendedUsdPerMtok ÷ priceUsd; Fei2411 monthly = weekly pool × 4";  return out;
}

function cmdPrices(a) {
  const site = typeof a.site === "string" ? a.site : DEFAULT_SITE;
  if (!fs.existsSync(site)) fail(`${site} not found: pass --site <path to public/data/combined.json>`);
  const models = typeof a.models === "string" ? a.models.split(",").map((x) => x.trim()).filter(Boolean) : PRICED_MODELS;
  for (const m of models) if (!MODEL_SLUG.test(m)) fail(`--models: bad model slug ${m}`);
  let out;
  try {
    out = pricesFromSite(JSON.parse(fs.readFileSync(site, "utf8")), models, site);
  } catch (err) {
    fail(err.message);
  }
  fs.writeFileSync(PRICES_PATH, JSON.stringify(out, null, 2) + "\n");
  log(`wrote ${PRICES_PATH}`);
  for (const [id, m] of Object.entries(out.models)) {
    const sites = Object.entries(out.sites).map(([n, s]) => `${planById(n)?.short ?? n} ${s[id] ? `${s[id].subsidy}×` : "none"}`);
    log(`${id.padEnd(15)} $${m.input} / $${m.cachedInput} / $${m.output} per 1M · site ${sites.join(" · ")} · as of ${m.asOf}`);
  }
  for (const [n, s] of Object.entries(out.sites)) for (const id of Object.keys(out.models)) if (!s[id]) log(`warning: no ${n} row for ${id}; measured ÷ site will be empty`);
}

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------

function codexArgs({ dir, sandbox, model, effort, lastFile }) {
  const args = ["exec", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-s", sandbox, "-C", dir, "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-c", `web_search="disabled"`];
  if (sandbox === "workspace-write") {
    args.push("-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true");
  }
  args.push("--json");
  if (lastFile) args.push("-o", lastFile);
  args.push("-");
  return args;
}

const activeChildren = new Set();
let interrupted = 0;

function runCodex(bin, args, prompt, { timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    const out = fs.createWriteStream(logFile);
    let stderr = "";
    let threadId = null;
    let buf = "";
    child.stdout.on("data", (d) => {
      out.write(d);
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(/"thread_id"\s*:\s*"([^"]+)"/);
        if (m && !threadId) threadId = m[1];
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM"); // own child only
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end();
      activeChildren.delete(child);
      resolve({ code, signal, stderr, threadId, timedOut: signal === "SIGTERM" && !interrupted });
    });
    child.stdin.end(prompt);
  });
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(dir, rel);
    if (!RF.isUnder(p, dir)) throw new Error(`starter file outside task dir: ${rel}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function sessionsUnder(dir, sinceMs) {
  return RF.listRolloutFiles(SESSIONS_DIR, sinceMs)
    .map((f) => RF.parseRolloutFile(f))
    .filter((s) => RF.isUnder(s.cwd, dir));
}

function lastRateEvent(sessions) {
  let best = null;
  for (const s of sessions) for (const e of s.events) if (e.rate && (!best || e.ts > best.ts)) best = e;
  return best;
}
const lastRate = (sessions) => lastRateEvent(sessions)?.rate || null;

const numOpt = (a, k) => (a[k] == null ? null : Number(a[k]));

function saveManifest(dir, m) {
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
}

async function cmdRun(a) {
  const arm = String(a.arm || "").toUpperCase();
  if (!ARMS[arm]) fail("--arm A or --arm B");
  const cfg = ARMS[arm];
  const effort = a.effort || cfg.effort;
  const model = a.model || DEFAULT_MODEL;
  if (model === true || !MODEL_SLUG.test(model)) fail("--model <slug>, e.g. gpt-6.2-astra");
  const maxWeekly = Number(a["max-weekly"] ?? 85);
  const idleMin = Number(a["idle-min"] ?? 5);
  const settleMin = Number(a["settle-min"] ?? 2);
  const timeoutMs = Number(a["task-timeout-min"] ?? 25) * 60000;
  const asked = { targetPp: numOpt(a, "target-pp"), parallel: numOpt(a, "parallel"), maxHours: numOpt(a, "max-hours") };
  if (asked.parallel != null && !(Number.isInteger(asked.parallel) && asked.parallel >= 1 && asked.parallel <= MAX_PARALLEL)) fail(`--parallel 1 to ${MAX_PARALLEL}`);
  if (asked.targetPp != null && !(asked.targetPp > 0)) fail("--target-pp: a number above 0");
  if (asked.maxHours != null && !(asked.maxHours > 0)) fail("--max-hours: a number above 0");
  const bin = a.codex || "codex";
  const tag = a.tag || `${new Date().toISOString().slice(0, 10)}-${arm}`;
  if (!/^[\w.-]+$/.test(tag)) fail("--tag: letters, digits, . _ - only");
  const runDir = path.join(RUNS_DIR, tag);
  const workRoot = path.join(WORK_BASE, tag);
  const dry = !!a["dry-run"];
  const taskAt = (n) => {
    if (arm === "A") {
      const base = TASKS_A[n % TASKS_A.length];
      const round = Math.floor(n / TASKS_A.length) + 1;
      return { ...base, id: `r${round}-${base.id}`, round };
    }
    return { ...taskB(n), round: 1 };
  };
  const pingArgs = (dir) => codexArgs({ dir, sandbox: "read-only", model, effort, lastFile: null });
  const PING = "Reply with the single word ok.";

  const prices = loadPrices();
  let price;
  try {
    price = priceFor(prices, model);
  } catch (err) {
    fail(err.message);
  }
  // Plan before any call: --plan, else the newest local meter reading, else Plus. Checked again
  // on the first ping's reading.
  const pre = latestReading(Date.now() - READING_LOOKBACK_MS);
  let plan;
  try {
    plan = resolvePlan({ planTypes: a.plan ? [] : typesOf(pre), requested: a.plan ?? null }) || planById(DEFAULT_PLAN_ID);
  } catch (err) {
    fail(err.message);
  }
  if (planFee(plan) == null) fail(`${plan.name}: no monthly fee in scripts/billing-periods.mjs`);
  let pace = pacing({ arm, plan, model, prices, ...asked });
  const paceLine = (p) =>
    `plan       ${plan.name} · $${planFee(plan)}/month · ${p.usdPerPp ? `site $${p.usdPerPp.toFixed(2)}/weekly pp` : "no site value"}\n` +
    `pacing     target +${p.targetPp} pp weekly · stop at ${p.maxHours} h with ${RF.MIN_STEPS}+ steps · ${p.parallel} parallel${p.est ? ` · expected ${p.est.hours} h, +${p.est.pp} pp, API $${p.est.usd}` : ""}`;

  if (dry) {
    log(`dry run · arm ${arm} (${cfg.label}) · tag ${tag} · stop at weekly ${maxWeekly}% · model ${model} · effort ${effort}`);
    log(paceLine(pace));
    log(`prices     ${model} $${price.input} / $${price.cachedInput} / $${price.output} per 1M (input / cached / output), as of ${price.asOf ?? prices.asOf}`);
    log(`work dir   ${workRoot}`);
    log(`run dir    ${runDir}`);
    log(`workload   v${WORKLOAD_VERSION} ${workloadHash()}${arm === "B" ? ` · ${B_ROWS} CSV rows per prompt` : ` · ${TASKS_A.length} tasks, repeated in rounds until the target`}`);
    log(`\nidle check (before and after): ping, ${settleMin} min, ping, ${idleMin} min, ping`);
    log(`  echo ${sq(PING)} | ${bin} ${pingArgs(path.join(workRoot, "ping")).map(sq).join(" ")}`);
    for (let n = 0; n < 3; n++) {
      const t = taskAt(n);
      const dir = path.join(workRoot, t.id);
      log(`\ntask ${t.id}${Object.keys(t.files).length ? ` · starter files: ${Object.keys(t.files).join(", ")}` : ""} · prompt ${t.prompt.length} chars`);
      log(`  ${bin} ${codexArgs({ dir, sandbox: cfg.sandbox, model, effort, lastFile: path.join(runDir, "logs", `${t.id}.last.txt`) }).map(sq).join(" ")}  < prompt`);
      log(`  prompt: ${t.prompt.split("\n")[0].slice(0, 160)}${t.prompt.length > 160 ? " …" : ""}`);
    }
    log(`\n… then more tasks, ${pace.parallel} at a time, until weekly has moved ${pace.targetPp} pp or ${pace.maxHours} h have passed with ${RF.MIN_STEPS}+ steps. No calls made.`);
    return;
  }

  const v = codexVersion(bin);
  if (!v) fail(`codex not found (${bin})`);
  const procs = otherAgentProcesses();
  if (procs.length && !a.force) fail(`close these first (or pass --force): ${procs.map((p) => `${p.kind} pid ${p.pid}`).join(", ")}`);
  if (fs.existsSync(path.join(runDir, "manifest.json")) && !a.force) fail(`run ${tag} exists: pick another --tag`);
  fs.mkdirSync(workRoot, { recursive: true });
  if (spawnSync("git", ["-C", workRoot, "rev-parse"], { stdio: "ignore" }).status === 0) fail(`${workRoot} is inside a git repository`);
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });

  const startMs = Date.now();
  const m = {
    schema: RF.RUN_SCHEMA,
    kitVersion: KIT_VERSION,
    tag,
    arm,
    label: cfg.label,
    model,
    effort,
    sandbox: cfg.sandbox,
    codexVersion: v,
    workload: { version: WORKLOAD_VERSION, hash: workloadHash() },
    plan: { id: plan.id, name: plan.name, feeUsd: planFee(plan), planType: null },
    targetPp: pace.targetPp,
    maxHours: pace.maxHours,
    minSteps: RF.MIN_STEPS,
    parallel: pace.parallel,
    maxWeeklyPct: maxWeekly,
    root: workRoot,
    startedAt: nowIso(),
    endedAt: null,
    concurrentCodex: procs.map((p) => ({ kind: p.kind })),
    idle: [],
    tasks: [],
    pauses: [],
    stopReason: null,
  };
  saveManifest(runDir, m);
  log(`run ${tag} · arm ${arm} (${cfg.label}) · ${model} ${effort}`);
  log(`work dir ${workRoot}`);
  log(`run dir  ${runDir}`);

  process.on("SIGINT", () => {
    interrupted++;
    if (interrupted === 1) {
      log("\nstopping after the current call; Ctrl-C again to quit now");
      for (const c of activeChildren) c.kill("SIGTERM"); // own children only
    } else process.exit(130);
  });

  const ping = async (label) => {
    const dir = path.join(workRoot, "ping");
    fs.mkdirSync(dir, { recursive: true });
    const r = await runCodex(bin, pingArgs(dir), PING, { timeoutMs: 5 * 60000, logFile: path.join(runDir, "logs", `ping-${label}.jsonl`) });
    if (r.code !== 0 && !interrupted) fail(`ping failed (exit ${r.code}):\n${r.stderr.slice(-2000)}`);
    return nowIso();
  };
  const idleCheck = async (phase) => {
    log(`idle check (${phase}): ${settleMin + idleMin} min`);
    await ping(`${phase}-0`);
    await sleep(settleMin * 60000);
    if (interrupted) return;
    const start = await ping(`${phase}-1`);
    await sleep(idleMin * 60000);
    if (interrupted) return;
    const end = await ping(`${phase}-2`);
    m.idle.push({ phase, start, end });
    saveManifest(runDir, m);
    const rate = lastRate(sessionsUnder(path.join(workRoot, "ping"), startMs));
    log(`  ${fmtRate(rate)}`);
  };

  await idleCheck("before");
  const firstEv = lastRateEvent(sessionsUnder(workRoot, startMs));
  const first = firstEv?.rate;
  // the ping's reading decides the plan; pacing follows it
  try {
    const seen = resolvePlan({ planTypes: typesOf(firstEv), requested: a.plan ?? null });
    if (seen && seen.id !== plan.id) {
      plan = seen;
      if (planFee(plan) == null) fail(`${plan.name}: no monthly fee in scripts/billing-periods.mjs`);
      pace = pacing({ arm, plan, model, prices, ...asked });
    }
  } catch (err) {
    fail(err.message);
  }
  Object.assign(m, { plan: { id: plan.id, name: plan.name, feeUsd: planFee(plan), planType: first?.planType ?? null }, targetPp: pace.targetPp, maxHours: pace.maxHours, parallel: pace.parallel });
  saveManifest(runDir, m);
  log(paceLine(pace));
  const targetPp = pace.targetPp;
  const parallel = pace.parallel;
  const w0 = first?.windows?.weekly?.pct;
  if (w0 == null) fail("no weekly reading after the ping");
  if (w0 + targetPp > maxWeekly) fail(`weekly at ${w0}%: +${targetPp} pp would pass ${maxWeekly}%`);
  const st = { ts: firstEv.ts, weekly: w0, fiveH: first?.windows?.["5h"]?.pct ?? null, maxTask5h: 0, movedPp: 0, readings: [{ r: w0 }], failures: 0 };
  const steps = () => Math.round(st.movedPp / RF.detectStep(st.readings));
  let pauseUntil = null;
  let n = 0;
  const loopStart = Date.now();

  const runTask = async (t, idx) => {
    const dir = path.join(workRoot, t.id);
    fs.mkdirSync(dir, { recursive: true });
    writeFiles(dir, t.files);
    const tStart = Date.now();
    const rec = { id: t.id, dir, startedAt: nowIso(), endedAt: null, exit: null, threadId: null };
    m.tasks.push(rec);
    saveManifest(runDir, m);
    const r = await runCodex(bin, codexArgs({ dir, sandbox: cfg.sandbox, model, effort, lastFile: path.join(runDir, "logs", `${t.id}.last.txt`) }), t.prompt, { timeoutMs, logFile: path.join(runDir, "logs", `${t.id}.jsonl`) });
    rec.endedAt = nowIso();
    rec.exit = r.timedOut ? "timeout" : r.code;
    rec.threadId = r.threadId;
    const ss = sessionsUnder(dir, tStart);
    const priced = RF.priceTimeline(RF.buildTimeline(ss).events, prices.models, model);
    const usd = priced.length ? priced[priced.length - 1].ca : 0;
    rec.calls = priced.filter((e) => e.kind === "call").length;
    rec.usd = RF.round(usd, 6);
    saveManifest(runDir, m);
    // parallel tasks finish out of order: only a reading newer than the last one moves the counters
    const ev = lastRateEvent(ss);
    const rate = ev?.rate;
    const wk = rate?.windows?.weekly;
    const fh = rate?.windows?.["5h"];
    if (ev && ev.ts > st.ts) {
      st.ts = ev.ts;
      if (wk) {
        if (wk.pct >= st.weekly) st.movedPp += wk.pct - st.weekly;
        st.weekly = wk.pct;
        st.readings.push({ r: wk.pct });
      }
      if (fh) {
        if (st.fiveH != null && fh.pct >= st.fiveH) st.maxTask5h = Math.max(st.maxTask5h, fh.pct - st.fiveH);
        st.fiveH = fh.pct;
      }
    }
    const hours = (Date.now() - loopStart) / 3600000;
    const rateH = st.movedPp > 0 ? st.movedPp / hours : null;
    const etaTarget = rateH ? ((targetPp - st.movedPp) / rateH) * 60 : null;
    const etaCap = rateH ? Math.max((pace.maxHours - hours) * 60, ((RF.MIN_STEPS - steps()) / rateH) * 60) : null;
    const eta = etaTarget != null ? Math.min(etaTarget, etaCap) : null;
    log(`${hhmm(Date.now())} ${t.id.padEnd(16)} exit ${String(rec.exit).padEnd(7)} calls ${String(rec.calls).padStart(3)}  $${usd.toFixed(3).padStart(7)}  ${st.fiveH != null ? `5h ${st.fiveH}%  ` : ""}weekly ${st.weekly}%  +${st.movedPp}/${targetPp} pp${eta != null && eta > 0 ? `  ~${Math.round(eta)} min left` : ""}`);
    if (interrupted || m.stopReason) return;
    if (rec.exit !== 0) {
      st.failures++;
      if (r.stderr.trim()) log(`  stderr: ${r.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
      if (rec.calls === 0 && idx === 0) {
        m.stopReason = "first task made no calls";
        return;
      }
    } else st.failures = 0;
    if (st.failures >= 3) m.stopReason = "3 failed tasks in a row";
    else if (st.movedPp >= targetPp) m.stopReason = "target reached";
    else if (st.weekly >= maxWeekly) m.stopReason = `weekly at ${st.weekly}%`;
    else if (hours >= pace.maxHours && steps() >= RF.MIN_STEPS) m.stopReason = `${pace.maxHours} h with ${steps()} steps`;
    else if (!pauseUntil && fiveHourPause(st.fiveH != null ? { pct: st.fiveH } : null, st.maxTask5h * parallel, rate?.reachedType)) {
      pauseUntil = (fh?.resetsAt ? fh.resetsAt * 1000 : Date.now() + 3600000) + 60000;
      log(`5h at ${st.fiveH}% (largest task +${st.maxTask5h} pp): paused until ${hhmm(pauseUntil)}`);
      m.pauses.push({ from: nowIso(), until: new Date(pauseUntil).toISOString() });
      saveManifest(runDir, m);
    }
  };

  const running = new Set();
  while (!interrupted && !m.stopReason) {
    while (running.size < parallel && !pauseUntil && !interrupted && !m.stopReason) {
      const idx = n++;
      const p = runTask(taskAt(idx), idx).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size) await Promise.race(running);
    else if (pauseUntil) {
      while (Date.now() < pauseUntil && !interrupted) await sleep(Math.min(60000, pauseUntil - Date.now()));
      pauseUntil = null;
      st.fiveH = null;
    }
  }
  await Promise.all(running);
  if (interrupted) m.stopReason = "interrupted";
  else await idleCheck("after");
  m.endedAt = nowIso();
  saveManifest(runDir, m);

  // other Codex sessions during the run (ids only)
  const all = RF.listRolloutFiles(SESSIONS_DIR, startMs).map((f) => RF.parseRolloutFile(f));
  const tl = RF.buildTimeline(all, { root: workRoot, fromMs: startMs, toMs: Date.now() });
  m.otherSessions = tl.otherSessions;
  saveManifest(runDir, m);
  // copy the run's rollouts
  const dest = path.join(runDir, "rollouts");
  fs.mkdirSync(dest, { recursive: true });
  for (const s of all.filter((s) => RF.isUnder(s.cwd, workRoot))) fs.copyFileSync(s.file, path.join(dest, path.basename(s.file)));
  log(`\nstopped: ${m.stopReason}`);
  analyseAndWrite({ run: tag });
}

// ---------------------------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------------------------

/** Raw field names in a rollout file: token usage objects and rate_limits (names only). */
function rolloutFieldNames(file) {
  const usage = new Set();
  const meter = new Set();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { usage: [], meter: [] };
  }
  for (const line of text.split("\n")) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o?.payload;
    if (o?.type !== "event_msg" || p?.type !== "token_count") continue;
    for (const k of Smoke.fieldNames(p.info?.last_token_usage || p.info?.total_token_usage)) usage.add(k);
    for (const k of Smoke.fieldNames(p.rate_limits)) meter.add(k);
  }
  return { usage: [...usage], meter: [...meter] };
}

/**
 * One `codex exec` of a one-line prompt in a throwaway folder, with the idle-ping command shape
 * (read-only sandbox, the run's model and effort). Writes kits/codex/results/smoke-codex-<date>.json.
 */
async function cmdSmoke(a) {
  const bin = a.codex || "codex";
  const model = typeof a.model === "string" ? a.model : DEFAULT_MODEL;
  if (!MODEL_SLUG.test(model)) fail("--model <slug>, e.g. gpt-6.2-sol");
  const effort = typeof a.effort === "string" ? a.effort : ARMS.A.effort;
  if (a.plan != null && (a.plan === true || !planById(a.plan))) fail(`--plan ${PLAN_IDS.join(" | ")}`);
  const clean = Smoke.cleaner();
  const S = Smoke.stepList();
  const fields = { usage: [], meter: [] };
  let planId = typeof a.plan === "string" ? planById(a.plan).id : null;

  const v = codexVersion(bin);
  S.add("binary", v ? "pass" : "fail", v ? `codex-cli ${v}` : "codex not found: install the Codex CLI or pass --codex <path>");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const loggedIn = fs.existsSync(path.join(codexHome, "auth.json"));
  S.add("login", loggedIn ? "pass" : "fail", loggedIn ? "auth.json present (not opened)" : "no auth.json in the Codex home: run codex and log in");

  let run = null;
  let dir = null;
  let base = null;
  if (v) {
    const procs = otherAgentProcesses();
    if (procs.length && !a.force) fail(`close these first (or pass --force): ${procs.map((p) => `${p.kind} pid ${p.pid}`).join(", ")}`);
    fs.mkdirSync(WORK_BASE, { recursive: true });
    base = fs.mkdtempSync(path.join(WORK_BASE, "smoke-"));
    dir = path.join(base, "ping");
    fs.mkdirSync(dir);
    const startMs = Date.now();
    log(`smoke · codex exec -m ${model} · effort ${effort} · one prompt: ${Smoke.SMOKE_PROMPT}`);
    const r = await runCodex(bin, codexArgs({ dir, sandbox: "read-only", model, effort, lastFile: null }), Smoke.SMOKE_PROMPT, { timeoutMs: 5 * 60000, logFile: path.join(base, "exec.jsonl") });
    run = { r, sessions: sessionsUnder(dir, startMs) };
    S.add("prompt", r.code === 0 ? "pass" : "fail", r.timedOut ? "timed out after 5 min" : `exit ${r.code ?? r.signal}`);
  } else S.add("prompt", "skipped", "no codex binary");

  if (run) {
    const events = run.sessions.flatMap((s) => s.events);
    for (const s of run.sessions) {
      const f = rolloutFieldNames(s.file);
      fields.usage.push(...f.usage);
      fields.meter.push(...f.meter);
    }
    const calls = events.filter((e) => e.kind === "call");
    if (!run.sessions.length) S.add("usage", "fail", "no rollout file for the prompt in the Codex sessions folder");
    else if (!calls.length) S.add("usage", "fail", "no token_count event with usage in the rollout");
    else {
      const found = ["input", "cached", "output", "reasoning"].filter((k) => calls.some((c) => c.usage?.[k] > 0));
      S.add("usage", found.includes("input") && found.includes("output") ? "pass" : "fail", `parsed: ${found.join(", ") || "nothing"}`);
    }
    const seen = [...new Set(events.map((e) => e.model).filter(Boolean))];
    if (!seen.length) S.add("model", "skipped", "the rollout names no model");
    else S.add("model", seen.every((m) => m === model) ? "pass" : "fail", seen.every((m) => m === model) ? `${model} as requested` : `requested ${model}, rollout says ${seen.join(", ")}`);
    const ev = lastRateEvent(run.sessions);
    const w = ev?.rate?.windows || {};
    if (!ev) S.add("meter", "fail", "automatic: no rate_limits in the rollout");
    else if (!w.weekly) S.add("meter", "fail", `automatic: no weekly window (windows: ${Object.keys(w).join(", ") || "none"})`);
    else S.add("meter", "pass", `automatic: weekly % parsed (unit % of the weekly limit; windows ${Object.keys(w).join(", ")})`);
    S.add("meter-fields", fields.meter.length ? "pass" : "fail", fields.meter.length ? "rate_limits field names recorded" : "no rate_limits fields");
    if (ev?.rate?.planType) {
      try {
        const p = resolvePlan({ planTypes: [ev.rate.planType], requested: a.plan ?? null });
        planId = p.id;
        S.add("plan", "pass", `plan_type ${ev.rate.planType} is ${p.name}`);
      } catch (err) {
        S.add("plan", "fail", err.message);
      }
    } else S.add("plan", "skipped", "no plan_type in the rollout");
  } else for (const id of ["usage", "model", "meter", "meter-fields", "plan"]) S.add(id, "skipped", "the prompt did not run");
  if (base) fs.rmSync(base, { recursive: true, force: true });

  const report = Smoke.buildReport({ kit: "codex", kitDir: KIT_DIR, adapter: "codex", toolVersion: v ? `codex-cli ${v}` : null, plan: planId, model, steps: S.steps, fields, critical: ["binary", "prompt"], clean });
  const file = Smoke.writeReport(RESULTS_DIR, report);
  Smoke.printReport(report, file, log);
  if (report.result === "fails") process.exitCode = 1;
  return report;
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyseAndWrite(a) {
  const prices = loadPrices();
  let manifest = null;
  let sessions;
  let root = a.root ? path.resolve(a.root) : null;
  let fromMs = a.from ? Date.parse(a.from) : null;
  let toMs = a.to ? Date.parse(a.to) : null;
  let tag = a.tag || null;
  if (a.run) {
    const mp = path.join(RUNS_DIR, a.run, "manifest.json");
    if (!fs.existsSync(mp)) fail(`${mp} not found`);
    manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
    root = manifest.root;
    fromMs = Date.parse(manifest.startedAt);
    toMs = manifest.endedAt ? Date.parse(manifest.endedAt) : Date.now();
    tag = manifest.tag;
    const copies = path.join(RUNS_DIR, a.run, "rollouts");
    const files = fs.existsSync(copies) && fs.readdirSync(copies).length ? fs.readdirSync(copies).map((f) => path.join(copies, f)) : RF.listRolloutFiles(SESSIONS_DIR, fromMs, toMs);
    sessions = files.map((f) => RF.parseRolloutFile(f));
  } else if (a.dir) {
    const dir = path.resolve(a.dir);
    sessions = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => RF.parseRolloutFile(path.join(dir, f)));
    tag ||= path.basename(dir);
  } else if (fromMs != null) {
    sessions = RF.listRolloutFiles(a["sessions-dir"] || SESSIONS_DIR, fromMs, toMs).map((f) => RF.parseRolloutFile(f));
    tag ||= `range-${new Date(fromMs).toISOString().slice(0, 16).replace(/:/g, "")}`;
  } else fail("analyse needs --run <tag>, --dir <folder> or --from <ISO> [--to <ISO>]");
  if (fromMs != null && !Number.isFinite(fromMs)) fail("--from is not a date");
  if (a.model === true || (a.model && !MODEL_SLUG.test(a.model))) fail("--model <slug>, e.g. gpt-6.2-astra");
  const expected = expectedFrom(a, manifest);
  try {
    priceFor(prices, expected.model);
  } catch (err) {
    fail(err.message);
  }
  // plan: --plan, else the manifest's, else the rollouts' plan_type (fails when it names several plans)
  let plan = null;
  if (a.plan != null) {
    plan = planById(a.plan === true ? "" : a.plan);
    if (!plan) fail(`--plan ${a.plan === true ? "" : a.plan}: use ${PLAN_IDS.join(", ")}`);
  } else if (manifest?.plan?.id) plan = planById(manifest.plan.id);
  if (!plan) {
    const inRange = (e) => (fromMs == null || e.ts >= fromMs) && (toMs == null || e.ts <= toMs);
    const types = sessions.filter((s) => !root || RF.isUnder(s.cwd, root)).flatMap((s) => s.events.filter(inRange).map((e) => e.rate?.planType));
    try {
      plan = resolvePlan({ planTypes: types });
    } catch (err) {
      if (!/is not a plan this kit measures|plan_type changes/.test(err.message)) fail(err.message);
    }
  }
  const res = RF.analyse({
    plan,
    sessions,
    prices,
    manifest,
    expected,
    root,
    fromMs,
    toMs,
    site: siteRefFor(prices, expected.model, (plan || planById(DEFAULT_PLAN_ID)).name),
    otherSessionsExtra: manifest?.otherSessions || [],
  });
  res.tag = tag;
  res.kitVersion = KIT_VERSION;
  res.workload = manifest?.workload ?? null;
  res.generatedAt = nowIso();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = a.out ? path.resolve(a.out) : path.join(RESULTS_DIR, `${tag}.json`);
  fs.writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
  printSummary(res);
  log(`\nwrote ${out}`);
  return res;
}

function pct(x) {
  return x == null ? "—" : `${(100 * x).toFixed(1)}%`;
}

function printSummary(r) {
  const f2 = (x) => (x == null ? "—" : x.toFixed(2));
  const f4 = (x) => (x == null ? "—" : x.toFixed(4));
  const P = planById(r.plan);
  log(`\n${r.tag} · arm ${r.arm ?? "—"} · ${r.planName ?? r.plan} · ${r.model} · verdict ${r.verdict}`);
  log(`calls ${r.run.calls} · sessions ${r.run.sessions} · ${r.run.minutes.toFixed(0)} min · effort ${Object.entries(r.effort).map(([k, v]) => `${k} ${v.calls}`).join(", ")}`);
  log(`tokens input ${r.tokens.input} (cached ${r.tokens.cachedInput}) · output ${r.tokens.output} (reasoning ${r.tokens.reasoning})`);
  log(`API $${f2(r.usd.total)} · uncached ${pct(r.usdShare?.uncachedInput)} · cached ${pct(r.usdShare?.cachedInput)} · output ${pct(r.usdShare?.output)} · cache share of input tokens ${pct(r.cacheShare.tokens)}`);
  for (const w of ["5h", "weekly"]) {
    const x = r.windows[w];
    if (!x) continue;
    if (!x.usable) {
      log(`${w.padEnd(6)} ${x.firstReading ?? "—"}% → ${x.lastReading ?? "—"}% · ${x.reason}`);
      continue;
    }
    const u = x.usdPerPp;
    log(`${w.padEnd(6)} ${x.firstReading}% → ${x.lastReading}% · ${x.crossings} steps · $${f4(u.est)}/pp (95% ${u.ci95 ? `${f4(u.ci95[0])}–${f4(u.ci95[1])}` : "—"}) · first–last $${f4(u.naiveFirstLast)} · lag ${x.lag}`);
  }
  if (r.subsidy) {
    const s = r.subsidy;
    log(`monthly API value $${f2(s.monthlyApiUsd.est)} (95% ${s.monthlyApiUsd.ci95 ? `${f2(s.monthlyApiUsd.ci95[0])}–${f2(s.monthlyApiUsd.ci95[1])}` : "—"}) · subsidy ${f2(s.multiple.est)}× (95% ${s.multiple.ci95 ? `${f2(s.multiple.ci95[0])}–${f2(s.multiple.ci95[1])}` : "—"})`);
    if (s.site) log(`site ${r.model} ${P?.short ?? r.plan} ${f2(s.site.value)}× · measured ÷ site ${f4(s.site.ratio)}`);
  }
  if (r.fiveHourWindowsPerWeek) log(`5h windows per weekly pool ${f2(r.fiveHourWindowsPerWeek.est)}`);
  for (const fl of r.flags) log(`${fl.severity.padEnd(7)} ${fl.code}: ${fl.detail}`);
}

// ---------------------------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------------------------

function cmdCompare(a) {
  const [fa, fb] = a._.slice(1);
  if (!fa || !fb) fail("usage: compare <result-a.json> <result-b.json>");
  const A = JSON.parse(fs.readFileSync(fa, "utf8"));
  const B = JSON.parse(fs.readFileSync(fb, "utf8"));
  const c = RF.compareResults(A, B);
  if (!c.ok) fail(c.reason);
  c.generatedAt = nowIso();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = a.out ? path.resolve(a.out) : path.join(RESULTS_DIR, `compare-${A.tag}-vs-${B.tag}.json`);
  fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n");
  log(`weekly $/pp  ${A.tag} ${c.a.usdPerPp.toFixed(4)} · ${B.tag} ${c.b.usdPerPp.toFixed(4)}`);
  log(`ratio ${c.ratio.est.toFixed(3)} (95% ${c.ratio.ci95[0].toFixed(3)}–${c.ratio.ci95[1].toFixed(3)}) · p ${c.ratio.p.toFixed(3)}`);
  log(`uncached-input $ share ${pct(c.a.uncachedInputShare)} vs ${pct(c.b.uncachedInputShare)}`);
  if (c.uncachedInputWeight) log(`uncached-input meter weight ${c.uncachedInputWeight.est.toFixed(2)} (95% ${c.uncachedInputWeight.ci95[0].toFixed(2)}–${c.uncachedInputWeight.ci95[1].toFixed(2)})`);
  log(`verdict ${c.verdict}`);
  log(`\nwrote ${out}`);
}

// ---------------------------------------------------------------------------------------------

const HELP = `codex-quota ${KIT_VERSION}

  node kits/codex/scripts/codex-quota.mjs smoke [--plan <plan>] [--model <slug>] [--codex <path>]
  node kits/codex/scripts/codex-quota.mjs check [--plan <plan>] [--model <slug>] [--codex <path>]
  node kits/codex/scripts/codex-quota.mjs run --arm A|B [options]
  node kits/codex/scripts/codex-quota.mjs analyse --run <tag> | --dir <folder> | --from <ISO> [--to <ISO>] [options]
  node kits/codex/scripts/codex-quota.mjs compare <result-a.json> <result-b.json> [--out <file>]
  node kits/codex/scripts/codex-quota.mjs prices [--site public/data/combined.json] [--models ${PRICED_MODELS.join(",")}]

run options
  --arm               A (coding tasks, up to +${ARMS.A.targetPp} pp) | B (low-cache prompts, up to +${ARMS.B.targetPp} pp)
  --plan              ${PLAN_IDS.join(" | ")} (default from plan_type; required for Pro)
  --model             codex model slug, passed as -m (default ${DEFAULT_MODEL}); needs a price in prices.json
  --tag               run name (default <date>-<arm>)
  --target-pp         weekly pp to use (default per plan, at most A ${ARMS.A.targetPp}, B ${ARMS.B.targetPp})
  --max-hours         stop after this many hours once weekly made ${RF.MIN_STEPS} steps (default A ${ARMS.A.maxHours}, B ${ARMS.B.maxHours})
  --parallel          tasks at a time, 1 to ${MAX_PARALLEL} (default per plan)
  --max-weekly        stop at this weekly % (default 85)
  --effort            default medium
  --idle-min          idle check length, minutes (default 5)
  --settle-min        wait before the idle check, minutes (default 2)
  --task-timeout-min  per task (default 25)
  --codex             codex binary (default codex)
  --force             start with other codex / pi processes running, or reuse a tag
  --dry-run           print the commands; no calls

analyse options
  --run <tag>         kits/codex/results/runs/<tag>/ (manifest + rollouts)
  --dir <folder>      every rollout-*.jsonl in a folder
  --from / --to       ISO times; rollouts from ~/.codex/sessions (or --sessions-dir)
  --root <dir>        keep sessions whose cwd is under <dir>
  --model / --effort  expected model and effort (default from the manifest)
  --plan              ${PLAN_IDS.join(" | ")} (default from the manifest, else plan_type)
  --out <file>        default kits/codex/results/<tag>.json
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help || cmd === "help") return log(HELP);
  if (cmd === "smoke") return cmdSmoke(a);
  if (cmd === "check") return cmdCheck(a);
  if (cmd === "prices") return cmdPrices(a);
  if (cmd === "run") return cmdRun(a);
  if (cmd === "analyse" || cmd === "analyze") return analyseAndWrite(a);
  if (cmd === "compare") return cmdCompare(a);
  fail(`unknown command ${cmd}\n${HELP}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
