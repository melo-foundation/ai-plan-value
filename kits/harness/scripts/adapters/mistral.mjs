/**
 * Mistral Vibe adapter (`vibe`; Mistral Vibe Pro).
 *
 * Sources (mistralai/mistral-vibe main @ fb7511a, 3.1.5, 2026-11-24; docs.mistral.ai; help.mistral.ai):
 *   install:   README.md (curl -LsSf https://mistral.ai/vibe/install.sh | bash; uv tool install
 *              --python 3.14 mistral-vibe). Version: vibe --version.
 *   login:     browser sign-in on first run, or `vibe --setup`; key in MISTRAL_API_KEY, ~/.vibe/.env
 *              or the OS keyring. A `vibe`-scope key bills the chat plan (vibe/app_server/_account.py).
 *   headless:  docs/programmatic-mode.md: vibe -p "<prompt>" --workdir DIR --model ALIAS
 *              --thinking LEVEL --approval-policy NAME --output-dir DIR (writes DIR/export.json and
 *              DIR/session/, however the run ends). Exit 0 finished, 1 usage / config error,
 *              2 infrastructure failure, 3 limit or refusal, 4 aborted.
 *   sandbox:   no OS sandbox on the host (only the experimental --agent-socket server). The kit runs
 *              --approval-policy accept-edits: write_file / edit inside the workdir are approved,
 *              anything that would ask (paths outside the workdir, bash) is denied in -p mode
 *              (docs.mistral.ai/vibe/code/safety-approvals-permissions).
 *   tokens:    export.json (vibe/app_server/run_export.py, schema_version 1): usage { input_tokens,
 *              output_tokens, cached_input_tokens, total_tokens }, steps (model calls of the root
 *              agent), subagents[] { model, usage, steps }. total = input + output, so input
 *              includes cached (OpenAI-style). No model field at the top level: the requested
 *              model is recorded. --output json carries no usage.
 *   meter:     % of the monthly Vibe budget: console Code > CLI > View organization usage
 *              (help.mistral.ai article 698531); TUI footer gauge. vibe/app_server/_billing.py reads
 *              GET https://api.mistral.ai/v1/billing/budget → { vibe_budget: { usage_percentage
 *              (0–100), initial_budget, reset_at, payg_enabled } } with the API key; needs the
 *              see_org_inference_usage permission (403 otherwise). --auto-meter calls it with
 *              $MISTRAL_API_KEY; the key goes into the header only and is never printed or stored.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dotsToHyphens, loginFile, splitJsonStream, versionOf } from "../lib/util.mjs";

const DEFAULT_BASE = "https://api.mistral.ai/v1";
// tests point the budget call at a local server
const baseUrl = () => (process.env.HARNESS_QUOTA_MISTRAL_BASE || DEFAULT_BASE).replace(/\/+$/, "");

/** Vibe alias → site baseModelId: "mistral-large-4-0" → "mistral-large-4", "mistral-medium-3.5" → "mistral-medium-3-5". */
export function siteModelId(m) {
  return dotsToHyphens(m).replace(/^(mistral-[a-z]+-\d+)-0$/, "$1");
}

/** usage records from export.json: the root agent and each subagent. */
export function usageFromExport(text, model = null) {
  const j = splitJsonStream(text).values.find((v) => v && !Array.isArray(v) && ("usage" in v || "outcome" in v));
  if (!j) return [];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const rec = (u, m, steps) => {
    const input = n(u.input_tokens);
    const cached = Math.min(n(u.cached_input_tokens), input);
    return { model: m ?? null, uncached: input - cached, cached, cacheWrite: 0, output: n(u.output_tokens), reasoning: 0, calls: n(steps) || 1 };
  };
  const out = [];
  if (j.usage) out.push(rec(j.usage, model, j.steps));
  for (const s of j.subagents || []) if (s?.usage) out.push(rec(s.usage, s.model ?? model, s.steps));
  return out;
}

/** /v1/billing/budget → reading. */
export function readingFromBudget(json) {
  const b = json?.vibe_budget;
  if (!b) throw new Error(`Mistral billing/budget has no vibe_budget (keys: ${Object.keys(json || {}).slice(0, 8).join(", ") || "none"})`);
  const pct = Number(b.usage_percentage);
  if (!Number.isFinite(pct)) throw new Error("Mistral billing/budget: usage_percentage is not a number");
  const t = b.reset_at ? Date.parse(b.reset_at) : NaN;
  return { pct: Math.max(0, pct), resetsAt: Number.isFinite(t) ? Math.floor(t / 1000) : null, periodType: "monthly" };
}

export async function fetchBudget({ timeoutMs = 30000 } = {}) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY is not set: export the Vibe key for the automatic meter");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/billing/budget`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: ctl.signal });
    if (res.status === 401) throw new Error("Mistral billing/budget HTTP 401: check MISTRAL_API_KEY");
    if (res.status === 403) throw new Error("Mistral billing/budget HTTP 403: the key lacks see_org_inference_usage");
    if (!res.ok) throw new Error(`Mistral billing/budget HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error("Mistral billing/budget: body is not JSON");
    }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Mistral billing/budget: timed out");
    if (/^Mistral /.test(e.message) || /^MISTRAL_API_KEY/.test(e.message)) throw e;
    throw new Error(`Mistral billing/budget: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: "mistral",
  name: "Mistral Vibe",
  bin: "vibe",
  install: "curl -LsSf https://mistral.ai/vibe/install.sh | bash (or uv tool install --python 3.14 mistral-vibe)",
  login: "run `vibe` and sign in in the browser (or vibe --setup), with the Mistral Vibe Pro account",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  loginCheck() {
    if (process.env.MISTRAL_API_KEY) return { status: "pass", reason: "MISTRAL_API_KEY set (not printed)" };
    return loginFile(path.join(os.homedir(), ".vibe", ".env"), "Vibe key file", "run vibe and sign in, or vibe --setup");
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    return cmd.slice(0, 2).some((x) => ["vibe", "vibe-rs", "vibe-app-server", "vibe-acp"].includes(base(x)));
  },
  preflight() {
    return [];
  },

  models: { default: "mistral-large-4-0" },
  siteModelId,
  sameModel: (rec, exp) => siteModelId(rec) === siteModelId(exp),
  // "default" passes no --thinking
  efforts: { default: "default", values: ["default", "off", "low", "medium", "high", "xhigh", "max"] },

  plans: [{ plan: "Mistral Vibe Pro" }],

  command({ dir, prompt, model, effort, logDir, taskId }) {
    const args = ["-p", prompt, "--workdir", dir, "--model", model, "--approval-policy", "accept-edits", "--output-dir", path.join(logDir, `${taskId}.vibe`)];
    if (effort && effort !== "default") args.push("--thinking", effort);
    return { args, env: {}, cwd: dir };
  },
  parseUsage({ logDir, taskId, model }) {
    const f = path.join(logDir, `${taskId}.vibe`, "export.json");
    let usage = [];
    try {
      usage = usageFromExport(fs.readFileSync(f, "utf8"), model);
    } catch {}
    return { usage, tokenSource: usage.length ? "per-task" : "none" };
  },

  meter: {
    unit: "% of the monthly Vibe budget",
    windows: { monthly: { perMonth: 1 } },
    window: "monthly",
    note: "Mistral Vibe Pro: one monthly budget shown as % used; the subsidy uses 100 × monthly $/pp.",
    manual: {
      where: "the % used in console Code > CLI > View organization usage, or the usage gauge in the `vibe` footer",
      url: "https://console.mistral.ai",
      allowLeft: false,
    },
    auto: {
      route: "GET api.mistral.ai/v1/billing/budget with $MISTRAL_API_KEY (undocumented)",
      async read({ timeoutMs }) {
        const j = await fetchBudget({ timeoutMs });
        return { ...readingFromBudget(j), fields: Object.keys(j || {}) };
      },
    },
  },
  pacing: { targetPp: 5, maxPct: 85, every: 5 },
  typical: { minutes: "1–3 h (unverified)", meter: "+5 pp of the monthly budget" },
};
