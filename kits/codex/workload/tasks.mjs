/**
 * Fixed workload for the Codex quota runs. Version bumps whenever a prompt or starter file changes;
 * every run manifest records WORKLOAD_VERSION and the SHA-256 of the task set.
 *
 * Arm A: 20 self-contained Node.js coding tasks, multi-turn agentic work (high cache share).
 * Arm B: single-answer questions over a large unique synthetic CSV in the prompt (low cache share).
 */

import crypto from "node:crypto";

export const WORKLOAD_VERSION = "1";

const RULES = [
  "Rules: work only inside the current directory. Use Node.js built-ins only: no npm install, no network.",
  "Write tests with node:test and node:assert, run them with `node --test`, and finish when they pass.",
  "End with a two-line summary.",
].join(" ");

const t = (id, prompt, files = {}) => ({ id, prompt: `${prompt}\n\n${RULES}`, files });

export const TASKS_A = [
  t("lru", "Implement an LRU cache class in lru.mjs: constructor(capacity), get, set, has, delete, size, and keys() in most-recent-first order. Evict the least recently used entry when full. Cover eviction order, updates and capacity 1 in lru.test.mjs."),
  t("csv", "Write an RFC 4180 CSV parser in csv.mjs: parse(text) returns rows of strings. Handle quoted fields, escaped quotes, embedded newlines, CRLF and LF, and a trailing newline. Add stringify(rows) that round-trips. Test edge cases in csv.test.mjs."),
  t(
    "dates",
    "dates.mjs has bugs. Make every test in dates.test.mjs pass without changing the tests. Then add three more tests for leap-year edge cases.",
    {
      "dates.mjs": `export function isLeap(y) {\n  return y % 4 === 0;\n}\n\nexport function daysInMonth(y, m) {\n  // m is 1-12\n  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];\n}\n\nexport function addMonths(date, n) {\n  // date: {y, m, d}; clamp the day to the target month's length\n  const total = date.m + n;\n  const y = date.y + Math.floor(total / 12);\n  const m = total % 12;\n  return { y, m, d: date.d };\n}\n\nexport function dayOfYear({ y, m, d }) {\n  let n = d;\n  for (let i = 1; i <= m; i++) n += daysInMonth(y, i);\n  return n;\n}\n`,
      "dates.test.mjs": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { isLeap, daysInMonth, addMonths, dayOfYear } from "./dates.mjs";\n\ntest("leap years", () => {\n  assert.equal(isLeap(2024), true);\n  assert.equal(isLeap(1900), false);\n  assert.equal(isLeap(2000), true);\n});\ntest("days in month", () => {\n  assert.equal(daysInMonth(2023, 2), 28);\n  assert.equal(daysInMonth(2024, 2), 29);\n  assert.equal(daysInMonth(2024, 12), 31);\n});\ntest("add months clamps", () => {\n  assert.deepEqual(addMonths({ y: 2024, m: 1, d: 31 }, 1), { y: 2024, m: 2, d: 29 });\n  assert.deepEqual(addMonths({ y: 2024, m: 11, d: 15 }, 2), { y: 2025, m: 1, d: 15 });\n  assert.deepEqual(addMonths({ y: 2024, m: 3, d: 31 }, -1), { y: 2024, m: 2, d: 29 });\n});\ntest("day of year", () => {\n  assert.equal(dayOfYear({ y: 2023, m: 1, d: 1 }), 1);\n  assert.equal(dayOfYear({ y: 2024, m: 3, d: 1 }), 61);\n  assert.equal(dayOfYear({ y: 2023, m: 12, d: 31 }), 365);\n});\n`,
    }
  ),
  t("intervals", "In intervals.mjs implement merge(intervals), insert(intervals, interval) and subtract(a, b) for closed integer intervals [start, end]. Inputs may be unsorted and overlapping. Test them in intervals.test.mjs, including empty input and touching intervals."),
  t("calc", "Write an arithmetic expression evaluator in calc.mjs without eval or Function: numbers (incl. decimals), + - * / ^ (right-associative), unary minus, parentheses. Throw an Error with the character position on bad input. Test precedence and errors in calc.test.mjs."),
  t("mdtable", "Write mdtable.mjs exporting toTable(rows, columns?) that renders an array of objects as an aligned GitHub Markdown table (numbers right-aligned, strings left), and a CLI mode: `node mdtable.mjs < data.json` prints the table. Test both in mdtable.test.mjs."),
  t(
    "inventory",
    "inventory.mjs works but is one long function. Split it into small pure functions in separate modules (parse, validate, totals, report), keep `node inventory.mjs sample.txt` output byte-identical, and add unit tests for each module.",
    {
      "inventory.mjs": `import fs from "node:fs";\nconst text = fs.readFileSync(process.argv[2], "utf8");\nconst lines = text.split("\\n");\nconst items = [];\nconst errors = [];\nfor (let i = 0; i < lines.length; i++) {\n  const l = lines[i].trim();\n  if (!l || l.startsWith("#")) continue;\n  const parts = l.split(",");\n  if (parts.length !== 4) { errors.push("line " + (i + 1) + ": expected 4 fields"); continue; }\n  const sku = parts[0].trim();\n  const name = parts[1].trim();\n  const qty = Number(parts[2]);\n  const price = Number(parts[3]);\n  if (!/^[A-Z]{3}-\\d{3}$/.test(sku)) { errors.push("line " + (i + 1) + ": bad sku " + sku); continue; }\n  if (!Number.isInteger(qty) || qty < 0) { errors.push("line " + (i + 1) + ": bad qty"); continue; }\n  if (!(price >= 0)) { errors.push("line " + (i + 1) + ": bad price"); continue; }\n  items.push({ sku, name, qty, price });\n}\nconst byCat = {};\nlet total = 0;\nfor (const it of items) {\n  const cat = it.sku.slice(0, 3);\n  byCat[cat] = (byCat[cat] || 0) + it.qty * it.price;\n  total += it.qty * it.price;\n}\nconsole.log("items: " + items.length);\nfor (const c of Object.keys(byCat).sort()) console.log(c + ": " + byCat[c].toFixed(2));\nconsole.log("total: " + total.toFixed(2));\nif (errors.length) { console.log("errors:"); for (const e of errors) console.log("  " + e); }\n`,
      "sample.txt": `# sku,name,qty,price\nABC-001, widget, 4, 2.50\nABC-002, gadget, 1, 10\nXYZ-100, bolt, 250, 0.04\nbad-1, nope, 1, 1\nXYZ-101, nut, -3, 0.02\nQRS-555, spring, 12, 0.75\nQRS-556, lever\n`,
    }
  ),
  t("semver", "Implement semver.mjs: parse, compare (including prerelease ordering per semver 2.0.0), and satisfies(version, range) for exact, ^, ~, >=, <, and space-separated AND ranges. Test with at least 25 cases in semver.test.mjs."),
  t("toposort", "In toposort.mjs implement topoSort(graph) for a graph given as {node: [dependencies]}. Return a stable order (ties broken alphabetically). On a cycle, throw an Error whose message lists one cycle path like a -> b -> a. Test in toposort.test.mjs."),
  t("bucket", "Write a token-bucket rate limiter in bucket.mjs with an injectable clock: new Bucket({ capacity, refillPerSec, now }), tryTake(n), and msUntil(n). No timers. Test refill, burst, fractional refill and msUntil with a fake clock in bucket.test.mjs."),
  t("diff", "Write diff.mjs: diffLines(a, b) using the LCS algorithm, returning ops [{op: ' '|'-'|'+', line}], and format(ops, context = 3) that prints unified-diff hunks with @@ -l,s +l,s @@ headers. Test identical, empty and interleaved inputs in diff.test.mjs."),
  t("schema", "Write a small JSON Schema validator in schema.mjs supporting type, required, properties, additionalProperties: false, items, enum, minimum, maximum, minLength. validate(schema, value) returns a list of errors with JSON-pointer paths. Test nested objects and arrays in schema.test.mjs."),
  t(
    "ledger",
    "ledger.mjs has rounding and ordering bugs. Make every test in ledger.test.mjs pass without changing the tests. Keep amounts as integer cents internally.",
    {
      "ledger.mjs": `export class Ledger {\n  constructor() { this.entries = []; }\n  add(date, amount, memo = "") {\n    this.entries.push({ date, amount, memo });\n  }\n  balance(upTo) {\n    let b = 0;\n    for (const e of this.entries) if (!upTo || e.date < upTo) b += e.amount;\n    return b;\n  }\n  statement() {\n    let run = 0;\n    return this.entries.map((e) => { run += e.amount; return e.date + " " + e.amount.toFixed(2) + " " + run.toFixed(2) + (e.memo ? " " + e.memo : ""); });\n  }\n  split(amount, parts) {\n    const each = amount / parts;\n    return Array(parts).fill(each);\n  }\n}\n`,
      "ledger.test.mjs": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { Ledger } from "./ledger.mjs";\n\ntest("balance includes the day itself and sums exactly", () => {\n  const l = new Ledger();\n  l.add("2026-01-01", 0.1); l.add("2026-01-01", 0.2); l.add("2026-01-02", 5);\n  assert.equal(l.balance("2026-01-01"), 0.3);\n  assert.equal(l.balance(), 5.3);\n});\ntest("statement is in date order with running totals", () => {\n  const l = new Ledger();\n  l.add("2026-02-03", 10, "b"); l.add("2026-02-01", -2.5, "a");\n  assert.deepEqual(l.statement(), ["2026-02-01 -2.50 -2.50 a", "2026-02-03 10.00 7.50 b"]);\n});\ntest("split distributes cents", () => {\n  const l = new Ledger();\n  assert.deepEqual(l.split(10, 3), [3.34, 3.33, 3.33]);\n  assert.deepEqual(l.split(0.05, 2), [0.03, 0.02]);\n});\n`,
    }
  ),
  t("roman", "Write roman.mjs with toRoman(n) for 1..3999 and fromRoman(s) that rejects non-canonical numerals (IIII, VX, IC). Test the round trip for every value 1..3999 and the rejections in roman.test.mjs."),
  t("wrap", "Write wrap.mjs: wrap(text, width) that word-wraps paragraphs (blank-line separated), breaks words longer than width, and justify(text, width) that pads spaces evenly (last line left-aligned). Test both in wrap.test.mjs."),
  t("emitter", "Write an EventEmitter in emitter.mjs with on, once, off, emit, a '*' wildcard listener that receives (event, ...args), and listenerCount. Listeners removed during emit must not break iteration. Test ordering and removal in emitter.test.mjs."),
  t("dijkstra", "Write heap.mjs (binary min-heap with push, pop, peek, size and a comparator) and dijkstra.mjs: shortestPath(graph, from, to) on a weighted adjacency map returning { distance, path }, or null when unreachable. Test both in dijkstra.test.mjs."),
  t("ini", "Write ini.mjs: parse(text) for INI files with sections, key = value, ; and # comments, quoted values, and dotted section names into nested objects; stringify(obj) that parse() round-trips. Test in ini.test.mjs."),
  t("trie", "Write trie.mjs: insert(word, weight), remove(word), and complete(prefix, k) returning the top-k words by weight then alphabetically. Make complete efficient for large word lists. Test in trie.test.mjs, including 10,000 generated words."),
  t("argv", "Write argv.mjs: parseArgs(argv, spec) supporting --flag, --key value, --key=value, -abc short flag groups, --no-flag negation, repeated keys into arrays, and -- terminator; report unknown options as errors. Test in argv.test.mjs."),
];

// ---------------------------------------------------------------------------------------------
// Arm B
// ---------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const B_ROWS = 1400; // ≈ 30k tokens of CSV per prompt

/** Arm B item i: a unique synthetic sensor log and three questions about it. */
export function taskB(i, rows = B_ROWS) {
  const rnd = mulberry32(1000003 * (i + 1));
  const sensors = Array.from({ length: 24 }, (_, n) => `s${String(n + 1).padStart(2, "0")}-${Math.floor(rnd() * 900 + 100)}`);
  const metrics = ["temp", "humidity", "pressure", "vibration"];
  const statuses = ["ok", "ok", "ok", "ok", "ok", "warn", "fault"];
  let t0 = Date.parse("2026-01-01T00:00:00Z") + Math.floor(rnd() * 86400) * 1000 * 30;
  const lines = ["timestamp,sensor,metric,value,status"];
  for (let r = 0; r < rows; r++) {
    t0 += Math.floor(1 + rnd() * 120) * 1000;
    const m = metrics[Math.floor(rnd() * metrics.length)];
    const base = { temp: 20, humidity: 45, pressure: 1013, vibration: 0.3 }[m];
    const spread = { temp: 8, humidity: 20, pressure: 15, vibration: 0.5 }[m];
    const v = (base + (rnd() - 0.5) * 2 * spread).toFixed(m === "vibration" ? 3 : 2);
    lines.push(`${new Date(t0).toISOString()},${sensors[Math.floor(rnd() * sensors.length)]},${m},${v},${statuses[Math.floor(rnd() * statuses.length)]}`);
  }
  const prompt = [
    "Below is a synthetic sensor log in CSV. Do not run any commands or read any files; answer from the text only.",
    "1. Which sensor has the most rows with status fault, and how many?",
    "2. What is the highest temp value, with its timestamp and sensor?",
    "3. How many rows have each status?",
    "Reply in at most 80 words.",
    "",
    lines.join("\n"),
  ].join("\n");
  return { id: `b${String(i + 1).padStart(3, "0")}`, prompt, files: {} };
}

export function workloadHash() {
  const h = crypto.createHash("sha256");
  h.update(WORKLOAD_VERSION);
  for (const x of TASKS_A) h.update(JSON.stringify(x));
  h.update(taskB(0).prompt);
  h.update(String(B_ROWS));
  return h.digest("hex").slice(0, 16);
}
