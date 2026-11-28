/**
 * Run manifest → result. The manifest holds per-task token counts and the meter readings with the
 * number of tasks finished when each was taken; prices are applied here, so a run can be analysed
 * again with new prices.
 */

import os from "node:os";
import { fitReadings, idleMoves, priceUsage } from "./fit.mjs";
import { roundDeep, SECRET_RES } from "./util.mjs";

export const RESULT_SCHEMA = "harness-quota.result/1";
export const RUN_SCHEMA = "harness-quota.run/1";
export const MIN_STEPS = 6;

/** Cumulative API $ after each task, and token / $ totals. */
export function priceTasks(tasks, price, expectedModel, sameModel = (a, b) => a === b) {
  const cum = [0];
  const tokens = { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const usd = { uncachedInput: 0, cachedInput: 0, output: 0, total: 0 };
  const byModel = {};
  let calls = 0;
  let perTaskOnly = 0;
  let incomplete = 0;
  for (const t of tasks) {
    let taskUsd = 0;
    for (const u of t.usage || []) {
      const p = priceUsage(u, price);
      taskUsd += p.usd;
      for (const k of ["uncachedInput", "cachedInput", "output"]) usd[k] += p.parts[k];
      tokens.uncachedInput += u.uncached;
      tokens.cachedInput += u.cached;
      tokens.cacheWrite += u.cacheWrite || 0;
      tokens.output += u.output;
      tokens.reasoning += u.reasoning || 0;
      const m = u.model || "unrecorded";
      byModel[m] ||= { calls: 0, usd: 0, matches: sameModel(m, expectedModel) };
      byModel[m].calls += u.calls || 1;
      byModel[m].usd += p.usd;
      calls += u.calls || 1;
    }
    if (t.tokenSource && t.tokenSource !== "per-call") perTaskOnly++;
    if (t.usageIncomplete) incomplete++;
    usd.total += taskUsd;
    cum.push(cum[cum.length - 1] + taskUsd);
  }
  return { cum, tokens, usd, byModel, calls, perTaskOnly, incomplete };
}

/**
 * Cloud harnesses with no token counts (costUnit "acu"): cumulative ACUs after each task stand in
 * for cumulative API $, so the fit gives ACUs per meter point.
 */
export function acuTasks(tasks) {
  const cum = [0];
  let total = 0;
  let read = 0;
  for (const t of tasks) {
    if (Number.isFinite(t.acus)) {
      total += t.acus;
      read++;
    }
    cum.push(total);
  }
  return { cum, total, read };
}

/**
 * analyse({ manifest, price, fee, site, sameModel }) → result object (rounded, no ids or paths).
 *   price: { input, cachedInput, output, asOf, source }; fee: { usd, source } | null;
 *   site: { value, id, … } | null (site subsidyMultiple for plan + model).
 */
export function analyse({ manifest: m, price, fee, site = null, sameModel }) {
  const flags = [];
  const flag = (code, severity, detail) => flags.push({ code, severity, detail });
  const acuMode = m.costUnit === "acu";
  const priced = priceTasks(m.tasks || [], price, m.model, sameModel);
  const acu = acuMode ? acuTasks(m.tasks || []) : null;
  const cum = acuMode ? acu.cum : priced.cum;
  const readings = (m.readings || []).map((r) => ({ ts: Date.parse(r.ts), pct: r.pct, usd: cum[Math.min(r.tasksDone, cum.length - 1)], resetsAt: r.resetsAt ?? null, mode: r.mode }));

  if (acuMode) {
    if (!acu.read) flag("no_acus", "error", "no ACU readings recorded");
    else if (acu.read < (m.tasks || []).length) flag("acus_missing", "warning", `${(m.tasks || []).length - acu.read} of ${(m.tasks || []).length} tasks have no ACU reading`);
  } else if (!priced.calls) flag("no_calls", "error", "no model calls recorded");
  const wrong = Object.entries(priced.byModel).filter(([, v]) => !v.matches);
  if (wrong.length) flag("model_mismatch", "error", `${wrong.reduce((s, [, v]) => s + v.calls, 0)} of ${priced.calls} calls not on ${m.model}: ${wrong.map(([k]) => k).join(", ")}`);
  if (priced.perTaskOnly && !acuMode) flag("tokens_per_task", "info", `${priced.perTaskOnly} of ${(m.tasks || []).length} tasks have token totals per task, not per call`);
  if (priced.incomplete) flag("usage_incomplete", "warning", `${priced.incomplete} tasks report incomplete token usage`);
  const failed = (m.tasks || []).filter((t) => t.exit !== 0).length;
  if (failed) flag("task_failures", "warning", `${failed} of ${(m.tasks || []).length} tasks did not exit 0`);

  const win = fitReadings(readings, { window: m.meter?.window ?? null });
  if (!win.usable) flag("window_unusable", "error", `${win.window}: ${win.reason}`);
  else if (win.crossings < MIN_STEPS) flag("too_few_steps", "warning", `${win.crossings} meter steps of ${win.fitStep} pp; ${MIN_STEPS} or more needed`);
  if (win.epochs > 1) flag("window_reset", "warning", `${win.window} window reset ${win.epochs - 1}× during the run; one intercept per window`);
  for (const s of win.shortSteps || []) flag("meter_jump", "error", `meter ran ${s.extraPp} pp ahead of usage at ${s.ts}`);
  if (win.usable && win.usdPerPp.bounds === null) flag("not_exactly_linear", "info", "no single line through every step; the meter does not follow API $ exactly");

  const idle = idleMoves(m.idle, readings, win.readingStep || 0);
  for (const it of idle) if (it.moved) flag("meter_moved_idle", "error", `meter moved ${it.before} → ${it.after} during idle check (${it.phase})`);
  if (!(m.idle || []).length) flag("idle_missing", "warning", "no idle checks recorded");
  else for (const it of idle) if (!it.checked) flag("idle_unchecked", "warning", `idle check ${it.phase} has no comparable readings`);

  if (m.detectedPlan && m.detectedPlan !== m.plan) flag("plan_mismatch", "error", `meter reports ${m.detectedPlan}, run declared ${m.plan}`);
  const periods = [...new Set((m.readings || []).map((r) => r.periodType).filter(Boolean))];
  if (periods.some((p) => p !== m.meter?.window)) flag("period_mismatch", "warning", `meter period ${periods.join(", ")}, kit window ${m.meter?.window}`);
  const extra = (m.readings || []).map((r) => r.extraUsed).filter((x) => x != null);
  if (extra.length > 1 && Math.max(...extra) > Math.min(...extra)) flag("on_demand", "error", "on-demand or extra credits were used during the run");
  if (m.concurrent) flag("concurrent_process", "warning", `${m.concurrent} other ${m.harness?.name ?? "harness"} process(es) running at start`);
  if (m.meter?.switchedToManualAt) flag("meter_mode_switched", "info", "automatic meter failed; manual readings after that point");
  const skipped = (m.skippedReadings || 0);
  if (skipped) flag("reading_skipped", "info", `${skipped} manual readings skipped`);

  let subsidy = null;
  const perMonth = m.meter?.windowsPerMonth;
  if (win.usable && perMonth && fee?.usd && !acuMode) {
    const b = win.usdPerPp;
    const monthly = (x) => 100 * x * perMonth;
    subsidy = {
      definition: `monthly API value = 100 × ${m.meter.window} $/pp × ${perMonth}; multiple = monthly ÷ $${fee.usd}`,
      window: m.meter.window,
      windowsPerMonth: perMonth,
      monthlyApiUsd: { est: monthly(b.est), ci95: b.ci95 ? b.ci95.map(monthly) : null },
      multiple: { est: monthly(b.est) / fee.usd, ci95: b.ci95 ? b.ci95.map((x) => monthly(x) / fee.usd) : null, sigmaLn: b.relSe },
    };
    if (site?.value) {
      const ratio = subsidy.multiple.est / site.value;
      subsidy.site = { value: site.value, id: site.id, effort: site.effort, quotaWindow: site.quotaWindow, ratio, lnRatio: Math.log(ratio) };
    }
  }

  let acuResult = null;
  if (acuMode) {
    const nTasks = (m.tasks || []).length;
    const usdPerAcu = Number.isFinite(m.inputs?.["acu-usd"]) ? m.inputs["acu-usd"] : null;
    const b = win.usable ? win.usdPerPp : null;
    const monthly = (x) => 100 * x * (perMonth || 0);
    acuResult = {
      definition: `ACUs per task from the session; ACU/pp from the meter fit; monthly ACUs = 100 × ${m.meter?.window} ACU/pp × ${perMonth}; $ = ACUs × --acu-usd`,
      total: acu.total,
      perTask: acu.read ? acu.total / acu.read : null,
      perPp: b ? { est: b.est, ci95: b.ci95 } : null,
      monthlyAcus: b && perMonth ? { est: monthly(b.est), ci95: b.ci95 ? b.ci95.map(monthly) : null } : null,
      usdPerAcu,
      usdPerTask: usdPerAcu != null && acu.read ? (usdPerAcu * acu.total) / acu.read : null,
      monthlyUsd: usdPerAcu != null && b && perMonth ? { est: usdPerAcu * monthly(b.est), ci95: b.ci95 ? b.ci95.map((x) => usdPerAcu * monthly(x)) : null } : null,
      multiple: usdPerAcu != null && b && perMonth && fee?.usd ? (usdPerAcu * monthly(b.est)) / fee.usd : null,
      tasksWithAcus: acu.read,
      tasks: nTasks,
    };
  }

  const sev = new Set(flags.map((f) => f.severity));
  const ts = (m.tasks || []).flatMap((t) => [Date.parse(t.startedAt), Date.parse(t.endedAt)]).filter(Number.isFinite);
  const result = {
    schema: RESULT_SCHEMA,
    kitVersion: m.kitVersion,
    tag: m.tag,
    harness: { id: m.harness?.id, name: m.harness?.name, version: m.harness?.version ?? null },
    plan: m.plan,
    planFeeUsd: fee?.usd ?? null,
    planFeeSource: fee?.source ?? null,
    model: m.model,
    siteModelId: m.siteModelId,
    effort: m.effort ?? null,
    inputs: m.inputs ?? {},
    costUnit: m.costUnit ?? "api-usd",
    planNotOnSite: fee?.notOnSite === true,
    arm: m.arm,
    workload: m.workload,
    meter: { mode: m.meter?.switchedToManualAt ? "manual" : m.meter?.mode, requested: m.meter?.mode, autoRoute: m.meter?.autoRoute ?? null, unit: m.meter?.unit, window: m.meter?.window, windowsPerMonth: perMonth, note: m.meter?.note ?? null },
    verdict: sev.has("error") ? "contaminated" : sev.has("warning") ? "check" : "clean",
    run: {
      start: ts.length ? new Date(Math.min(...ts)).toISOString() : null,
      end: ts.length ? new Date(Math.max(...ts)).toISOString() : null,
      minutes: ts.length ? (Math.max(...ts) - Math.min(...ts)) / 60000 : 0,
      tasks: (m.tasks || []).length,
      failedTasks: failed,
      calls: priced.calls,
      readings: readings.length,
      stopReason: m.stopReason ?? null,
    },
    prices: { model: m.siteModelId, unit: "USD per 1M tokens", input: price.input, cachedInput: price.cachedInput, output: price.output, asOf: price.asOf, source: price.source },
    tokens: priced.tokens,
    usd: priced.usd,
    usdShare: priced.usd.total > 0 ? { uncachedInput: priced.usd.uncachedInput / priced.usd.total, cachedInput: priced.usd.cachedInput / priced.usd.total, output: priced.usd.output / priced.usd.total } : null,
    models: Object.fromEntries(Object.entries(priced.byModel).map(([k, v]) => [k, { calls: v.calls, usd: v.usd }])),
    readings: readings.map((r) => ({ ts: new Date(r.ts).toISOString(), pct: r.pct, usd: r.usd, mode: r.mode })),
    fit: win,
    subsidy,
    acu: acuResult,
    idle,
    flags,
  };
  return scrub(roundDeep(result, 6));
}


/** Strings in a result that look like a secret, an email or a home path. */
export function secretHits(obj, home = os.homedir()) {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === "string") {
      for (const re of SECRET_RES) if (re.test(v)) hits.push({ path: p, kind: String(re) });
      if (home && home.length > 1 && v.includes(home)) hits.push({ path: p, kind: "home path" });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(obj, "$");
  return hits;
}

/** Replace any string that trips secretHits with "[removed]". */
export function scrub(obj, home = os.homedir()) {
  const bad = (s) => SECRET_RES.some((re) => re.test(s)) || (home && home.length > 1 && s.includes(home));
  const walk = (v) => {
    if (typeof v === "string") return bad(v) ? "[removed]" : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}
