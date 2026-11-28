#!/usr/bin/env node
/**
 * Stand-in for `droid` (Factory Droid) in the run tests: no network.
 *   droid --version
 *   droid exec --cwd <dir> -m <model> --auto medium --settings <file> -o json <prompt>
 *       checks the sandbox settings file, prints the -o json result and moves the meter in
 *       $FAKE_METER by the task's API $ ÷ FAKE_BETA.
 *
 * env: FAKE_METER, FAKE_BETA (default 0.5), FAKE_PRICE (JSON), FAKE_CALLS.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v") {
  console.log("0.99.0-fake");
  process.exit(0);
}
if (argv[0] !== "exec") process.exit(2);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
if (opt("--cwd") !== process.cwd() || opt("--auto") !== "medium" || opt("-o") !== "json") process.exit(3);
const settings = JSON.parse(fs.readFileSync(opt("--settings"), "utf8"));
if (settings.sandbox?.enabled !== true) process.exit(4);
const prompt = argv[argv.length - 1];
if (!prompt || prompt.startsWith("-")) process.exit(5);

const price = JSON.parse(process.env.FAKE_PRICE || '{"input":4,"cachedInput":0.2,"output":20}');
const beta = Number(process.env.FAKE_BETA || 0.5);
const calls = Number(process.env.FAKE_CALLS || 6);
const meterPath = process.env.FAKE_METER;
const st = meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 10, n: 0 };
st.n ||= 0;
const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
for (let c = 0; c < calls; c++) {
  st.n++;
  u.input_tokens += 20 + ((st.n * 37) % 200);
  u.cache_read_input_tokens += 20000 + ((st.n * 7919) % 20000);
  u.cache_creation_input_tokens += 500 + ((st.n * 13) % 500);
  u.output_tokens += 400 + ((st.n * 131) % 700);
}
const usd = ((u.input_tokens + u.cache_creation_input_tokens) * price.input + u.cache_read_input_tokens * price.cachedInput + u.output_tokens * price.output) / 1e6;
st.used += usd / beta;
if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
fs.writeFileSync("done.txt", "ok\n");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 5657, num_turns: calls, result: "Done.", session_id: "00000000-0000-4000-8000-000000000001", usage: { ...u, factory_credits: Math.round(usd * 1000), ttft_ms: 900 } }));
