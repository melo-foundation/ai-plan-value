/**
 * Synthetic API plan runs with a known meter, for the fit tests. Each call costs a seeded random
 * API $; the meter holds true usage per window and each call adds $ ÷ β (or the call's weighted
 * tokens for token meters). Readings are floored to the window's resolution.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * opts: { seed, adapter, mode, calls, pollEvery, model, responseModel(i), windows: { w: { beta, start, q, capacity, unit } },
 *   idleBump: { phase: "before"|"after", window, amount }, resetAt: { call, window }, fee, siteRef, usd: [min, max] }
 */
export function simulateRun(opts = {}) {
  const o = { seed: 1, adapter: "glm", mode: "auto", calls: 120, pollEvery: 1, model: "glm-5.3", usd: [0.004, 0.02], fee: { plan: "GLM Coding Lite ¥118 (mixed)", feeUsd: 17.7326, currency: "CNY", feeLocal: 118 }, siteRef: null, ...opts };
  const rnd = mulberry32(o.seed);
  const W = o.windows || { weekly: { beta: 0.05, start: 20.3, q: 1, capacity: 100, unit: "%" }, "5h": { beta: 0.01, start: 3.2, q: 1, capacity: 100, unit: "%" } };
  const used = Object.fromEntries(Object.entries(W).map(([w, x]) => [w, x.start]));
  const resets = Object.fromEntries(Object.keys(W).map((w, i) => [w, 1764806400 + i * 3600]));
  let t = Date.parse("2026-11-28T09:00:00Z");
  const run = {
    schema: "api-plan.run/1",
    kitVersion: "test",
    tag: "sim",
    adapter: o.adapter,
    provider: o.adapter,
    api: "openai",
    apiHost: "http://127.0.0.1",
    meterEndpoint: o.mode,
    mode: o.mode,
    model: o.model,
    expectModel: null,
    siteModel: "glm-5-3",
    price: { source: "test", input: 1, cachedInput: 0.1, output: 4 },
    fee: o.fee,
    siteRef: o.siteRef,
    workload: { version: "1", hash: "x" },
    primary: o.primary || Object.keys(W)[0],
    calls: [],
    readings: [],
    idle: [],
  };
  const read = (phase) => {
    const windows = {};
    const resolution = {};
    for (const [w, x] of Object.entries(W)) {
      windows[w] = { used: Math.floor(used[w] / x.q + 1e-9) * x.q, capacity: x.capacity, unit: x.unit, resetsAt: o.mode === "manual" ? null : resets[w] };
      resolution[w] = x.q;
    }
    run.readings.push({ ts: t, phase, afterCall: run.calls.length, windows, ...(o.mode === "manual" ? { resolution } : {}) });
  };
  const idle = (phase) => {
    const from = run.readings.length;
    read(`${phase}-0`);
    t += 180000;
    if (o.idleBump?.phase === phase) used[o.idleBump.window] += o.idleBump.amount;
    read(`${phase}-1`);
    run.idle.push({ phase, from, to: run.readings.length - 1 });
  };
  idle("before");
  let total = 0;
  for (let i = 0; i < o.calls; i++) {
    if (o.resetAt?.call === i) {
      used[o.resetAt.window] = 0;
      resets[o.resetAt.window] += 7 * 86400;
    }
    const usd = o.usd[0] + rnd() * (o.usd[1] - o.usd[0]);
    const t0 = t;
    t += 15000;
    run.calls.push({ n: i, id: `c${i}`, profile: i % 3 === 2 ? "unique" : "shared", t0, t1: t, ok: true, status: 200, usage: { uncached: 1000, cached: 6000, cacheWrite: 0, output: 800, reasoning: 0 }, responseModel: o.responseModel ? o.responseModel(i) : o.model, usd, parts: { uncachedInput: usd * 0.3, cachedInput: usd * 0.1, cacheWrite: 0, output: usd * 0.6 } });
    total += usd;
    for (const [w, x] of Object.entries(W)) used[w] += usd / x.beta;
    if (o.mode === "auto" && (i + 1) % o.pollEvery === 0) read("run");
  }
  t += 120000;
  idle("after");
  run.startedAt = new Date(run.calls[0]?.t0 ?? t).toISOString();
  run.endedAt = new Date(t).toISOString();
  run.stopReason = "target reached";
  return { run, truth: { total, used: { ...used } } };
}
