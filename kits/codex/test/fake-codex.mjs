#!/usr/bin/env node
/**
 * Stand-in for `codex` in the run tests: makes no network call. `codex exec` writes one rollout
 * file under $CODEX_HOME/sessions in the codex-cli 0.172.0 line shapes, with a meter kept in
 * $CODEX_HOME/fake-meter.json that each call moves by its meter $ ÷ β (reading taken before the
 * call is charged, floor). Concurrent runs (--parallel) take a lock on the meter file.
 *
 * Weight-arm prompts (they contain "do not run commands, call tools or read files") and
 * `codex exec resume <id> -` make one call whose tokens follow the text: input = (system prompt +
 * the session's earlier turns + the prompt) ÷ 4 chars; cached = the longest prefix, in 1024-char
 * blocks, that an earlier call sent (a prompt cache shared by all sessions, kept in
 * $CODEX_HOME/fake-cache.json); visible output 14 tokens per line asked for ("Write exactly N
 * numbered lines"), else 4; reasoning by effort (low 30, medium 300, high 4000–7000). Resume
 * appends to the session's rollout file. Other prompts keep the fixed per-call sizes below.
 *
 * env: FAKE_CODEX_PRICE (JSON {input, cachedInput, output}), FAKE_CODEX_BETA (JSON {"5h", weekly}),
 *      FAKE_CODEX_WEIGHTS (JSON {input, cached, output, reasoning}: meter $ per API $ of each kind,
 *      default 1 each), FAKE_CODEX_CALLS (calls per task; pings and weight-arm calls make 1),
 *      FAKE_CODEX_MODEL (model written to the rollout instead of -m, as if codex ignored it),
 *      FAKE_CODEX_PLAN (plan_type, default plus), FAKE_CODEX_WINDOWS ("both" default; "weekly":
 *      primary null, weekly in secondary; "weekly-primary": weekly in primary, no secondary),
 *      FAKE_CODEX_SLEEP_MS (per task), FAKE_CODEX_EXIT (exit with this code before writing
 *      anything, stderr names FAKE_CODEX_LEAK), FAKE_CODEX_LEAK (a string written into
 *      session_meta, rate_limits and stderr, as an account id or email would be),
 *      FAKE_CODEX_NO_RATE=1 (token_count events carry no rate_limits), FAKE_CODEX_NO_CACHE=1 (the
 *      prompt cache never hits).
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
const resume = argv[1] === "resume";
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const resumeId = resume ? argv[argv.length - 2] : null;
const cwd = resume ? process.cwd() : opt("-C");
const model = process.env.FAKE_CODEX_MODEL || opt("-m");
const effort = (argv.find((x) => x.startsWith("model_reasoning_effort=")) || "").replace(/^model_reasoning_effort="?([^"]*)"?$/, "$1") || null;
const price = JSON.parse(process.env.FAKE_CODEX_PRICE || '{"input":2,"cachedInput":0.1,"output":10}');
const beta = JSON.parse(process.env.FAKE_CODEX_BETA || '{"5h":0.1,"weekly":0.66}');
const weight = { input: 1, cached: 1, output: 1, reasoning: 1, ...JSON.parse(process.env.FAKE_CODEX_WEIGHTS || "{}") };
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
const textMode = resume || /do not run commands, call tools or read files/.test(prompt);
const calls = isPing || textMode ? 1 : Number(process.env.FAKE_CODEX_CALLS || 4);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (!isPing && process.env.FAKE_CODEX_SLEEP_MS) pause(Number(process.env.FAKE_CODEX_SLEEP_MS));

const home = process.env.CODEX_HOME;
const statePath = path.join(home, "fake-meter.json");
const lockPath = path.join(home, "fake-meter.lock");
const cachePath = path.join(home, "fake-cache.json");
const sessDir = path.join(home, "fake-sessions");
for (let i = 0; ; i++) {
  try {
    fs.mkdirSync(lockPath);
    break;
  } catch {
    if (i > 4000) process.exit(3);
    pause(5);
  }
}
const nowS = Math.floor(Date.now() / 1000);
const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { u: { "5h": 0.3, weekly: 20.3 }, resets: { "5h": nowS + 4 * 3600, weekly: nowS + 4 * 86400 }, n: 0 };

// session: new, or the one resumed
fs.mkdirSync(sessDir, { recursive: true });
let sid;
let file;
let sess;
const now = new Date();
const pad = (x) => String(x).padStart(2, "0");
if (resume) {
  sid = resumeId;
  const sp = path.join(sessDir, `${sid}.json`);
  if (!fs.existsSync(sp)) {
    fs.rmdirSync(lockPath);
    process.stderr.write(`error: no session ${sid}\n`);
    process.exit(1);
  }
  sess = JSON.parse(fs.readFileSync(sp, "utf8"));
  file = sess.file;
} else {
  sid = crypto.randomUUID();
  const day = path.join(home, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(day, { recursive: true });
  file = path.join(day, `rollout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${sid}.jsonl`);
  sess = { file, history: "", total: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 } };
}

const SYSTEM = "You are Codex, a coding agent. ".repeat(400); // ≈ 3k tokens of instructions and tools
const BLOCK = 1024;
/** Text-mode call: tokens from the context the call sends, cached from the shared prefix cache. */
function textCall() {
  const context = SYSTEM + sess.history + prompt;
  const store = new Set(fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : []);
  let h = "";
  let hit = 0;
  let missed = false;
  for (let i = 0; i + BLOCK <= context.length; i += BLOCK) {
    h = crypto.createHash("sha1").update(h).update(context.slice(i, i + BLOCK)).digest("hex").slice(0, 16);
    if (!missed && store.has(h) && process.env.FAKE_CODEX_NO_CACHE !== "1") hit += BLOCK;
    else missed = true;
    store.add(h);
  }
  fs.writeFileSync(cachePath, JSON.stringify([...store]));
  const input = Math.ceil(context.length / 4);
  const cached = Math.floor(hit / 4);
  const lines = prompt.match(/Write exactly (\d+) numbered lines/);
  const visible = lines ? Number(lines[1]) * 14 : 4;
  const r = { low: 30, medium: 300, high: 4000 + ((st.n * 997) % 3000), xhigh: 8000, max: 9000 }[effort] ?? 300;
  const answer = lines ? "1. …\n" : "ok";
  sess.history += prompt + answer;
  return { input, cached, visible, reasoning: r };
}

// timestamps follow the meter order across concurrent fakes
const base = Math.max(Date.now() - 2 * (calls + 2), (st.lastTs ?? 0) + 2);
let k = 0;
const lines = [];
const push = (type, payload) => lines.push(JSON.stringify({ timestamp: new Date(base + 2 * k++).toISOString(), type, payload }));
if (!resume) push("session_meta", { session_id: sid, id: sid, cwd, originator: "codex_exec", cli_version: "0.172.0", source: "exec", ...(leak ? { account_email: leak } : {}) });
push("turn_context", { model, ...(effort ? { effort } : {}), cwd });
const total = sess.total;
for (let c = 0; c < calls; c++) {
  st.n++;
  let uncached, cached, output, reasoning;
  if (textMode && !isPing) {
    const t = textCall();
    cached = t.cached;
    uncached = t.input - t.cached;
    reasoning = t.reasoning;
    output = t.visible + t.reasoning;
  } else {
    uncached = isPing ? 2000 : 2500 + ((st.n * 397) % 1000);
    cached = isPing ? 14000 : 30000 + ((st.n * 7919) % 20000);
    output = isPing ? 5 : 900 + ((st.n * 131) % 600);
    reasoning = Math.round(output * 0.4);
  }
  const last = { input_tokens: uncached + cached, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: uncached + cached + output };
  for (const key of Object.keys(total)) total[key] += last[key];
  const usd = (uncached * price.input * weight.input + cached * price.cachedInput * weight.cached + (output - reasoning) * price.output * weight.output + reasoning * price.output * weight.reasoning) / 1e6;
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
fs.appendFileSync(file, lines.join("\n") + "\n");
fs.writeFileSync(path.join(sessDir, `${sid}.json`), JSON.stringify(sess));
st.lastTs = base + 2 * k;
fs.writeFileSync(statePath, JSON.stringify(st));
fs.rmdirSync(lockPath);
console.log(JSON.stringify({ type: "thread.started", thread_id: sid }));
