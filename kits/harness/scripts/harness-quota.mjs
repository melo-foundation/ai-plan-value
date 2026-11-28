#!/usr/bin/env node
/**
 * harness-quota: measures API-priced usage per point of a coding subscription's usage meter by
 * running the vendor's own coding CLI headless on the fixed Codex-kit workload, and the monthly API
 * value and subsidy multiple the site uses. Usage: kits/harness/README.md.
 *
 *   node kits/harness/scripts/harness-quota.mjs smoke   --harness <id> [--plan <plan>] [--manual]
 *   node kits/harness/scripts/harness-quota.mjs check   --harness <id> [--plan <plan>] [--auto-meter]
 *   node kits/harness/scripts/harness-quota.mjs plans   --harness <id> [--model <id>]
 *   node kits/harness/scripts/harness-quota.mjs run     --harness <id> --plan <plan> [options]
 *   node kits/harness/scripts/harness-quota.mjs analyse --run <tag> [--site <combined.json>]
 *
 * Meter: manual by default (the kit asks for the dashboard value before the run, after every N
 * tasks and at the end); --auto-meter reads it through the adapter's undocumented route and falls
 * back to manual when that fails. Tokens per call or per task come from the harness's own logs or
 * JSON output; API $ uses combined.json aaPricing; fees come from scripts/billing-periods.mjs.
 *
 * Each task runs in its own folder under ~/.cache/harness-quota-runs/<tag>/ with the harness's
 * sandbox limiting writes to that folder. Run manifests, logs and results stay in
 * kits/harness/results/ (git-ignored). Result files hold no prompts, paths, account ids or keys.
 * Zero dependencies (Node ≥ 20).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ADAPTERS, getAdapter } from "./adapters/index.mjs";
import { analyse, RUN_SCHEMA, secretHits } from "./lib/analyse.mjs";
import { askReading, lineReader } from "./lib/manual.mjs";
import { DEFAULT_SITE, feeFor, loadSite, priceFor, siteMultiple } from "./lib/site.mjs";
import { hhmm, nowIso, otherProcesses, parseArgs, redact, sleep, splitJsonStream, sq, whichBin } from "./lib/util.mjs";
import { TASKS_A, taskB, WORKLOAD_VERSION, workloadHash, B_ROWS } from "../../codex/workload/tasks.mjs";
import * as Smoke from "../../lib/smoke.mjs";

const __filename = fileURLToPath(import.meta.url);
export const KIT_VERSION = "1.0.0";
const KIT_DIR = path.resolve(path.dirname(__filename), "..");
// HARNESS_QUOTA_SCRATCH (tests): runs, results and work dirs go under it.
const SCRATCH = process.env.HARNESS_QUOTA_SCRATCH ? path.resolve(process.env.HARNESS_QUOTA_SCRATCH) : null;
const RESULTS_DIR = SCRATCH ? path.join(SCRATCH, "results") : path.join(KIT_DIR, "results");
const RUNS_DIR = path.join(RESULTS_DIR, "runs");
const WORK_BASE = SCRATCH ? path.join(SCRATCH, "work") : path.join(os.homedir(), ".cache", "harness-quota-runs");
const MODEL_SLUG = /^[a-z0-9][a-z0-9.-]*$/i;

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

function setup(a, { needPlan = true } = {}) {
  let ad;
  try {
    ad = getAdapter(a.harness);
  } catch (e) {
    fail(e.message);
  }
  const plans = ad.plans.map((p) => p.plan);
  const plan = typeof a.plan === "string" ? a.plan : null;
  if (needPlan && !plan) fail(`--plan "<name>": ${plans.map((p) => `"${p}"`).join(", ")}`);
  if (plan && !plans.includes(plan)) fail(`--plan ${plan} is not a ${ad.name} plan: ${plans.map((p) => `"${p}"`).join(", ")}`);
  const model = typeof a.model === "string" ? a.model : ad.models.default;
  if (!MODEL_SLUG.test(model)) fail("--model <id>, e.g. " + ad.models.default);
  let effort = null;
  if (ad.efforts) {
    effort = typeof a.effort === "string" ? a.effort : ad.efforts.default;
    if (!ad.efforts.values.includes(effort)) fail(`--effort ${ad.efforts.values.join(" | ")}`);
  } else if (a.effort) fail(`${ad.name} takes no --effort`);
  const window = typeof a.window === "string" ? a.window : (plan && ad.meter.windowFor?.(plan)) || ad.meter.window;
  if (!ad.meter.windows[window]) fail(`--window ${Object.keys(ad.meter.windows).join(" | ")}`);
  let site;
  try {
    site = loadSite(typeof a.site === "string" ? a.site : DEFAULT_SITE);
  } catch (e) {
    fail(e.message);
  }
  const siteModelId = ad.siteModelId(model);
  let price;
  try {
    price = priceFor(site, siteModelId);
  } catch (e) {
    fail(e.message);
  }
  const fee = plan ? planFee(ad, plan, site) : null;
  const siteRef = plan ? siteMultiple(site, plan, siteModelId, effort) : null;
  const bin = typeof a.bin === "string" ? a.bin : ad.bin;
  const inputs = adapterInputs(ad, a, { require: needPlan });
  return { ad, plan, model, effort, window, site, siteModelId, price, fee, siteRef, bin, inputs };
}

/** Fee from billing-periods / combined.json, else the adapter's own record for plans not on the site (kit.json notOnSite). */
function planFee(ad, plan, site) {
  const f = feeFor(plan, site);
  if (f) return f;
  const p = ad?.plans.find((x) => x.plan === plan && x.notOnSite && x.usd > 0);
  return p ? { usd: p.usd, source: `kits/harness/kit.json (not on the site; ${p.source})`, notOnSite: true } : null;
}

/** Adapter-specific inputs (ad.inputs: [{ key, values?, type?: "number", required? }]) → { key: value }. */
function adapterInputs(ad, a, { require }) {
  const out = {};
  for (const inp of ad.inputs || []) {
    const v = a[inp.key];
    const want = inp.values ? inp.values.join(" | ") : "<number>";
    if (v == null || v === true) {
      if (inp.required && require) fail(`${ad.name} needs --${inp.key} ${want}`);
      continue;
    }
    if (inp.values && !inp.values.includes(String(v))) fail(`--${inp.key} ${want}`);
    if (inp.type === "number") {
      const n = Number(v);
      if (!(n > 0)) fail(`--${inp.key}: a positive number`);
      out[inp.key] = n;
    } else out[inp.key] = String(v);
  }
  return out;
}

/** Version of the harness: the binary's version, or the adapter's own string for cloud harnesses (bin null). */
function harnessVersion(ad, bin, a) {
  if (ad.bin == null) return ad.version(null, a);
  return whichBin(bin) ? ad.version(bin) : null;
}

// ---------------------------------------------------------------------------------------------
// check, plans
// ---------------------------------------------------------------------------------------------

async function cmdCheck(a) {
  const s = setup(a, { needPlan: false });
  const { ad, bin } = s;
  const warn = [];
  log(`node ${process.versions.node}${Number(process.versions.node.split(".")[0]) < 20 ? "  (needs 20+)" : ""}`);
  const v = harnessVersion(ad, bin, a);
  log(`${ad.name} ${v ?? "not found"}`);
  if (!v) warn.push(ad.bin == null ? `${ad.name}: ${ad.install}` : `${bin} not found: ${ad.install}, or pass --bin <path>`);
  const procs = otherProcesses(ad.procMatch);
  log(`other ${ad.name} processes ${procs.length ? procs.map((p) => `pid ${p.pid} (${p.cmd})`).join(", ") : "none"}`);
  if (procs.length) warn.push("close the processes listed above");
  for (const w of ad.preflight({ bin, a })) warn.push(w);
  log(`model ${s.model} → ${s.siteModelId} $${s.price.input} / $${s.price.cachedInput} / $${s.price.output} per 1M (input / cached / output), as of ${s.price.asOf}`);
  if (s.plan) log(`plan ${s.plan} · fee ${s.fee ? `$${s.fee.usd}` : "unknown"} · site ${s.siteRef ? `${s.siteRef.value}×` : "none"}`);
  log(`meter ${a["auto-meter"] ? `auto (${ad.meter.auto?.route ?? "none"})` : "manual"} · ${ad.meter.unit} · window ${s.window}`);
  if (a["auto-meter"]) {
    if (!ad.meter.auto) warn.push(`${ad.name} has no automatic meter`);
    else if (v) {
      try {
        const r = await ad.meter.auto.read({ bin, model: s.model, dir: os.tmpdir(), timeoutMs: 90000, window: s.window, a, inputs: s.inputs });
        log(`meter reading ${r.pct}%${r.resetsAt ? ` · resets ${new Date(r.resetsAt * 1000).toLocaleString()}` : ""}${r.plan ? ` · plan ${r.plan}` : ""}`);
        if (s.plan && r.plan && r.plan !== s.plan) warn.push(`meter reports ${r.plan}, not ${s.plan}`);
      } catch (e) {
        warn.push(`auto meter failed: ${redact(e.message)}; run without --auto-meter`);
      }
    }
  }
  log(`workload v${WORKLOAD_VERSION} ${workloadHash()}`);
  if (warn.length) {
    log("\nwarnings:");
    for (const w of warn) log(`  ${w}`);
    process.exitCode = 1;
  } else log("\nok");
}

function cmdPlans(a) {
  const s = setup(a, { needPlan: false });
  log(`${s.ad.name} · ${s.model} (${s.siteModelId})`);
  for (const { plan } of s.ad.plans) {
    const fee = planFee(s.ad, plan, s.site);
    const ref = siteMultiple(s.site, plan, s.siteModelId, s.effort);
    log(`  ${plan.padEnd(24)} ${fee ? `$${fee.usd}`.padEnd(8) : "—".padEnd(8)} site ${ref ? `${ref.value}×` : "—"}`);
  }
}

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------

let activeChild = null;
let interrupted = 0;

function runChild(bin, { args, env = {}, cwd, stdin = null }, { timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
    activeChild = child;
    const out = fs.createWriteStream(logFile);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      out.write(d);
      if (stdout.length < 20e6) stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); // own child only
    child.on("error", (e) => (stderr += `\nspawn: ${e.code || e.message}`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.end();
      activeChild = null;
      resolve({ code, signal, stdout, stderr, timedOut: signal === "SIGTERM" && !interrupted });
    });
    if (stdin != null) child.stdin.end(stdin);
  });
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

const saveManifest = (dir, m) => fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");

async function cmdRun(a) {
  const s = setup(a);
  const { ad, plan, model, effort, window, bin, inputs } = s;
  const arm = String(a.arm || "A").toUpperCase();
  if (!["A", "B"].includes(arm)) fail("--arm A | B");
  const autoRequested = !!a["auto-meter"];
  if (autoRequested && !ad.meter.auto) fail(`${ad.name} has no automatic meter: run without --auto-meter`);
  const every = Number(a.every ?? ad.pacing.every);
  const targetPp = Number(a["target-pp"] ?? ad.pacing.targetPp);
  const maxPct = Number(a["max-pct"] ?? ad.pacing.maxPct);
  const idleMin = Number(a["idle-min"] ?? 5);
  const timeoutMs = Number(a["task-timeout-min"] ?? 25) * 60000;
  const maxTasks = Number(a["max-tasks"] ?? 200);
  const meterTimeoutMs = Number(a["meter-timeout-s"] ?? 90) * 1000;
  for (const [k, v] of Object.entries({ every, "target-pp": targetPp, "max-pct": maxPct, "idle-min": idleMin, "task-timeout-min": timeoutMs, "max-tasks": maxTasks })) if (!(v >= 0) || (k !== "idle-min" && !(v > 0))) fail(`--${k}: a positive number`);
  const tag = typeof a.tag === "string" ? a.tag : `${new Date().toISOString().slice(0, 10)}-${ad.id}-${arm}`;
  if (!/^[\w.-]+$/.test(tag)) fail("--tag: letters, digits, . _ - only");
  const runDir = path.join(RUNS_DIR, tag);
  const logDir = path.join(runDir, "logs");
  const workRoot = path.join(WORK_BASE, tag);
  const taskAt = (n) => {
    if (arm === "A") {
      const base = TASKS_A[n % TASKS_A.length];
      return { ...base, id: `r${Math.floor(n / TASKS_A.length) + 1}-${base.id}` };
    }
    return taskB(n);
  };
  const meterWhere = ad.meter.manual.where + (ad.meter.manual.url ? ` (${ad.meter.manual.url})` : "");

  if (a["dry-run"]) {
    log(`dry run · ${ad.name} · ${plan} · ${model}${effort ? ` ${effort}` : ""} · arm ${arm} · tag ${tag}`);
    if (Object.keys(inputs).length) log(`inputs     ${Object.entries(inputs).map(([k, v]) => `--${k} ${v}`).join(" · ")}`);
    log(`prices     ${s.siteModelId} $${s.price.input} / $${s.price.cachedInput} / $${s.price.output} per 1M (input / cached / output), as of ${s.price.asOf}`);
    log(`fee        ${s.fee ? `$${s.fee.usd}/month` : "unknown"} · site ${s.siteRef ? `${s.siteRef.value}×` : "none"}`);
    log(`meter      ${autoRequested ? `auto: ${ad.meter.auto.route}; manual if it fails` : `manual: ${meterWhere}`} · ${ad.meter.unit} · window ${window}`);
    log(`pacing     target +${targetPp} pp · stop at ${maxPct}% · ${autoRequested ? "reading after every task" : `reading every ${every} tasks`} · idle check ${idleMin} min before and after`);
    log(`work dir   ${workRoot}`);
    log(`run dir    ${runDir}`);
    log(`workload   v${WORKLOAD_VERSION} ${workloadHash()}${arm === "B" ? ` · ${B_ROWS} CSV rows per prompt` : ` · ${TASKS_A.length} tasks, repeated until the target`}`);
    for (let n = 0; n < 3; n++) {
      const t = taskAt(n);
      const dir = path.join(workRoot, t.id);
      log(`\ntask ${t.id}${Object.keys(t.files).length ? ` · starter files: ${Object.keys(t.files).join(", ")}` : ""} · prompt ${t.prompt.length} chars`);
      if (!ad.command) {
        log(`  ${ad.describeTask({ dir, a, inputs })}`);
        continue;
      }
      const c = ad.command({ dir, prompt: "<prompt>", model, effort, logDir, taskId: t.id, a, inputs });
      const env = Object.entries(c.env || {}).map(([k, v]) => `${k}=${sq(v)}`).join(" ");
      log(`  cd ${sq(c.cwd || dir)} && ${env ? env + " " : ""}${bin} ${c.args.map(sq).join(" ")}`);
    }
    log(`\n… then more tasks until the meter has moved ${targetPp} pp. No calls made.`);
    return;
  }

  const version = harnessVersion(ad, bin, a);
  if (!version) fail(ad.bin == null ? `${ad.name}: ${ad.install}` : `${bin} not found: ${ad.install}, or pass --bin <path>`);
  const procs = otherProcesses(ad.procMatch);
  if (procs.length && !a.force) fail(`close these first (or pass --force): ${procs.map((p) => `pid ${p.pid} (${p.cmd})`).join(", ")}`);
  const pre = ad.preflight({ bin, a });
  if (pre.length && !a.force) fail(pre.join("; "));
  if (fs.existsSync(path.join(runDir, "manifest.json")) && !a.force) fail(`run ${tag} exists: pick another --tag`);
  fs.mkdirSync(workRoot, { recursive: true });
  if (spawnSync("git", ["-C", workRoot, "rev-parse"], { stdio: "ignore" }).status === 0) fail(`${workRoot} is inside a git repository`);
  fs.mkdirSync(logDir, { recursive: true });

  let mode = autoRequested ? "auto" : "manual";
  const m = {
    schema: RUN_SCHEMA,
    kitVersion: KIT_VERSION,
    tag,
    harness: { id: ad.id, name: ad.name, version },
    plan,
    model,
    siteModelId: s.siteModelId,
    effort,
    inputs,
    costUnit: ad.costUnit || "api-usd",
    arm,
    workload: { version: WORKLOAD_VERSION, hash: workloadHash(), arm, ...(ad.workloadNote ? { note: ad.workloadNote } : {}) },
    meter: { mode, autoRoute: autoRequested ? ad.meter.auto.route : null, unit: ad.meter.unit, window, windowsPerMonth: ad.meter.windows[window].perMonth, note: ad.meter.note, every },
    targetPp,
    maxPct,
    root: workRoot,
    startedAt: nowIso(),
    endedAt: null,
    concurrent: procs.length,
    detectedPlan: null,
    readings: [],
    idle: [],
    tasks: [],
    skippedReadings: 0,
    stopReason: null,
  };
  saveManifest(runDir, m);
  log(`run ${tag} · ${ad.name} ${version} · ${plan} · ${model}${effort ? ` ${effort}` : ""} · target +${targetPp} pp of the ${window} meter`);
  log(`work dir ${workRoot}`);
  log(`run dir  ${runDir}`);
  log(`meter    ${mode === "auto" ? `auto (${ad.meter.auto.route})` : `manual: ${meterWhere}`}`);

  process.on("SIGINT", () => {
    interrupted++;
    if (interrupted === 1) {
      log("\nstopping after the current task; Ctrl-C again to quit now");
      activeChild?.kill("SIGTERM");
    } else process.exit(130);
  });

  const io = lineReader();
  let tasksDone = 0;
  /** One meter reading; returns the reading, null (skipped) or { stop: true }. */
  const read = async (label) => {
    let r = null;
    if (mode === "auto") {
      try {
        r = await ad.meter.auto.read({ bin, model, dir: workRoot, timeoutMs: meterTimeoutMs, window, a, inputs: inputs });
      } catch (e) {
        log(`auto meter failed: ${redact(e.message)}; switching to manual`);
        mode = "manual";
        m.meter.switchedToManualAt = nowIso();
      }
    }
    if (!r) {
      const res = ad.meter.manual.ask ? await ad.meter.manual.ask(io, label, { plan, inputs }) : await askReading(io, `${label} · ${ad.meter.manual.where}, % used: `, { allowLeft: ad.meter.manual.allowLeft });
      if (res.stop) return { stop: true };
      if (res.skip) {
        m.skippedReadings++;
        saveManifest(runDir, m);
        return null;
      }
      r = { pct: res.pct, resetsAt: null, extraUsed: res.extraUsed ?? null };
    }
    const rec = { ts: nowIso(), pct: r.pct, tasksDone, resetsAt: r.resetsAt ?? null, mode, label };
    if (r.periodType) rec.periodType = r.periodType;
    if (r.extraUsed != null) rec.extraUsed = r.extraUsed;
    if (r.plan && !m.detectedPlan) m.detectedPlan = r.plan;
    m.readings.push(rec);
    saveManifest(runDir, m);
    if (mode === "auto") log(`  meter ${r.pct}%`);
    return rec;
  };
  const idleCheck = async (phase, fromIdx = null) => {
    let from = fromIdx;
    if (from == null) {
      const r0 = await read(`idle check ${phase}, start`);
      if (!r0 || r0.stop) return r0;
      from = m.readings.length - 1;
    }
    log(`idle check (${phase}): ${idleMin} min, no tasks`);
    await sleep(idleMin * 60000);
    if (interrupted) return null;
    const r1 = await read(`idle check ${phase}, end`);
    if (!r1 || r1.stop) return r1;
    m.idle.push({ phase, from, to: m.readings.length - 1 });
    saveManifest(runDir, m);
    return r1;
  };

  const first = await idleCheck("before");
  if (first?.stop) {
    m.stopReason = "stopped before the first task";
    return finish();
  }
  const start = m.readings[m.readings.length - 1];
  if (!start) fail("no meter reading before the first task");
  if (start.pct + targetPp > maxPct) {
    m.stopReason = `meter at ${start.pct}%: +${targetPp} pp would pass ${maxPct}%`;
    saveManifest(runDir, m);
    fail(`${m.stopReason}; run after the ${window} reset or pass a smaller --target-pp`);
  }

  let lastPct = start.pct;
  let movedPp = 0;
  let sinceReading = 0;
  let chunk = mode === "auto" ? 1 : every;
  let failures = 0;
  let n = 0;
  const loopStart = Date.now();

  while (!interrupted && n < maxTasks) {
    const t = taskAt(n++);
    const dir = path.join(workRoot, t.id);
    fs.mkdirSync(dir, { recursive: true });
    writeFiles(dir, t.files);
    const rec = { id: t.id, startedAt: nowIso(), endedAt: null, exit: null };
    m.tasks.push(rec);
    saveManifest(runDir, m);
    let r;
    let u;
    if (ad.runTask) {
      // cloud harnesses: the adapter runs the task (API or the user pastes it) and reports exit, usage and ACUs
      r = await ad.runTask({ task: t, dir, model, effort, inputs, io, logDir, timeoutMs, a, isInterrupted: () => interrupted > 0 });
      if (r.stop) {
        m.tasks.pop();
        m.stopReason = "stopped at a task";
        saveManifest(runDir, m);
        break;
      }
      rec.endedAt = nowIso();
      rec.exit = r.exit;
      r.stderr ||= "";
      if (r.acus != null) rec.acus = r.acus;
      u = { usage: r.usage || [], tokenSource: r.tokenSource || "none" };
    } else {
      const cmd = ad.command({ dir, prompt: t.prompt, model, effort, logDir, taskId: t.id, a, inputs });
      r = await runChild(bin, { ...cmd, cwd: cmd.cwd || dir }, { timeoutMs, logFile: path.join(logDir, `${t.id}.out`) });
      rec.endedAt = nowIso();
      rec.exit = r.timedOut ? "timeout" : r.code;
      u = ad.parseUsage({ stdout: r.stdout, logDir, taskId: t.id, model });
    }
    rec.usage = u.usage;
    rec.tokenSource = u.tokenSource;
    if (u.incomplete) rec.usageIncomplete = true;
    tasksDone++;
    sinceReading++;
    saveManifest(runDir, m);
    const calls = u.usage.reduce((x, y) => x + (y.calls || 1), 0);
    log(`${hhmm(Date.now())} ${t.id.padEnd(16)} exit ${String(rec.exit).padEnd(7)} ${rec.acus != null ? `ACUs ${rec.acus}` : `calls ${String(calls).padStart(3)}  tokens ${u.tokenSource}`}`);
    if (rec.exit !== 0) {
      failures++;
      if (r.stderr.trim()) log(`  stderr: ${redact(r.stderr.trim().split("\n").slice(-3).join(" | ")).slice(0, 400)}`);
      if (n === 1 && !calls && rec.acus == null) {
        m.stopReason = "first task made no calls";
        break;
      }
    } else failures = 0;
    if (failures >= 3) {
      m.stopReason = "3 failed tasks in a row";
      break;
    }
    if (interrupted) break;
    if (sinceReading < chunk) continue;
    const rd = await read(`reading after task ${tasksDone}`);
    if (rd?.stop) {
      m.stopReason = "stopped at a reading";
      break;
    }
    if (!rd) continue;
    if (rd.pct >= lastPct) movedPp += rd.pct - lastPct;
    lastPct = rd.pct;
    sinceReading = 0;
    const perTask = movedPp / tasksDone;
    const mins = (Date.now() - loopStart) / 60000;
    log(`  +${Math.round(movedPp * 100) / 100}/${targetPp} pp${movedPp > 0 ? ` · ~${Math.max(0, Math.round(((targetPp - movedPp) / movedPp) * mins))} min left` : ""}`);
    if (movedPp >= targetPp) {
      m.stopReason = "target reached";
      break;
    }
    if (rd.pct >= maxPct) {
      m.stopReason = `meter at ${rd.pct}%`;
      break;
    }
    if (mode === "manual") {
      chunk = every;
      if (perTask > 0) {
        const room = Math.floor((maxPct - lastPct) / perTask);
        if (room < 1) {
          m.stopReason = `next task could pass ${maxPct}%`;
          break;
        }
        chunk = Math.max(1, Math.min(every, room, Math.ceil((targetPp - movedPp) / perTask)));
      }
    } else chunk = 1;
  }
  if (!m.stopReason) m.stopReason = interrupted ? "interrupted" : n >= maxTasks ? "max tasks" : "stopped";
  let endIdx = m.readings.length - 1;
  if (sinceReading > 0 || m.readings[endIdx]?.tasksDone !== tasksDone) {
    const fin = await read(`final reading after task ${tasksDone}`);
    endIdx = fin && !fin.stop ? m.readings.length - 1 : null;
  }
  if (!interrupted && endIdx != null && m.stopReason !== "stopped at a reading") await idleCheck("after", endIdx);
  return finish();

  function finish() {
    io.close();
    m.endedAt = nowIso();
    saveManifest(runDir, m);
    log(`\nstopped: ${m.stopReason}`);
    analyseAndWrite({ run: tag, site: a.site });
  }
}

// ---------------------------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------------------------

/** Field names of usage-like objects (keys named *usage*, *tokens*) in parsed JSON values; names only. */
export function usageFieldScan(values) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.slice(0, 200).forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v)) {
      if (x && typeof x === "object" && !Array.isArray(x) && /usage|tokens/i.test(k)) for (const f of Smoke.fieldNames(x)) if (!(x[f] && typeof x[f] === "object")) out.add(f);
      walk(x, depth + 1);
    }
  };
  values.forEach((v) => walk(v, 0));
  return [...out];
}

/** Parsed JSON values in stdout, every file under logDir (telemetry, export files) and `extra` files. */
function jsonValues(stdout, logDir, extra = []) {
  const vals = splitJsonStream(stdout).values;
  const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  for (const f of [...files(logDir), ...extra]) {
    try {
      if (fs.statSync(f).size < 5e6) vals.push(...splitJsonStream(fs.readFileSync(f, "utf8")).values);
    } catch {}
  }
  return vals;
}

/**
 * One headless run of a one-line prompt with the same command shape as a real task, in a throwaway
 * folder, then one meter reading. Writes kits/harness/results/smoke-<harness>-<date>.json.
 */
async function cmdSmoke(a) {
  let ad;
  try {
    ad = getAdapter(a.harness);
  } catch (e) {
    fail(e.message);
  }
  const plans = ad.plans.map((p) => p.plan);
  const plan = typeof a.plan === "string" ? a.plan : null;
  if (plan && !plans.includes(plan)) fail(`--plan ${plan} is not a ${ad.name} plan: ${plans.map((p) => `"${p}"`).join(", ")}`);
  const model = typeof a.model === "string" ? a.model : ad.models.default;
  if (!MODEL_SLUG.test(model)) fail("--model <id>, e.g. " + ad.models.default);
  let effort = null;
  if (ad.efforts) {
    effort = typeof a.effort === "string" ? a.effort : ad.efforts.default;
    if (!ad.efforts.values.includes(effort)) fail(`--effort ${ad.efforts.values.join(" | ")}`);
  } else if (a.effort) fail(`${ad.name} takes no --effort`);
  const window = typeof a.window === "string" ? a.window : (plan && ad.meter.windowFor?.(plan)) || ad.meter.window;
  if (!ad.meter.windows[window]) fail(`--window ${Object.keys(ad.meter.windows).join(" | ")}`);
  const inputs = adapterInputs(ad, a, { require: true });
  const bin = typeof a.bin === "string" ? a.bin : ad.bin;
  const timeoutMs = Number(a["task-timeout-min"] ?? 10) * 60000;
  const meterTimeoutMs = Number(a["meter-timeout-s"] ?? 90) * 1000;
  const clean = Smoke.cleaner(redact);
  const S = Smoke.stepList();
  const fields = { usage: [], meter: [] };

  const version = harnessVersion(ad, bin, a);
  S.add("binary", version ? "pass" : "fail", version ? version : ad.bin == null ? `${ad.name}: ${ad.install}` : `${ad.bin} not found: ${ad.install}, or pass --bin <path>`);
  const pre = ad.preflight({ bin, a });
  S.add("preflight", pre.length ? "fail" : "pass", pre.length ? pre.join("; ") : "sandbox and environment ok");
  const login = ad.loginCheck ? ad.loginCheck({ a }) : { status: "skipped", reason: "no login check for this harness; the prompt step tests it" };
  S.add("login", login.status, login.reason);

  const io = lineReader();
  let r = null;
  let u = null;
  let base = null;
  if (version) {
    const procs = otherProcesses(ad.procMatch);
    if (procs.length && !a.force) fail(`close these first (or pass --force): ${procs.map((p) => `pid ${p.pid} (${p.cmd})`).join(", ")}`);
    fs.mkdirSync(WORK_BASE, { recursive: true });
    base = fs.mkdtempSync(path.join(WORK_BASE, "smoke-"));
    const dir = path.join(base, "task");
    const logDir = path.join(base, "logs");
    fs.mkdirSync(dir);
    fs.mkdirSync(logDir);
    log(`smoke · ${ad.name} · ${model}${effort ? ` ${effort}` : ""} · one prompt: ${Smoke.SMOKE_PROMPT}`);
    if (ad.runTask) {
      r = await ad.runTask({ task: { id: "smoke", prompt: Smoke.SMOKE_PROMPT, files: {} }, dir, model, effort, inputs, io, logDir, timeoutMs, a, isInterrupted: () => false });
      if (r.stop) S.add("prompt", "skipped", "stopped before the task ran");
      else S.add("prompt", r.exit === 0 ? "pass" : "fail", r.exit === 0 ? "session finished" : `session failed (${r.exit})`);
      if (!r.stop) u = { usage: r.usage || [], tokenSource: r.tokenSource || "none", acus: r.acus };
    } else {
      const cmd = ad.command({ dir, prompt: Smoke.SMOKE_PROMPT, model, effort, logDir, taskId: "smoke", a, inputs });
      r = await runChild(bin, { ...cmd, cwd: cmd.cwd || dir }, { timeoutMs, logFile: path.join(base, "smoke.out") });
      S.add("prompt", r.code === 0 && !r.timedOut ? "pass" : "fail", r.timedOut ? `timed out after ${timeoutMs / 60000} min` : `exit ${r.code ?? r.signal}`);
      // model: null, so a model in the records comes from the harness's own output
      u = ad.parseUsage({ stdout: r.stdout, logDir, taskId: "smoke", model: null });
      fields.usage = usageFieldScan(jsonValues(r.stdout, logDir, ad.usageSources ? ad.usageSources({ stdout: r.stdout }) : []));
    }
  } else S.add("prompt", "skipped", "no harness binary");

  if (u && ad.costUnit === "acu") {
    S.add("usage", u.acus != null ? "pass" : "fail", u.acus != null ? "ACUs read for the session" : "no ACU count for the session");
    if (u.acus != null) fields.usage = [a["devin-api"] ? "acus_consumed" : "acus"];
    S.add("model", "skipped", `${ad.name} picks the model; none reported`);
  } else if (u) {
    const found = ["uncached", "cached", "cacheWrite", "output", "reasoning"].filter((k) => u.usage.some((x) => x[k] > 0));
    const ok = u.usage.length && found.includes("output") && found.some((k) => ["uncached", "cached", "cacheWrite"].includes(k));
    S.add("usage", ok ? "pass" : "fail", u.usage.length ? `parsed (${u.tokenSource}): ${found.join(", ") || "nothing"}` : "no token usage in the output");
    const seen = [...new Set(u.usage.map((x) => x.model).filter((m) => m && m !== "unrecorded"))];
    const same = seen.every((m) => ad.sameModel(m, model));
    if (!seen.length) S.add("model", "skipped", "the output names no model");
    else S.add("model", same ? "pass" : "fail", same ? `${seen.join(", ")} as requested` : `requested ${model}, output says ${seen.join(", ")}`);
  } else for (const id of ["usage", "model"]) S.add(id, "skipped", "the prompt did not run");

  let autoOk = false;
  if (!ad.meter.auto) {
    S.add("meter-auto", "skipped", "no automatic meter");
    S.add("meter-fields", "skipped", "no automatic meter");
  } else if (a.manual) {
    S.add("meter-auto", "skipped", "--manual");
    S.add("meter-fields", "skipped", "--manual");
  } else if (!version) {
    S.add("meter-auto", "skipped", "no harness binary");
    S.add("meter-fields", "skipped", "no harness binary");
  } else {
    try {
      const m = await ad.meter.auto.read({ bin, model, dir: base, timeoutMs: meterTimeoutMs, window, a, inputs });
      autoOk = Number.isFinite(m.pct);
      fields.meter = m.fields || [];
      S.add("meter-auto", autoOk ? "pass" : "fail", autoOk ? `automatic: ${window} % parsed (unit ${ad.meter.unit})` : "automatic: no percentage in the response");
      S.add("meter-fields", fields.meter.length ? "pass" : "fail", fields.meter.length ? "response field names recorded" : "no field names");
      if (m.plan) S.add("plan", !plan || m.plan === plan ? "pass" : "fail", !plan || m.plan === plan ? `the meter reports ${m.plan}` : `the meter reports ${m.plan}, not ${plan}`);
    } catch (e) {
      S.add("meter-auto", "fail", `automatic: ${e.message}`);
      S.add("meter-fields", "skipped", "no response");
    }
  }
  if (autoOk) S.add("meter-manual", "skipped", "the automatic reading worked");
  else {
    const label = "smoke reading";
    const res = ad.meter.manual.ask ? await ad.meter.manual.ask(io, label, { plan, inputs }) : await askReading(io, `${label} · ${ad.meter.manual.where}, % used: `, { allowLeft: ad.meter.manual.allowLeft });
    if (res.stop || res.skip) S.add("meter-manual", "skipped", res.skip ? "skipped at the prompt" : "no reading typed");
    else S.add("meter-manual", Number.isFinite(res.pct) ? "pass" : "fail", Number.isFinite(res.pct) ? `manual: reading parsed (unit ${ad.meter.unit})` : "manual: the reading did not parse");
  }
  io.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });

  const secrets = ["DEVIN_API_KEY", "KIMI_CODE_API_KEY", "MISTRAL_API_KEY", "DEVIN_ORG_ID"].map((k) => process.env[k]).filter(Boolean);
  const report = Smoke.buildReport({ kit: "harness", kitDir: KIT_DIR, adapter: ad.id, toolVersion: version, plan, model, steps: S.steps, fields, critical: ["binary", "prompt"], clean, secrets });
  const hits = secretHits(report);
  if (hits.length) fail(`report not written: ${hits.map((h) => `${h.path} (${h.kind})`).join(", ")}`);
  const file = Smoke.writeReport(RESULTS_DIR, report);
  Smoke.printReport(report, file, log);
  if (report.result === "fails") process.exitCode = 1;
  return report;
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyseAndWrite(a) {
  if (typeof a.run !== "string") fail("analyse --run <tag>");
  const mp = path.join(RUNS_DIR, a.run, "manifest.json");
  if (!fs.existsSync(mp)) fail(`${mp} not found`);
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  const ad = ADAPTERS[manifest.harness?.id];
  if (!ad) fail(`unknown harness ${manifest.harness?.id} in ${mp}`);
  let site;
  try {
    site = loadSite(typeof a.site === "string" ? a.site : DEFAULT_SITE);
  } catch (e) {
    fail(e.message);
  }
  let price;
  try {
    price = priceFor(site, manifest.siteModelId);
  } catch (e) {
    fail(e.message);
  }
  const res = analyse({ manifest, price, fee: planFee(ad, manifest.plan, site), site: siteMultiple(site, manifest.plan, manifest.siteModelId, manifest.effort), sameModel: ad.sameModel });
  res.generatedAt = nowIso();
  const hits = secretHits(res);
  if (hits.length) fail(`result not written: ${hits.map((h) => `${h.path} (${h.kind})`).join(", ")}`);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = typeof a.out === "string" ? path.resolve(a.out) : path.join(RESULTS_DIR, `${manifest.tag}.json`);
  fs.writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
  printSummary(res);
  log(`\nwrote ${out}`);
  return res;
}

function printSummary(r) {
  const f2 = (x) => (x == null ? "—" : x.toFixed(2));
  const f4 = (x) => (x == null ? "—" : x.toFixed(4));
  const ci = (c, f) => (c ? `${f(c[0])}–${f(c[1])}` : "—");
  const pct = (x) => (x == null ? "—" : `${(100 * x).toFixed(1)}%`);
  log(`\n${r.tag} · ${r.harness.name} · ${r.plan} · ${r.model}${r.effort ? ` ${r.effort}` : ""} · verdict ${r.verdict}`);
  log(`tasks ${r.run.tasks} (${r.run.failedTasks} failed) · calls ${r.run.calls} · readings ${r.run.readings} (${r.meter.requested === r.meter.mode ? r.meter.mode : `${r.meter.requested} → ${r.meter.mode}`}) · ${r.run.minutes.toFixed(0)} min`);
  if (r.acu) {
    const a = r.acu;
    log(`ACUs ${f2(a.total)} · ${f4(a.perTask)} per task (${a.tasksWithAcus} of ${a.tasks} tasks read)`);
    const w = r.fit;
    if (!w.usable) log(`${w.window} ${w.firstReading ?? "—"}% → ${w.lastReading ?? "—"}% · ${w.reason}`);
    else log(`${w.window} ${w.firstReading}% → ${w.lastReading}% · ${w.crossings} steps of ${w.fitStep} pp · ${f4(a.perPp.est)} ACU/pp (95% ${ci(a.perPp.ci95, f4)})`);
    if (a.monthlyAcus) log(`monthly ACUs ${f2(a.monthlyAcus.est)} (95% ${ci(a.monthlyAcus.ci95, f2)})`);
    if (a.usdPerAcu != null) log(`at $${a.usdPerAcu}/ACU: $${f2(a.usdPerTask)} per task${a.monthlyUsd ? ` · $${f2(a.monthlyUsd.est)}/month · ${f2(a.multiple)}× the fee` : ""}`);
    if (r.meter.note) log(r.meter.note);
    for (const fl of r.flags) log(`${fl.severity.padEnd(7)} ${fl.code}: ${fl.detail}`);
    return;
  }
  log(`tokens uncached ${r.tokens.uncachedInput} · cached ${r.tokens.cachedInput} · cache write ${r.tokens.cacheWrite} · output ${r.tokens.output} (reasoning ${r.tokens.reasoning})`);
  log(`API $${f2(r.usd.total)} · uncached ${pct(r.usdShare?.uncachedInput)} · cached ${pct(r.usdShare?.cachedInput)} · output ${pct(r.usdShare?.output)}`);
  const w = r.fit;
  if (!w.usable) log(`${w.window} ${w.firstReading ?? "—"}% → ${w.lastReading ?? "—"}% · ${w.reason}`);
  else log(`${w.window} ${w.firstReading}% → ${w.lastReading}% · ${w.crossings} steps of ${w.fitStep} pp · $${f4(w.usdPerPp.est)}/pp (95% ${ci(w.usdPerPp.ci95, f4)}) · first–last $${f4(w.usdPerPp.naiveFirstLast)}`);
  if (r.subsidy) {
    const s = r.subsidy;
    log(`monthly API value $${f2(s.monthlyApiUsd.est)} (95% ${ci(s.monthlyApiUsd.ci95, f2)}) · subsidy ${f2(s.multiple.est)}× (95% ${ci(s.multiple.ci95, f2)})`);
    if (s.site) log(`site ${r.plan} ${r.siteModelId} ${f2(s.site.value)}× · measured ÷ site ${f4(s.site.ratio)}`);
  }
  if (r.meter.note) log(r.meter.note);
  for (const fl of r.flags) log(`${fl.severity.padEnd(7)} ${fl.code}: ${fl.detail}`);
}

// ---------------------------------------------------------------------------------------------

const HELP = `harness-quota ${KIT_VERSION}

  node kits/harness/scripts/harness-quota.mjs smoke   --harness ${Object.keys(ADAPTERS).join("|")} [--plan <plan>] [--manual] [--bin <path>]
  node kits/harness/scripts/harness-quota.mjs check   --harness ${Object.keys(ADAPTERS).join("|")} [--plan <plan>] [--auto-meter] [--bin <path>]
  node kits/harness/scripts/harness-quota.mjs plans   --harness <id> [--model <id>]
  node kits/harness/scripts/harness-quota.mjs run     --harness <id> --plan <plan> [options]
  node kits/harness/scripts/harness-quota.mjs analyse --run <tag> [--site <combined.json>] [--out <file>]

run options
  --model             harness model id (default per harness)
  --effort            reasoning effort (harnesses that take one)
  --auto-meter        read the meter through the harness's undocumented route; manual if it fails
  --every             manual readings every N tasks (default 5)
  --target-pp         meter points to use (default per harness)
  --max-pct           stop at this meter % (default 85)
  --window            meter window (default per harness)
  --idle-min          idle check length, minutes (default 5)
  --task-timeout-min  per task (default 25)
  --max-tasks         default 200
  --arm               A coding tasks (default) | B low-cache prompts
  --tag               run name (default <date>-<harness>-<arm>)
  --bin               harness binary
  --site              combined.json (default public/data/combined.json)
  --gemini-sandbox    docker | podman | sandbox-exec (Gemini CLI)
  --qwen-sandbox      docker | podman | sandbox-exec (Qwen Code)
  --bl                bl binary for the Qwen Code automatic meter
  --contributor       on | off (Muse Code, required)
  --included-usd      the plan's included usage on the dashboard, $ (Cursor, required)
  --devin-api         start Devin sessions through the API (DEVIN_API_KEY, DEVIN_ORG_ID)
  --acu-usd           $ per ACU for the plan (Devin)
  --force             start with other harness processes open or preflight warnings, or reuse a tag
  --dry-run           print the commands; no calls

smoke options
  --manual            type the meter reading even where an automatic meter exists
  --task-timeout-min  default 10
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help || cmd === "help") return log(HELP);
  if (cmd === "smoke") return cmdSmoke(a);
  if (cmd === "check") return cmdCheck(a);
  if (cmd === "plans") return cmdPlans(a);
  if (cmd === "run") return cmdRun(a);
  if (cmd === "analyse" || cmd === "analyze") return analyseAndWrite(a);
  fail(`unknown command ${cmd}\n${HELP}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
