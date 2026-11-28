#!/usr/bin/env node
/**
 * Stand-in for `qwen` (Qwen Code) in the run tests: no network.
 *   qwen --version
 *   qwen -p <prompt> -m <model> --approval-mode yolo --sandbox --output-format json
 *       needs QWEN_SANDBOX set; writes one qwen-code.api_response record per call to
 *       $QWEN_TELEMETRY_OUTFILE unless FAKE_NO_TELEMETRY=1, prints the JSON message array with
 *       stats on the result, and moves the meter in $FAKE_METER by the task's API $ ÷ FAKE_BETA.
 *
 * env: FAKE_METER, FAKE_BETA (default 0.05), FAKE_PRICE (JSON), FAKE_CALLS, FAKE_NO_TELEMETRY.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("0.28.7-fake");
  process.exit(0);
}
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
if (opt("-p") == null) process.exit(42);
if (!argv.includes("--sandbox") || !process.env.QWEN_SANDBOX) process.exit(44);
if (opt("--approval-mode") !== "yolo" || opt("--output-format") !== "json") process.exit(42);
const model = opt("-m") || "qwen4-max";
const price = JSON.parse(process.env.FAKE_PRICE || '{"input":1.5,"cachedInput":0.075,"output":4.5}');
const beta = Number(process.env.FAKE_BETA || 0.05);
const calls = Number(process.env.FAKE_CALLS || 5);
const meterPath = process.env.FAKE_METER;
const st = meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 3, n: 0 };
st.n ||= 0;
const tot = { prompt: 0, candidates: 0, cached: 0, thoughts: 0, total: 0 };
let records = "";
for (let c = 0; c < calls; c++) {
  st.n++;
  const input = 20000 + ((st.n * 7919) % 30000);
  const cached = Math.floor(input * 0.6);
  const output = 600 + ((st.n * 131) % 900);
  const thoughts = Math.floor(output / 3); // inside output
  tot.prompt += input;
  tot.cached += cached;
  tot.candidates += output;
  tot.thoughts += thoughts;
  tot.total += input + output;
  st.used += ((input - cached) * price.input + cached * price.cachedInput + output * price.output) / 1e6 / beta;
  const rec = { attributes: { "event.name": "qwen-code.api_response", "event.timestamp": new Date().toISOString(), model, duration_ms: 900, input_token_count: input, output_token_count: output, cached_content_token_count: cached, thoughts_token_count: thoughts, total_token_count: input + output, auth_type: "openai" } };
  records += JSON.stringify(rec, null, 2) + "\n";
}
if (process.env.QWEN_TELEMETRY_OUTFILE && process.env.FAKE_NO_TELEMETRY !== "1") fs.appendFileSync(process.env.QWEN_TELEMETRY_OUTFILE, records);
if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
fs.writeFileSync("done.txt", "ok\n");
const stats = { models: { [model]: { api: { totalRequests: calls, totalErrors: 0, totalLatencyMs: 900 * calls }, tokens: tot } }, tools: { totalCalls: 2 } };
console.log(JSON.stringify([{ type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000000001", model }, { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }, { type: "result", subtype: "success", result: "Done.", usage: { input_tokens: tot.prompt, output_tokens: tot.candidates, cache_read_input_tokens: tot.cached }, stats }], null, 2));
