/**
 * Synthetic run manifests with a known meter, for the fit and flag tests.
 *
 * Each task makes a few calls with random token mixes; the meter holds true usage in pp and each
 * task adds its API $ ÷ β. Manual readings are floor(true) every `every` tasks; automatic readings
 * are the exact value after every task.
 */

import { RF } from "../scripts/lib/fit.mjs";

export const PRICE = { input: 2, cachedInput: 0.5, output: 6, asOf: "2026-11-28", source: "test" };
export const FEE = { usd: 30, source: "test" };

export function simulateManifest(o = {}) {
  const opt = {
    seed: 7,
    beta: 0.9, // $ per pp
    tasks: 60,
    every: 5,
    mode: "manual",
    start: 12.4,
    model: "grok-4.7",
    modelAt: {}, // task index → recorded model
    extraAt: {}, // task index → pp added from outside before that task's reading
    resetAt: null, // task index after which the window resets to 0
    idleMove: 0, // pp added during the "before" idle check
    detectedPlan: null,
    extraUsed: null, // [before, after] on-demand counters
    window: "weekly",
    perMonth: 4,
    ...o,
  };
  const rnd = RF.mulberry32(opt.seed);
  const between = (a, b) => Math.round(a + rnd() * (b - a));
  let U = opt.start;
  let t = Date.parse("2026-11-28T09:00:00Z");
  const iso = () => new Date(t).toISOString();
  const read = (exact) => (opt.mode === "auto" || exact ? Math.round(U * 1e6) / 1e6 : Math.floor(U));
  const readings = [];
  const tasks = [];
  const idle = [];
  let usd = 0;
  const push = (tasksDone, label) => readings.push({ ts: iso(), pct: read(), tasksDone, resetsAt: null, mode: opt.mode, label, ...(opt.extraUsed ? { extraUsed: tasksDone === 0 ? opt.extraUsed[0] : opt.extraUsed[1] } : {}) });
  push(0, "idle before start");
  t += 5 * 60000;
  U += opt.idleMove;
  push(0, "idle before end");
  idle.push({ phase: "before", from: 0, to: 1 });
  for (let i = 0; i < opt.tasks; i++) {
    const usage = [];
    const calls = between(3, 8);
    let taskUsd = 0;
    for (let c = 0; c < calls; c++) {
      const u = { model: opt.modelAt[i] ?? opt.model, uncached: between(1500, 6000), cached: between(10000, 60000), cacheWrite: 0, output: between(200, 2000), reasoning: 0, calls: 1 };
      u.reasoning = Math.round(u.output * 0.3);
      taskUsd += (u.uncached * PRICE.input + u.cached * PRICE.cachedInput + u.output * PRICE.output) / 1e6;
      usage.push(u);
    }
    const startedAt = iso();
    t += 4 * 60000;
    tasks.push({ id: `t${i}`, startedAt, endedAt: iso(), exit: 0, usage, tokenSource: "per-call" });
    usd += taskUsd;
    U += taskUsd / opt.beta;
    if (opt.extraAt[i]) U += opt.extraAt[i];
    if (opt.resetAt === i) U = taskUsd / opt.beta / 2;
    if (opt.mode === "auto" || (i + 1) % opt.every === 0 || i === opt.tasks - 1) push(i + 1, `after ${i + 1}`);
  }
  const endIdx = readings.length - 1;
  t += 5 * 60000;
  push(opt.tasks, "idle after end");
  idle.push({ phase: "after", from: endIdx, to: readings.length - 1 });
  return {
    manifest: {
      schema: "harness-quota.run/1",
      kitVersion: "test",
      tag: "sim",
      harness: { id: "grok", name: "Grok Build", version: "test" },
      plan: "SuperGrok",
      model: opt.model,
      siteModelId: "grok-4-7",
      effort: "medium",
      arm: "A",
      workload: { version: "1", hash: "test", arm: "A" },
      meter: { mode: opt.mode, unit: "%", window: opt.window, windowsPerMonth: opt.perMonth, note: null },
      detectedPlan: opt.detectedPlan,
      readings,
      idle,
      tasks,
      stopReason: "target reached",
    },
    truth: { beta: opt.beta, usd },
  };
}
