/**
 * Gemini CLI adapter (Google AI Pro, Google AI Ultra 5x / 20x).
 *
 * Sources (google-gemini/gemini-cli, main, 0.73.0-nightly 2026-11-23):
 *   headless:  docs/cli/headless.md (-p, --output-format json, exit codes 0 / 1 / 42 / 53)
 *   flags:     packages/cli/src/config/config.ts (-m, -p, --sandbox, --approval-mode, --skip-trust)
 *   sandbox:   docs/cli/sandbox.md (GEMINI_SANDBOX=docker|podman|sandbox-exec; Seatbelt
 *              permissive-open confines writes to the project folder)
 *   telemetry: docs/cli/telemetry.md (GEMINI_TELEMETRY_ENABLED / _TARGET=local / _OUTFILE /
 *              _LOG_PROMPTS; event gemini_cli.api_response with input_token_count,
 *              output_token_count, cached_content_token_count, thoughts_token_count,
 *              tool_token_count); packages/core/src/telemetry/file-exporters.ts writes
 *              pretty-printed JSON records back to back. The --telemetry-* flags are gone from
 *              config.ts in 0.73; the environment variables replace them.
 *   tokens:    packages/core/src/telemetry/types.ts: input_token_count = promptTokenCount
 *              (includes cachedContentTokenCount); output_token_count = candidatesTokenCount
 *              (excludes thoughtsTokenCount); tool_token_count = toolUsePromptTokenCount.
 *   meter:     /stats model (packages/cli/src/ui/commands/statsCommand.ts) is screen-only; in
 *              headless mode its output goes to a no-op UI (nonInteractiveCliCommands.ts).
 *              The data comes from Config.refreshUserQuota() (packages/core/src/config/config.ts)
 *              → CodeAssistServer.retrieveUserQuota (packages/core/src/code_assist/server.ts,
 *              POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota), response
 *              buckets[{ modelId, remainingFraction, remainingAmount, resetTime, tokenType }]
 *              (packages/core/src/code_assist/types.ts). --auto-meter runs that call through the
 *              installed CLI's own core package (gemini-quota-probe.mjs): the CLI's auth code
 *              loads the stored login; the kit never opens the credentials file.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dotsToHyphens, splitJsonStream, versionOf, whichBin } from "../lib/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROBE = path.join(here, "gemini-quota-probe.mjs");
const SANDBOXES = ["docker", "podman", "sandbox-exec"];

function sandboxKind(a = {}) {
  const want = typeof a["gemini-sandbox"] === "string" ? a["gemini-sandbox"] : process.env.GEMINI_SANDBOX;
  if (want && want !== "true") return SANDBOXES.includes(want) ? want : null;
  if (process.platform === "darwin") return "sandbox-exec";
  if (whichBin("docker")) return "docker";
  if (whichBin("podman")) return "podman";
  return null;
}

/** usage records from a telemetry outfile: one per gemini_cli.api_response event. */
export function usageFromTelemetry(text) {
  const out = [];
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    const at = o.attributes && typeof o.attributes === "object" ? o.attributes : null;
    if (at && (at["event.name"] === "gemini_cli.api_response" || at["event.name"] === "api_response") && at.input_token_count != null) {
      const n = (k) => (Number.isFinite(Number(at[k])) ? Number(at[k]) : 0);
      const input = n("input_token_count");
      const cached = Math.min(n("cached_content_token_count"), input);
      const thoughts = n("thoughts_token_count");
      out.push({ model: at.model ?? null, uncached: input - cached + n("tool_token_count"), cached, cacheWrite: 0, output: n("output_token_count") + thoughts, reasoning: thoughts, calls: 1 });
      return;
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) if (v && typeof v === "object") visit(v);
  };
  for (const v of splitJsonStream(text).values) visit(v);
  return out;
}

/** usage records from `--output-format json` stdout: one per model in stats.models. */
export function usageFromJson(stdout) {
  const vals = splitJsonStream(stdout).values.filter((v) => v && v.stats);
  const last = vals[vals.length - 1];
  if (!last) return [];
  const out = [];
  const nModels = Object.keys(last.stats.models || {}).length;
  for (const [model, mm] of Object.entries(last.stats.models || {})) {
    const t = mm.tokens || {};
    const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const prompt = n(t.prompt);
    const cached = Math.min(n(t.cached), prompt);
    const calls = n(mm.api?.totalRequests) || (nModels === 1 ? n(last.stats.api?.totalRequests) : 0) || 1;
    out.push({ model, uncached: prompt - cached + n(t.tool), cached, cacheWrite: 0, output: n(t.candidates) + n(t.thoughts), reasoning: n(t.thoughts), calls });
  }
  return out;
}

/** Gemini CLI installs: root folder of the @google/gemini-cli package that `bin` runs. */
export function cliPackageRoot(bin) {
  const p = whichBin(bin);
  if (!p) return null;
  let dir = path.dirname(fs.realpathSync(p));
  for (let i = 0; i < 8; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      try {
        if (JSON.parse(fs.readFileSync(pj, "utf8")).name === "@google/gemini-cli") return dir;
      } catch {}
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Run the quota probe as a child process; resolve with its parsed JSON or throw its reason. */
export function runProbe({ bin, model, dir, timeoutMs = 90000 }) {
  return new Promise((resolve, reject) => {
    const root = cliPackageRoot(bin);
    if (!root) return reject(new Error(`cannot find the @google/gemini-cli package behind ${bin}`));
    const child = spawn(process.execPath, [PROBE, "--cli-root", root, "--model", model, "--dir", dir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_BROWSER: "true", GEMINI_TELEMETRY_ENABLED: "false" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); // own child only
    child.on("close", (code) => {
      clearTimeout(timer);
      const last = out.trim().split("\n").filter(Boolean).pop();
      let j = null;
      try {
        j = JSON.parse(last || "null");
      } catch {}
      if (code === 0 && j?.ok) return resolve(j);
      reject(new Error(j?.error || (code == null ? "quota probe timed out" : `quota probe exit ${code}`)));
    });
  });
}

/** Pick the bucket for `model` from probe output → meter reading. */
export function readingFromBuckets(buckets, model) {
  const same = (b) => b.modelId && (b.modelId === model || dotsToHyphens(b.modelId) === dotsToHyphens(model));
  const mine = (buckets || []).filter(same);
  const b = mine.find((x) => !x.tokenType || /request/i.test(x.tokenType)) || mine[0];
  if (!b || !Number.isFinite(b.remainingFraction)) throw new Error(`no quota bucket for ${model} (buckets for: ${(buckets || []).map((x) => x.modelId).filter(Boolean).join(", ") || "none"})`);
  const resetsAt = b.resetTime ? Math.floor(Date.parse(b.resetTime) / 1000) : null;
  return { pct: Math.round((1 - b.remainingFraction) * 100 * 1e6) / 1e6, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, periodType: "daily" };
}

export default {
  id: "gemini",
  name: "Gemini CLI",
  bin: "gemini",
  install: "npm install -g @google/gemini-cli",
  login: "run `gemini`, choose Sign in with Google, use the Google AI Pro / Ultra account",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    return cmd.slice(0, 2).some((x) => base(x) === "gemini") || cmd.join(" ").includes("@google/gemini-cli/");
  },
  preflight({ a }) {
    const w = [];
    const sb = sandboxKind(a);
    if (!sb) w.push("no sandbox for Gemini CLI: install Docker or Podman (Linux), or pass --gemini-sandbox docker|podman|sandbox-exec");
    else if (sb !== "sandbox-exec" && !whichBin(sb)) w.push(`${sb} not found on PATH`);
    return w;
  },
  sandboxKind,

  models: { default: "gemini-3.8-flash" },
  siteModelId: dotsToHyphens,
  sameModel: (rec, exp) => dotsToHyphens(rec).replace(/-preview$/, "") === dotsToHyphens(exp).replace(/-preview$/, ""),
  efforts: null,

  plans: [{ plan: "Google AI Pro" }, { plan: "Google AI Ultra 5x" }, { plan: "Google AI Ultra 20x" }],

  command({ dir, prompt, model, logDir, taskId, a }) {
    return {
      args: ["-p", prompt, "-m", model, "--approval-mode", "yolo", "--sandbox", "--skip-trust", "--output-format", "json"],
      env: {
        GEMINI_SANDBOX: sandboxKind(a) || "true",
        GEMINI_TELEMETRY_ENABLED: "true",
        GEMINI_TELEMETRY_TARGET: "local",
        GEMINI_TELEMETRY_OUTFILE: path.join(logDir, `${taskId}.telemetry.log`),
        GEMINI_TELEMETRY_LOG_PROMPTS: "false",
      },
      cwd: dir,
    };
  },
  parseUsage({ stdout, logDir, taskId }) {
    const f = path.join(logDir, `${taskId}.telemetry.log`);
    if (fs.existsSync(f)) {
      const u = usageFromTelemetry(fs.readFileSync(f, "utf8"));
      if (u.length) return { usage: u, tokenSource: "per-call" };
    }
    const j = usageFromJson(stdout);
    return { usage: j, tokenSource: j.length ? "per-task" : "none" };
  },

  meter: {
    unit: "% of the model's daily requests",
    windows: { daily: { perMonth: 30 } },
    window: "daily",
    note: "Gemini CLI limits are requests per day per model; the subsidy uses 100 × daily $/pp × 30 days.",
    manual: {
      where: "the Usage % for the model in `/stats model` in an interactive `gemini` session",
      url: null,
      allowLeft: true,
    },
    auto: {
      route: "Code Assist retrieveUserQuota (undocumented)",
      async read({ bin, model, dir, timeoutMs }) {
        const j = await runProbe({ bin, model, dir, timeoutMs });
        return readingFromBuckets(j.buckets, model);
      },
    },
  },
  pacing: { targetPp: 25, maxPct: 85, every: 5 },
  typical: { minutes: "1–3 h (unverified)", meter: "+25 pp of one day's requests for the model" },
};
