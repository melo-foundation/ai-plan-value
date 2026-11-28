#!/usr/bin/env node
/**
 * harness-quota: measures API-priced usage per point of a coding subscription's usage meter by
 * running the vendor's own coding CLI headless on the fixed Codex-kit workload, and the monthly API
 * value and subsidy multiple the site uses. Usage: kits/harness/README.md.
 *
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
import { hhmm, nowIso, otherProcesses, parseArgs, redact, sleep, sq, whichBin } from "./lib/util.mjs";
import { TASKS_A, taskB, WORKLOAD_VERSION, workloadHash, B_ROWS } from "../../codex/workload/tasks.mjs";

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
  const window = typeof a.window === "string" ? a.window : ad.meter.window;
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
  const fee = plan ? feeFor(plan, site) : null;
  const siteRef = plan ? siteMultiple(site, plan, siteModelId, effort) : null;
  const bin = typeof a.bin === "string" ? a.bin : ad.bin;
  return { ad, plan, model, effort, window, site, siteModelId, price, fee, siteRef, bin };
}

// ---------------------------------------------------------------------------------------------
// check, plans
// ---------------------------------------------------------------------------------------------

async function cmdCheck(a) {
  const s = setup(a, { needPlan: false });
  const { ad, bin } = s;
  const warn = [];
  log(`node ${process.versions.node}${Number(process.versions.node.split(".")[0]) < 20 ? "  (needs 20+)" : ""}`);
  const v = whichBin(bin) ? ad.version(bin) : null;
  log(`${ad.name} ${v ?? "not found"}`);
  if (!v) warn.push(`${bin} not found: ${ad.install}, or pass --bin <path>`);
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
        const r = await ad.meter.auto.read({ bin, model: s.model, dir: os.tmpdir(), timeoutMs: 90000 });
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
    const fee = feeFor(plan, s.site);
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
  const { ad, plan, model, effort, window, bin } = s;
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
      const c = ad.command({ dir, prompt: "<prompt>", model, effort, logDir, taskId: t.id, a });
      const env = Object.entries(c.env || {}).map(([k, v]) => `${k}=${sq(v)}`).join(" ");
      log(`\ntask ${t.id}${Object.keys(t.files).length ? ` · starter files: ${Object.keys(t.files).join(", ")}` : ""} · prompt ${t.prompt.length} chars`);
      log(`  cd ${sq(c.cwd || dir)} && ${env ? env + " " : ""}${bin} ${c.args.map(sq).join(" ")}`);
    }
    log(`\n… then more tasks until the meter has moved ${targetPp} pp. No calls made.`);
    return;
  }

  const version = whichBin(bin) ? ad.version(bin) : null;
  if (!version) fail(`${bin} not found: ${ad.install}, or pass --bin <path>`);
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
    arm,
    workload: { version: WORKLOAD_VERSION, hash: workloadHash(), arm },
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
        r = await ad.meter.auto.read({ bin, model, dir: workRoot, timeoutMs: meterTimeoutMs });
      } catch (e) {
        log(`auto meter failed: ${redact(e.message)}; switching to manual`);
        mode = "manual";
        m.meter.switchedToManualAt = nowIso();
      }
    }
    if (!r) {
      const res = await askReading(io, `${label} · ${ad.meter.manual.where}, % used: `, { allowLeft: ad.meter.manual.allowLeft });
      if (res.stop) return { stop: true };
      if (res.skip) {
        m.skippedReadings++;
        saveManifest(runDir, m);
        return null;
      }
      r = { pct: res.pct, resetsAt: null };
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
    const cmd = ad.command({ dir, prompt: t.prompt, model, effort, logDir, taskId: t.id, a });
    const r = await runChild(bin, { ...cmd, cwd: cmd.cwd || dir }, { timeoutMs, logFile: path.join(logDir, `${t.id}.out`) });
    rec.endedAt = nowIso();
    rec.exit = r.timedOut ? "timeout" : r.code;
    const u = ad.parseUsage({ stdout: r.stdout, logDir, taskId: t.id, model });
    rec.usage = u.usage;
    rec.tokenSource = u.tokenSource;
    if (u.incomplete) rec.usageIncomplete = true;
    tasksDone++;
    sinceReading++;
    saveManifest(runDir, m);
    const calls = u.usage.reduce((x, y) => x + (y.calls || 1), 0);
    log(`${hhmm(Date.now())} ${t.id.padEnd(16)} exit ${String(rec.exit).padEnd(7)} calls ${String(calls).padStart(3)}  tokens ${u.tokenSource}`);
    if (rec.exit !== 0) {
      failures++;
      if (r.stderr.trim()) log(`  stderr: ${redact(r.stderr.trim().split("\n").slice(-3).join(" | ")).slice(0, 400)}`);
      if (n === 1 && !calls) {
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
  const res = analyse({ manifest, price, fee: feeFor(manifest.plan, site), site: siteMultiple(site, manifest.plan, manifest.siteModelId, manifest.effort), sameModel: ad.sameModel });
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
  --force             start with other harness processes open or preflight warnings, or reuse a tag
  --dry-run           print the commands; no calls
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help || cmd === "help") return log(HELP);
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
