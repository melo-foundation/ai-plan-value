/**
 * Token weights for the Codex kit: rollouts of several runs → one joint fit per meter window
 * (kits/lib/token-weights.mjs). Kinds: uncached input (reference, weight 1), cached input, visible
 * output (output_tokens − reasoning_output_tokens) and reasoning (reasoning_output_tokens), each
 * priced at the model's API list price (reasoning at the output price). Codex reports no billed
 * cache writes (cache_write_input_tokens counts as uncached input, as in rollout-fit.mjs).
 *
 * Runs of the weight arms (cache, input, output, reasoning) are fitted; every other run (arms A
 * and B, folders of rollouts) is a holdout unless listed as a fit run.
 */

import fs from "node:fs";
import path from "node:path";
import * as RF from "./rollout-fit.mjs";
import * as TW from "../../lib/token-weights.mjs";
import { WEIGHT_ARMS, ARM_KIND } from "../workload/arms.mjs";

export const WEIGHTS_SCHEMA = "codex-quota.weights/1";
export const KINDS = ["input", "cached", "output", "reasoning"];
export const REF = "input";
export const KIND_LABEL = { input: "uncached input", cached: "cached input", output: "visible output", reasoning: "reasoning" };

/** API $ of one call split by kind. */
export function kindUsd(usage, includesReasoning, price) {
  const cachedExceeds = usage.cached > usage.input;
  const uncached = cachedExceeds ? usage.input : usage.input - usage.cached;
  const out = includesReasoning ? usage.output : usage.output + usage.reasoning;
  const reasoning = Math.min(usage.reasoning, out);
  const visible = out - reasoning;
  const tokens = [uncached, usage.cached, visible, reasoning];
  const per = [price.input, price.cachedInput, price.output, price.output];
  return { tokens, usd: tokens.map((t, i) => (t * per[i]) / 1e6) };
}

/** Drop calls a resumed session's rollout may repeat (same session, time and usage). */
function dedupe(events) {
  const seen = new Set();
  return events.filter((e) => {
    const k = `${e.sessionId}|${e.ts}|${e.kind}|${e.usage ? `${e.usage.input}/${e.usage.cached}/${e.usage.output}/${e.usage.reasoning}` : JSON.stringify(e.rate?.windows || {})}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * One run in the fit's shape: { tag, arm, role, usd[K], tokens[K], calls, windows: { w: readings } }.
 * Readings carry the cumulative API $ vector through the reading's call (lag 0) and before it (lag 1).
 */
export function runFromSessions({ tag, arm = null, role = null, sessions, prices, model, root = null, fromMs = null, toMs = null }) {
  const tl = RF.buildTimeline(sessions, { root, fromMs, toMs });
  const events = dedupe(tl.events);
  const cum = new Array(KINDS.length).fill(0);
  const tok = new Array(KINDS.length).fill(0);
  const windows = {};
  let calls = 0;
  let wrongModel = 0;
  for (const e of events) {
    const before = cum.slice();
    if (e.kind === "call") {
      const price = prices.models[e.model] || prices.models[model];
      if (!price) throw new Error(`no price for model ${e.model}`);
      if (e.model && e.model !== model) wrongModel++;
      const k = kindUsd(e.usage, e.includesReasoning, price);
      k.usd.forEach((x, i) => (cum[i] += x));
      k.tokens.forEach((x, i) => (tok[i] += x));
      calls++;
    }
    for (const [w, x] of Object.entries(e.rate?.windows || {})) {
      if (!Number.isFinite(x.pct)) continue;
      (windows[w] ||= []).push({ r: x.pct, resetsAt: x.resetsAt ?? null, ref: [cum.slice(), e.kind === "call" ? before : cum.slice()] });
    }
  }
  return { tag, arm, role: role || (WEIGHT_ARMS.includes(arm) ? "fit" : "holdout"), usd: cum, tokens: tok, calls, wrongModel, windows };
}

// ---------------------------------------------------------------------------------------------
// Finding a run's rollouts
// ---------------------------------------------------------------------------------------------

/**
 * Resolve one --runs entry to { tag, manifest, sessions, root, fromMs, toMs, source }.
 *   a run folder with manifest.json (rollouts/ copies, else the sessions folder in the run's time);
 *   a tag under each of runsDirs (kits/codex/results/runs first);
 *   a tag whose work folder <workBase>/<tag> exists: sessions under it from the sessions folder;
 *   a folder of rollout-*.jsonl (searched recursively).
 */
export function locateRun(entry, { runsDirs, sessionsDir, workBase }) {
  const fromManifestDir = (dir) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const copies = path.join(dir, "rollouts");
    const fromMs = Date.parse(manifest.startedAt);
    const toMs = manifest.endedAt ? Date.parse(manifest.endedAt) : null;
    const hasCopies = fs.existsSync(copies) && fs.readdirSync(copies).some((f) => f.endsWith(".jsonl"));
    const files = hasCopies ? RF.listRolloutFiles(copies) : RF.listRolloutFiles(sessionsDir, fromMs, toMs);
    return { tag: manifest.tag, manifest, files, root: manifest.root, fromMs, toMs, source: hasCopies ? "run folder" : "sessions folder" };
  };
  if (fs.existsSync(entry) && fs.statSync(entry).isDirectory()) {
    if (fs.existsSync(path.join(entry, "manifest.json"))) return fromManifestDir(entry);
    const files = RF.listRolloutFiles(entry);
    if (!files.length) throw new Error(`${entry}: no rollout-*.jsonl and no manifest.json`);
    return { tag: path.basename(path.resolve(entry)), manifest: null, files, root: null, fromMs: null, toMs: null, source: "folder" };
  }
  if (!/^[\w.-]+$/.test(entry)) throw new Error(`${entry}: not a folder, and not a run tag`);
  for (const d of runsDirs) {
    const dir = path.join(d, entry);
    if (fs.existsSync(path.join(dir, "manifest.json"))) return fromManifestDir(dir);
  }
  const work = path.join(workBase, entry);
  if (fs.existsSync(work)) return { tag: entry, manifest: null, files: RF.listRolloutFiles(sessionsDir), root: work, fromMs: null, toMs: null, source: "sessions folder" };
  throw new Error(`run ${entry} not found in ${runsDirs.join(", ")} or ${workBase}: pass --runs-dir <folder holding <tag>/manifest.json>`);
}

// ---------------------------------------------------------------------------------------------
// Joint fit
// ---------------------------------------------------------------------------------------------

/**
 * fitRuns({ runs, model, plan, prices, boot, seed }) → result object (schema codex-quota.weights/1).
 * runs: from runFromSessions, each optionally with { verdict, flags, source }.
 */
export function fitRuns({ runs, model, plan = null, prices, boot = 400, seed = 1, kitVersion = null }) {
  const flags = [];
  const flag = (code, severity, detail) => flags.push({ code, severity, detail });
  const fit = runs.filter((r) => r.role === "fit");
  if (!fit.length) flag("no_fit_runs", "error", "no cache, input, output or reasoning run among --runs");
  for (const arm of WEIGHT_ARMS) if (fit.length && !fit.some((r) => r.arm === arm)) flag("arm_missing", "warning", `no ${arm} run: ${KIND_LABEL[ARM_KIND[arm]]} is fitted from the other runs only`);
  for (const r of runs) {
    if (r.wrongModel) flag("model_mismatch", "error", `${r.tag}: ${r.wrongModel} of ${r.calls} calls not on ${model}`);
    if (r.verdict === "contaminated") flag("run_contaminated", r.role === "fit" ? "error" : "warning", `${r.tag}${r.role === "fit" ? "" : " (holdout)"}: ${(r.flags || []).filter((f) => f.severity === "error").map((f) => f.code).join(", ")}`);
    const total = r.usd.reduce((a, b) => a + b, 0);
    if (r.role === "fit" && ARM_KIND[r.arm] && total > 0) {
      const k = KINDS.indexOf(ARM_KIND[r.arm]);
      const share = r.usd[k] / total;
      if (share < TW.IDENT_SHARE) flag("arm_impure", "warning", `${r.tag}: ${KIND_LABEL[ARM_KIND[r.arm]]} is ${Math.round(100 * share)}% of its API $`);
    }
    if (r.arm === "cache") {
      const inTok = r.tokens[0] + r.tokens[1];
      const cs = inTok > 0 ? r.tokens[1] / inTok : 0;
      if (cs < 0.8) flag("cache_low", "warning", `${r.tag}: ${Math.round(100 * cs)}% of input tokens cached (want 80%+): rerun with --cache-mode fresh or check the rollouts`);
    }
  }
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.windows)))].sort((a, b) => (a === "weekly") - (b === "weekly"));
  const windows = {};
  for (const w of names) {
    windows[w] = TW.fitWindow({ runs, kinds: KINDS, ref: REF, window: w, boot, seed, unit: "pp" });
    const x = windows[w];
    if (!x.usable) flag("window_unusable", w === "weekly" ? "error" : "warning", `${w}: ${x.reason}`);
    else {
      for (const p of x.perRun) if (p.crossings < TW.MIN_STEPS) flag("run_short", "warning", `${w}: ${p.tag} made ${p.crossings} steps (want ${TW.MIN_STEPS}+)`);
      for (const h of x.holdout) if (h.usable && !h.inside) flag("holdout_miss", "warning", `${w}: ${h.tag} predicted ÷ measured ${h.ratio.est.toFixed(3)} (95% ${h.ratio.ci95.map((v) => v.toFixed(3)).join("–")})`);
      for (const [k, v] of Object.entries(x.weights)) if (!v.fixed && v.est != null && !v.identified) flag("weight_unidentified", "info", `${w}: ${k}: ${v.reason}`);
    }
  }
  const compared = windows["5h"] && windows.weekly ? TW.compareWindows(windows["5h"], windows.weekly, KINDS) : null;
  if (compared?.comparable && compared.same === false) flag("windows_differ", "info", `5h and weekly weights differ: ${Object.entries(compared.kinds).filter(([, v]) => v.same === false).map(([k]) => k).join(", ")}`);
  const sev = new Set(flags.map((f) => f.severity));
  const p = prices.models[model];
  return TW.roundDeep({
    schema: WEIGHTS_SCHEMA,
    kitVersion,
    plan: plan?.id ?? null,
    planName: plan?.name ?? null,
    model,
    prices: { source: prices.source, asOf: p?.asOf ?? prices.asOf, unit: "USD per 1M tokens", input: p?.input, cachedInput: p?.cachedInput, output: p?.output, reasoning: p?.output },
    kinds: KINDS,
    kindLabels: KIND_LABEL,
    reference: REF,
    definition: "meter units per call = Σ_kind w_kind × API $_kind ÷ scale; w = 1 is the kind's API price; scale = API $ per pp at weight 1",
    verdict: sev.has("error") ? "contaminated" : sev.has("warning") ? "check" : "clean",
    runs: runs.map((r) => {
      const total = r.usd.reduce((a, b) => a + b, 0);
      const inTok = r.tokens[0] + r.tokens[1];
      return {
        tag: r.tag,
        arm: r.arm,
        role: r.role,
        source: r.source ?? null,
        calls: r.calls,
        apiUsd: total,
        apiShare: Object.fromEntries(KINDS.map((k, i) => [k, total > 0 ? r.usd[i] / total : null])),
        tokens: Object.fromEntries(KINDS.map((k, i) => [k, r.tokens[i]])),
        cachedShareOfInput: inTok > 0 ? r.tokens[1] / inTok : null,
        verdict: r.verdict ?? null,
        flags: (r.flags || []).map((f) => f.code),
      };
    }),
    windows,
    windowsCompared: compared,
    options: { boot, seed },
    flags,
  });
}
