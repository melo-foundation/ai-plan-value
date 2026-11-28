/**
 * Token-weight arms for the API plan kit, one token type each, generated from the run tag (the
 * text generators are the Codex kit's, kits/codex/workload/arms.mjs):
 *
 *   cache      one long fixed system prompt (≈ 40k tokens; Anthropic: cache_control), a one-word
 *              question per call: input served from the provider's prefix cache.
 *   input      a unique ≈ 30k-token user prompt per call (unique from its first line), one-word answer.
 *   output     a short prompt asking for 400 numbered lines, max_tokens 8000, reasoning effort low.
 *   reasoning  a short counting puzzle, reasoning effort high, max_tokens 16000.
 *   write      (Anthropic API) a unique long system prompt per call marked cache_control: every
 *              input token is a cache write.
 */

import crypto from "node:crypto";
import { cachePrefix, cacheWord, inputPrompt, outputPrompt, reasoningPrompt, NO_TOOLS } from "../../codex/workload/arms.mjs";

export const ARM_WORKLOAD_VERSION = "1";
export const API_ARMS = ["cache", "input", "output", "reasoning", "write"];
/** Kind each arm isolates (scripts/weights.mjs). */
export const ARM_KIND = { cache: "cached", input: "input", output: "output", reasoning: "reasoning", write: "cacheWrite" };
export const ARM_MAX_TOKENS = { cache: 16, input: 16, output: 8000, reasoning: 16000, write: 16 };
const SHORT = "Reply with exactly the word or number asked for and nothing else.";

/** Prompt n of an arm: { n, id, profile, system, user, cacheSystem, effort }. */
export function armPromptAt(arm, n, tag) {
  const id = `${arm[0]}${String(n + 1).padStart(4, "0")}`;
  const base = { n, id, profile: arm, cacheSystem: false, effort: null };
  if (arm === "cache") return { ...base, system: cachePrefix(tag), user: `Reply with the single word: ${cacheWord(tag, n)}.`, cacheSystem: true };
  if (arm === "input") return { ...base, system: SHORT, user: inputPrompt(tag, n) };
  if (arm === "output") return { ...base, system: SHORT, user: outputPrompt(tag, n), effort: "low" };
  if (arm === "reasoning") return { ...base, system: SHORT, user: reasoningPrompt(tag, n), effort: "high" };
  if (arm === "write") return { ...base, system: inputPrompt(`${tag}|write`, n), user: `${NO_TOOLS} Reply with the single word: ok.`, cacheSystem: true };
  throw new Error(`unknown arm ${arm}`);
}

export function armWorkloadHash() {
  const h = crypto.createHash("sha256");
  h.update(ARM_WORKLOAD_VERSION);
  for (const arm of API_ARMS) for (let n = 0; n < 2; n++) h.update(JSON.stringify(armPromptAt(arm, n, "hash")));
  return h.digest("hex").slice(0, 16);
}
