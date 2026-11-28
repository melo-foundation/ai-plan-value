/**
 * Manual meter readings: the kit asks the user to type the dashboard value and checks the format.
 *
 * Accepted (case-insensitive, spaces optional):
 *   37 · 37% · 37.5 % · 37% used · used 37%      → 37 % used
 *   63% left · 63% remaining · left 63%          → 37 % used (only when the meter allows "left")
 *   skip                                         → no reading this time
 *   stop                                         → stop the run after this prompt
 */

import readline from "node:readline";

const NUM = String.raw`(\d{1,3}(?:[.,]\d+)?)`;
const USED_RES = [new RegExp(`^${NUM}\\s*%?$`), new RegExp(`^${NUM}\\s*%?\\s*used$`), new RegExp(`^used\\s*${NUM}\\s*%?$`)];
const LEFT_RES = [new RegExp(`^${NUM}\\s*%?\\s*(?:left|remaining)$`), new RegExp(`^(?:left|remaining)\\s*${NUM}\\s*%?$`)];

/**
 * Parse one typed reading. Returns { pct } (percent used), { skip: true }, { stop: true } or
 * { error } with what is wrong and what to type.
 */
export function parseManualReading(text, { allowLeft = true } = {}) {
  const s = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return { error: "empty: type the % used, e.g. 37" };
  if (s === "skip") return { skip: true };
  if (s === "stop" || s === "q" || s === "quit") return { stop: true };
  const num = (m) => Number(m[1].replace(",", "."));
  for (const re of USED_RES) {
    const m = s.match(re);
    if (m) return check(num(m));
  }
  for (const re of LEFT_RES) {
    const m = s.match(re);
    if (m) {
      if (!allowLeft) return { error: `"left" not accepted here: type the % used, e.g. 37` };
      const left = num(m);
      const c = check(left);
      return c.error ? c : { pct: round6(100 - left), typedLeft: left };
    }
  }
  return { error: `not a percentage: type the % used, e.g. 37 or 37.5% (or "63% left", "skip", "stop")` };
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

function check(x) {
  if (!Number.isFinite(x)) return { error: "not a number" };
  if (x < 0 || x > 100) return { error: `${x} is outside 0–100` };
  return { pct: x };
}

/**
 * Line reader over a stream (stdin by default) that works with a TTY and with piped input
 * (tests): lines are queued as they arrive and handed out in order.
 */
export function lineReader(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, terminal: false });
  const queue = [];
  const waiting = [];
  let closed = false;
  rl.on("line", (l) => {
    if (waiting.length) waiting.shift()(l);
    else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });
  return {
    /** Prompt and resolve with the next line, or null at end of input. */
    ask(prompt) {
      output.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((r) => waiting.push(r));
    },
    close() {
      rl.close();
    },
  };
}

/**
 * Ask until the reply parses. Returns the parse result; end of input counts as { stop: true }.
 */
export async function askReading(io, prompt, opts = {}) {
  for (let tries = 0; tries < 20; tries++) {
    const line = await io.ask(prompt);
    if (line == null) return { stop: true, eof: true };
    const r = parseManualReading(line, opts);
    if (!r.error) return r;
    (opts.out || process.stdout).write(`  ${r.error}\n`);
  }
  return { stop: true };
}
