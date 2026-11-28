/**
 * Token weights for the API plan kit: run records (results/runs/<tag>/run.json) of one provider and
 * model → one joint fit per meter window (kits/lib/token-weights.mjs). Kinds: uncached input
 * (reference, weight 1), cached input, cache writes (Anthropic-style APIs), visible output
 * (completion tokens − reasoning tokens) and reasoning (completion_tokens_details.reasoning_tokens;
 * Anthropic and Ollama responses report none, so their thinking counts as output), at the run's
 * API price (writes at the cache-write price, else the input price).
 *
 * A reading after call k is located at the cumulative $ of calls 0…k−1 (lag 0) or 0…k−2 (lag 1), as
 * in fit.mjs. Runs of the weight arms are fitted; runs of the mixed workload are holdouts.
 */

import * as TW from "../../lib/token-weights.mjs";
import { adapterFor, windowDef } from "./adapters.mjs";
import { API_ARMS, ARM_KIND } from "../workload/arms.mjs";

export const WEIGHTS_SCHEMA = "api-plan.weights/1";
export const KINDS = ["input", "cached", "cacheWrite", "output", "reasoning"];
export const REF = "input";
export const KIND_LABEL = { input: "uncached input", cached: "cached input", cacheWrite: "cache write", output: "visible output", reasoning: "reasoning" };

/** API $ of one call's usage by kind. */
export function kindUsd(u, p) {
  const reasoning = Math.min(u.reasoning || 0, u.output || 0);
  const tokens = [u.uncached || 0, u.cached || 0, u.cacheWrite || 0, (u.output || 0) - reasoning, reasoning];
  const per = [p.input, p.cachedInput, p.cacheWrite ?? p.input, p.output, p.output];
  return { tokens, usd: tokens.map((t, i) => (t * per[i]) / 1e6) };
}

/** One run record in the fit's shape. */
export function runFromRecord(run, role = null) {
  const K = KINDS.length;
  const C = [new Array(K).fill(0)];
  const tok = new Array(K).fill(0);
  let calls = 0;
  for (const c of run.calls || []) {
    const next = C[C.length - 1].slice();
    if (c.ok && c.usage) {
      const k = kindUsd(c.usage, run.price);
      k.usd.forEach((x, i) => (next[i] += x));
      k.tokens.forEach((x, i) => (tok[i] += x));
      calls++;
    }
    C.push(next);
  }
  const windows = {};
  const units = {};
  for (const r of run.readings || []) {
    const k = Math.min(r.afterCall ?? 0, C.length - 1);
    for (const [w, x] of Object.entries(r.windows || {})) {
      if (!Number.isFinite(x.used)) continue;
      (windows[w] ||= []).push({ r: x.used, resetsAt: x.resetsAt ?? null, ref: [C[k], C[Math.max(0, k - 1)]] });
      units[w] ||= x.unit ?? null;
    }
  }
  const arm = run.arm ?? null;
  return { tag: run.tag, arm, role: role || (API_ARMS.includes(arm) ? "fit" : "holdout"), usd: C[C.length - 1], tokens: tok, calls, windows, units, adapter: run.adapter, model: run.model, api: run.api };
}

/** fitRuns({ records, holdout: Set of tags, boot, seed }) → result (schema api-plan.weights/1). */
export function fitRuns({ records, holdout = new Set(), boot = 400, seed = 1, kitVersion = null }) {
  const flags = [];
  const flag = (code, severity, detail) => flags.push({ code, severity, detail });
  const first = records[0];
  const runs = records.map((r) => runFromRecord(r, holdout.has(r.tag) ? "holdout" : null));
  const fit = runs.filter((r) => r.role === "fit");
  if (!fit.length) flag("no_fit_runs", "error", "no cache, input, output, reasoning or write run among --runs");
  const armsWanted = first.api === "anthropic" ? API_ARMS : API_ARMS.filter((a) => a !== "write");
  for (const arm of armsWanted) if (fit.length && !fit.some((r) => r.arm === arm)) flag("arm_missing", "warning", `no ${arm} run: ${KIND_LABEL[ARM_KIND[arm]]} is fitted from the other runs only`);
  for (const r of runs) {
    const total = r.usd.reduce((a, b) => a + b, 0);
    if (r.role === "fit" && ARM_KIND[r.arm] && total > 0) {
      const share = r.usd[KINDS.indexOf(ARM_KIND[r.arm])] / total;
      if (share < TW.IDENT_SHARE) flag("arm_impure", "warning", `${r.tag}: ${KIND_LABEL[ARM_KIND[r.arm]]} is ${Math.round(100 * share)}% of its API $${r.arm === "reasoning" && first.api !== "openai" ? " (this API reports no reasoning tokens)" : ""}`);
    }
    if (r.arm === "cache") {
      const inTok = r.tokens[0] + r.tokens[1] + r.tokens[2];
      if (inTok > 0 && r.tokens[1] / inTok < 0.8) flag("cache_low", "warning", `${r.tag}: ${Math.round((100 * r.tokens[1]) / inTok)}% of input tokens cached (want 80%+)`);
    }
  }
  const ad = adapterFor(first.adapter);
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.windows)))];
  const windows = {};
  for (const w of names) {
    const def = ad ? windowDef(ad, w) : {};
    const unit = runs.find((r) => r.units[w])?.units[w] ?? def.unit ?? "units";
    windows[w] = TW.fitWindow({ runs, kinds: KINDS, ref: REF, window: w, boot, seed, unit: unit === "%" ? "pp" : unit });
    const x = windows[w];
    if (!x.usable) flag("window_unusable", "warning", `${w}: ${x.reason}`);
    else {
      for (const p of x.perRun) if (p.crossings < TW.MIN_STEPS) flag("run_short", "warning", `${w}: ${p.tag} made ${p.crossings} steps (want ${TW.MIN_STEPS}+): rerun with a larger --target`);
      for (const h of x.holdout) if (h.usable && !h.inside) flag("holdout_miss", "warning", `${w}: ${h.tag} predicted ÷ measured ${h.ratio.est.toFixed(3)}`);
    }
  }
  if (!Object.values(windows).some((x) => x.usable)) flag("no_window", "error", "no window has enough steps in the fit runs");
  const usable = Object.values(windows).filter((x) => x.usable);
  const compared = [];
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) compared.push(TW.compareWindows(usable[i], usable[j], KINDS));
  for (const c of compared) if (c.comparable && c.same === false) flag("windows_differ", "info", `${c.windows.join(" and ")} weights differ`);
  const sev = new Set(flags.map((f) => f.severity));
  return TW.roundDeep({
    schema: WEIGHTS_SCHEMA,
    kitVersion,
    provider: first.provider,
    adapter: first.adapter,
    api: first.api,
    plan: first.fee?.plan ?? null,
    model: first.model,
    prices: first.price,
    kinds: KINDS,
    kindLabels: KIND_LABEL,
    reference: REF,
    definition: "meter units per call = Σ_kind w_kind × API $_kind ÷ scale; w = 1 is the kind's API price; scale = API $ per meter unit at weight 1",
    verdict: sev.has("error") ? "contaminated" : sev.has("warning") ? "check" : "clean",
    runs: runs.map((r) => {
      const total = r.usd.reduce((a, b) => a + b, 0);
      return { tag: r.tag, arm: r.arm, role: r.role, calls: r.calls, apiUsd: total, apiShare: Object.fromEntries(KINDS.map((k, i) => [k, total > 0 ? r.usd[i] / total : null])), tokens: Object.fromEntries(KINDS.map((k, i) => [k, r.tokens[i]])) };
    }),
    windows,
    windowsCompared: compared,
    options: { boot, seed },
    flags,
  });
}
