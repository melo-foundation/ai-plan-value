#!/usr/bin/env node
/**
 * Stand-in for `grok` (Grok Build) in the run tests: no network.
 *   grok --version
 *   grok -p … --output-format json   one task: prints the JSON result (usage, modelUsage) and
 *                                    moves the meter in $FAKE_METER by its API $ ÷ FAKE_BETA
 *   grok agent stdio                 JSON-RPC: initialize, then _x.ai/billing → creditUsagePercent
 *
 * env: FAKE_METER, FAKE_BETA (default 0.5), FAKE_PRICE (JSON), FAKE_CALLS, FAKE_MODEL,
 *      FAKE_TIER (subscription_tier, default "SuperGrok"), FAKE_BILLING_METHOD (only this method
 *      name answers; the other gets -32601), FAKE_BILLING_FAIL=1 (billing error).
 */

import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const meterPath = process.env.FAKE_METER;
const load = () => (meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 20.3, n: 0 });

if (argv[0] === "--version") {
  console.log("grok 0.9.0-fake");
  process.exit(0);
}

if (argv[0] === "agent" && argv[1] === "stdio") {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  send({ jsonrpc: "2.0", method: "session/notice", params: { text: "hello" } }); // a notification first
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    if (/x\.ai\/billing$/.test(m.method)) {
      const want = process.env.FAKE_BILLING_METHOD;
      if (want && m.method !== want) return send({ id: m.id, error: { code: -32601, message: "Method not found" } });
      if (process.env.FAKE_BILLING_FAIL === "1") return send({ id: m.id, error: { code: -32603, message: "Internal error", data: "Billing data requires auth with grok.com. Run `grok login` to authenticate." } });
      const st = load();
      const start = new Date(Date.now() - 2 * 86400000).toISOString();
      const end = new Date(Date.now() + 5 * 86400000).toISOString();
      return send({ id: m.id, result: { config: { creditUsagePercent: st.used, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end }, onDemandUsed: {}, prepaidBalance: { val: 0 } }, on_demand_enabled: false, subscription_tier: process.env.FAKE_TIER || "SuperGrok" } });
    }
    send({ id: m.id, error: { code: -32601, message: "Method not found" } });
  });
  rl.on("close", () => process.exit(0));
} else {
  const opt = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };
  if (opt("-p") == null) process.exit(1);
  if (opt("--sandbox") !== "strict" || opt("--cwd") !== process.cwd()) process.exit(3);
  const model = process.env.FAKE_MODEL || opt("-m") || "grok-4.6";
  const price = JSON.parse(process.env.FAKE_PRICE || '{"input":2,"cachedInput":0.5,"output":6}');
  const beta = Number(process.env.FAKE_BETA || 0.5);
  const calls = Number(process.env.FAKE_CALLS || 6);
  const st = load();
  st.n ||= 0;
  const u = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  for (let c = 0; c < calls; c++) {
    st.n++;
    u.input_tokens += 2000 + ((st.n * 397) % 3000);
    u.cache_read_input_tokens += 30000 + ((st.n * 7919) % 20000);
    u.output_tokens += 600 + ((st.n * 131) % 900);
  }
  u.reasoning_tokens = Math.round(u.output_tokens * 0.3);
  u.total_tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens;
  const usd = (u.input_tokens * price.input + u.cache_read_input_tokens * price.cachedInput + u.output_tokens * price.output) / 1e6;
  st.used += usd / beta;
  if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
  fs.writeFileSync("done.txt", "ok\n");
  console.log(JSON.stringify({ text: "Done.", stopReason: "end_turn", sessionId: "00000000-0000-4000-8000-000000000001", requestId: "req", num_turns: calls, usage: u, modelUsage: { [model]: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, modelCalls: calls, costUSD: usd } }, total_cost_usd: usd, usage_is_incomplete: false, cost_is_partial: false }));
}
