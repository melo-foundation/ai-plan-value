/**
 * Devin adapter (Devin Pro, Devin Max): cloud sessions, ACUs per task. No local binary.
 *
 * Two ways to run a task:
 *   paste (default)  the kit prints the task (prompt with the starter files inlined); the user
 *                    runs it in a new Devin session and types the session's ACUs.
 *   --devin-api      the kit starts each session through the v3 API with DEVIN_API_KEY (a cog_
 *                    personal access token or service-user key) and DEVIN_ORG_ID, polls it until
 *                    it stops, and reads acus_consumed. The key is sent only in the
 *                    Authorization header; it is never printed or written.
 *
 * No token counts reach the kit (the session API has none), so the result is ACUs per task and
 * ACUs per meter point, and $ at --acu-usd when given, not an API-$ subsidy (costUnit "acu").
 *
 * Sources (docs.devin.ai, read 2026-11-28):
 *   plans:     https://docs.devin.ai/admin/billing/self-serve.md (Pro $20: daily and weekly quota;
 *              Max $200: weekly quota, no daily cap; both cover Devin sessions, Devin CLI and
 *              Devin Desktop; usage at app.devin.ai/settings/usage). No ACU price for Pro or Max.
 *   API:       https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md
 *              (POST /v3/organizations/{org_id}/sessions { prompt, title, tags, max_acu_limit … };
 *              a PAT with UseDevinSessions works), .../get-organizations-session.md
 *              (GET …/sessions/{devin_id}: status new|claimed|running|exit|error|suspended|resuming,
 *              status_detail, acus_consumed), https://docs.devin.ai/api-reference/personal-access-tokens.md
 *              (cog_ prefix; Settings > Devin API > PATs). Server base not given in the v3 spec;
 *              https://api.devin.ai is assumed (DEVIN_API_BASE overrides).
 * Unverified: PATs and an org id on individual Pro / Max accounts; which status_detail values mean
 * the task is done; where a session's ACUs show in the web app.
 */

import { redact, sleep } from "../lib/util.mjs";

const PLANS = ["Devin Pro", "Devin Max"];
const DONE_STATUS = new Set(["exit", "error", "suspended"]);
const DONE_DETAIL = /finished|waiting_for_user|blocked|stopped|completed/i;
const ACU_RE = /^(\d{1,6}(?:[.,]\d{1,4})?)\s*(?:acus?)?$/i;

/** Task prompt for a cloud session: the starter files inlined ahead of the kit's prompt. */
export function cloudPrompt(task) {
  const files = Object.entries(task.files || {});
  if (!files.length) return task.prompt;
  const blocks = files.map(([p, c]) => `--- ${p} ---\n${c}${String(c).endsWith("\n") ? "" : "\n"}--- end ${p} ---`);
  return `Create these files in an empty folder first, exactly as given:\n\n${blocks.join("\n\n")}\n\nThen, in that folder:\n${task.prompt}`;
}

/** One typed ACU reading: "3.5", "3.5 ACUs", "fail 2" (task failed). */
export function parseAcus(text) {
  const s = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "skip") return { skip: true };
  if (s === "stop" || s === "q" || s === "quit") return { stop: true };
  const failed = s.startsWith("fail");
  const m = s.replace(/^fail(ed)?\s*/, "").match(ACU_RE);
  if (!m) return { error: `not an ACU count: type the session's ACUs, e.g. 2.5 (or "fail 2.5", "skip", "stop")` };
  return { acus: Number(m[1].replace(",", ".")), failed };
}

const apiBase = () => (process.env.DEVIN_API_BASE || "https://api.devin.ai").replace(/\/$/, "");

/** Fetch JSON from the Devin API; errors carry the status and no credential. */
async function devinFetch(pathname, { method = "GET", body = null, timeoutMs = 60000 } = {}) {
  const key = process.env.DEVIN_API_KEY;
  if (!key) throw new Error("DEVIN_API_KEY is not set");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(apiBase() + pathname, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`Devin API ${method} ${pathname.replace(/\/sessions\/.*/, "/sessions/…")}: HTTP ${res.status} ${redact(text.slice(0, 160)).replace(/\s+/g, " ")}`);
    return JSON.parse(text);
  } catch (e) {
    throw new Error(redact(e.name === "AbortError" ? `Devin API ${method}: timed out` : e.message));
  } finally {
    clearTimeout(timer);
  }
}

/** Start one session, poll until it stops, return { exit, acus, status }. */
export async function runViaApi({ prompt, title, timeoutMs, isInterrupted = () => false, pollMs = Number(process.env.DEVIN_POLL_S || 20) * 1000 }) {
  const org = encodeURIComponent(process.env.DEVIN_ORG_ID || "");
  const created = await devinFetch(`/v3/organizations/${org}/sessions`, { method: "POST", body: { prompt, title, tags: ["harness-quota"] } });
  const id = encodeURIComponent(created.session_id);
  const t0 = Date.now();
  let s = created;
  while (!(DONE_STATUS.has(s.status) || (s.status_detail && DONE_DETAIL.test(s.status_detail)))) {
    if (Date.now() - t0 > timeoutMs) return { exit: "timeout", acus: Number.isFinite(s.acus_consumed) ? s.acus_consumed : null, status: s.status };
    if (isInterrupted()) return { exit: "interrupted", acus: Number.isFinite(s.acus_consumed) ? s.acus_consumed : null, status: s.status };
    await sleep(pollMs);
    s = await devinFetch(`/v3/organizations/${org}/sessions/${id}`);
  }
  return { exit: s.status === "error" ? 1 : 0, acus: Number.isFinite(s.acus_consumed) ? s.acus_consumed : null, status: s.status_detail ? `${s.status}/${s.status_detail}` : s.status };
}

export default {
  id: "devin",
  name: "Devin",
  bin: null,
  install: "paste mode needs nothing; for --devin-api set DEVIN_API_KEY (cog_…) and DEVIN_ORG_ID (org-…)",
  login: "app.devin.ai with the Devin Pro / Max account",
  version(bin, a = {}) {
    if (a["devin-api"]) return process.env.DEVIN_API_KEY && process.env.DEVIN_ORG_ID ? "cloud (v3 API)" : null;
    return "cloud (paste)";
  },
  procMatch: () => false,
  preflight({ a }) {
    const w = [];
    if (a["devin-api"] && !/^org-/.test(process.env.DEVIN_ORG_ID || "")) w.push("DEVIN_ORG_ID must be the organization id (org-…)");
    return w;
  },

  // label for the site comparison only; Devin picks the model server-side
  models: { default: "claude-sonnet-5.5" },
  siteModelId: (m) => String(m).toLowerCase().replace(/\./g, "-"),
  sameModel: () => true,
  efforts: null,
  inputs: [{ key: "acu-usd", type: "number", required: false }],
  costUnit: "acu",
  workloadNote: "cloud sessions: starter files inlined in the prompt",

  plans: PLANS.map((plan) => ({ plan })),

  describeTask({ a }) {
    return a["devin-api"] ? `POST ${apiBase()}/v3/organizations/$DEVIN_ORG_ID/sessions { prompt } · poll until it stops · read acus_consumed` : "print the prompt (starter files inlined) · you run it in a new Devin session · type its ACUs";
  },

  async runTask({ task, io, timeoutMs, a, isInterrupted }) {
    const prompt = cloudPrompt(task);
    if (a["devin-api"]) {
      try {
        const r = await runViaApi({ prompt, title: `harness-quota ${task.id}`, timeoutMs, isInterrupted });
        return { exit: r.exit, acus: r.acus, usage: [], tokenSource: "none", stderr: r.exit === 0 ? "" : `session ${r.status}` };
      } catch (e) {
        return { exit: 1, acus: null, usage: [], tokenSource: "none", stderr: redact(e.message) };
      }
    }
    process.stdout.write(`\n==== task ${task.id}: paste everything between the lines into a new Devin session ====\n${prompt}\n==== end of task ${task.id} ====\n`);
    for (let tries = 0; tries < 20; tries++) {
      const line = await io.ask(`task ${task.id} · when the session stops, the session's ACUs used: `);
      if (line == null) return { stop: true };
      const r = parseAcus(line);
      if (r.stop) return { stop: true };
      if (r.skip) return { exit: 0, acus: null, usage: [], tokenSource: "none" };
      if (!r.error) return { exit: r.failed ? 1 : 0, acus: r.acus, usage: [], tokenSource: "none" };
      process.stdout.write(`  ${r.error}\n`);
    }
    return { stop: true };
  },

  meter: {
    unit: "% of the plan's daily (Pro) or weekly quota",
    windows: { daily: { perMonth: 30 }, weekly: { perMonth: 4 } },
    window: "weekly",
    windowFor: (plan) => (plan === "Devin Pro" ? "daily" : "weekly"),
    note: "Devin reports no tokens: the result is ACUs per task and per meter point, and $ at --acu-usd, not an API-$ subsidy. Pro uses the daily quota (× 30), Max the weekly (× 4).",
    manual: {
      where: "the quota % at app.devin.ai/settings/usage",
      url: "https://app.devin.ai/settings/usage",
      allowLeft: true,
    },
    auto: null,
  },
  pacing: { targetPp: 10, maxPct: 85, every: 5 },
  typical: { minutes: "2–5 h (unverified)", meter: "+10 pp of one day (Pro) or week (Max) (unverified)" },
};
