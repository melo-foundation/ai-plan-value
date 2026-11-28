#!/usr/bin/env node
/**
 * Stand-in for the Cursor CLI (`agent`) in the run tests: no network.
 *   agent --version
 *   agent -p --output-format json … <prompt>   prints the json result with `usage` and moves the
 *                                              meter in $FAKE_METER ({ used: % of included }) by
 *                                              the task's API $ ÷ FAKE_BETA
 *
 * env: FAKE_METER, FAKE_BETA (default 0.5), FAKE_PRICE (JSON), FAKE_CALLS.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("2026.11.20-fake");
  process.exit(0);
}
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
if (!argv.includes("-p") || opt("--output-format") !== "json") process.exit(1);
if (opt("--sandbox") !== "enabled" || opt("--workspace") !== process.cwd() || !argv.includes("--trust")) process.exit(3);
const price = JSON.parse(process.env.FAKE_PRICE || '{"input":2,"cachedInput":0.5,"output":6}');
const beta = Number(process.env.FAKE_BETA || 0.5);
const calls = Number(process.env.FAKE_CALLS || 6);
const meterPath = process.env.FAKE_METER;
const st = meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 10, n: 0 };
st.n ||= 0;
const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
for (let c = 0; c < calls; c++) {
  st.n++;
  u.inputTokens += 2000 + ((st.n * 397) % 3000);
  u.cacheReadTokens += 30000 + ((st.n * 7919) % 20000);
  u.cacheWriteTokens += 500;
  u.outputTokens += 600 + ((st.n * 131) % 900);
}
const usd = ((u.inputTokens + u.cacheWriteTokens) * price.input + u.cacheReadTokens * price.cachedInput + u.outputTokens * price.output) / 1e6;
st.used += usd / beta;
if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
fs.writeFileSync("done.txt", "ok\n");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1234, duration_api_ms: 1234, result: "Done.", session_id: "00000000-0000-4000-8000-000000000001", request_id: "req", usage: u }));
