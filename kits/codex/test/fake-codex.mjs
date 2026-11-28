#!/usr/bin/env node
/**
 * Stand-in for `codex` in the run tests: makes no network call. `codex exec` writes one rollout
 * file under $CODEX_HOME/sessions in the codex-cli 0.172.0 line shapes, with a meter kept in
 * $CODEX_HOME/fake-meter.json that each call moves by its API $ ÷ β (reading taken before the
 * call is charged, floor).
 *
 * env: FAKE_CODEX_PRICE (JSON {input, cachedInput, output}), FAKE_CODEX_BETA (JSON {"5h", weekly}),
 *      FAKE_CODEX_CALLS (calls per task; pings make 1), FAKE_CODEX_MODEL (model written to the
 *      rollout instead of -m, as if codex ignored it).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("codex-cli 0.172.0");
  process.exit(0);
}
if (argv[0] !== "exec") process.exit(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const cwd = opt("-C");
const model = process.env.FAKE_CODEX_MODEL || opt("-m");
const effort = (argv.find((x) => x.startsWith("model_reasoning_effort=")) || "").replace(/^model_reasoning_effort="?([^"]*)"?$/, "$1") || null;
const price = JSON.parse(process.env.FAKE_CODEX_PRICE || '{"input":2,"cachedInput":0.1,"output":10}');
const beta = JSON.parse(process.env.FAKE_CODEX_BETA || '{"5h":0.1,"weekly":0.66}');
const prompt = fs.readFileSync(0, "utf8");
const isPing = prompt.startsWith("Reply with the single word ok.");
const calls = isPing ? 1 : Number(process.env.FAKE_CODEX_CALLS || 4);

const home = process.env.CODEX_HOME;
const statePath = path.join(home, "fake-meter.json");
const nowS = Math.floor(Date.now() / 1000);
const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { u: { "5h": 0.3, weekly: 20.3 }, resets: { "5h": nowS + 4 * 3600, weekly: nowS + 4 * 86400 }, n: 0 };

const sid = crypto.randomUUID();
const now = new Date();
const pad = (x) => String(x).padStart(2, "0");
const day = path.join(home, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
fs.mkdirSync(day, { recursive: true });
const name = `rollout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${sid}.jsonl`;

const base = Date.now() - 2 * (calls + 2);
let k = 0;
const lines = [];
const push = (type, payload) => lines.push(JSON.stringify({ timestamp: new Date(base + 2 * k++).toISOString(), type, payload }));
push("session_meta", { session_id: sid, id: sid, cwd, originator: "codex_exec", cli_version: "0.172.0", source: "exec" });
push("turn_context", { model, ...(effort ? { effort } : {}), cwd });
const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
for (let c = 0; c < calls; c++) {
  st.n++;
  const uncached = isPing ? 2000 : 2500 + ((st.n * 397) % 1000);
  const cached = isPing ? 14000 : 30000 + ((st.n * 7919) % 20000);
  const output = isPing ? 5 : 900 + ((st.n * 131) % 600);
  const last = { input_tokens: uncached + cached, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: Math.round(output * 0.4), total_tokens: uncached + cached + output };
  for (const key of Object.keys(total)) total[key] += last[key];
  const usd = (uncached * price.input + cached * price.cachedInput + output * price.output) / 1e6;
  const rate = {
    limit_id: "codex",
    primary: { used_percent: Math.floor(st.u["5h"]), window_minutes: 300, resets_at: st.resets["5h"] },
    secondary: { used_percent: Math.floor(st.u.weekly), window_minutes: 10080, resets_at: st.resets.weekly },
    credits: { has_credits: false, unlimited: false, balance: "0" },
    plan_type: "plus",
    rate_limit_reached_type: null,
  };
  for (const w of ["5h", "weekly"]) st.u[w] += usd / beta[w];
  push("event_msg", { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: last, last_usage_includes_reasoning: true, model_context_window: 475000 }, rate_limits: rate });
}
fs.writeFileSync(path.join(day, name), lines.join("\n") + "\n");
fs.writeFileSync(statePath, JSON.stringify(st));
console.log(JSON.stringify({ type: "thread.started", thread_id: sid }));
