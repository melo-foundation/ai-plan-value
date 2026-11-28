/**
 * Harness adapters. One file per harness; register it in ADAPTERS below and in kits/harness/kit.json.
 *
 * Adapter shape (every field is used by scripts/harness-quota.mjs; see gemini.mjs and grok.mjs):
 *
 *   id            "gemini"                         --harness value
 *   name          "Gemini CLI"
 *   bin           "gemini"                         default binary; --bin <path> overrides
 *   install       "npm install -g @google/gemini-cli"
 *   login         "gemini (choose Sign in with Google)"
 *   version(bin)  → version string | null          run the binary's version command
 *   procMatch(argv[]) → bool                       other running copies (warned about, --force to ignore)
 *   preflight({ bin, a }) → [warning strings]      sandbox availability etc.; empty = ok
 *
 *   models        { default, list?: [ids] }        harness model ids; --model overrides
 *   siteModelId(model) → combined.json baseModelId
 *   sameModel(recorded, expected) → bool           for the model_mismatch flag
 *   efforts       null | { default, values[] }     reasoning effort, when the harness takes one
 *
 *   plans         [{ plan: "Google AI Pro" }]      exact combined.json / billing-periods.mjs plan names
 *   planFromMeter(text) → plan | null              optional: map a tier name the auto meter returns
 *
 *   command({ dir, prompt, model, effort, logDir, taskId }) → { args[], env{}, stdin?: string }
 *                                                  headless run of one prompt in `dir`, writes
 *                                                  limited to `dir` by the harness's sandbox flags
 *   parseUsage({ stdout, logDir, taskId, model }) → { usage: [{ model, uncached, cached, cacheWrite,
 *                                                  output (incl. reasoning), reasoning, calls }],
 *                                                  tokenSource: "per-call" | "per-task" | "none",
 *                                                  incomplete?: bool }
 *
 *   meter: {
 *     unit        "% of daily requests for the model"
 *     windows     { daily: { perMonth: 30 } }      window id → windows per month for the subsidy
 *     window      default window id
 *     note        sentence copied into the result (e.g. the daily × 30 conversion)
 *     manual: {
 *       where     "/stats model in an interactive gemini session"   shown when asking
 *       url       dashboard URL or null
 *       allowLeft true when the screen shows % left
 *     }
 *     auto: null | {
 *       route     "retrieveUserQuota (undocumented)"  recorded in the result
 *       read({ bin, model, dir, timeoutMs }) → { pct, resetsAt (s) | null, periodType?, plan?, extraUsed? }
 *                 throws Error with a one-line reason; the kit then falls back to manual
 *     }
 *   }
 *   pacing        { targetPp, maxPct, every }      defaults for --target-pp, --max-pct, --every
 *   typical       { minutes: "1–3 h", meter: "+25 pp of one day" }   README / dry-run text
 *
 * Optional (muse.mjs, cursor.mjs, devin.mjs):
 *   plans[i]      { plan, usd, notOnSite: true, source }  plan not on the site yet: fee from here
 *   inputs        [{ key, values? | type: "number", required? }]  extra --<key> flags; recorded in
 *                 the result as inputs; passed to command() and meter.manual.ask()
 *   meter.windowFor(plan) → window id               per-plan default window
 *   meter.manual.ask(io, label, { plan, inputs }) → { pct, extraUsed? } | { skip } | { stop }
 *                                                  custom manual prompt (e.g. dashboard $ → %)
 *   bin: null, version(null, a), runTask({ task, dir, io, timeoutMs, a, … }) → { exit, acus?,
 *                 usage?, tokenSource?, stderr? } | { stop }, describeTask({ dir, a }) → string
 *                                                  cloud harness: the adapter runs each task
 *   costUnit      "acu"                            no tokens: fit ACUs per pp instead of API $
 */

import gemini from "./gemini.mjs";
import grok from "./grok.mjs";
import factory from "./factory.mjs";
import kimi from "./kimi.mjs";
import qwen from "./qwen.mjs";
import mistral from "./mistral.mjs";

export const ADAPTERS = { [gemini.id]: gemini, [grok.id]: grok };
for (const a of [factory, kimi, qwen, mistral]) ADAPTERS[a.id] = a;

export function getAdapter(id) {
  const a = ADAPTERS[String(id || "").toLowerCase()];
  if (!a) throw new Error(`--harness ${Object.keys(ADAPTERS).join(" | ")}`);
  return a;
}

// Muse Code, Cursor CLI, Devin
import muse from "./muse.mjs";
import cursor from "./cursor.mjs";
import devin from "./devin.mjs";
Object.assign(ADAPTERS, { [muse.id]: muse, [cursor.id]: cursor, [devin.id]: devin });
