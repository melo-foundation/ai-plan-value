#!/usr/bin/env node
/**
 * Stand-in for `muse` (Muse Code) in the run tests: no network.
 *   muse --version
 *   muse usage --json            allowance { tier, window, weekly { usedPercent, resetsAtMs } }
 *   muse exec --json … <prompt>  JSONL: a run.usage line (and per-call model_completed records
 *                                when FAKE_PER_CALL=1); moves the weekly meter in $FAKE_METER by
 *                                the task's API $ ÷ FAKE_BETA
 *
 * env: FAKE_METER, FAKE_BETA (default 0.5), FAKE_PRICE (JSON), FAKE_CALLS, FAKE_MODEL, FAKE_TIER,
 *      FAKE_PER_CALL=1, FAKE_NO_ALLOWANCE=1, FAKE_ARGS (path: append argv as JSON lines).
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
const meterPath = process.env.FAKE_METER;
const load = () => (meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 20.3, n: 0 });
if (process.env.FAKE_ARGS) fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify(argv) + "\n");

if (argv[0] === "--version") {
  console.log("muse 1.4.25-fake");
  process.exit(0);
}

if (argv[0] === "usage" && argv[1] === "--json") {
  if (process.env.FAKE_NO_ALLOWANCE === "1") {
    console.log('{"schemaVersion":1,"allowance":null,"reason":"no_allowance","hint":null}');
    process.exit(1);
  }
  const st = load();
  const now = Date.now();
  console.log(JSON.stringify({ schemaVersion: 1, allowance: { tier: process.env.FAKE_TIER || "Muse Code Power Usage", window: { usedPercent: 3, resetsAtMs: now + 3 * 3600e3 }, weekly: { usedPercent: st.used, resetsAtMs: now + 4 * 86400e3 }, asOfMs: now, source: "mint" }, reason: null, hint: null }));
  process.exit(0);
}

if (argv[0] !== "exec") process.exit(2);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
if (!argv.includes("--json") || !argv.includes("--disable-approval")) process.exit(2);
if (!["on", "off"].includes(opt("--contributor-mode"))) process.exit(2);
if (argv.includes("--yolo") || argv.includes("--disable-sandbox")) process.exit(3);
const model = process.env.FAKE_MODEL || opt("--model") || "muse-spark-1.2";
const price = JSON.parse(process.env.FAKE_PRICE || '{"input":1.25,"cachedInput":0.15,"output":4.25}');
const beta = Number(process.env.FAKE_BETA || 0.5);
const calls = Number(process.env.FAKE_CALLS || 6);
const st = load();
st.n ||= 0;
const tot = { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
const lines = [];
let id = 0;
const rec = (payload_type, payload) => lines.push({ id: `rec-${++id}`, recorded_at: Date.now() * 1000, payload_type, payload });
rec("runtime.session.metadata", { record: { workspace_root: process.cwd() } });
let usd = 0;
for (let c = 0; c < calls; c++) {
  st.n++;
  const unc = 2000 + ((st.n * 397) % 3000);
  const cr = 30000 + ((st.n * 7919) % 20000);
  const out = 600 + ((st.n * 131) % 900);
  const u = { input_tokens: unc + cr, cache_read_tokens: cr, cache_write_tokens: 0, output_tokens: out, reasoning_tokens: Math.round(out * 0.3) };
  for (const k of Object.keys(tot)) tot[k] += u[k];
  usd += (unc * price.input + cr * price.cachedInput + out * price.output) / 1e6;
  if (process.env.FAKE_PER_CALL === "1") rec("runtime.session", { kind: "run", event: { kind: "model_completed", model, usage: u } });
}
st.used += usd / beta;
if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
fs.writeFileSync("done.txt", "ok\n");
const now = Date.now();
rec("run.usage", { model, model_calls: calls, usage: tot, allowance: { window: { used_percent: 3, resets_at_ms: now + 3 * 3600e3 }, weekly: { used_percent: st.used, resets_at_ms: now + 4 * 86400e3 } } });
for (const l of lines) console.log(JSON.stringify(l));
