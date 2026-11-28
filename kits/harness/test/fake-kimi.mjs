#!/usr/bin/env node
/**
 * Stand-in for `kimi` (Kimi Code) in the run tests: no network.
 *   kimi --version
 *   kimi -p <prompt> --output-format stream-json -m kimi-code/<model>
 *       writes $KIMI_CODE_HOME/sessions/<ws>/<session>/agents/{main,agent-1}/wire.jsonl (step.end per
 *       call, usage.record per turn), prints stream-json lines with the session id, and moves the
 *       meter in $FAKE_METER by the task's API $ ÷ FAKE_BETA.
 *
 * env: KIMI_CODE_HOME, FAKE_METER, FAKE_BETA (default 0.5), FAKE_PRICE (JSON), FAKE_CALLS,
 *      FAKE_MODEL (recorded model), FAKE_NO_STEPS=1 (usage.record only).
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-V") {
  console.log("kimi-code 2.0.0-fake");
  process.exit(0);
}
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
if (opt("-p") == null || opt("--output-format") !== "stream-json") process.exit(1);
const alias = opt("-m") || "kimi-code/kimi-k3";
if (!alias.startsWith("kimi-code/")) process.exit(1);
const model = process.env.FAKE_MODEL || alias.slice("kimi-code/".length);
const price = JSON.parse(process.env.FAKE_PRICE || '{"input":3,"cachedInput":0.3,"output":15}');
const beta = Number(process.env.FAKE_BETA || 0.5);
const calls = Number(process.env.FAKE_CALLS || 6);
const meterPath = process.env.FAKE_METER;
const st = meterPath && fs.existsSync(meterPath) ? JSON.parse(fs.readFileSync(meterPath, "utf8")) : { used: 10, n: 0 };
st.n ||= 0;
const sid = `ses_fake_${process.pid}_${st.n}`;
const base = path.join(process.env.KIMI_CODE_HOME, "sessions", "wd_task_0123456789ab", sid, "agents");
const lines = { main: [], "agent-1": [] };
let usd = 0;
for (let c = 0; c < calls; c++) {
  st.n++;
  const u = { inputOther: 300 + ((st.n * 397) % 2000), output: 400 + ((st.n * 131) % 800), inputCacheRead: 15000 + ((st.n * 7919) % 15000), inputCacheCreation: 0 };
  usd += ((u.inputOther + u.inputCacheCreation) * price.input + u.inputCacheRead * price.cachedInput + u.output * price.output) / 1e6;
  const agent = c === calls - 1 ? "agent-1" : "main";
  if (process.env.FAKE_NO_STEPS !== "1") lines[agent].push({ type: "context.append_loop_event", event: { type: "step.end", uuid: `s${c}`, turnId: "t1", step: c, usage: u, finishReason: "end_turn" }, time: Date.now() });
  lines[agent].push({ type: "usage.record", model, usage: u, usageScope: "turn", time: Date.now() });
}
for (const [agent, recs] of Object.entries(lines)) {
  fs.mkdirSync(path.join(base, agent), { recursive: true });
  fs.writeFileSync(path.join(base, agent, "wire.jsonl"), [{ type: "metadata", protocol_version: "1.1" }, ...recs].map((r) => JSON.stringify(r)).join("\n") + "\n");
}
st.used += usd / beta;
if (meterPath) fs.writeFileSync(meterPath, JSON.stringify(st));
fs.writeFileSync("done.txt", "ok\n");
console.log(JSON.stringify({ role: "meta", type: "system.version", version: "2.0.0-fake" }));
console.log(JSON.stringify({ role: "assistant", content: "Done.", tool_calls: [] }));
console.log(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: sid, command: `kimi -S ${sid}`, content: "resume" }));
