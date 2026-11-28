/**
 * Muse Code adapter (`muse`; Meta's Muse Code subscriptions: Everyday, High, Power, Maximum Usage).
 *
 * The plans are not in combined.json or billing-periods.mjs yet: names and fees come from this
 * file (mirrored in kit.json with notOnSite: true) so a result can still be computed.
 *
 * Sources (dev.meta.ai, read 2026-11-28):
 *   plans / fees: https://dev.meta.ai/products/muse-code/ ($5 / $15 / $50 / $200 a month),
 *              https://dev.meta.ai/help/subscriptions/what-is-a-muse-code-subscription
 *              (Everyday 10–50 prompts per 5 h; High 5×, Power 20×, Maximum 80×; the subscription
 *              works only through the Muse Code CLI).
 *   allowance: https://dev.meta.ai/docs/muse-code/subscriptions ("a five-hour allowance and a
 *              weekly allowance"; `muse usage` shows usage and reset times without a model turn;
 *              contributor mode gives more usage; per run `--contributor-mode on|off` or
 *              MUSE_CONTRIBUTOR_MODE).
 *   install:   https://dev.meta.ai/docs/muse-code/ (curl -fsSL https://dev.meta.ai/install.sh | bash;
 *              `muse exec "<prompt>"` runs one prompt to completion).
 *   headless:  https://dev.meta.ai/docs/muse-code/extending (`muse exec --json` emits JSONL events;
 *              `--disable-approval` skips approval prompts and keeps the sandbox; exit 0 / 1 / 2 /
 *              130 / 143). Changelog 1.4.24: "The run.usage line of muse exec --json now counts
 *              every model call of the run".
 *   sandbox:   https://dev.meta.ai/docs/muse-code/permissions (on by default, OS-enforced: write
 *              access to the workspace and a temp dir, the rest read-only).
 *   model:     https://dev.meta.ai/docs/muse-code/configuration (--model, default muse-spark-1.2;
 *              --reasoning-effort none|minimal|low|medium|high|xhigh|max|ultra, default high; the
 *              Meta provider does not accept none).
 *
 * Not in Meta's docs (taken from aqua5230/usage, loaders/muse_quota_probe.py and muse_loader.py;
 * unverified against a real install):
 *   - `muse usage --json` (Muse 1.4.13+): { schemaVersion, allowance: { tier, window { usedPercent,
 *     resetsAtMs }, weekly { usedPercent, resetsAtMs }, asOfMs }, reason, hint }; reason
 *     "no_allowance" when the login has no subscription.
 *   - `--trust-workspace` on `muse exec`.
 *   - token fields: input_tokens (includes cache reads and writes), output_tokens,
 *     cache_read_tokens (or cached_input_tokens / cached_tokens), cache_write_tokens, as in the
 *     session journal's model_completed events. The run.usage line is read with the same names.
 * The kit never opens ~/.config/muse or any stored key.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { dotsToHyphens, splitJsonStream, versionOf } from "../lib/util.mjs";

const FEES_URL = "https://dev.meta.ai/products/muse-code/";
export const PLANS = [
  { plan: "Muse Code Everyday Usage", usd: 5, notOnSite: true, source: FEES_URL },
  { plan: "Muse Code High Usage", usd: 15, notOnSite: true, source: FEES_URL },
  { plan: "Muse Code Power Usage", usd: 50, notOnSite: true, source: FEES_URL },
  { plan: "Muse Code Maximum Usage", usd: 200, notOnSite: true, source: FEES_URL },
];

const num = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const pick = (o, ...keys) => {
  for (const k of keys) if (num(o?.[k]) != null) return o[k];
  return null;
};

/** One token object (snake_case or camelCase) → a usage record; null when it has no token counts. */
export function usageRecord(tok, model, calls = 1) {
  if (!tok || typeof tok !== "object") return null;
  const input = pick(tok, "input_tokens", "inputTokens", "prompt_tokens");
  const output = pick(tok, "output_tokens", "outputTokens", "completion_tokens");
  if (input == null && output == null) return null;
  const cached = pick(tok, "cache_read_tokens", "cached_input_tokens", "cached_tokens", "cacheReadTokens", "cachedInputTokens") ?? 0;
  const write = pick(tok, "cache_write_tokens", "cacheWriteTokens", "cache_creation_tokens") ?? 0;
  const reasoning = pick(tok, "reasoning_tokens", "reasoningTokens", "thinking_tokens") ?? 0;
  const inp = input ?? 0;
  // input_tokens includes cache reads and writes in the session journal; if not, take it as uncached
  const uncached = cached + write <= inp ? inp - cached - write : inp;
  return { model: model ?? null, uncached, cached, cacheWrite: write, output: output ?? 0, reasoning, calls: num(calls) || 1 };
}

/**
 * usage from `muse exec --json` stdout (JSONL). Per call from runtime.session model_completed
 * events when the stream carries them; else per task from the last run.usage line.
 */
export function usageFromJsonl(stdout) {
  const vals = splitJsonStream(stdout).values.filter((v) => v && typeof v === "object" && !Array.isArray(v));
  const perCall = [];
  let runUsage = null;
  for (const v of vals) {
    const p = v.payload && typeof v.payload === "object" ? v.payload : null;
    if (!p) continue;
    if (v.payload_type === "runtime.session" && p.kind === "run" && p.event?.kind === "model_completed") {
      const model = typeof p.event.model === "string" ? p.event.model : p.event.model?.model_id;
      const r = usageRecord(p.event.usage, model);
      if (r) perCall.push(r);
    } else if (v.payload_type === "run.usage") runUsage = p;
  }
  if (perCall.length) return { usage: perCall, tokenSource: "per-call" };
  if (runUsage) {
    const tok = runUsage.usage ?? runUsage.tokens ?? runUsage.total ?? runUsage;
    const models = runUsage.by_model ?? runUsage.models ?? null;
    if (models && typeof models === "object" && !Array.isArray(models) && Object.keys(models).length) {
      const usage = Object.entries(models).map(([m, t]) => usageRecord(t, m, t?.model_calls ?? t?.calls)).filter(Boolean);
      if (usage.length) return { usage, tokenSource: "per-task" };
    }
    const model = typeof runUsage.model === "string" ? runUsage.model : runUsage.model?.model_id ?? runUsage.model_id ?? null;
    const r = usageRecord(tok, model, runUsage.model_calls ?? runUsage.calls ?? tok?.model_calls);
    if (r) return { usage: [r], tokenSource: "per-task" };
  }
  return { usage: [], tokenSource: "none" };
}

export function planFromMeter(tier) {
  if (!tier) return null;
  const t = String(tier).trim().toLowerCase();
  return PLANS.find((p) => p.plan.toLowerCase() === t || p.plan.toLowerCase() === `muse code ${t}`)?.plan || null;
}

/** `muse usage --json` stdout → weekly meter reading. Throws with a one-line reason. */
export function readingFromUsage(stdout, window = "weekly") {
  let j;
  try {
    j = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error("muse usage --json: output is not JSON");
  }
  if (j?.allowance == null) throw new Error(j?.reason === "no_allowance" ? "muse usage: no Muse Code allowance on this login" : `muse usage: no allowance (${j?.reason ?? "no reason given"})`);
  const w = j.allowance[window];
  if (!w || num(w.usedPercent) == null) throw new Error(`muse usage: no ${window} usedPercent`);
  const reset = num(w.resetsAtMs);
  return { pct: w.usedPercent, resetsAt: reset != null ? Math.floor(reset / 1000) : null, periodType: window, plan: planFromMeter(j.allowance.tier) };
}

/** Run `muse usage --json` (no model call); resolve with its stdout. */
export function runUsage({ bin, dir, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["usage", "--json"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); // own child only
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot start ${bin} usage: ${e.code || e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // no_allowance answers carry a non-zero exit in aqua5230/usage; let the parser say why
      if (code === 0 || out.trim().startsWith("{")) return resolve(out);
      reject(new Error(code == null ? "muse usage timed out" : `muse usage exit ${code}: ${err.trim().split("\n").pop() || "no output"}`));
    });
  });
}

export default {
  id: "muse",
  name: "Muse Code",
  bin: "muse",
  install: "curl -fsSL https://dev.meta.ai/install.sh | bash",
  login: "run `muse`, sign in with the Meta Model API account that holds the Muse Code subscription (unset META_API_KEY)",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    return cmd.slice(0, 2).some((x) => base(x) === "muse");
  },
  preflight() {
    const w = [];
    if (process.env.META_API_KEY) w.push("META_API_KEY is set: unset it so muse uses the subscription login, not pay-as-you-go");
    if (process.env.MUSE_CONTRIBUTOR_MODE) w.push("MUSE_CONTRIBUTOR_MODE is set: unset it and pass --contributor on|off");
    return w;
  },

  // muse-spark-1.2 is the CLI default but has no site price; 1.3 does
  models: { default: "muse-spark-1.3" },
  siteModelId: (m) => dotsToHyphens(m).replace(/-contributor$/, ""),
  sameModel: (rec, exp) => dotsToHyphens(rec).replace(/-contributor$/, "") === dotsToHyphens(exp).replace(/-contributor$/, ""),
  efforts: { default: "high", values: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
  inputs: [{ key: "contributor", values: ["on", "off"], required: true }],

  plans: PLANS,
  planFromMeter,

  command({ dir, prompt, model, effort, inputs }) {
    const args = ["exec", "--json", "--disable-approval", "--trust-workspace", "--model", model];
    if (effort) args.push("--reasoning-effort", effort);
    args.push("--contributor-mode", inputs?.contributor ?? "on", prompt);
    return { args, env: {}, cwd: dir };
  },
  parseUsage({ stdout }) {
    return usageFromJsonl(stdout);
  },

  meter: {
    unit: "% of the weekly allowance",
    windows: { weekly: { perMonth: 4 } },
    window: "weekly",
    note: "Muse Code has a 5-hour and a weekly allowance; the kit reads the weekly one and the subsidy uses 100 × weekly $/pp × 4 weeks (site convention). The allowance depends on contributor mode (inputs.contributor).",
    manual: {
      where: "the weekly % in `muse usage`",
      url: null,
      allowLeft: true,
    },
    auto: {
      route: "muse usage --json (command documented; JSON fields from aqua5230/usage, unverified)",
      async read({ bin, dir, timeoutMs }) {
        const out = await runUsage({ bin, dir, timeoutMs });
        let fields = [];
        try {
          fields = Object.keys(JSON.parse(String(out).trim()) || {});
        } catch {}
        return { ...readingFromUsage(out), fields };
      },
    },
  },
  pacing: { targetPp: 10, maxPct: 85, every: 5 },
  typical: { minutes: "1–3 h (unverified)", meter: "+10 pp of the weekly allowance (unverified)" },
};
