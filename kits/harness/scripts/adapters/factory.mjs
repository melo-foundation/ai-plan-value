/**
 * Factory Droid adapter (`droid`; Droid Pro, Droid Max).
 *
 * Sources (docs.factory.com, mirrors docs.factory.ai; checked 2026-11-28):
 *   install / login: droid-cli/quickstart.md, droid-cli/cli-reference.md
 *              (curl -fsSL https://app.factory.ai/cli | sh; brew install --cask droid;
 *              npm install -g droid; browser sign-in on first launch or /login;
 *              FACTORY_API_KEY=fk-… for exec). Version: droid --version.
 *   headless:  droid-exec/overview.md: droid exec [options] [prompt]; --cwd, -m, -r,
 *              --auto low|medium|high, -o json|stream-json, --settings <path> ("merged for this run
 *              only"). Exit 0 = run completed; non-zero on a permission stop, bad flag or API error.
 *              --auto medium is the lowest level that runs builds and tests (autonomy-and-safety/
 *              auto-run.md); low allows edits and low-risk commands only.
 *   sandbox:   autonomy-and-safety/sandbox.md: { sandbox: { enabled: true, mode: "whole-process" } }
 *              in a settings file; the cwd is always writable, other paths only via
 *              sandbox.filesystem.allowWrite; bubblewrap + seccomp on Linux, Seatbelt on macOS;
 *              fails closed (whole-process: Droid refuses to start). The kit writes that settings
 *              file into the run's log folder and passes it with --settings.
 *   tokens:    -o json result: { type: "result", num_turns, session_id, usage: { input_tokens,
 *              output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
 *              factory_credits } }. Field meanings are undocumented; input_tokens is read as
 *              uncached (docs example: 4 input next to 13528 cache read). The result has no model
 *              field: the requested model is recorded. No documented local session log carries
 *              per-call tokens; the OTEL metrics list has no token counts.
 *   meter:     pricing/individuals.md: Standard Credits × model multiplier (models.md), three
 *              independent rolling windows 5-hour / 7-day / 30-day. /limits and /cost are
 *              interactive slash commands; no non-interactive meter command is documented (the
 *              analytics API needs an Enterprise org). Manual only.
 */

import fs from "node:fs";
import path from "node:path";
import { dotsToHyphens, splitJsonStream, versionOf, whichBin } from "../lib/util.mjs";

const PLANS = ["Droid Pro", "Droid Max"];
export const SETTINGS = { sandbox: { enabled: true, mode: "whole-process" }, hooksDisabled: true };

/** usage record from `droid exec -o json` stdout (the last `result` object). */
export function usageFromJson(stdout, model = null) {
  const vals = splitJsonStream(stdout).values.filter((v) => v && !Array.isArray(v) && v.usage && (v.type === "result" || v.type === "completion" || v.type == null));
  const j = vals[vals.length - 1];
  if (!j) return [];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const u = j.usage;
  const rec = { model: j.model ?? model ?? null, uncached: n(u.input_tokens), cached: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens), reasoning: n(u.reasoning_tokens), calls: n(j.num_turns) || 1 };
  if (u.factory_credits != null) rec.credits = n(u.factory_credits);
  return [rec];
}

export default {
  id: "factory",
  name: "Factory Droid",
  bin: "droid",
  install: "curl -fsSL https://app.factory.ai/cli | sh (or brew install --cask droid, npm install -g droid)",
  login: "run `droid` and sign in in the browser (or /login), with the Droid Pro / Max account",
  version(bin) {
    return versionOf(bin, ["--version"]);
  },
  procMatch(cmd) {
    const base = (s) => path.basename(s || "");
    return cmd.slice(0, 2).some((x) => base(x) === "droid");
  },
  preflight() {
    const w = [];
    if (process.platform === "linux" && !whichBin("bwrap")) w.push("bubblewrap (bwrap) not found: install it for the Droid sandbox (e.g. dnf install bubblewrap / apt install bubblewrap)");
    return w;
  },

  models: { default: "claude-opus-5-5" },
  siteModelId: dotsToHyphens,
  sameModel: (rec, exp) => dotsToHyphens(rec) === dotsToHyphens(exp),
  efforts: { default: "medium", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },

  plans: PLANS.map((plan) => ({ plan })),

  command({ dir, prompt, model, effort, logDir, a = {} }) {
    const settings = path.join(logDir, "droid-settings.json");
    if (!a["dry-run"] && !fs.existsSync(settings)) {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(settings, JSON.stringify(SETTINGS, null, 2) + "\n");
    }
    const args = ["exec", "--cwd", dir, "-m", model, "--auto", "medium", "--settings", settings, "-o", "json"];
    if (effort) args.push("-r", effort);
    args.push(prompt);
    return { args, env: {}, cwd: dir };
  },
  parseUsage({ stdout, model }) {
    const usage = usageFromJson(stdout, model);
    return { usage, tokenSource: usage.length ? "per-task" : "none" };
  },

  meter: {
    unit: "% of the 7-day Standard Credits window",
    windows: { "7d": { perMonth: 4 }, "30d": { perMonth: 1 }, "5h": { perMonth: null } },
    window: "7d",
    note: "Standard Credits × model multiplier in three rolling windows (5-hour, 7-day, 30-day); the subsidy uses 100 × 7-day $/pp × 4 (site convention) or 30-day × 1.",
    manual: {
      where: "the 7-day usage % in `/limits` in an interactive `droid` session",
      url: null,
      allowLeft: true,
    },
    auto: null,
  },
  pacing: { targetPp: 10, maxPct: 85, every: 5 },
  typical: { minutes: "1–3 h (unverified)", meter: "+10 pp of the 7-day window" },
};
