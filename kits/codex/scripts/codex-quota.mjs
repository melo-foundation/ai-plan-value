#!/usr/bin/env node
/**
 * codex-quota: measures API-priced usage per percentage point of the Codex usage meter (ChatGPT
 * Plus; GPT-6.2 Sol by default, any model via --model) from Codex CLI rollout files, and the
 * monthly API value and subsidy multiple the site uses. Usage: kits/codex/README.md.
 *
 *   node kits/codex/scripts/codex-quota.mjs check
 *   node kits/codex/scripts/codex-quota.mjs run --arm A|B [--model <slug>] [--tag <tag>] [--target-pp N] [--dry-run] [options]
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

const __filename = fileURLToPath(import.meta.url);
const KIT_VERSION = "1.0.0";
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
export const PRICED_MODELS = ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.2-astra"];
const siteBaseId = (slug) => slug.replace(/\./g, "-");
const ARMS = {
  A: { targetPp: 12, effort: "medium", sandbox: "workspace-write", label: "coding tasks, medium effort" },
  B: { targetPp: 8, effort: "medium", sandbox: "read-only", label: "low-cache prompts, medium effort" },
};
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

/** Site ChatGPT Plus subsidy multiple for one model, as analyse() takes it; null when absent. */
export function siteRefFor(prices, model) {
  const s = prices?.site?.[model];
  return s?.subsidy ? { subsidy: s.subsidy, source: `${s.id}: ${(s.chain || []).join("; ")}` } : null;
}

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
  const last = latestReading();
  log(`last meter reading ${last ? `${new Date(last.ts).toLocaleString()}: ${fmtRate(last.rate)}` : "none"}`);
  if (last?.rate?.planType && last.rate.planType !== "plus") warn.push(`plan_type is ${last.rate.planType}, not plus`);
  const wk = last?.rate?.windows?.weekly?.pct;
  if (wk != null && wk + ARMS.A.targetPp + ARMS.B.targetPp > 85) warn.push(`weekly at ${wk}%: A + B need about ${ARMS.A.targetPp + ARMS.B.targetPp} pp; start below ${85 - ARMS.A.targetPp - ARMS.B.targetPp}%`);
  const p = fs.existsSync(PRICES_PATH) ? JSON.parse(fs.readFileSync(PRICES_PATH, "utf8")) : null;
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
  const plus = (base) => d.entries.find((e) => e.plan === "ChatGPT Plus" && e.baseModelId === base);
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
  };
  const missing = [];
  for (const id of models) {
    const base = siteBaseId(id);
    const e = pick(base);
    if (!e) {
      missing.push(`${id} (baseModelId ${base})`);
      continue;
    }
    out.models[id] = { input: e.aaPricing.inputPer1M, cachedInput: e.aaPricing.cacheHitPer1M, output: e.aaPricing.outputPer1M, asOf, baseModelId: base };
    out.site[id] = ref(plus(base));
  }
  if (missing.length) throw new Error(`no aaPricing (inputPer1M, cacheHitPer1M, outputPer1M) in ${siteLabel} for ${missing.join(", ")}`);
  out.site.definition = "subsidyMultiple = monthlyTokens × listBlendedUsdPerMtok ÷ priceUsd; Fei2411 monthly = weekly pool × 4";
  return out;
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
    const r = out.site[id];
    log(`${id.padEnd(15)} $${m.input} / $${m.cachedInput} / $${m.output} per 1M · site Plus ${r ? `${r.subsidy}× (${r.id})` : "none"} · as of ${m.asOf}`);
  }
  for (const id of Object.keys(out.models)) if (!out.site[id]) log(`warning: no ChatGPT Plus row for ${id}; measured ÷ site will be empty`);
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

let activeChild = null;
let interrupted = 0;

function runCodex(bin, args, prompt, { timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    activeChild = child;
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
      activeChild = null;
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

function lastRate(sessions) {
  let best = null;
  for (const s of sessions) for (const e of s.events) if (e.rate && (!best || e.ts > best.ts)) best = e;
  return best?.rate || null;
}

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
  const targetPp = Number(a["target-pp"] ?? cfg.targetPp);
  const maxWeekly = Number(a["max-weekly"] ?? 85);
  const idleMin = Number(a["idle-min"] ?? 5);
  const settleMin = Number(a["settle-min"] ?? 2);
  const timeoutMs = Number(a["task-timeout-min"] ?? 25) * 60000;
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

  if (dry) {
    log(`dry run · arm ${arm} (${cfg.label}) · tag ${tag} · target +${targetPp} pp weekly · stop at weekly ${maxWeekly}% · model ${model} · effort ${effort}`);
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
    log(`\n… then more tasks until weekly has moved ${targetPp} pp. No calls made.`);
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
    targetPp,
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
  log(`run ${tag} · arm ${arm} (${cfg.label}) · ${model} ${effort} · target +${targetPp} pp weekly`);
  log(`work dir ${workRoot}`);
  log(`run dir  ${runDir}`);

  process.on("SIGINT", () => {
    interrupted++;
    if (interrupted === 1) {
      log("\nstopping after the current call; Ctrl-C again to quit now");
      activeChild?.kill("SIGTERM");
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
  const first = lastRate(sessionsUnder(workRoot, startMs));
  const w0 = first?.windows?.weekly?.pct;
  if (w0 == null) fail("no weekly reading after the ping");
  if (w0 + targetPp > maxWeekly) fail(`weekly at ${w0}%: +${targetPp} pp would pass ${maxWeekly}%`);
  let lastWeekly = w0;
  let last5h = first?.windows?.["5h"]?.pct ?? null;
  let maxTask5h = 0;
  let movedPp = 0;
  let failures = 0;
  let n = 0;
  const loopStart = Date.now();

  while (!interrupted) {
    const t = taskAt(n++);
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
    const rate = lastRate(ss);
    const wk = rate?.windows?.weekly;
    const fh = rate?.windows?.["5h"];
    if (wk) {
      if (wk.pct >= lastWeekly) movedPp += wk.pct - lastWeekly;
      lastWeekly = wk.pct;
    }
    if (fh) {
      if (last5h != null && fh.pct >= last5h) maxTask5h = Math.max(maxTask5h, fh.pct - last5h);
      last5h = fh.pct;
    }
    const hours = (Date.now() - loopStart) / 3600000;
    const eta = movedPp > 0 ? ((targetPp - movedPp) / movedPp) * hours * 60 : null;
    log(`${hhmm(Date.now())} ${t.id.padEnd(16)} exit ${String(rec.exit).padEnd(7)} calls ${String(rec.calls).padStart(3)}  $${usd.toFixed(3).padStart(7)}  5h ${fh?.pct ?? "—"}%  weekly ${wk?.pct ?? "—"}%  +${movedPp}/${targetPp} pp${eta != null && eta > 0 ? `  ~${Math.round(eta)} min left` : ""}`);
    if (interrupted) break;
    if (rec.exit !== 0) {
      failures++;
      if (r.stderr.trim()) log(`  stderr: ${r.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
      if (rec.calls === 0 && n === 1) {
        m.stopReason = "first task made no calls";
        break;
      }
    } else failures = 0;
    if (failures >= 3) {
      m.stopReason = "3 failed tasks in a row";
      break;
    }
    if (movedPp >= targetPp) {
      m.stopReason = "target reached";
      break;
    }
    if (wk && wk.pct >= maxWeekly) {
      m.stopReason = `weekly at ${wk.pct}%`;
      break;
    }
    if (fiveHourPause(fh, maxTask5h, rate?.reachedType)) {
      const until = (fh?.resetsAt ? fh.resetsAt * 1000 : Date.now() + 3600000) + 60000;
      log(`5h at ${fh?.pct}% (largest task +${maxTask5h} pp): paused until ${hhmm(until)}`);
      m.pauses.push({ from: nowIso(), until: new Date(until).toISOString() });
      saveManifest(runDir, m);
      while (Date.now() < until && !interrupted) await sleep(Math.min(60000, until - Date.now()));
      last5h = null;
    }
  }
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
  const res = RF.analyse({
    sessions,
    prices,
    manifest,
    expected,
    root,
    fromMs,
    toMs,
    site: siteRefFor(prices, expected.model),
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
  log(`\n${r.tag} · arm ${r.arm ?? "—"} · ${r.model} · verdict ${r.verdict}`);
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
    if (s.site) log(`site ${r.model} Plus ${f2(s.site.value)}× · measured ÷ site ${f4(s.site.ratio)}`);
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

  node kits/codex/scripts/codex-quota.mjs check [--codex <path>]
  node kits/codex/scripts/codex-quota.mjs run --arm A|B [options]
  node kits/codex/scripts/codex-quota.mjs analyse --run <tag> | --dir <folder> | --from <ISO> [--to <ISO>] [options]
  node kits/codex/scripts/codex-quota.mjs compare <result-a.json> <result-b.json> [--out <file>]
  node kits/codex/scripts/codex-quota.mjs prices [--site public/data/combined.json] [--models ${PRICED_MODELS.join(",")}]

run options
  --arm               A (coding tasks, +${ARMS.A.targetPp} pp) | B (low-cache prompts, +${ARMS.B.targetPp} pp)
  --model             codex model slug, passed as -m (default ${DEFAULT_MODEL}); needs a price in prices.json
  --tag               run name (default <date>-<arm>)
  --target-pp         weekly pp to use (default A ${ARMS.A.targetPp}, B ${ARMS.B.targetPp})
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
  --out <file>        default kits/codex/results/<tag>.json
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help || cmd === "help") return log(HELP);
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
