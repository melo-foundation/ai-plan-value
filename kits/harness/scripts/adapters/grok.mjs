/**
 * Grok Build adapter (`grok`; SuperGrok, X plans).
 *
 * Sources (xai-org/grok-build, main; docs.x.ai):
 *   install / login: README (curl -fsSL https://x.ai/cli/install.sh | bash; grok login,
 *              grok login --device-auth), user guide 02-authentication.md (~/.grok/auth.json)
 *   headless:  user guide 14-headless-mode.md, https://docs.x.ai/build/cli/headless-scripting.md
 *              (-p/--single, --cwd, -m, --reasoning-effort, --permission-mode, --sandbox,
 *              --output-format json, --no-auto-update; exit 0 / 1 / 130 / 143). stdin is not read.
 *   tokens:    JSON `usage` { input_tokens (uncached only), cache_read_input_tokens,
 *              cache_creation_input_tokens, output_tokens, reasoning_tokens, total_tokens },
 *              `modelUsage.<model>` { inputTokens, outputTokens, cacheReadInputTokens,
 *              modelCalls }, `usage_is_incomplete`. total_tokens = input + cache_read +
 *              cache_creation + output, so output_tokens is taken to include reasoning.
 *   sandbox:   user guide 18-sandbox.md: `strict` writes only the working dir,
 *              ~/.grok/sessions and temp dirs; Landlock on Linux (bubblewrap for read-deny),
 *              Seatbelt on macOS.
 *   meter:     grok.com Settings > Usage, one weekly pool across Grok products
 *              (https://docs.x.ai/grok/faq, https://docs.x.ai/x-subscription/usage-limits.md).
 *              --auto-meter asks the CLI itself: `grok agent stdio` (ACP, JSON-RPC 2.0 over
 *              stdio) handles the extension method x.ai/billing
 *              (crates/codegen/xai-grok-shell/src/extensions/billing.rs), which calls the
 *              undocumented GET cli-chat-proxy.grok.com/v1/billing?format=credits with the CLI's
 *              stored login and returns { config: { creditUsagePercent, currentPeriod { type,
 *              start, end }, onDemandUsed, prepaidBalance, … }, subscription_tier }. The kit
 *              never opens ~/.grok/auth.json.
 */

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { dotsToHyphens, loginFile, splitJsonStream, versionOf, whichBin } from "../lib/util.mjs";

const PLANS = ["SuperGrok Lite", "SuperGrok", "SuperGrok Plus", "SuperGrok Heavy", "X Plus", "X Ultra", "SuperGrok Lite, legacy", "SuperGrok, legacy", "SuperGrok Plus, legacy", "SuperGrok Heavy, legacy"];

/** usage records from `grok -p … --output-format json` stdout. */
export function usageFromJson(stdout) {
  const vals = splitJsonStream(stdout).values.filter((v) => v && !Array.isArray(v) && (v.usage || v.modelUsage || v.usage_is_incomplete != null));
  const j = vals[vals.length - 1];
  if (!j) return { usage: [], incomplete: false };
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const u = j.usage || {};
  const models = Object.entries(j.modelUsage || {});
  const incomplete = j.usage_is_incomplete === true;
  if (models.length <= 1) {
    const [model, mu] = models[0] || [null, {}];
    if (!j.usage && !models.length) return { usage: [], incomplete };
    return {
      usage: [{ model: model ?? j.model ?? null, uncached: n(u.input_tokens ?? mu.inputTokens), cached: n(u.cache_read_input_tokens ?? mu.cacheReadInputTokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens ?? mu.outputTokens), reasoning: n(u.reasoning_tokens), calls: n(mu.modelCalls) || n(j.num_turns) || 1 }],
      incomplete,
    };
  }
  const usage = models.map(([model, mu], i) => ({ model, uncached: n(mu.inputTokens), cached: n(mu.cacheReadInputTokens), cacheWrite: i === 0 ? n(u.cache_creation_input_tokens) : 0, output: n(mu.outputTokens), reasoning: 0, calls: n(mu.modelCalls) || 1 }));
  return { usage, incomplete };
}

/** Billing response (x.ai/billing result) → meter reading. Throws when it has no percentage. */
export function readingFromBilling(res) {
  const c = res?.config;
  if (!c) throw new Error("billing response has no config");
  let pct = Number.isFinite(c.creditUsagePercent) ? c.creditUsagePercent : null;
  if (pct == null && Number.isFinite(c.used?.val) && c.monthlyLimit?.val > 0) pct = (100 * c.used.val) / c.monthlyLimit.val;
  if (pct == null) {
    // proto3 JSON drops zero values: a config with a period but no percentage means 0 %
    if (c.currentPeriod) pct = 0;
    else throw new Error("billing response has no creditUsagePercent");
  }
  const type = String(c.currentPeriod?.type || "");
  const periodType = /WEEK/i.test(type) ? "weekly" : /MONTH/i.test(type) ? "monthly" : null;
  const end = c.currentPeriod?.end || c.billingPeriodEnd || null;
  const resetsAt = end ? Math.floor(Date.parse(end) / 1000) : null;
  const extraUsed = (c.onDemandUsed?.val ?? 0) - (c.prepaidBalance?.val ?? 0);
  const plan = planFromMeter(res.subscription_tier);
  return { pct, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, periodType, extraUsed, plan };
}

export function planFromMeter(tier) {
  if (!tier) return null;
  const t = String(tier).trim().toLowerCase();
  return PLANS.find((p) => p.toLowerCase() === t) || null;
}

/**
 * Ask `grok agent stdio` for x.ai/billing over JSON-RPC. The CLI makes the HTTP call with its own
 * login. Resolves with the billing result; rejects with a one-line reason.
 */
export function billingViaAgent({ bin, timeoutMs = 60000, dir = process.cwd() }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["agent", "stdio"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let settled = false;
    const methods = ["_x.ai/billing", "x.ai/billing"];
    let mi = 0;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      child.kill("SIGTERM"); // own child only
      err ? reject(err) : resolve(val);
    };
    const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    const timer = setTimeout(() => finish(new Error("grok agent stdio: no billing answer before the timeout")), timeoutMs);
    child.on("error", (e) => finish(new Error(`cannot start ${bin} agent stdio: ${e.code || e.message}`)));
    child.stdin.on("error", () => {});
    child.on("close", (code) => finish(new Error(`grok agent stdio exited (${code}) before answering`)));
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.method) continue; // requests and notifications from the agent
        if (m.id === 1) {
          if (m.error) return finish(new Error(`initialize failed: ${m.error.message || m.error.code}`));
          send({ id: 2, method: methods[mi], params: {} });
        } else if (m.id === 2 || m.id === 3) {
          if (m.error) {
            if (m.error.code === -32601 && mi === 0) {
              mi = 1;
              send({ id: 3, method: methods[mi], params: {} });
              continue;
            }
            const msg = String(m.error.data || m.error.message || m.error.code).split("\n")[0].slice(0, 160);
            return finish(new Error(`x.ai/billing: ${msg}`));
          }
          finish(null, m.result);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
  });
}

export default {
  id: "grok",
  name: "Grok Build",
  bin: "grok",
  install: "curl -fsSL https://x.ai/cli/install.sh | bash",
  login: "grok login (grok login --device-auth over SSH), with the SuperGrok / X account",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  loginCheck() {
    return loginFile(path.join(os.homedir(), ".grok", "auth.json"), "Grok login file", "run grok login");
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    return cmd.slice(0, 2).some((x) => ["grok", "xai-grok-pager"].includes(base(x)));
  },
  preflight() {
    const w = [];
    if (process.platform === "linux" && !whichBin("bwrap")) w.push("bubblewrap (bwrap) not found: install it for the strict sandbox (e.g. dnf install bubblewrap / apt install bubblewrap)");
    return w;
  },

  models: { default: "grok-4.7" },
  siteModelId: dotsToHyphens,
  sameModel: (rec, exp) => dotsToHyphens(rec) === dotsToHyphens(exp),
  efforts: { default: "medium", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },

  plans: PLANS.map((plan) => ({ plan })),
  planFromMeter,

  command({ dir, prompt, model, effort }) {
    const args = ["-p", prompt, "--cwd", dir, "-m", model, "--sandbox", "strict", "--permission-mode", "bypassPermissions", "--output-format", "json", "--no-auto-update"];
    if (effort) args.push("--reasoning-effort", effort);
    return { args, env: {}, cwd: dir };
  },
  parseUsage({ stdout }) {
    const { usage, incomplete } = usageFromJson(stdout);
    return { usage, tokenSource: usage.length ? "per-task" : "none", incomplete };
  },

  meter: {
    unit: "% of the weekly usage pool",
    windows: { weekly: { perMonth: 4 }, monthly: { perMonth: 1 } },
    window: "weekly",
    note: "One weekly pool across Grok, Grok Build and Cursor; the subsidy uses 100 × weekly $/pp × 4 weeks (site convention).",
    manual: {
      where: "the weekly usage % in grok.com Settings > Usage",
      url: "https://grok.com",
      allowLeft: true,
    },
    auto: {
      route: "grok agent stdio → x.ai/billing → cli-chat-proxy.grok.com/v1/billing (undocumented)",
      async read({ bin, dir, timeoutMs }) {
        const res = await billingViaAgent({ bin, dir, timeoutMs });
        return { ...readingFromBilling(res), fields: Object.keys(res || {}) };
      },
    },
  },
  pacing: { targetPp: 10, maxPct: 85, every: 5 },
  typical: { minutes: "1–3 h (unverified)", meter: "+10 pp of the weekly pool" },
};
