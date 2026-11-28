/**
 * Cursor adapter: the Cursor CLI (`agent`, older installs `cursor-agent`) on Cursor Pro, Pro+ and
 * Ultra. The site's rows for these plans price the Cursor Models pool on grok-4-6, monthly.
 *
 * Sources (cursor.com, read 2026-11-28):
 *   install:   https://cursor.com/docs/cli/headless (curl https://cursor.com/install -fsS | bash)
 *   flags:     https://cursor.com/docs/cli/reference/parameters (-p/--print, --output-format
 *              text|json|stream-json, --model, -f/--force, --sandbox enabled|disabled, --trust
 *              (headless only), --workspace <path>, --list-models, `agent login`, `agent status`)
 *   output:    https://cursor.com/docs/cli/reference/output-format (json: one object { type:
 *              "result", subtype, is_error, duration_ms, result, session_id, request_id } on
 *              success; nothing on failure). The docs list no token fields.
 *   tokens:    not documented. Forum reports show `usage` { inputTokens, outputTokens,
 *              cacheReadTokens, cacheWriteTokens } in the json result
 *              (forum.cursor.com/t/171923, /t/164471); a Cursor staff reply in /t/164471 says
 *              inputTokens counts only tokens neither read from nor written to cache and that
 *              cacheWriteTokens matches the dashboard. Per task (one turn); no model field.
 *   plans:     https://cursor.com/docs/account/pricing/legacy-cursor-plans (Pro $20, Pro+ $60,
 *              Ultra $200; two monthly pools, Cursor Models (Grok 4.7, 4.6, 4.5, Composer 2.5)
 *              and Other Models; on-demand usage beyond them; both reset with the billing cycle).
 *              The included $ per pool is not published.
 *   meter:     https://cursor.com/dashboard/spending ("real-time usage for both pools, remaining
 *              allowance, and any on-demand charges",
 *              https://cursor.com/help/models-and-usage/usage-limits). No documented API for
 *              individual plans (the Admin API is teams only), so the meter is typed by hand.
 */

import path from "node:path";
import { dotsToHyphens, splitJsonStream, versionOf } from "../lib/util.mjs";

const PLANS = ["Cursor Pro", "Cursor Pro+", "Cursor Ultra"];
const MONEY = /^\$?\s*(\d{1,7}(?:[.,]\d{1,4})?)\s*\$?$/;

/** usage from `agent -p --output-format json` stdout: the last result object's `usage`. */
export function usageFromJson(stdout, model = null) {
  const vals = splitJsonStream(stdout).values.filter((v) => v && !Array.isArray(v) && v.usage && typeof v.usage === "object");
  const j = vals[vals.length - 1];
  if (!j) return [];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const u = j.usage;
  return [{ model: j.model ?? model, uncached: n(u.inputTokens ?? u.input_tokens), cached: n(u.cacheReadTokens ?? u.cache_read_tokens), cacheWrite: n(u.cacheWriteTokens ?? u.cache_write_tokens), output: n(u.outputTokens ?? u.output_tokens), reasoning: n(u.reasoningTokens), calls: 1 }];
}

/** One typed dollar amount: "12.34", "$12.34", "12,34". Returns { usd } | { skip } | { stop } | { error }. */
export function parseDollars(text) {
  const s = String(text ?? "").trim().toLowerCase();
  if (s === "skip") return { skip: true };
  if (s === "stop" || s === "q" || s === "quit") return { stop: true };
  const m = s.match(MONEY);
  if (!m) return { error: `not a dollar amount: type it as on the dashboard, e.g. 12.34 (or "skip", "stop")` };
  return { usd: Number(m[1].replace(",", ".")) };
}

/** Dashboard $ → meter % of the plan's monthly included usage. */
export const pctOfIncluded = (usd, includedUsd) => Math.round(((100 * usd) / includedUsd) * 1e6) / 1e6;

async function askDollars(io, prompt) {
  for (let tries = 0; tries < 20; tries++) {
    const line = await io.ask(prompt);
    if (line == null) return { stop: true };
    const r = parseDollars(line);
    if (!r.error) return r;
    process.stdout.write(`  ${r.error}\n`);
  }
  return { stop: true };
}

export default {
  id: "cursor",
  name: "Cursor CLI",
  bin: "agent",
  install: "curl https://cursor.com/install -fsS | bash",
  login: "agent login, with the Cursor Pro / Pro+ / Ultra account (unset CURSOR_API_KEY)",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    // the CLI (any install name) and the Cursor editor, which draws on the same pools
    return cmd.join(" ").includes("cursor-agent") || cmd.slice(0, 1).some((x) => ["cursor", "Cursor"].includes(base(x)) || /Cursor\.app\/|cursor\.AppImage/i.test(x));
  },
  preflight() {
    const w = [];
    if (process.env.CURSOR_API_KEY) w.push("CURSOR_API_KEY is set: unset it so the CLI uses the plan's login");
    return w;
  },

  models: { default: "grok-4.6" },
  siteModelId: (m) => dotsToHyphens(m).replace(/-(thinking|fast|low|medium|high|xhigh|max)$/, ""),
  sameModel: (rec, exp) => rec === "unrecorded" || rec == null || dotsToHyphens(rec) === dotsToHyphens(exp),
  efforts: null,
  inputs: [{ key: "included-usd", type: "number", required: true }],

  plans: PLANS.map((plan) => ({ plan })),

  command({ dir, prompt, model }) {
    return { args: ["-p", "--output-format", "json", "--model", model, "--force", "--sandbox", "enabled", "--trust", "--workspace", dir, prompt], env: {}, cwd: dir };
  },
  parseUsage({ stdout, model }) {
    const usage = usageFromJson(stdout, model);
    return { usage, tokenSource: usage.length ? "per-task" : "none" };
  },

  meter: {
    unit: "% of the plan's monthly included usage ($ used ÷ --included-usd)",
    windows: { monthly: { perMonth: 1 } },
    window: "monthly",
    note: "Cursor Pro / Pro+ / Ultra meter in $ of included usage per month; the kit converts the dashboard $ to % of --included-usd. Usage the dashboard allows past the included $ (the unstated bonus) is not counted, so the monthly API value is for the included $ only.",
    manual: {
      where: "cursor.com/dashboard/spending: included usage used, $",
      url: "https://cursor.com/dashboard/spending",
      allowLeft: false,
      /** Ask the dashboard's included-usage $ and the on-demand $; return % of --included-usd. */
      async ask(io, label, { inputs }) {
        const inc = await askDollars(io, `${label} · cursor.com/dashboard/spending, included usage $ used: `);
        if (inc.stop || inc.skip) return inc;
        const od = await askDollars(io, `  on-demand line (0 if none), $ used: `);
        if (od.stop) return od;
        return { pct: pctOfIncluded(inc.usd, inputs["included-usd"]), extraUsed: od.skip ? null : od.usd };
      },
    },
    auto: null,
  },
  pacing: { targetPp: 10, maxPct: 85, every: 5 },
  typical: { minutes: "1–3 h (unverified)", meter: "+10 pp of the month's included usage (unverified)" },
};
