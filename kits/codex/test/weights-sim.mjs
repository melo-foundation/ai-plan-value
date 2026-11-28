/**
 * Synthetic rollouts of the token-weight arms (and A / B holdouts) on one shared meter with known
 * weights, for the weights tests. Line shapes as in sim.mjs (codex-cli 0.172.0). The meter charges
 * Σ w_kind × API $_kind ÷ β per window; readings are floored and taken before the call is charged.
 */

import { mulberry32 } from "../scripts/rollout-fit.mjs";
import * as RF from "../scripts/rollout-fit.mjs";
import { PRICE } from "./sim.mjs";

/** Tokens per call by arm: [min, max] of uncached input, cached input, visible output, reasoning. */
export const MIX = {
  cache: { input: [200, 600], cached: [40000, 50000], output: [3, 8], reasoning: [0, 20] },
  input: { input: [28000, 32000], cached: [0, 12000], output: [3, 8], reasoning: [0, 30] },
  output: { input: [2000, 3000], cached: [9000, 12000], output: [5000, 7000], reasoning: [0, 100] },
  reasoning: { input: [2000, 3000], cached: [9000, 12000], output: [10, 40], reasoning: [4000, 9000] },
  A: { input: [1500, 6000], cached: [15000, 90000], output: [150, 2200], reasoning: [20, 300] },
  B: { input: [28000, 32000], cached: [0, 3000], output: [300, 900], reasoning: [300, 1500] },
};
const KINDS = ["input", "cached", "output", "reasoning"];
const iso = (ms) => new Date(ms).toISOString();

/**
 * opts: { seed, arms: [{ arm, tag, targetPp (weekly) }], weight: { weekly: {kind: w}, "5h": {kind: w} } or one
 * { kind: w } for both, beta: { "5h", weekly }, price, callsPerSession }
 * Returns [{ tag, arm, sessions: [parsed rollout] }].
 */
export function simulateArms(opts = {}) {
  const o = {
    seed: 1,
    arms: [
      { arm: "A", tag: "sim-A1", targetPp: 12 },
      { arm: "B", tag: "sim-B1", targetPp: 8 },
      { arm: "cache", tag: "sim-cache1", targetPp: 3 },
      { arm: "input", tag: "sim-input1", targetPp: 3 },
      { arm: "output", tag: "sim-output1", targetPp: 3 },
      { arm: "reasoning", tag: "sim-reasoning1", targetPp: 3 },
    ],
    weight: { input: 1, cached: 3, output: 1, reasoning: 1.5 },
    beta: { "5h": 0.11, weekly: 0.66 },
    price: PRICE,
    callsPerSession: 8,
    startMs: Date.parse("2026-11-28T09:00:00Z"),
    ...opts,
  };
  const wOf = (win) => (o.weight[win] ? { input: 1, cached: 1, output: 1, reasoning: 1, ...o.weight[win] } : { input: 1, cached: 1, output: 1, reasoning: 1, ...o.weight });
  const rnd = mulberry32(o.seed);
  const U = { weekly: 20.3 + rnd(), "5h": 1 + rnd() };
  const resets = { "5h": Math.floor(o.startMs / 1000) + 5 * 3600, weekly: Math.floor(o.startMs / 1000) + 6 * 86400 };
  let t = o.startMs;
  const out = [];
  for (const spec of o.arms) {
    const mix = MIX[spec.arm];
    const sessions = [];
    const startWeekly = U.weekly;
    let s = 0;
    while (U.weekly - startWeekly < spec.targetPp + 0.15) {
      const sid = `00000000-0000-7000-8000-${String(out.length * 1000 + s).padStart(12, "0")}`;
      const cwd = `/work/${spec.tag}/task-${s}`;
      const lines = [];
      const push = (type, payload) => lines.push(JSON.stringify({ timestamp: iso(t), type, payload }));
      push("session_meta", { session_id: sid, id: sid, cwd, originator: "codex_exec", cli_version: "0.172.0", source: "exec" });
      push("turn_context", { model: "gpt-6.2-sol", effort: spec.arm === "reasoning" ? "high" : "low", cwd });
      const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
      for (let c = 0; c < o.callsPerSession && U.weekly - startWeekly < spec.targetPp + 0.15; c++) {
        t += 9000;
        // a 5h window resets when it would pass 90%
        if (U["5h"] > 90) {
          U["5h"] = 0.2 * rnd();
          resets["5h"] = Math.floor(t / 1000) + 5 * 3600;
        }
        const tok = Object.fromEntries(KINDS.map((k) => [k, Math.round(mix[k][0] + rnd() * (mix[k][1] - mix[k][0]))]));
        const usd = { input: (tok.input * o.price.input) / 1e6, cached: (tok.cached * o.price.cachedInput) / 1e6, output: (tok.output * o.price.output) / 1e6, reasoning: (tok.reasoning * o.price.output) / 1e6 };
        const read = { "5h": Math.floor(U["5h"]), weekly: Math.floor(U.weekly) };
        for (const w of ["5h", "weekly"]) {
          const wt = wOf(w);
          U[w] += KINDS.reduce((a, k) => a + usd[k] * wt[k], 0) / o.beta[w];
        }
        const last = { input_tokens: tok.input + tok.cached, cached_input_tokens: tok.cached, cache_write_input_tokens: 0, output_tokens: tok.output + tok.reasoning, reasoning_output_tokens: tok.reasoning, total_tokens: tok.input + tok.cached + tok.output + tok.reasoning };
        for (const k of Object.keys(total)) total[k] += last[k];
        const rate = {
          limit_id: "codex",
          primary: { used_percent: read["5h"], window_minutes: 300, resets_at: resets["5h"] },
          secondary: { used_percent: read.weekly, window_minutes: 10080, resets_at: resets.weekly },
          credits: { has_credits: false, unlimited: false, balance: "0" },
          plan_type: "plus",
          rate_limit_reached_type: null,
        };
        push("event_msg", { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: last, last_usage_includes_reasoning: true, model_context_window: 475000 }, rate_limits: rate });
      }
      sessions.push(RF.parseRolloutText(lines.join("\n") + "\n", `rollout-${sid}.jsonl`));
      s++;
    }
    out.push({ tag: spec.tag, arm: spec.arm, root: `/work/${spec.tag}`, sessions });
    t += 600000;
  }
  return out;
}
