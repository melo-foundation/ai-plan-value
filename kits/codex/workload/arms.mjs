/**
 * Token-weight arms for the Codex quota kit. Each arm's calls are dominated by one token type:
 *
 *   cache      one long fixed prefix (≈ 40k tokens) sent as the first message of a session, then
 *              `codex exec resume` on that session with a one-word question per call: the resent
 *              context is served from the prompt cache (rollout cached_input_tokens).
 *   input      a unique ≈ 30k-token prompt per call (unique from its first line), one-word answer.
 *   output     a short prompt asking for 400 numbered lines, lowest effort.
 *   reasoning  a short counting puzzle at high effort, number-only answer.
 *
 * Every prompt is generated from the run tag and the call index: the same tag gives the same
 * prompts byte for byte. ARM_WORKLOAD_VERSION bumps whenever a prompt changes; armWorkloadHash()
 * goes into the run manifest.
 */

import crypto from "node:crypto";

export const ARM_WORKLOAD_VERSION = "1";
export const WEIGHT_ARMS = ["cache", "input", "output", "reasoning"];
/** Token type each arm isolates (kind names of scripts/weights.mjs). */
export const ARM_KIND = { cache: "cached", input: "input", output: "output", reasoning: "reasoning" };
export const NO_TOOLS = "Answer in this message only: do not run commands, call tools or read files.";
export const CACHE_PREFIX_ROWS = 3200; // ≈ 40k tokens
export const INPUT_ROWS = 2400; // ≈ 30k tokens
export const OUTPUT_LINES = 400; // ≈ 6k output tokens

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

const WORDS = ["amber", "basalt", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lagoon", "maple", "nectar", "onyx", "pepper", "quartz", "raven", "saffron", "tundra", "umber", "violet", "willow", "xenon", "yarrow", "zephyr", "acorn", "birch", "cobalt", "dune", "falcon", "glacier"];
const REGIONS = ["north", "south", "east", "west", "central", "coastal", "upland", "delta"];

/** n rows of a synthetic parts table, seeded. */
function table(seed, n) {
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const rows = ["id,part,lot,region,weight_kg,grade"];
  for (let i = 0; i < n; i++) rows.push(`${String(i + 1).padStart(5, "0")},${pick(WORDS)}-${pick(WORDS)},${Math.floor(rnd() * 9000 + 1000)},${pick(REGIONS)},${(rnd() * 90 + 1).toFixed(2)},${"ABCD"[Math.floor(rnd() * 4)]}`);
  return rows.join("\n");
}

/** Word the n-th cache call asks for. */
export const cacheWord = (tag, n) => WORDS[seedOf(`${tag}|cache|${n}`) % WORDS.length];

/** Fixed long prefix of a cache stream: the same for every stream of a tag. */
export function cachePrefix(tag) {
  return [
    NO_TOOLS,
    "Below is a reference table. Each later message asks for one word; reply with exactly that word and nothing else.",
    "",
    table(seedOf(`${tag}|cache-prefix`), CACHE_PREFIX_ROWS),
  ].join("\n");
}

/** First message of a cache stream (long), and every later message (short). */
export function cacheFirst(tag) {
  return `${cachePrefix(tag)}\n\nReply with the single word: ready.`;
}
export function cacheTurn(tag, n) {
  return `${NO_TOOLS} Reply with the single word: ${cacheWord(tag, n)}.`;
}
/** --cache-mode fresh: a new session per call, the same long prefix, a short varying suffix. */
export function cacheFresh(tag, n) {
  return `${cachePrefix(tag)}\n\nReply with the single word: ${cacheWord(tag, n)}.`;
}

/** Input arm item n: unique from its first line. */
export function inputPrompt(tag, n) {
  return [`Reference ${tag} #${n + 1} (${seedOf(`${tag}|input|${n}`).toString(16)}).`, NO_TOOLS, "Read the table below, then reply with the single word: ok.", "", table(seedOf(`${tag}|input|${n}`), INPUT_ROWS), "", "Reply with the single word: ok."].join("\n");
}

/** Output arm item n: a short prompt with a long answer. */
export function outputPrompt(tag, n) {
  const rnd = mulberry32(seedOf(`${tag}|output|${n}`));
  const words = [...WORDS];
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }
  words.length = 12;
  return `${NO_TOOLS}\nWrite exactly ${OUTPUT_LINES} numbered lines, 1 to ${OUTPUT_LINES}. Line i is the number i, a period, then eight words from this list in any order: ${words.join(", ")}. No other text before or after the lines.`;
}

/** Reasoning arm item n: a short puzzle with a number-only answer. */
export function reasoningPrompt(tag, n) {
  const rnd = mulberry32(seedOf(`${tag}|reasoning|${n}`));
  const N = 200 + Math.floor(rnd() * 300);
  const m = 7 + Math.floor(rnd() * 24);
  const r = Math.floor(rnd() * m);
  const k = 3 + Math.floor(rnd() * 5);
  const kinds = [
    `How many ordered pairs of integers (x, y) with 1 ≤ x, y ≤ ${N} satisfy x² + ${k}·y² ≡ ${r} (mod ${m})?`,
    `How many integers n with 1 ≤ n ≤ ${N * 20} have a digit sum divisible by ${k} and leave remainder ${r} when divided by ${m}?`,
    `How many subsets of {1, 2, …, ${12 + (N % 9)}} have a sum divisible by ${m}?`,
  ];
  return `${NO_TOOLS}\n${kinds[n % kinds.length]} Work it out exactly. Reply with the number only.`;
}

/** Prompt of call n of an arm (the cache arm's first call of a stream is cacheFirst). */
export function armPrompt(arm, tag, n) {
  if (arm === "cache") return cacheTurn(tag, n);
  if (arm === "input") return inputPrompt(tag, n);
  if (arm === "output") return outputPrompt(tag, n);
  if (arm === "reasoning") return reasoningPrompt(tag, n);
  throw new Error(`unknown arm ${arm}`);
}

export function armWorkloadHash() {
  const h = crypto.createHash("sha256");
  h.update(ARM_WORKLOAD_VERSION);
  h.update(cacheFirst("hash"));
  for (let n = 0; n < 3; n++) for (const arm of WEIGHT_ARMS) h.update(armPrompt(arm, "hash", n));
  h.update(cacheFresh("hash", 0));
  return h.digest("hex").slice(0, 16);
}
