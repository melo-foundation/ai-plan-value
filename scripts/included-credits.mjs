/**
 * Included credits: value a subscription bundles outside its coding quota (API / cloud credits, bundled products,
 * separate allowances). Recorded and shown per plan; never counted in subsidyMultiple or any cost.
 *
 * Each record: plan (billing key, see billingKey()), status, url + checked (the page read), credits:
 *   [{ kind, usdPerMonth (number when the official page states a $ amount per month, else null), text, url, checked }]
 *   status "listed"  — the official page lists at least one credit
 *          "none"    — the official page is readable and lists nothing outside the quota
 *          "unknown" — the official page could not be read or does not say; never filled with a guess.
 *                      Carries reason (UNKNOWN_REASONS in billing-periods.mjs) and tried (date last rendered).
 * The quota itself (Cursor included usage, Copilot AI Credits, Kilo / Ollama / Command Code credits) is not a credit here.
 */

import { billingKey, isAnnualVariant, monthlyTwinKey } from "./billing-periods.mjs";

export const CREDITS_CHECKED = "2026-11-26";
const C = CREDITS_CHECKED;
const GOOGLE_ONE = "https://one.google.com/intl/en_us/about/google-ai-plans/";
const X_PREMIUM = "https://docs.x.ai/x-subscription/x-premium";
const KIMI_HELP = "https://www.kimi.com/en/help/membership/membership-pricing";

const none = (plan, url, extra = {}) => ({ plan, status: "none", url, checked: C, credits: [], ...extra });
const unknown = (plan, url, reason, extra = {}) => ({ plan, status: "unknown", url, checked: C, credits: [], reason, tried: C, ...extra });
const listed = (plan, url, credits, extra = {}) => ({ plan, status: "listed", url, checked: C, credits: credits.map((c) => ({ url, checked: C, ...c })), ...extra });

// prettier-ignore
export const INCLUDED_CREDITS = [
  // Anthropic — claude.com/pricing; per-plan amounts: platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
  // ("Free, Pro, and Enterprise plans aren't eligible"). Credits cover the Claude API, not Claude Code; expire each billing cycle.
  none("Claude Pro", "https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers"),
  listed("Claude Max", "https://claude.com/pricing", [{ kind: "API credits", usdPerMonth: 100, text: "$100 a month in API credits to build on the Claude Platform" }]),
  listed("Claude Ultra", "https://claude.com/pricing", [{ kind: "API credits", usdPerMonth: 200, text: "$200 a month in API credits" }]),
  listed("Claude Team Premium", "https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers", [{ kind: "API credits", usdPerMonth: 100, text: "Team, Premium seat: $100 per seat, pooled into one monthly balance capped at $500" }]),

  // OpenAI — developers.openai.com/api/docs/guides/chatgpt-api-credits ("Pro ($100 tier) | $100" …); Plus: "Monthly API credits: No".
  none("ChatGPT Plus", "https://help.openai.com/en/articles/20001626"),
  listed("ChatGPT Pro 10x", "https://developers.openai.com/api/docs/guides/chatgpt-api-credits", [{ kind: "API credits", usdPerMonth: 100, text: "Pro ($100 tier) | $100" }]),
  listed("ChatGPT Pro 20x", "https://developers.openai.com/api/docs/guides/chatgpt-api-credits", [{ kind: "API credits", usdPerMonth: 200, text: "Pro ($200 tier) | $200" }]),
  listed("ChatGPT Pro 500", "https://developers.openai.com/api/docs/guides/chatgpt-api-credits", [{ kind: "API credits", usdPerMonth: 500, text: "Pro ($500 tier) | $500" }]),

  // Google — developers.google.com/profile/help/benefits (cloud credits, expire one year after grant); one.google.com plans page (products).
  listed("Google AI Pro", "https://developers.google.com/profile/help/benefits", [
    { kind: "Google Cloud credits", usdPerMonth: 10, text: "Google AI Pro: $10 USD per month in GenAI and Google Cloud developer credits" },
    { kind: "5 TB storage", usdPerMonth: null, text: "5 TB of cloud storage across Gmail, Drive and Photos", url: GOOGLE_ONE },
    { kind: "YouTube Premium Lite", usdPerMonth: 8.99, text: "YouTube Premium Lite individual plan … Premium Lite ($8.99)", url: GOOGLE_ONE },
    { kind: "Google Home Premium Standard", usdPerMonth: 10, text: "Google Home Premium Standard plan at no cost (US$10/month value)", url: GOOGLE_ONE },
    { kind: "Google Health Premium", usdPerMonth: null, text: "A Google AI Ultra or AI Pro subscription includes Google Health Premium for no extra cost.", url: GOOGLE_ONE },
  ]),
  listed("Google AI Ultra 5x", "https://developers.google.com/profile/help/benefits", [
    { kind: "Google Cloud credits", usdPerMonth: 40, text: "Google AI Ultra 5x: $40 USD per month in GenAI and Google Cloud developer credits" },
    { kind: "20 TB storage", usdPerMonth: null, text: "Cloud storage starting at 20 TB across Gmail, Drive, and Photos.", url: GOOGLE_ONE },
    { kind: "YouTube Premium Family", usdPerMonth: 26.99, text: "Included in Ultra: YouTube Premium Family ($26.99/mo)", url: GOOGLE_ONE },
    { kind: "Google Home Premium Advanced", usdPerMonth: 20, text: "Google Home Premium Advanced plan at no cost (US$20/mo value)", url: GOOGLE_ONE },
    { kind: "Google Health Premium", usdPerMonth: null, text: "A Google AI Ultra or AI Pro subscription includes Google Health Premium for no extra cost.", url: GOOGLE_ONE },
    { kind: "10,000 Flow credits/mo", usdPerMonth: null, text: "Google Flow Credits: 10,000/mo", url: GOOGLE_ONE },
    { kind: "1,000 Colab compute units/mo", usdPerMonth: null, text: "Google Colab (Compute units): 1,000/mo", url: GOOGLE_ONE },
  ]),
  listed("Google AI Ultra 20x", "https://developers.google.com/profile/help/benefits", [
    { kind: "Google Cloud credits", usdPerMonth: 100, text: "Google AI Ultra 20x: $100 USD per month in GenAI and Google Cloud developer credits" },
    { kind: "30 TB storage", usdPerMonth: null, text: "30 TB (plans comparison table, storage row)", url: GOOGLE_ONE },
    { kind: "YouTube Premium Family", usdPerMonth: 26.99, text: "Included in Ultra: YouTube Premium Family ($26.99/mo)", url: GOOGLE_ONE },
    { kind: "Google Home Premium Advanced", usdPerMonth: 20, text: "Google Home Premium Advanced plan at no cost (US$20/mo value)", url: GOOGLE_ONE },
    { kind: "Google Health Premium", usdPerMonth: null, text: "A Google AI Ultra or AI Pro subscription includes Google Health Premium for no extra cost.", url: GOOGLE_ONE },
    { kind: "25,000 Flow credits/mo", usdPerMonth: null, text: "Google Flow Credits: 25,000/mo", url: GOOGLE_ONE },
    { kind: "2,000 Colab compute units/mo", usdPerMonth: null, text: "Google Colab (Compute units): 2,000/mo", url: GOOGLE_ONE },
  ]),

  // xAI — docs.x.ai/x-subscription/pricing. Cursor access is the shared weekly pool (the quota); x.ai/pricing: "API usage is billed
  // separately … and doesn't draw from your plan's usage pool" (no included API credit). docs.x.ai/x-subscription/x-premium:
  // "Premium, Super, and Ultra: full X Premium+ benefits".
  listed("X Plus", "https://docs.x.ai/x-subscription/pricing", [{ kind: "X Premium", usdPerMonth: null, text: "Paid individual plans include X Premium benefits when you connect your X account." }]),
  listed("X Premium", X_PREMIUM, [{ kind: "X Premium+", usdPerMonth: null, text: "Premium, Super, and Ultra: full X Premium+ benefits" }]),
  listed("X Super", X_PREMIUM, [{ kind: "X Premium+", usdPerMonth: null, text: "Premium, Super, and Ultra: full X Premium+ benefits" }]),
  listed("X Ultra", "https://docs.x.ai/x-subscription/pricing", [{ kind: "X Premium", usdPerMonth: null, text: "Paid individual plans include X Premium benefits when you connect your X account." }]),
  // Legacy SuperGrok tiers: x.ai/pricing renders (headless Chrome) and lists only The X Subscription tiers; docs.x.ai/grok/faq
  // and docs.x.ai/x-subscription/pricing ("Existing Cursor, SuperGrok, and X Premium plans continue") do not list tier contents.
  unknown("SuperGrok Lite", "https://x.ai/pricing", "not-stated"),
  unknown("SuperGrok", "https://x.ai/pricing", "not-stated"),
  unknown("SuperGrok Plus", "https://x.ai/pricing", "not-stated"),
  unknown("SuperGrok Heavy", "https://x.ai/pricing", "not-stated"),
  unknown("SuperGrok Lite, legacy", "https://x.ai/pricing", "not-stated"),
  unknown("SuperGrok, legacy", "https://x.ai/pricing", "not-stated"),
  unknown("SuperGrok Plus, legacy", "https://x.ai/pricing", "not-stated"),
  unknown("SuperGrok Heavy, legacy", "https://x.ai/pricing", "not-stated"),

  // Cursor — legacy plans page: Cursor Models + Other Models pools are the quota; the "Grok" and "X" rows read "Not included".
  none("Cursor Pro", "https://cursor.com/docs/account/pricing/legacy-cursor-plans", { legacy: true }),
  none("Cursor Pro+", "https://cursor.com/docs/account/pricing/legacy-cursor-plans", { legacy: true }),
  none("Cursor Ultra", "https://cursor.com/docs/account/pricing/legacy-cursor-plans", { legacy: true }),

  // GitHub — AI Credits (base + flex) are the quota; no separate premium-request allowance on monthly plans.
  none("GitHub Copilot Pro", "https://github.com/features/copilot/plans"),
  none("GitHub Copilot Pro+", "https://github.com/features/copilot/plans"),
  none("GitHub Copilot Max", "https://github.com/features/copilot/plans"),

  // Mistral — no amount published for the API allowance.
  listed("Mistral Vibe Pro", "https://docs.mistral.ai/admin/billing-usage/subscriptions", [{ kind: "API allowance", usdPerMonth: null, text: "Each Mistral plan includes both Vibe & Studio usage and API usage, as two separate monthly allowances." }]),

  // Cognition / Factory / OpenCode / Command Code / Ollama / Kilo — every listed credit is the coding quota itself.
  none("Devin Pro", "https://devin.ai/pricing"),
  none("Devin Max", "https://devin.ai/pricing"),
  none("Droid Pro", "https://factory.com/pricing"),
  none("Droid Max", "https://factory.com/pricing"),
  none("OpenCode Go", "https://opencode.ai/go"),
  none("OpenCode Go Plus", "https://opencode.ai/go"),
  none("OpenCode Go Teams", "https://opencode.ai/go"),
  none("Command Code GOAT", "https://commandcode.ai/pricing"),
  none("Command Code Max 10×", "https://commandcode.ai/pricing"),
  none("Ollama Pro", "https://ollama.com/pricing"),
  none("Ollama Max", "https://ollama.com/pricing"),
  none("Ollama Team", "https://ollama.com/pricing"),
  none("Kilo Pass Starter", "https://kilo.ai/pricing/kilo-pass"),
  none("Kilo Pass Pro", "https://kilo.ai/pricing/kilo-pass"),
  none("Kilo Pass Expert", "https://kilo.ai/pricing/kilo-pass"),

  // DeepRelay — web search in Claude Code and Codex, separate from the token caps.
  listed("DeepRelay Base", "https://deeprelay.ai/pricing", [{ kind: "100 web searches/mo", usdPerMonth: null, text: "Web search in Claude Code and Codex: 100 searches a month included" }]),
  listed("DeepRelay Plus", "https://deeprelay.ai/pricing", [{ kind: "500 web searches/mo", usdPerMonth: null, text: "Web search in Claude Code and Codex: 500 searches a month included" }]),

  // Kimi — membership-pricing: Agent / Claw / storage perks "共享一个额度池" with Kimi Code (one quota, not a credit).
  // Moderato / Allegretto / Allegro (legacy, en help page): "Legacy plans retain both a rolling 5-hour Kimi Code limit and a weekly limit.
  // … Both use the monthly shared credit pool." / "All membership features share one credit pool."
  none("Kimi Plus", "https://www.kimi.com/help/membership/membership-pricing"),
  none("Kimi Pro", "https://www.kimi.com/help/membership/membership-pricing"),
  none("Kimi Max", "https://www.kimi.com/help/membership/membership-pricing"),
  none("Kimi Ultra", "https://www.kimi.com/help/membership/membership-pricing"),
  none("Kimi Moderato", KIMI_HELP),
  none("Kimi Allegretto", KIMI_HELP),
  none("Kimi Allegro", KIMI_HELP),
  none("Kimi Moderato, legacy", KIMI_HELP),
  none("Kimi Allegretto, legacy", KIMI_HELP),
  none("Kimi Allegro, legacy", KIMI_HELP),

  // Zhipu — coding-plan/overview: web search / reader / zread / vision draw from the same 5h + weekly pool. Existing-subscriber
  // terms (an older separate monthly MCP call count) are not on the signed-out bigmodel.cn/glm-coding page (headless Chrome, "登录 / 注册").
  none("GLM Coding Lite ¥118", "https://docs.bigmodel.cn/cn/coding-plan/overview"),
  none("GLM Coding Pro ¥538", "https://docs.bigmodel.cn/cn/coding-plan/overview"),
  none("GLM Coding Max ¥1078", "https://docs.bigmodel.cn/cn/coding-plan/overview"),
  unknown("GLM Coding Lite ¥49, existing subscribers", "https://bigmodel.cn/glm-coding", "login"),
  unknown("GLM Coding Pro ¥149, existing subscribers", "https://bigmodel.cn/glm-coding", "login"),
  unknown("GLM Coding Max ¥469, existing subscribers", "https://bigmodel.cn/glm-coding", "login"),

  // MiniMax — M Plan: "M Plan 包含的所有模型共用同一份周额度" (image / speech / video share the quota). Token Plan (legacy): subscribe/token-plan
  // now shows M Plan only; m-plan/token-plan-notice lists text M3.1 Flash + image H3 Image and "当前的套餐与权益保持不变", with no statement
  // whether image use draws from the text quota. App Store Token Plan buyers get one-off 积分 (valid 1 year) when renewal ends.
  none("MiniMax M Plan Go (CN)", "https://platform.minimaxi.com/docs/m-plan/faq"),
  none("MiniMax M Plan Explore (CN)", "https://platform.minimaxi.com/docs/m-plan/faq"),
  none("MiniMax M Plan Build (CN)", "https://platform.minimaxi.com/docs/m-plan/faq"),
  unknown("MiniMax Token Plan Plus", "https://platform.minimaxi.com/docs/m-plan/token-plan-notice", "not-stated"),
  unknown("MiniMax Token Plan Max", "https://platform.minimaxi.com/docs/m-plan/token-plan-notice", "not-stated"),
  unknown("MiniMax Token Plan Ultra", "https://platform.minimaxi.com/docs/m-plan/token-plan-notice", "not-stated"),
  unknown("MiniMax Token Plan Plus (Global)", "https://platform.minimax.io/docs/m-plan/token-plan-notice", "not-stated"),
  unknown("MiniMax Token Plan Max (Global)", "https://platform.minimax.io/docs/m-plan/token-plan-notice", "not-stated"),
  unknown("MiniMax Token Plan Ultra (Global)", "https://platform.minimax.io/docs/m-plan/token-plan-notice", "not-stated"),

  // Alibaba — token-plan-harness-benefits: "Harness 权益消耗独立计量，不从套餐 Credits 或用量包抵扣" (metered apart from the plan); Standard and Pro only.
  none("阿里云百炼 Token Plan Lite (¥39)", "https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits"),
  none("阿里云百炼 Token Plan Essential (¥79)", "https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits"),
  listed("阿里云百炼 Token Plan Standard (¥139)", "https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits", [{ kind: "Harness tools", usdPerMonth: null, text: "赠送 Harness 权益 (per month: 100 enhanced web searches, 100 vertical searches, 1,000 page parses, 20 images, 10,000 TTS chars, 5 h ASR, 100 code-interpreter runs)" }]),
  listed("阿里云百炼 Token Plan Pro (¥312)", "https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits", [{ kind: "Harness tools", usdPerMonth: null, text: "赠送 Harness 权益 (per month: 500 enhanced web searches, 500 vertical searches, 5,000 page parses, 50 images, 10,000 TTS chars, 5 h ASR, 500 code-interpreter runs)" }]),
  none("Qwen Token Plan Standard", "https://www.alibabacloud.com/campaign/ai-landing-page-token"),

  // Tencent — points only; vouchers apply at renewal.
  none("Tencent Token Plan Lite", "https://www.tencentcloud.com/document/product/1300/81315"),
  none("Tencent Token Plan Standard", "https://www.tencentcloud.com/document/product/1300/81315"),
  none("Tencent Token Plan Pro", "https://www.tencentcloud.com/document/product/1300/81315"),
  none("Tencent Token Plan Max", "https://www.tencentcloud.com/document/product/1300/81315"),

  // Xiaomi — mimo.mi.com docs (platform.xiaomimimo.com/token-plan renders title only). Limited-time offer.
  ...["Lite", "Standard", "Pro", "Max"].map((t) =>
    listed(`MiMo Token Plan ${t}`, "https://mimo.mi.com/docs/en-US/price/token-plan", [{ kind: "free TTS (limited time)", usdPerMonth: null, text: "The TTS series models are available for free for a limited time and will not consume your plan credits." }])
  ),

  // StepFun — platform.stepfun.com/step-plan (headless Chrome; local DNS fails, public DNS resolves): "Studio 可额外使用相当于套餐 40% 的专属创作额度".
  // Mini ¥49 and Max ¥699 are no longer listed (Max is now ¥399).
  unknown("Step Plan Mini (¥49)", "https://platform.stepfun.com/step-plan", "not-stated"),
  ...["Plus (¥99)", "Pro (¥199)"].map((t) =>
    listed(`Step Plan ${t}`, "https://platform.stepfun.com/step-plan", [{ kind: "Studio creation quota (40% of plan)", usdPerMonth: null, text: "Studio 可额外使用相当于套餐 40% 的专属创作额度。地址：studio.stepfun.com" }])
  ),
  unknown("Step Plan Max (¥699)", "https://platform.stepfun.com/step-plan", "not-stated"),
];

const SNAP_KEYS = ["subsidyMultiple", "priceUsd", "priceUsdMonthly", "priceUsdYearly", "realUsdPerMtok", "aaCostPerTaskUsd"];

function findRecord(key, byPlan) {
  if (byPlan.has(key)) return byPlan.get(key);
  const base = key.replace(/,\s*legacy$/i, "");
  const rec = byPlan.get(base);
  return rec && rec.legacy ? rec : null;
}

/**
 * Adds to every subscription entry:
 *   includedCredits        [{ kind, usdPerMonth, text, url, checked }] (copy of the record's credits; [] for none / unknown)
 *   includedCreditsStatus  "listed" | "none" | "unknown" (unknown also when no record matches)
 * Throws if any cost field changes, so the credits can never leak into the subsidy.
 */
export function applyIncludedCredits(entries, { log = () => {} } = {}) {
  const byPlan = new Map(INCLUDED_CREDITS.map((r) => [r.plan, r]));
  const stats = { checked: CREDITS_CHECKED, listed: 0, none: 0, unknown: 0, unmatched: [], subsidyUnchanged: true };
  const unmatched = new Set();
  for (const e of entries) {
    if (e.billing !== "subscription") continue;
    const snap = SNAP_KEYS.map((k) => e[k]);
    const key = isAnnualVariant(e.plan) ? monthlyTwinKey(e.plan) : billingKey(e.plan);
    const rec = findRecord(key, byPlan);
    if (!rec) unmatched.add(key);
    e.includedCredits = rec ? rec.credits.map((c) => ({ kind: c.kind, usdPerMonth: c.usdPerMonth ?? null, text: c.text, url: c.url, checked: c.checked })) : [];
    e.includedCreditsStatus = rec ? rec.status : "unknown";
    stats[e.includedCreditsStatus]++;
    if (SNAP_KEYS.some((k, i) => !Object.is(e[k], snap[i]))) throw new Error(`Included credits changed a cost field on ${e.id}`);
  }
  stats.unmatched = [...unmatched].sort();
  if (stats.unmatched.length) log(`Included credits: no record for ${stats.unmatched.length} plans: ${stats.unmatched.join("; ")}`);
  return stats;
}
