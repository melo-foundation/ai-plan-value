/**
 * Synthetic Codex rollout files with a known meter, for the tests.
 *
 * The meter holds true usage in pp per window; each call adds its API $ ÷ β_window. Readings are
 * floor (or round) of true usage, taken before the call is charged (lag 1) or after (lag 0).
 * Line shapes follow a verified codex-cli 0.172.0 rollout (session_meta, turn_context,
 * event_msg/token_count).
 */

import { mulberry32 } from "../scripts/rollout-fit.mjs";

export const PRICE = { input: 2, cachedInput: 0.1, output: 10 };
export const ASTRA_PRICE = { input: 8, cachedInput: 0.4, output: 40 };
export const PRICES = { source: "test", asOf: "2026-11-26", models: { "gpt-6.2-sol": PRICE, "gpt-6.1-sol": PRICE, "gpt-6.2-astra": ASTRA_PRICE } };

const iso = (ms) => new Date(ms).toISOString();

/**
 * opts: {
 *   seed, startMs, calls (number), sessions (calls per session), cwd, model, effort, price (API $ the meter charges),
 *   beta: { "5h": $/pp, weekly: $/pp }, start: { "5h": pp, weekly: pp }, rounding: "floor"|"round", lag: 0|1,
 *   mix: { uncached, cached, output } token ranges as [min, max], reasoningShare,
 *   weight: { uncached, cached, output } meter weights relative to API $ (default 1 each),
 *   extra: [{ atCall, pp: { weekly, "5h" } }]  outside use added before call atCall,
 *   modelAt: { callIndex: model }, effortAt: { callIndex: effort },
 *   gapS: seconds between calls, resetAtCall: { "5h": index } force a window reset before that call,
 *   planType: rate_limits.plan_type (default "plus"),
 *   windows: "both" | "weekly" (primary null) | "weekly-primary" (weekly in the primary slot)
 * }
 * Returns { sessions: [{ name, text }], truth }.
 */
export function simulateRun(opts = {}) {
  const o = {
    seed: 1,
    startMs: Date.parse("2026-11-28T09:00:00Z"),
    calls: 400,
    sessions: 20,
    cwd: "/home/u/.cache/codex-quota-runs/t/work",
    model: "gpt-6.2-sol",
    effort: "medium",
    beta: { "5h": 0.15, weekly: 0.75 },
    start: { "5h": 0.4, weekly: 19.3 },
    rounding: "floor",
    lag: 1,
    mix: { uncached: [1500, 6000], cached: [15000, 90000], output: [200, 2500] },
    reasoningShare: 0.4,
    weight: { uncached: 1, cached: 1, output: 1 },
    extra: [],
    modelAt: {},
    effortAt: {},
    gapS: 12,
    resetAtCall: {},
    price: PRICE,
    planType: "plus",
    windows: "both",
    ...opts,
  };
  const rnd = mulberry32(o.seed);
  const between = (r) => Math.round(r[0] + rnd() * (r[1] - r[0]));
  const U = { ...o.start };
  const resets = { "5h": Math.floor(o.startMs / 1000) + 5 * 3600 - 600, weekly: Math.floor(o.startMs / 1000) + 4 * 86400 };
  const read = (x) => (o.rounding === "round" ? Math.round(x) : Math.floor(x));
  let t = o.startMs;
  const sessions = [];
  const perSession = Math.ceil(o.calls / o.sessions);
  let callIdx = 0;
  let trueUsd = 0;
  for (let s = 0; s < o.sessions && callIdx < o.calls; s++) {
    const sid = `00000000-0000-7000-8000-${String(s).padStart(12, "0")}`;
    const lines = [];
    let ord = 0;
    const push = (type, payload) => lines.push(JSON.stringify({ timestamp: iso(t), ordinal: ord++, type, payload }));
    push("session_meta", { session_id: sid, id: sid, timestamp: iso(t), cwd: `${o.cwd}/task-${s}`, originator: "codex_exec", cli_version: "0.172.0", source: "exec" });
    let model = o.model;
    let effort = o.effort;
    const ctx = () => push("turn_context", { model, ...(effort != null ? { effort } : {}), cwd: `${o.cwd}/task-${s}`, sandbox_policy: { type: "workspace-write" } });
    ctx();
    const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    for (let c = 0; c < perSession && callIdx < o.calls; c++, callIdx++) {
      t += o.gapS * 1000;
      if (o.modelAt[callIdx] !== undefined || o.effortAt[callIdx] !== undefined) {
        if (o.modelAt[callIdx] !== undefined) model = o.modelAt[callIdx];
        if (o.effortAt[callIdx] !== undefined) effort = o.effortAt[callIdx];
        ctx();
      }
      for (const ex of o.extra) if (ex.atCall === callIdx) for (const w of Object.keys(ex.pp)) U[w] += ex.pp[w];
      for (const w of Object.keys(o.resetAtCall)) {
        if (o.resetAtCall[w] === callIdx) {
          U[w] = 0;
          resets[w] = Math.floor(t / 1000) + (w === "5h" ? 5 * 3600 : 7 * 86400);
        }
      }
      const uncached = between(o.mix.uncached);
      const cached = between(o.mix.cached);
      const output = between(o.mix.output);
      const reasoning = Math.round(output * o.reasoningShare);
      const last = { input_tokens: uncached + cached, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: uncached + cached + output };
      for (const k of Object.keys(total)) total[k] += last[k];
      const parts = { uncached: (uncached * o.price.input) / 1e6, cached: (cached * o.price.cachedInput) / 1e6, output: (output * o.price.output) / 1e6 };
      const usd = parts.uncached + parts.cached + parts.output;
      const meterUsd = parts.uncached * o.weight.uncached + parts.cached * o.weight.cached + parts.output * o.weight.output;
      trueUsd += usd;
      const before = { ...U };
      for (const w of Object.keys(U)) U[w] += meterUsd / o.beta[w];
      const R = o.lag === 1 ? before : U;
      const fiveH = { used_percent: read(R["5h"]), window_minutes: 300, resets_at: resets["5h"] };
      const weekly = { used_percent: read(R.weekly), window_minutes: 10080, resets_at: resets.weekly };
      const rate = {
        limit_id: "codex",
        limit_name: null,
        ...(o.windows === "weekly" ? { primary: null, secondary: weekly } : o.windows === "weekly-primary" ? { primary: weekly } : { primary: fiveH, secondary: weekly }),
        credits: { has_credits: false, unlimited: false, balance: "0" },
        plan_type: o.planType,
        rate_limit_reached_type: null,
      };
      push("event_msg", { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: last, last_usage_includes_reasoning: true, model_context_window: 475000 }, rate_limits: rate });
    }
    sessions.push({ name: `rollout-${iso(o.startMs).slice(0, 19).replace(/:/g, "-")}-${sid}.jsonl`, text: lines.join("\n") + "\n", cwd: `${o.cwd}/task-${s}` });
  }
  return { sessions, truth: { beta: o.beta, usd: trueUsd, end: { ...U }, endMs: t } };
}
