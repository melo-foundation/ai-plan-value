#!/usr/bin/env node
/**
 * Stand-in for `codex` in the run tests: makes no network call. `codex exec` writes one rollout
 * file under $CODEX_HOME/sessions in the codex-cli 0.172.0 line shapes, with a meter kept in
 * $CODEX_HOME/fake-meter.json that each call moves by its API $ ÷ β (reading taken before the
 * call is charged, floor). Concurrent runs (--parallel) take a lock on the meter file.
 *
 * env: FAKE_CODEX_PRICE (JSON {input, cachedInput, output}), FAKE_CODEX_BETA (JSON {"5h", weekly}),
 *      FAKE_CODEX_CALLS (calls per task; pings make 1), FAKE_CODEX_MODEL (model written to the
 *      rollout instead of -m, as if codex ignored it), FAKE_CODEX_PLAN (plan_type, default plus),
 *      FAKE_CODEX_WINDOWS ("both" default; "weekly": primary null, weekly in secondary;
 *      "weekly-primary": weekly in primary, no secondary), FAKE_CODEX_SLEEP_MS (per task),
 *      FAKE_CODEX_EXIT (exit with this code before writing anything, stderr names FAKE_CODEX_LEAK),
 *      FAKE_CODEX_LEAK (a string written into session_meta, rate_limits and stderr, as an account
 *      id or email would be), FAKE_CODEX_NO_RATE=1 (token_count events carry no rate_limits).
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
const planType = process.env.FAKE_CODEX_PLAN || "plus";
const windows = process.env.FAKE_CODEX_WINDOWS || "both";
const prompt = fs.readFileSync(0, "utf8");
const leak = process.env.FAKE_CODEX_LEAK || null;
if (leak) process.stderr.write(`account ${leak}\n`);
if (process.env.FAKE_CODEX_EXIT) {
  process.stderr.write(`error: not logged in (${leak ?? "no account"})\n`);
  process.exit(Number(process.env.FAKE_CODEX_EXIT));
}
const isPing = prompt.startsWith("Reply with the single word ok.");
const calls = isPing ? 1 : Number(process.env.FAKE_CODEX_CALLS || 4);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (!isPing && process.env.FAKE_CODEX_SLEEP_MS) pause(Number(process.env.FAKE_CODEX_SLEEP_MS));

const home = process.env.CODEX_HOME;
const statePath = path.join(home, "fake-meter.json");
const lockPath = path.join(home, "fake-meter.lock");
for (let i = 0; ; i++) {
  try {
    fs.mkdirSync(lockPath);
    break;
  } catch {
    if (i > 2000) process.exit(3);
    pause(5);
  }
}
const nowS = Math.floor(Date.now() / 1000);
const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { u: { "5h": 0.3, weekly: 20.3 }, resets: { "5h": nowS + 4 * 3600, weekly: nowS + 4 * 86400 }, n: 0 };

const sid = crypto.randomUUID();
const now = new Date();
const pad = (x) => String(x).padStart(2, "0");
const day = path.join(home, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
fs.mkdirSync(day, { recursive: true });
const name = `rollout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${sid}.jsonl`;

// timestamps follow the meter order across concurrent fakes
const base = Math.max(Date.now() - 2 * (calls + 2), (st.lastTs ?? 0) + 2);
let k = 0;
const lines = [];
const push = (type, payload) => lines.push(JSON.stringify({ timestamp: new Date(base + 2 * k++).toISOString(), type, payload }));
push("session_meta", { session_id: sid, id: sid, cwd, originator: "codex_exec", cli_version: "0.172.0", source: "exec", ...(leak ? { account_email: leak } : {}) });
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
  const fiveH = { used_percent: Math.floor(st.u["5h"]), window_minutes: 300, resets_at: st.resets["5h"] };
  const weekly = { used_percent: Math.floor(st.u.weekly), window_minutes: 10080, resets_at: st.resets.weekly };
  const slots = windows === "weekly" ? { primary: null, secondary: weekly } : windows === "weekly-primary" ? { primary: weekly } : { primary: fiveH, secondary: weekly };
  const rate = {
    limit_id: "codex",
    ...slots,
    credits: { has_credits: false, unlimited: false, balance: "0" },
    plan_type: planType,
    rate_limit_reached_type: null,
    ...(leak ? { account_id: leak } : {}),
  };
  for (const w of ["5h", "weekly"]) st.u[w] += usd / beta[w];
  push("event_msg", { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: last, last_usage_includes_reasoning: true, model_context_window: 475000 }, ...(process.env.FAKE_CODEX_NO_RATE === "1" ? {} : { rate_limits: rate }) });
}
fs.writeFileSync(path.join(day, name), lines.join("\n") + "\n");
st.lastTs = base + 2 * k;
fs.writeFileSync(statePath, JSON.stringify(st));
fs.rmdirSync(lockPath);
console.log(JSON.stringify({ type: "thread.started", thread_id: sid }));
