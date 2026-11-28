/**
 * Fixed workload for the API plan kit: coding-style prompts sent straight to the provider API.
 *
 * Two cache profiles, in a fixed 2:1 cycle:
 *   shared  — one long system prompt (a synthetic code base, ~6k tokens) that never changes, plus a
 *             short task. Providers with prefix caching serve most of the input from cache.
 *   unique  — a short system prompt plus a synthetic module (~2.5k tokens) generated from the run tag
 *             and the prompt index, so no two prompts (and no two runs) share a long prefix.
 *
 * Everything is generated from fixed seeds: the same tag gives the same prompts byte for byte.
 * WORKLOAD_VERSION bumps whenever a prompt changes; every run records it and workloadHash().
 */

import crypto from "node:crypto";

export const WORKLOAD_VERSION = "1";
export const CYCLE = ["shared", "shared", "unique"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (s) => crypto.createHash("sha256").update(String(s)).digest().readUInt32LE(0);

const NOUNS = ["order", "invoice", "ledger", "cart", "token", "session", "route", "queue", "batch", "report", "account", "shipment", "coupon", "price", "stock", "user", "event", "metric", "cache", "job"];
const VERBS = ["parse", "validate", "merge", "split", "normalize", "score", "rank", "group", "filter", "apply", "resolve", "build", "load", "flush", "retry", "format", "sum", "diff", "index", "plan"];
const FIELDS = ["id", "amount", "createdAt", "status", "owner", "tags", "qty", "unit", "region", "weight", "priority", "deadline"];

/** One synthetic JavaScript function: plausible code with a few deliberate rough edges. */
function synthFunction(rnd, n) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const name = `${pick(VERBS)}${pick(NOUNS).replace(/^./, (c) => c.toUpperCase())}${n}`;
  const a = pick(FIELDS);
  const b = pick(FIELDS);
  const k = 2 + Math.floor(rnd() * 9);
  const body = [
    `export function ${name}(items, opts = {}) {`,
    `  // ${pick(VERBS)}s each ${pick(NOUNS)} by ${a}, then ${pick(VERBS)}s the result by ${b}`,
    `  const limit = opts.limit ?? ${k * 10};`,
    `  const out = [];`,
    `  for (let i = 0; i <= items.length; i++) {`,
    `    const it = items[i];`,
    `    if (!it || it.${a} == null) continue;`,
    `    const key = String(it.${b} ?? "none").trim().toLowerCase();`,
    `    const prev = out.find((x) => x.key === key);`,
    `    if (prev) prev.total += Number(it.${a}) || 0;`,
    `    else out.push({ key, total: Number(it.${a}) || 0, first: i });`,
    `    if (out.length > limit) break;`,
    `  }`,
    `  out.sort((x, y) => y.total - x.total || x.first - y.first);`,
    `  return opts.top ? out.slice(0, ${k}) : out;`,
    `}`,
  ];
  return { name, text: body.join("\n") };
}

function synthModule(seed, count) {
  const rnd = mulberry32(seed);
  const fns = [];
  for (let i = 0; i < count; i++) fns.push(synthFunction(rnd, i + 1));
  return fns;
}

const RULES = "You are a senior engineer reviewing JavaScript. Answer with code first, then at most five short bullet points. No preamble.";

const SHARED_FNS = synthModule(20261128, 44);
export const SHARED_SYSTEM = [RULES, "", "The code base under review (src/lib.mjs):", "", "```js", ...SHARED_FNS.map((f) => f.text + "\n"), "```"].join("\n");

const TASKS = [
  (f) => `Find the bugs in ${f} and give a corrected version.`,
  (f) => `Write node:test unit tests for ${f}, covering empty input, missing fields and ties.`,
  (f) => `Refactor ${f} into two smaller pure functions without changing its output.`,
  (f) => `Rewrite ${f} to run in O(n) and explain the change in one bullet.`,
  (f) => `Add JSDoc types to ${f} and make it reject invalid options with a clear Error.`,
  (f) => `Port ${f} to TypeScript with strict types.`,
  (f) => `${f} is slow on 1e6 items. Profile it by reading and give a faster version.`,
  (f) => `Write a property-based test (no libraries) that checks ${f} never returns more than opts.limit groups.`,
];

/**
 * Prompt n of a run (0-based). tag makes the unique prompts unique per run; shared prompts do not
 * depend on it.
 */
export function promptAt(n, tag = "") {
  const profile = CYCLE[n % CYCLE.length];
  const task = TASKS[n % TASKS.length];
  if (profile === "shared") {
    const f = SHARED_FNS[(n * 7) % SHARED_FNS.length].name;
    return { n, id: `s${String(n + 1).padStart(4, "0")}`, profile, system: SHARED_SYSTEM, user: task(`${f} in src/lib.mjs`), cacheSystem: true };
  }
  const fns = synthModule(seedOf(`${tag}|${n}`), 18);
  const f = fns[n % fns.length].name;
  const user = ["Module src/unique.mjs:", "", "```js", ...fns.map((x) => x.text + "\n"), "```", "", task(`${f} in src/unique.mjs`)].join("\n");
  return { n, id: `u${String(n + 1).padStart(4, "0")}`, profile, system: RULES, user, cacheSystem: false };
}

export function workloadHash() {
  const h = crypto.createHash("sha256");
  h.update(WORKLOAD_VERSION);
  h.update(SHARED_SYSTEM);
  for (let n = 0; n < 24; n++) h.update(JSON.stringify(promptAt(n, "hash")));
  return h.digest("hex").slice(0, 16);
}

/** Rough token counts (4 chars per token) for the run estimates. */
export function approxTokens() {
  const shared = Math.round((SHARED_SYSTEM.length + 120) / 4);
  const unique = Math.round((promptAt(2, "x").user.length + RULES.length) / 4);
  return { shared, unique };
}
