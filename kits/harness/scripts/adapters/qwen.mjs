/**
 * Qwen Code adapter (`qwen`; 阿里云百炼 Token Plan Lite / Essential / Standard / Pro, Qwen Token Plan
 * Standard).
 *
 * Sources (QwenLM/qwen-code main, 0.28.7; modelstudioai/cli main; help.aliyun.com; 2026-11-28):
 *   install:   README.md (npm install -g @qwen-code/qwen-code@latest, Node 22+; brew install
 *              qwen-code). Version: qwen --version.
 *   login:     docs/users/configuration/auth.md: /auth > Alibaba ModelStudio > Token Plan (China
 *              (Beijing) or Singapore), or OPENAI_API_KEY + OPENAI_BASE_URL
 *              (https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1; intl
 *              https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1) + OPENAI_MODEL;
 *              help.aliyun.com/zh/model-studio/qwen-code (BAILIAN_TOKEN_PLAN_API_KEY via
 *              settings.json modelProviders envKey). The kit reads none of these.
 *   headless:  docs/users/features/headless.md: -p, -m, --approval-mode yolo, -o json (an array of
 *              messages; stats on the last). Exit codes (packages/core/src/utils/errors.ts): 41 auth,
 *              42 input, 44 sandbox, 52 config, 53 turn limit, 54 tool, 55 budget, 130 SIGINT.
 *   sandbox:   docs/users/features/sandbox.md: --sandbox with QWEN_SANDBOX=docker|podman|sandbox-exec
 *              (the env var wins); Seatbelt permissive-open blocks writes outside the project
 *              folder; Docker / Podman mount the workspace and ~/.qwen only.
 *   telemetry: docs/developers/development/telemetry.md: QWEN_TELEMETRY_ENABLED, QWEN_TELEMETRY_OUTFILE
 *              (overrides OTLP), QWEN_TELEMETRY_LOG_PROMPTS; event qwen-code.api_response
 *              (packages/core/src/telemetry/constants.ts) with input_token_count, output_token_count,
 *              cached_content_token_count, thoughts_token_count.
 *   tokens:    packages/core/src/core/openaiContentGenerator/converter.ts: promptTokenCount =
 *              prompt_tokens (includes cached), candidatesTokenCount = completion_tokens, thoughts
 *              capped at completion_tokens, so thoughts are inside output (not added). JSON stats:
 *              packages/core/src/telemetry/uiTelemetry.ts stats.models.<m>.tokens { prompt,
 *              candidates, cached, thoughts, total }, api.totalRequests; no tool field.
 *   meter:     `bl usage token-plan --output json` (modelstudioai/cli
 *              packages/commands/src/commands/usage/token-plan.ts; needs `bl auth login --console`):
 *              passes through per5HourPercentage / per1WeekPercentage / per1MonthPercentage (0–1)
 *              and *ResetTime. Parsed with the API plan kit's parseBailian. Qwen Code's own /stats
 *              shows local token counts only.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseBailian } from "../../../api-plan/scripts/adapters.mjs";
import { dotsToHyphens, redact, splitJsonStream, versionOf, whichBin } from "../lib/util.mjs";

const SANDBOXES = ["docker", "podman", "sandbox-exec"];
const PLANS = ["阿里云百炼 Token Plan Lite (¥39)", "阿里云百炼 Token Plan Essential (¥79)", "阿里云百炼 Token Plan Standard (¥139)", "阿里云百炼 Token Plan Pro (¥312)", "Qwen Token Plan Standard"];
export const BL_ARGS = ["usage", "token-plan", "--output", "json"];

export function sandboxKind(a = {}) {
  const want = typeof a["qwen-sandbox"] === "string" ? a["qwen-sandbox"] : process.env.QWEN_SANDBOX;
  if (want && want !== "true") return SANDBOXES.includes(want) ? want : null;
  if (process.platform === "darwin") return "sandbox-exec";
  if (whichBin("docker")) return "docker";
  if (whichBin("podman")) return "podman";
  return null;
}

/** "qwen3.8-max" → "qwen-3-8-max" (site id); "qwen4-max", "glm-5.3", "deepseek-v4.1-flash-1017" keep their shape. */
export function siteModelId(m) {
  return dotsToHyphens(m).replace(/^qwen(\d+)-(\d+)-/, "qwen-$1-$2-");
}

/** usage records from a telemetry outfile: one per qwen-code.api_response event. */
export function usageFromTelemetry(text) {
  const out = [];
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    const at = o.attributes && typeof o.attributes === "object" ? o.attributes : null;
    if (at && (at["event.name"] === "qwen-code.api_response" || at["event.name"] === "api_response") && at.input_token_count != null) {
      const n = (k) => (Number.isFinite(Number(at[k])) ? Number(at[k]) : 0);
      const input = n("input_token_count");
      const cached = Math.min(n("cached_content_token_count"), input);
      out.push({ model: at.model ?? null, uncached: input - cached, cached, cacheWrite: 0, output: n("output_token_count"), reasoning: n("thoughts_token_count"), calls: 1 });
      return;
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) if (v && typeof v === "object") visit(v);
  };
  for (const v of splitJsonStream(text).values) visit(v);
  return out;
}

/** usage records from `-o json` stdout (array of messages; stats on the last one that has them). */
export function usageFromJson(stdout) {
  const flat = splitJsonStream(stdout).values.flatMap((v) => (Array.isArray(v) ? v : [v]));
  const last = flat.filter((v) => v && v.stats?.models).pop();
  if (!last) return [];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return Object.entries(last.stats.models).map(([model, mm]) => {
    const t = mm.tokens || {};
    const prompt = n(t.prompt);
    const cached = Math.min(n(t.cached), prompt);
    return { model, uncached: prompt - cached, cached, cacheWrite: 0, output: n(t.candidates), reasoning: n(t.thoughts), calls: n(mm.api?.totalRequests) || 1 };
  });
}

/** `bl usage token-plan --output json` → reading for `window` (monthly, weekly, 5h). */
export function readingFromBl(json, window = "monthly") {
  const { windows } = parseBailian(json);
  const w = windows[window];
  if (!w) throw new Error(`bl usage token-plan has no ${window} window (has: ${Object.keys(windows).join(", ") || "none"})`);
  return { pct: Math.round(w.used * 1e6) / 1e6, resetsAt: w.resetsAt ?? null, periodType: window };
}

export function runBl({ blBin = "bl", timeoutMs = 60000 }) {
  const r = spawnSync(blBin, BL_ARGS, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error?.code === "ENOENT") throw new Error(`${blBin} not found: npm install -g bailian-cli, then bl auth login --console, or pass --bl <path>`);
  if (r.status !== 0) throw new Error(`bl ${BL_ARGS.join(" ")} exited ${r.status ?? "on timeout"}: ${redact((r.stderr || "").trim().split("\n")[0] || "").slice(0, 160)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error("bl usage token-plan printed no JSON");
  }
}

export default {
  id: "qwen",
  name: "Qwen Code",
  bin: "qwen",
  install: "npm install -g @qwen-code/qwen-code@latest (Node 22+), plus Docker or Podman on Linux",
  login: "run `qwen`, /auth > Alibaba ModelStudio > Token Plan, with the Token Plan key",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    return cmd.slice(0, 2).some((x) => base(x) === "qwen") || cmd.join(" ").includes("@qwen-code/qwen-code/");
  },
  preflight({ a }) {
    const w = [];
    const sb = sandboxKind(a);
    if (!sb) w.push("no sandbox for Qwen Code: install Docker or Podman (Linux), or pass --qwen-sandbox docker|podman|sandbox-exec");
    else if (sb !== "sandbox-exec" && !whichBin(sb)) w.push(`${sb} not found on PATH`);
    return w;
  },
  sandboxKind,

  models: { default: "qwen4-max" },
  siteModelId,
  sameModel: (rec, exp) => siteModelId(rec) === siteModelId(exp),
  efforts: null,

  plans: PLANS.map((plan) => ({ plan })),

  command({ dir, prompt, model, logDir, taskId, a }) {
    return {
      args: ["-p", prompt, "-m", model, "--approval-mode", "yolo", "--sandbox", "--output-format", "json"],
      env: {
        QWEN_SANDBOX: sandboxKind(a) || "true",
        QWEN_TELEMETRY_ENABLED: "true",
        QWEN_TELEMETRY_OUTFILE: path.join(logDir, `${taskId}.telemetry.log`),
        QWEN_TELEMETRY_LOG_PROMPTS: "false",
      },
      cwd: dir,
    };
  },
  parseUsage({ stdout, logDir, taskId }) {
    const f = path.join(logDir, `${taskId}.telemetry.log`);
    try {
      const u = usageFromTelemetry(fs.readFileSync(f, "utf8"));
      if (u.length) return { usage: u, tokenSource: "per-call" };
    } catch {}
    const j = usageFromJson(stdout);
    return { usage: j, tokenSource: j.length ? "per-task" : "none" };
  },

  meter: {
    unit: "% of the monthly Token Plan quota",
    windows: { monthly: { perMonth: 1 }, weekly: { perMonth: 4 }, "5h": { perMonth: null } },
    window: "monthly",
    note: "Token Plan windows are 5-hour, 7-day and monthly; the subsidy uses 100 × monthly $/pp (or 7-day × 4).",
    manual: {
      where: "the monthly % in the Bailian console Token Plan page",
      url: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan",
      allowLeft: true,
    },
    auto: {
      route: "bl usage token-plan --output json (documented command, undocumented fields)",
      async read({ window, a = {}, timeoutMs }) {
        const blBin = typeof a.bl === "string" ? a.bl : "bl";
        return readingFromBl(runBl({ blBin, timeoutMs }), window || "monthly");
      },
    },
  },
  pacing: { targetPp: 2, maxPct: 85, every: 5 },
  typical: { minutes: "1–3 h (unverified)", meter: "+2 pp of the monthly quota" },
};
