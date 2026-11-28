#!/usr/bin/env node
/**
 * Stand-in for `gemini` in the run tests: no network. `gemini -p … --output-format json` makes
 * FAKE_CALLS calls, writes one gemini_cli.api_response telemetry record per call to
 * $GEMINI_TELEMETRY_OUTFILE (pretty-printed records back to back, as the file exporter does)
 * unless FAKE_NO_TELEMETRY=1, prints the JSON result with stats.models, and moves the meter in
 * $FAKE_METER ({ used: % }) by each call's API $ ÷ FAKE_BETA.
 *
 * env: FAKE_METER (path), FAKE_BETA ($ per pp, default 0.05), FAKE_PRICE (JSON), FAKE_CALLS,
 *      FAKE_MODEL (recorded model instead of -m), FAKE_NO_TELEMETRY.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("0.73.0-fake");
  process.exit(0);
}
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const prompt = opt("-p");
if (prompt == null) process.exit(42);
const model = process.env.FAKE_MODEL || opt("-m") || "gemini-3.8-flash";
const price = JSON.parse(process.env.FAKE_PRICE || '{"input":0.75,"cachedInput":0.075,"output":3.75}');
const beta = Number(process.env.FAKE_BETA || 0.05);
const calls = Number(process.env.FAKE_CALLS || 5);
const meterPath = process.env.FAKE_METER;
const st = meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 3.2, n: 0 };
st.n ||= 0;
const tot = { prompt: 0, candidates: 0, cached: 0, thoughts: 0, tool: 0, total: 0, input: 0 };
let records = "";
for (let c = 0; c < calls; c++) {
  st.n++;
  const input = 20000 + ((st.n * 7919) % 30000);
  const cached = Math.floor(input * 0.7);
  const output = 400 + ((st.n * 131) % 900);
  const thoughts = 300 + ((st.n * 37) % 500);
  const tool = 50;
  tot.prompt += input;
  tot.cached += cached;
  tot.candidates += output;
  tot.thoughts += thoughts;
  tot.tool += tool;
  tot.total += input + output + thoughts + tool;
  tot.input += input - cached;
  const usd = ((input - cached + tool) * price.input + cached * price.cachedInput + (output + thoughts) * price.output) / 1e6;
  st.used += usd / beta;
  const rec = {
    resource: { attributes: { "service.name": "gemini-cli" } },
    hrTime: [Math.floor(Date.now() / 1000), 0],
    body: `API response from ${model}.`,
    attributes: { "session.id": "fake", "event.name": "gemini_cli.api_response", "event.timestamp": new Date().toISOString(), model, status_code: 200, duration_ms: 900, input_token_count: input, output_token_count: output, cached_content_token_count: cached, thoughts_token_count: thoughts, tool_token_count: tool, total_token_count: input + output + thoughts + tool, prompt_id: "fake#1", auth_type: "oauth-personal" },
  };
  records += JSON.stringify(rec, null, 2) + "\n";
}
if (process.env.GEMINI_TELEMETRY_OUTFILE && process.env.FAKE_NO_TELEMETRY !== "1") fs.appendFileSync(process.env.GEMINI_TELEMETRY_OUTFILE, records);
if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
fs.writeFileSync("done.txt", "ok\n"); // in the task folder (cwd)
console.log(JSON.stringify({ session_id: "fake", response: "Done.\nTests pass.", stats: { models: { [model]: { api: { totalRequests: calls, totalErrors: 0, totalLatencyMs: 900 * calls }, tokens: tot } }, tools: {}, files: {} } }, null, 2));
