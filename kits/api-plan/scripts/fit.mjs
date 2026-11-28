/**
 * Fit for the API plan kit: API $ per meter unit, per window, from one run record.
 *
 * Automatic meters (a reading after every few calls) use the Codex kit's step-crossing fit
 * (kits/codex/scripts/rollout-fit.mjs fitWindow): each reading is floored onto a grid of Q native
 * units, every grid level crossed is located between two consecutive readings, and a GLS line
 * through the crossings gives $ per Q units with a Student t interval; both reading lags are tried.
 * Q is a whole multiple of the meter's own resolution q, so a floored reading is still an exact
 * floor of true usage; it is raised until the run crosses at most ~200 levels (fine-grained meters
 * such as token counts would otherwise produce millions of crossings).
 *
 * Manual meters (typed before and after the run) use the end points: $ per unit = C ÷ Δ, with Δ
 * the typed change. Each typed value is off by less than its last shown digit q (rounding rule
 * unknown), so Δ is off by less than q: hard bounds C ÷ (Δ ± q); 95% interval from the
 * difference of two uniform errors, SD q ÷ √6.
 *
 * Pool $ = $ per unit × window capacity; monthly API value = pool $ × the window's month factor
 * (adapters.mjs); subsidy multiple = the smallest monthly value over windows that have a factor
 * (the window that runs out first) ÷ the plan's USD fee.
 */

import * as RF from "../../codex/scripts/rollout-fit.mjs";
import { adapterFor, windowDef } from "./adapters.mjs";

export const RESULT_SCHEMA = "api-plan.result/1";
export const RUN_SCHEMA = "api-plan.run/1";
const MAX_LEVELS = 200;
const Z95 = 1.959964;

export const round = RF.round;

/** Largest of 1000, 100, 10, 1, 0.1 … 1e-6 that divides every value. */
export function resolutionOf(values) {
  const steps = [1000, 100, 10, 1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.001, 1e-4, 1e-5, 1e-6];
  for (const q of steps) if (values.every((v) => Math.abs(v / q - Math.round(v / q)) < 1e-6)) return q;
  return 1e-6;
}

/** Decimal step of a typed number: "37" → 1, "37.5" → 0.1, "1.92" → 0.01. */
export function typedResolution(text) {
  const m = String(text).match(/\.(\d+)/);
  return m ? 10 ** -m[1].length : 1;
}

function cumulative(calls) {
  const c = [0];
  for (const x of calls) c.push(c[c.length - 1] + (x.usd || 0));
  return c;
}

/** Readings of one window as [{ i, ts, used, capacity, resetsAt, cb, ca, phase }]. */
function readingsOf(run, w, C) {
  const out = [];
  run.readings.forEach((r, i) => {
    const x = r.windows?.[w];
    if (!x || !Number.isFinite(x.used)) return;
    const k = Math.min(r.afterCall ?? 0, C.length - 1);
    out.push({ i, ts: r.ts, used: x.used, unit: x.unit ?? null, capacity: x.capacity ?? null, resetsAt: x.resetsAt ?? null, q: r.resolution?.[w] ?? null, cb: C[Math.max(0, k - 1)], ca: C[k], phase: r.phase });
  });
  return out;
}

/** Step-crossing fit of one automatic window. */
export function fitAutoWindow(run, w, C) {
  const rs = readingsOf(run, w, C);
  const def = windowDef(adapterFor(run.adapter), w);
  const capacity = [...rs].reverse().find((x) => x.capacity > 0)?.capacity ?? def.capacity ?? null;
  const base = { window: w, label: def.label, unit: rs[0]?.unit ?? def.unit, mode: "auto", readings: rs.length, capacity, monthFactor: def.monthFactor ?? null };
  if (rs.length < 2) return { ...base, usable: false, reason: "fewer than 2 readings" };
  const q = resolutionOf(rs.map((x) => x.used));
  const move = Math.max(...rs.map((x) => x.used)) - Math.min(...rs.map((x) => x.used));
  const Q = q * Math.max(1, Math.ceil(move / q / MAX_LEVELS - 1e-9));
  const priced = rs.map((x) => ({ ts: x.ts, kind: "meter", usd: 0, cb: x.cb, ca: x.ca, rate: { windows: { [w]: { pct: Math.floor(x.used / Q + 1e-9), resetsAt: x.resetsAt } } } }));
  const f = RF.fitWindow(priced, w);
  const out = { ...base, resolution: q, grid: Q, first: rs[0].used, last: rs[rs.length - 1].used, moved: rs[rs.length - 1].used - rs[0].used, epochs: f.epochs?.length ?? 1, resetsAt: f.epochs?.map((e) => e.resetsAt) ?? [] };
  if (!f.usable) return { ...out, usable: false, reason: String(f.reason).replace(/ pp\b/, ` × ${Q} ${base.unit || "units"}`) };
  const u = f.usdPerPp;
  const per = (x) => (x == null ? null : x / Q);
  return {
    ...out,
    usable: true,
    lag: f.lag,
    crossings: f.crossings,
    usdPerUnit: { est: per(u.est), se: per(u.se), ci95: u.ci95 ? u.ci95.map(per) : null, relSe: u.relSe, bounds: u.bounds ? { lo: per(u.bounds.lo), hi: per(u.bounds.hi) } : null, naiveFirstLast: per(u.naiveFirstLast), df: u.df },
    shortSteps: f.shortSteps || [],
    exactlyLinear: u.bounds !== null,
  };
}

/** End-point estimate of one manual window: last "before" reading to last "after" reading. */
export function fitManualWindow(run, w, C) {
  const rs = readingsOf(run, w, C);
  const def = windowDef(adapterFor(run.adapter), w);
  const capacity = [...rs].reverse().find((x) => x.capacity > 0)?.capacity ?? def.capacity ?? null;
  const base = { window: w, label: def.label, unit: def.unit, mode: "manual", readings: rs.length, capacity, monthFactor: def.monthFactor ?? null };
  const before = rs.filter((x) => x.phase.startsWith("before"));
  const after = rs.filter((x) => x.phase.startsWith("after"));
  if (!before.length || !after.length) return { ...base, usable: false, reason: "needs a reading before and after the run" };
  const a = before[before.length - 1];
  const b = after[after.length - 1];
  const q = Math.max(a.q ?? typedResolution(a.used), b.q ?? typedResolution(b.used));
  const delta = b.used - a.used;
  const usd = b.ca - a.ca;
  const out = { ...base, resolution: q, first: a.used, last: b.used, moved: delta, usdBetween: usd };
  if (delta < 2 * q) return { ...out, usable: false, reason: `meter moved ${round(delta, 6)}, below twice its resolution ${q}: run longer (--target)` };
  const sd = q / Math.sqrt(6);
  const est = usd / delta;
  const ciLoD = delta + Z95 * sd;
  const ciHiD = delta - Z95 * sd;
  return {
    ...out,
    usable: true,
    usdPerUnit: { est, se: (est * sd) / delta, ci95: [usd / ciLoD, ciHiD > 0 ? usd / ciHiD : null], relSe: sd / delta, bounds: { lo: usd / (delta + q), hi: delta > q ? usd / (delta - q) : null } },
  };
}

function poolAndMonth(win) {
  if (!win.usable || !(win.capacity > 0)) return win;
  const u = win.usdPerUnit;
  const pool = { est: u.est * win.capacity, ci95: u.ci95 ? u.ci95.map((x) => (x == null ? null : x * win.capacity)) : null };
  const monthly = win.monthFactor ? { est: pool.est * win.monthFactor, ci95: pool.ci95 ? pool.ci95.map((x) => (x == null ? null : x * win.monthFactor)) : null } : null;
  return { ...win, poolUsd: pool, monthlyApiUsd: monthly };
}

/** Same-window idle comparison: meter change between two readings with no calls between. */
function idleChecks(run) {
  const out = [];
  for (const it of run.idle || []) {
    const a = run.readings[it.from];
    const b = run.readings[it.to];
    if (!a || !b) continue;
    for (const w of Object.keys(a.windows || {})) {
      const x = a.windows[w];
      const y = b.windows?.[w];
      if (!y) continue;
      const reset = x.resetsAt != null && y.resetsAt != null && Math.abs(y.resetsAt - x.resetsAt) > 600;
      const q = Math.max(a.resolution?.[w] ?? 0, b.resolution?.[w] ?? 0);
      out.push({ phase: it.phase, window: w, before: x.used, after: y.used, moved: !reset && y.used - x.used > Math.max(q / 2, 1e-9), reset, minutes: round((b.ts - a.ts) / 60000, 2) });
    }
  }
  return out;
}

const norm = (m) => String(m || "").toLowerCase().replace(/^.*\//, "");
/** A response model matches the requested one when equal or a dated / suffixed variant of it. */
export function modelMatches(requested, got) {
  const r = norm(requested);
  const g = norm(got);
  if (!g) return true;
  return g === r || g.startsWith(`${r}-`) || g.startsWith(`${r}@`) || g.startsWith(`${r}:`) || r.startsWith(`${g}-`);
}

/** Full analysis of a run record → result object (no key, no account data, no prompts). */
export function analyseRun(run) {
  const flags = [];
  const flag = (code, severity, detail) => flags.push({ code, severity, detail });
  const calls = run.calls || [];
  const ok = calls.filter((c) => c.ok);
  const C = cumulative(calls);

  const tokens = { input: 0, uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const usd = { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0, total: 0 };
  const byProfile = {};
  const models = {};
  let cachedExceeds = 0;
  for (const c of ok) {
    if (!c.usage) continue;
    const u = c.usage;
    tokens.uncachedInput += u.uncached;
    tokens.cachedInput += u.cached;
    tokens.cacheWrite += u.cacheWrite;
    tokens.input += u.uncached + u.cached + u.cacheWrite;
    tokens.output += u.output;
    tokens.reasoning += u.reasoning;
    for (const k of ["uncachedInput", "cachedInput", "cacheWrite", "output"]) usd[k] += c.parts?.[k] ?? 0;
    usd.total += c.usd;
    const p = (byProfile[c.profile] ||= { calls: 0, usd: 0, input: 0, cachedInput: 0, output: 0 });
    p.calls++;
    p.usd += c.usd;
    p.input += u.uncached + u.cached + u.cacheWrite;
    p.cachedInput += u.cached;
    p.output += u.output;
    if (u.cachedExceedsInput) cachedExceeds++;
    const m = c.responseModel ?? "unrecorded";
    (models[m] ||= { calls: 0 }).calls++;
  }

  if (!ok.length) flag("no_calls", "error", "no successful calls");
  const failed = calls.length - ok.length;
  if (failed) flag("call_errors", failed > 0.1 * calls.length ? "error" : "warning", `${failed} of ${calls.length} calls failed (${[...new Set(calls.filter((c) => !c.ok).map((c) => c.status ?? c.error))].join(", ")})`);
  const noUsage = ok.filter((c) => !c.usage).length;
  if (noUsage) flag("no_usage", "error", `${noUsage} responses without a usage field; their tokens are unpriced`);
  const wrong = ok.filter((c) => !modelMatches(run.expectModel || run.model, c.responseModel));
  if (wrong.length) flag("model_mismatch", "error", `${wrong.length} of ${ok.length} responses name another model: ${[...new Set(wrong.map((c) => c.responseModel))].join(", ")} (expected ${run.expectModel || run.model}; pass --expect-model if this is an alias)`);
  if (cachedExceeds) flag("cached_exceeds_input", "warning", `${cachedExceeds} responses report more cached than prompt tokens; priced as uncached prompt tokens only`);
  if (run.price?.source === "--price option") flag("price_from_option", "info", `API price from --price ${run.price.input},${run.price.cachedInput},${run.price.output}`);
  if (run.stopReason === "interrupted") flag("interrupted", "warning", "run stopped with Ctrl-C");
  if (/ceiling|max-/.test(run.stopReason || "")) flag("ceiling", "info", `stopped: ${run.stopReason}`);

  // windows
  const names = [...new Set(run.readings.flatMap((r) => Object.keys(r.windows || {})))];
  const windows = {};
  for (const w of names) windows[w] = poolAndMonth(run.mode === "manual" ? fitManualWindow(run, w, C) : fitAutoWindow(run, w, C));
  for (const [w, x] of Object.entries(windows)) {
    const counts = !!x.monthFactor;
    if (x.mode === "auto" && x.epochs > 1) flag("window_reset", counts ? "warning" : "info", `${w} reset ${x.epochs - 1}× during the run; one intercept per window`);
    if (x.mode === "manual" && x.moved < 0) flag("window_reset", "error", `${w} fell from ${x.first} to ${x.last}: the window reset during the run; rerun inside one window`);
    for (const s of x.shortSteps || []) flag("meter_jump", "error", `${w}: meter ran ahead of the run's usage at ${s.ts}`);
    if (x.usable && x.exactlyLinear === false) flag("not_exactly_linear", "info", `${w}: no single line through every step`);
    if (!x.usable && x.moved >= 0) flag("window_unusable", w === run.primary ? "error" : "info", `${w}: ${x.reason}`);
  }
  const idle = idleChecks(run);
  for (const it of idle) {
    if (!it.moved) continue;
    const sev = it.phase === "before" || run.mode !== "manual" ? "error" : "warning";
    flag("meter_moved_idle", sev, `${it.window} moved ${it.before} → ${it.after} during the ${it.minutes}-min idle check (${it.phase})${sev === "warning" ? "; the dashboard may lag, the later reading is used" : ""}`);
  }
  if (!(run.idle || []).length) flag("idle_missing", "warning", "no idle checks recorded");

  // subsidy
  const candidates = Object.values(windows).filter((x) => x.monthlyApiUsd);
  candidates.sort((a, b) => a.monthlyApiUsd.est - b.monthlyApiUsd.est);
  const bind = candidates[0] || null;
  let subsidy = null;
  const fee = run.fee?.feeUsd ?? null;
  if (bind) {
    const m = bind.monthlyApiUsd;
    subsidy = {
      window: bind.window,
      definition: `monthly API value = $ per ${bind.unit} × ${bind.capacity} (window size) × ${bind.monthFactor} (${bind.label} → month); multiple = monthly ÷ plan fee in USD`,
      monthlyApiUsd: m,
      otherWindows: candidates.slice(1).map((x) => ({ window: x.window, monthlyApiUsd: x.monthlyApiUsd.est })),
      multiple: fee > 0 ? { est: m.est / fee, ci95: m.ci95 ? m.ci95.map((x) => (x == null ? null : x / fee)) : null, sigmaLn: bind.usdPerUnit.relSe } : null,
    };
    if (subsidy.multiple && run.siteRef?.subsidy) {
      const ratio = subsidy.multiple.est / run.siteRef.subsidy;
      subsidy.site = { value: run.siteRef.subsidy, id: run.siteRef.id, level: run.siteRef.level, dataDate: run.siteRef.dataDate, ratio, lnRatio: Math.log(ratio) };
    }
    if (!fee) flag("plan_unknown", "warning", "no --plan: monthly API value only, no subsidy multiple");
  } else if (!flags.some((f) => f.code === "window_unusable" && f.severity === "error")) {
    flag("no_monthly_window", "error", "no usable window converts to a month (5-hour and session windows do not)");
  }
  const fiveHour = windows["5h"]?.usable && windows.weekly?.usable && windows["5h"].poolUsd && windows.weekly.poolUsd ? { est: windows.weekly.poolUsd.est / windows["5h"].poolUsd.est } : null;

  const sev = new Set(flags.map((f) => f.severity));
  const ts = calls.map((c) => c.t1).filter(Number.isFinite);
  return RFroundDeep({
    schema: RESULT_SCHEMA,
    kitVersion: run.kitVersion,
    tag: run.tag,
    provider: run.provider,
    adapter: run.adapter,
    region: run.region ?? null,
    api: run.api,
    apiHost: run.apiHost,
    meter: { mode: run.mode, endpoint: run.meterEndpoint, primary: run.primary },
    plan: run.fee?.plan ?? null,
    fee: run.fee ?? null,
    model: run.model,
    siteModel: run.siteModel,
    responseModels: models,
    verdict: sev.has("error") ? "contaminated" : sev.has("warning") ? "check" : "clean",
    run: {
      start: run.startedAt,
      end: run.endedAt,
      minutes: ts.length ? (Math.max(...ts) - Math.min(...calls.map((c) => c.t0))) / 60000 : 0,
      calls: calls.length,
      okCalls: ok.length,
      stopReason: run.stopReason,
      maxTokens: run.maxTokens,
    },
    workload: run.workload,
    prices: run.price,
    tokens,
    usd,
    usdShare: usd.total > 0 ? { uncachedInput: usd.uncachedInput / usd.total, cachedInput: usd.cachedInput / usd.total, cacheWrite: usd.cacheWrite / usd.total, output: usd.output / usd.total } : null,
    cacheShare: tokens.input > 0 ? tokens.cachedInput / tokens.input : null,
    byProfile,
    windows,
    fiveHourWindowsPerWeek: fiveHour,
    subsidy,
    idle,
    flags,
  });
}

function RFroundDeep(o, d = 6) {
  if (Array.isArray(o)) return o.map((x) => RFroundDeep(x, d));
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) r[k] = RFroundDeep(v, d);
    return r;
  }
  // significant digits: $ per weighted token is ~1e-7
  if (typeof o === "number" && !Number.isInteger(o)) return Number.isFinite(o) ? Number(o.toPrecision(d + 3)) : null;
  return o;
}
