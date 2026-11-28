#!/usr/bin/env node
/**
 * Stand-in for `vibe` (Mistral Vibe) in the run tests: no network.
 *   vibe --version
 *   vibe -p <prompt> --workdir <dir> --model <alias> --approval-policy accept-edits --output-dir <dir>
 *       writes <output-dir>/export.json (usage, steps, one subagent) and moves the meter in
 *       $FAKE_METER by the task's API $ ÷ FAKE_BETA.
 *
 * env: FAKE_METER, FAKE_BETA (default 0.05), FAKE_PRICE (JSON), FAKE_CALLS.
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v") {
  console.log("vibe 3.1.5-fake");
  process.exit(0);
}
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
if (opt("-p") == null || opt("--workdir") !== process.cwd() || opt("--approval-policy") !== "accept-edits" || !opt("--output-dir")) process.exit(1);
const model = opt("--model") || "mistral-large-4-0";
const price = JSON.parse(process.env.FAKE_PRICE || '{"input":0.7,"cachedInput":0.07,"output":2.1}');
const beta = Number(process.env.FAKE_BETA || 0.05);
const calls = Number(process.env.FAKE_CALLS || 6);
const meterPath = process.env.FAKE_METER;
const st = meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 5, n: 0 };
st.n ||= 0;
const root = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 };
const sub = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 };
for (let c = 0; c < calls; c++) {
  st.n++;
  const u = c === calls - 1 ? sub : root;
  const input = 30000 + ((st.n * 7919) % 30000);
  const cached = Math.floor(input * 0.7);
  const output = 800 + ((st.n * 131) % 900);
  u.input_tokens += input;
  u.cached_input_tokens += cached;
  u.output_tokens += output;
  u.total_tokens += input + output;
  st.used += ((input - cached) * price.input + cached * price.cachedInput + output * price.output) / 1e6 / beta;
}
if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
fs.writeFileSync("done.txt", "ok\n");
const out = opt("--output-dir");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, "export.json"),
  JSON.stringify({ schema_version: 1, vibe_version: "3.1.5-fake", outcome: "finished", stop_reason: "end_turn", exit_code: 0, session_id: "00000000-0000-4000-8000-000000000001", usage: root, cost_usd: 0.01, steps: calls - 1, subagents: [{ model, usage: sub, steps: 1, status: "closed" }] }, null, 2) + "\n",
);
console.log("Done.");
