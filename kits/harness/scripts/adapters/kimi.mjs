/**
 * Kimi Code adapter (`kimi`; Kimi Plus / Pro / Max / Ultra and the Moderato / Allegretto / Allegro
 * names).
 *
 * Sources (MoonshotAI/kimi-code main, 2026-11-28; the Python MoonshotAI/kimi-cli is archived):
 *   install:   docs/en/guides/getting-started.md (curl -fsSL https://code.kimi.com/kimi-code/install.sh
 *              | bash; npm install -g @moonshot-ai/kimi-code). Version: kimi --version.
 *   login:     docs/en/reference/kimi-command.md: `kimi login` (device code) or /login in the TUI;
 *              credentials in ~/.kimi-code/credentials/ (docs/en/configuration/data-locations.md);
 *              KIMI_CODE_HOME moves the data folder; KIMI_CODE_BASE_URL defaults to
 *              https://api.kimi.com/coding/v1.
 *   headless:  kimi-command.md, apps/kimi-code/src/cli/v2/run-v2-print.ts: kimi -p "<prompt>"
 *              --output-format stream-json [-m <alias>]; -p runs with `auto` permission and cannot
 *              take --yolo / --auto / --plan. Working dir = cwd. Exit 0 ok, 1 error, 4 session busy.
 *              Managed models are aliased kimi-code/<modelId> (packages/oauth/src/managed-kimi-code.ts).
 *   sandbox:   none found (permission modes manual / yolo / auto only,
 *              packages/agent-core-v2/src/agent/permissionPolicy/types.ts). Writes are not confined.
 *   tokens:    stream-json carries no usage (apps/kimi-code/src/cli/prompt-render.ts). It prints a
 *              meta line { role: "meta", type: "session.resume_hint", session_id }. The session's
 *              ~/.kimi-code/sessions/<workspaceId>/<sessionId>/agents/<agent>/wire.jsonl holds one
 *              { type: "context.append_loop_event", event: { type: "step.end", usage } } per model
 *              call and { type: "usage.record", model, usage, usageScope } per turn; usage =
 *              { inputOther, output, inputCacheRead, inputCacheCreation } (packages/core/src/llm/usage.ts).
 *   meter:     /usage (packages/oauth/src/managed-usage.ts): GET ${KIMI_CODE_BASE_URL}/usages with
 *              Authorization: Bearer <access token>; { usages: { limit_5h, limit_7d,
 *              limit_month_total, limit_month_code: { used_ratio, reset_time } } }. Undocumented;
 *              also in CodexBar docs/kimi.md (KIMI_CODE_API_KEY, or the CLI's
 *              ~/.kimi-code/credentials/kimi-code.json access token, read-only). --auto-meter uses
 *              $KIMI_CODE_API_KEY only (credential files are never opened); the key goes
 *              into the request header only and is never printed, logged or stored.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dotsToHyphens, loginFile, splitJsonStream, versionOf } from "../lib/util.mjs";

const PLANS = ["Kimi Plus", "Kimi Pro", "Kimi Max", "Kimi Ultra", "Kimi Moderato", "Kimi Allegretto", "Kimi Allegro", "Kimi Moderato, legacy", "Kimi Allegretto, legacy", "Kimi Allegro, legacy"];
const DEFAULT_BASE = "https://api.kimi.com/coding/v1";

export const kimiHome = () => process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const baseUrl = () => (process.env.KIMI_CODE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");

/** Session id from `kimi -p --output-format stream-json` stdout. */
export function sessionIdFrom(stdout) {
  const ids = splitJsonStream(stdout).values.filter((v) => v && v.role === "meta" && v.session_id).map((v) => String(v.session_id));
  return ids.pop() || null;
}

/** Every wire.jsonl of a session (main agent and subagents). */
export function wireFiles(sessionId, home = kimiHome()) {
  if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return [];
  const root = path.join(home, "sessions");
  const out = [];
  let ws = [];
  try {
    ws = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const w of ws) {
    const agents = path.join(root, w, sessionId, "agents");
    let names = [];
    try {
      names = fs.readdirSync(agents);
    } catch {
      continue;
    }
    for (const a of names) {
      const f = path.join(agents, a, "wire.jsonl");
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

/** usage records from wire.jsonl text: one per step.end; usage.record turns when no step has usage. */
export function usageFromWire(text, model = null) {
  const steps = [];
  const turns = [];
  let seenModel = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "usage.record") {
      if (r.model) seenModel = r.model;
      if (r.usageScope === "turn" && r.usage) turns.push({ u: r.usage, model: r.model });
    } else if (r.type === "context.append_loop_event" && r.event?.type === "step.end" && r.event.usage) steps.push({ u: r.event.usage, model: r.event.model });
  }
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const rec = ({ u, model: m }) => ({ model: m ?? seenModel ?? model ?? null, uncached: n(u.inputOther), cached: n(u.inputCacheRead), cacheWrite: n(u.inputCacheCreation), output: n(u.output), reasoning: 0, calls: 1 });
  return { usage: (steps.length ? steps : turns).map(rec), perCall: steps.length > 0 };
}

/** /usages response → reading for `window` (monthly = limit_month_total, weekly = limit_7d, 5h = limit_5h). */
export function readingFromUsages(json, window = "monthly") {
  const key = { monthly: "limit_month_total", weekly: "limit_7d", "5h": "limit_5h" }[window];
  const u = json?.usages;
  if (!u || typeof u !== "object" || Array.isArray(u)) throw new Error(`Kimi /usages: unexpected response (top-level keys: ${Object.keys(json || {}).slice(0, 8).join(", ") || "none"})`);
  const w = u[key];
  const ratio = Number(w?.used_ratio);
  if (!w || !Number.isFinite(ratio)) throw new Error(`Kimi /usages has no ${key} (has: ${Object.keys(u).join(", ") || "none"})`);
  const t = w.reset_time ? Date.parse(w.reset_time) : NaN;
  return { pct: Math.round(ratio * 100 * 1e6) / 1e6, resetsAt: Number.isFinite(t) ? Math.floor(t / 1000) : null, periodType: window };
}

/** Bearer token for /usages: $KIMI_CODE_API_KEY only. The kit never opens the CLI's credential files. Never logged. */
export function usagesToken() {
  if (process.env.KIMI_CODE_API_KEY) return process.env.KIMI_CODE_API_KEY;
  throw new Error("export KIMI_CODE_API_KEY for the automatic meter, or run without --auto-meter");
}

export async function fetchUsages({ timeoutMs = 30000 } = {}) {
  const token = usagesToken();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/usages`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: ctl.signal });
    if (res.status === 401 || res.status === 403) throw new Error(`Kimi /usages HTTP ${res.status}: run \`kimi login\`, or export KIMI_CODE_API_KEY`);
    if (!res.ok) throw new Error(`Kimi /usages HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error("Kimi /usages: body is not JSON");
    }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Kimi /usages: timed out");
    if (/^Kimi /.test(e.message)) throw e;
    throw new Error(`Kimi /usages: ${e.cause?.code || e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: "kimi",
  name: "Kimi Code",
  bin: "kimi",
  install: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash (or npm install -g @moonshot-ai/kimi-code)",
  login: "kimi login, with the Kimi membership account",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  loginCheck() {
    return loginFile(path.join(kimiHome(), "credentials"), "Kimi Code credentials folder", "run kimi login");
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    return cmd.slice(0, 2).some((x) => base(x) === "kimi") || cmd.join(" ").includes("@moonshot-ai/kimi-code/");
  },
  preflight() {
    return [];
  },

  models: { default: "kimi-k3" },
  siteModelId: dotsToHyphens,
  sameModel: (rec, exp) => dotsToHyphens(String(rec).replace(/^kimi-code\//, "")) === dotsToHyphens(String(exp).replace(/^kimi-code\//, "")),
  efforts: null,

  plans: PLANS.map((plan) => ({ plan })),

  command({ dir, prompt, model }) {
    return { args: ["-p", prompt, "--output-format", "stream-json", "-m", `kimi-code/${model}`], env: {}, cwd: dir };
  },
  parseUsage({ stdout, model }) {
    const sid = sessionIdFrom(stdout);
    const usage = [];
    let perCall = true;
    for (const f of wireFiles(sid)) {
      const r = usageFromWire(fs.readFileSync(f, "utf8"), model);
      usage.push(...r.usage);
      if (!r.perCall) perCall = false;
    }
    return { usage, tokenSource: usage.length ? (perCall ? "per-call" : "per-task") : "none" };
  },
  usageSources({ stdout }) {
    return wireFiles(sessionIdFrom(stdout));
  },

  meter: {
    unit: "% of the monthly total",
    windows: { monthly: { perMonth: 1 }, weekly: { perMonth: 5 }, "5h": { perMonth: null } },
    window: "monthly",
    fineWindow: "5h",
    note: "Kimi plans: rolling 5-hour window and a monthly pool (legacy plans: weekly); the subsidy uses 100 × monthly $/pp, or weekly × 5 on legacy plans (the API plan kit's convention).",
    manual: {
      where: "the Monthly limit % in `/usage` in an interactive `kimi` session",
      url: "https://www.kimi.com/membership/subscription?tab=quota",
      allowLeft: true,
    },
    auto: {
      route: "GET api.kimi.com/coding/v1/usages with $KIMI_CODE_API_KEY (undocumented)",
      async read({ window, timeoutMs }) {
        const j = await fetchUsages({ timeoutMs });
        return { ...readingFromUsages(j, window || "monthly"), fields: Object.keys(j || {}) };
      },
    },
  },
  pacing: { every: 5 },
};
