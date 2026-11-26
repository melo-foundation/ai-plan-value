/**
 * Billing periods: official monthly vs annual list prices per subscription plan.
 *
 * Each record: plan (billing key, see billingKey()), currency, monthly (list price per month),
 * annual (total per year), status:
 *   "official" — annual total read from the official page at `url` on `checked`
 *   "none"     — official page/help center states there is no annual option
 *   "unknown"  — annual option exists or may exist but no official figure could be confirmed
 * Unknown and none rows keep their monthly price in Yearly mode. Never fill an unknown with a guess.
 * Every "unknown" record carries reason (one of UNKNOWN_REASONS) and tried (date the page was last rendered):
 *   blocked    — the page refuses automated fetches and headless Chrome (403 / bot wall)
 *   login      — the figure is only shown to signed-in or existing subscribers
 *   dns        — the host does not resolve
 *   not-stated — the page renders and does not state the figure
 *   js-only    — the figure needs client interaction the page watch cannot reproduce
 *
 * priceUsdYearly = priceUsd × (annual / 12) / monthly, so CNY rows inherit the build's
 * USD/CNY handling of priceUsd (live ECB rate or Fei2411's dated rate) unchanged.
 */

export const BILLING_CHECKED = "2026-11-26";
export const UNKNOWN_REASONS = ["blocked", "login", "dns", "not-stated", "js-only"];
const C = BILLING_CHECKED;
const T = { tried: C };
const GOOGLE_ONE = "https://one.google.com/intl/en_us/about/google-ai-plans/";
const X_PRICING = "https://docs.x.ai/x-subscription/pricing";

// prettier-ignore
export const BILLING_PERIODS = [
  // Anthropic — https://claude.com/pricing: Pro "$17 per month, $200 billed up front"; Team Premium "$100 per seat/month if billed annually"; Max/Ultra no annual toggle.
  { plan: "Claude Pro", currency: "USD", monthly: 20, annual: 200, status: "official", url: "https://claude.com/pricing", checked: C },
  { plan: "Claude Max", currency: "USD", monthly: 100, annual: null, status: "none", url: "https://claude.com/pricing", checked: C },
  { plan: "Claude Ultra", currency: "USD", monthly: 200, annual: null, status: "none", url: "https://claude.com/pricing", checked: C },
  { plan: "Claude Team Premium", currency: "USD", monthly: 125, annual: 1200, status: "official", url: "https://claude.com/pricing", checked: C },

  // OpenAI — help center: "we do not support annual billing… for ChatGPT Go, Plus, or Pro"; "Pro is billed monthly. Annual billing … not available."
  { plan: "ChatGPT Plus", currency: "USD", monthly: 20, annual: null, status: "none", url: "https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus", checked: C },
  { plan: "ChatGPT Pro 10x", currency: "USD", monthly: 100, annual: null, status: "none", url: "https://help.openai.com/en/articles/9793128", checked: C },
  { plan: "ChatGPT Pro 20x", currency: "USD", monthly: 200, annual: null, status: "none", url: "https://help.openai.com/en/articles/9793128", checked: C },
  { plan: "ChatGPT Pro 500", currency: "USD", monthly: 500, annual: null, status: "none", url: "https://help.openai.com/en/articles/9793128", checked: C },

  // Google — one.google.com plans page (headless Chrome), AI Pro savings calculator: "Monthly ($19.99)" / "Annual ($199.99)".
  // Ultra tiers: "From $99.99/mo", no annual figure on that page or the launch blog.
  { plan: "Google AI Pro", currency: "USD", monthly: 19.99, annual: 199.99, status: "official", url: GOOGLE_ONE, checked: C },
  { plan: "Google AI Ultra 5x", currency: "USD", monthly: 99.99, annual: undefined, status: "unknown", url: GOOGLE_ONE, checked: C, reason: "not-stated", ...T },
  { plan: "Google AI Ultra 20x", currency: "USD", monthly: 199.99, annual: undefined, status: "unknown", url: GOOGLE_ONE, checked: C, reason: "not-stated", ...T },

  // xAI — docs.x.ai/x-subscription/pricing: Plus "$80/yr ($7/mo)", Premium "$300/yr ($25/mo)", Super "$1000/yr ($84/mo)", Ultra "$2000/yr ($167/mo)".
  // x.ai/pricing (headless Chrome) lists the same four tiers monthly only; grok.com/plans shows local currency (CA$ here: ×10 annual on every tier).
  // SuperGrok tiers: neither page lists them ("Existing Cursor, SuperGrok, and X Premium plans continue"); docs.x.ai/grok/faq mentions
  // "a SuperGrok Heavy yearly subscription" with no figure.
  { plan: "X Plus", currency: "USD", monthly: 8, annual: 80, status: "official", url: X_PRICING, checked: C },
  { plan: "X Premium", currency: "USD", monthly: 30, annual: 300, status: "official", url: X_PRICING, checked: C },
  { plan: "X Super", currency: "USD", monthly: 100, annual: 1000, status: "official", url: X_PRICING, checked: C },
  { plan: "X Ultra", currency: "USD", monthly: 200, annual: 2000, status: "official", url: X_PRICING, checked: C },
  { plan: "SuperGrok Lite", currency: "USD", monthly: 10, annual: undefined, status: "unknown", url: "https://x.ai/pricing", checked: C, reason: "not-stated", ...T },
  { plan: "SuperGrok", currency: "USD", monthly: 30, annual: undefined, status: "unknown", url: "https://x.ai/pricing", checked: C, reason: "not-stated", ...T },
  { plan: "SuperGrok Plus", currency: "USD", monthly: 100, annual: undefined, status: "unknown", url: "https://x.ai/pricing", checked: C, reason: "not-stated", ...T },
  { plan: "SuperGrok Heavy", currency: "USD", monthly: 300, annual: undefined, status: "unknown", url: "https://docs.x.ai/grok/faq", checked: C, reason: "not-stated", ...T },
  { plan: "SuperGrok Lite, legacy", currency: "USD", monthly: 10, annual: undefined, status: "unknown", url: "https://x.ai/pricing", checked: C, reason: "not-stated", ...T },
  { plan: "SuperGrok, legacy", currency: "USD", monthly: 30, annual: undefined, status: "unknown", url: "https://x.ai/pricing", checked: C, reason: "not-stated", ...T },
  { plan: "SuperGrok Plus, legacy", currency: "USD", monthly: 100, annual: undefined, status: "unknown", url: "https://x.ai/pricing", checked: C, reason: "not-stated", ...T },
  { plan: "SuperGrok Heavy, legacy", currency: "USD", monthly: 300, annual: undefined, status: "unknown", url: "https://docs.x.ai/grok/faq", checked: C, reason: "not-stated", ...T },

  // GitHub — usage-based billing since 2026-06-01; current plan/billing pages list monthly prices only; annual plans are legacy
  // ("When your annual plan ends, you'll be automatically downgraded to Copilot Free").
  { plan: "GitHub Copilot Pro", currency: "USD", monthly: 10, annual: null, status: "none", url: "https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/what-changed-with-billing", checked: C },
  { plan: "GitHub Copilot Pro+", currency: "USD", monthly: 39, annual: null, status: "none", url: "https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/what-changed-with-billing", checked: C },
  { plan: "GitHub Copilot Max", currency: "USD", monthly: 100, annual: null, status: "none", url: "https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing", checked: C },

  // Cursor — help center: "Annual billing is … $2,000/yr for Ultra". Pro / Pro+ are legacy plans; the legacy doc gives no annual figure.
  { plan: "Cursor Ultra", currency: "USD", monthly: 200, annual: 2000, status: "official", url: "https://cursor.com/help/account-and-billing/pricing.md", checked: C },
  { plan: "Cursor Pro", currency: "USD", monthly: 20, annual: undefined, status: "unknown", url: "https://cursor.com/docs/account/pricing/legacy-cursor-plans.md", checked: C, reason: "not-stated", ...T, legacy: true },
  { plan: "Cursor Pro+", currency: "USD", monthly: 60, annual: undefined, status: "unknown", url: "https://cursor.com/docs/account/pricing/legacy-cursor-plans.md", checked: C, reason: "not-stated", ...T, legacy: true },
  { plan: "Cursor Ultra, legacy", currency: "USD", monthly: 200, annual: undefined, status: "unknown", url: "https://cursor.com/docs/account/pricing/legacy-cursor-plans.md", checked: C, reason: "not-stated", ...T },

  // Cognition / Factory — monthly only.
  { plan: "Devin Pro", currency: "USD", monthly: 20, annual: null, status: "none", url: "https://docs.devin.ai/admin/billing/self-serve.md", checked: C },
  { plan: "Devin Max", currency: "USD", monthly: 200, annual: null, status: "none", url: "https://docs.devin.ai/admin/billing/self-serve.md", checked: C },
  { plan: "Droid Pro", currency: "USD", monthly: 20, annual: null, status: "none", url: "https://factory.com/pricing", checked: C },
  { plan: "Droid Max", currency: "USD", monthly: 200, annual: null, status: "none", url: "https://factory.com/pricing", checked: C },

  // Mistral — help center: "For Pro and Team plans, you can choose between monthly or annual billing." / "Annual billing includes a 20% discount
  // compared with monthly billing." No dollar figure published: annual = 14.99 × 12 × 0.8 from the official discount.
  { plan: "Mistral Vibe Pro", currency: "USD", monthly: 14.99, annual: 143.904, status: "official", url: "https://help.mistral.ai/en/articles/455205-how-can-i-upgrade-or-cancel-my-le-chat-subscription", checked: C, note: "official 20% annual discount; total computed" },

  // OpenCode — docs: Go has "three monthly plans".
  { plan: "OpenCode Go", currency: "USD", monthly: 10, annual: null, status: "none", url: "https://opencode.ai/docs/go", checked: C },
  { plan: "OpenCode Go Plus", currency: "USD", monthly: 40, annual: null, status: "none", url: "https://opencode.ai/docs/go", checked: C },
  { plan: "OpenCode Go Teams", currency: "USD", monthly: 20, annual: null, status: "none", url: "https://opencode.ai/docs/go", checked: C },

  // Command Code — "$10 /month + processing fee"; the only yearly price (MOAT $60/yr) is a separate membership.
  { plan: "Command Code GOAT", currency: "USD", monthly: 10, annual: null, status: "none", url: "https://commandcode.ai/pricing", checked: C },
  { plan: "Command Code Max 10×", currency: "USD", monthly: 100, annual: null, status: "none", url: "https://commandcode.ai/pricing", checked: C },

  // Ollama — "$20 / mo. or $200/yr billed annually"; Max and Team have no yearly variant.
  { plan: "Ollama Pro", currency: "USD", monthly: 20, annual: 200, status: "official", url: "https://ollama.com/pricing", checked: C },
  { plan: "Ollama Max", currency: "USD", monthly: 100, annual: null, status: "none", url: "https://ollama.com/pricing", checked: C },
  { plan: "Ollama Team", currency: "USD", monthly: 500, annual: null, status: "none", url: "https://ollama.com/pricing", checked: C },

  // Kilo Pass — annual = 12 × monthly ("pay $228 annually for the $19/mo plan"); annual raises the credit bonus to 50%, the fee is unchanged.
  // The dataset carries only the annual-bonus rows ("Kilo Pass … (Annual)"), so they show in Yearly mode only.
  { plan: "Kilo Pass Starter", currency: "USD", monthly: 19, annual: 228, status: "official", url: "https://kilo.ai/pricing/kilo-pass", checked: C },
  { plan: "Kilo Pass Pro", currency: "USD", monthly: 49, annual: 588, status: "official", url: "https://kilo.ai/pricing/kilo-pass", checked: C },
  { plan: "Kilo Pass Expert", currency: "USD", monthly: 199, annual: 2388, status: "official", url: "https://kilo.ai/pricing/kilo-pass", checked: C },

  // DeepRelay — "Billed monthly through Stripe, renews until cancelled."
  { plan: "DeepRelay Base", currency: "USD", monthly: 0.99, annual: null, status: "none", url: "https://deeprelay.ai/pricing", checked: C },
  { plan: "DeepRelay Plus", currency: "USD", monthly: 4.99, annual: null, status: "none", url: "https://deeprelay.ai/pricing", checked: C },
  // Kimi — kimi.com/membership/pricing: "Billed annually $180" (Plus) / $372 / $948 / $1,908. Moderato / Allegretto / Allegro are the old
  // names of Plus / Pro / Max. kimi.com/en/help/membership/membership-pricing: "Andante, Moderato, Allegretto, and Allegro are legacy plans.
  // Existing subscribers keep their plan names, benefit rules, and auto-renewal arrangements." No legacy price is listed.
  { plan: "Kimi Plus", currency: "USD", monthly: 19, annual: 180, status: "official", url: "https://www.kimi.com/membership/pricing", checked: C },
  { plan: "Kimi Moderato", currency: "USD", monthly: 19, annual: 180, status: "official", url: "https://www.kimi.com/membership/pricing", checked: C },
  { plan: "Kimi Pro", currency: "USD", monthly: 39, annual: 372, status: "official", url: "https://www.kimi.com/membership/pricing", checked: C },
  { plan: "Kimi Allegretto", currency: "USD", monthly: 39, annual: 372, status: "official", url: "https://www.kimi.com/membership/pricing", checked: C },
  { plan: "Kimi Max", currency: "USD", monthly: 99, annual: 948, status: "official", url: "https://www.kimi.com/membership/pricing", checked: C },
  { plan: "Kimi Allegro", currency: "USD", monthly: 99, annual: 948, status: "official", url: "https://www.kimi.com/membership/pricing", checked: C },
  { plan: "Kimi Ultra", currency: "USD", monthly: 199, annual: 1908, status: "official", url: "https://www.kimi.com/membership/pricing", checked: C },
  { plan: "Kimi Moderato, legacy", currency: "USD", monthly: 19, annual: undefined, status: "unknown", url: "https://www.kimi.com/en/help/membership/membership-pricing", checked: C, reason: "not-stated", ...T },
  { plan: "Kimi Allegretto, legacy", currency: "USD", monthly: 39, annual: undefined, status: "unknown", url: "https://www.kimi.com/en/help/membership/membership-pricing", checked: C, reason: "not-stated", ...T },
  { plan: "Kimi Allegro, legacy", currency: "USD", monthly: 99, annual: undefined, status: "unknown", url: "https://www.kimi.com/en/help/membership/membership-pricing", checked: C, reason: "not-stated", ...T },

  // Zhipu GLM Coding (CN) — bigmodel.cn/glm-coding (headless Chrome, 连续包年 tab): 7折 = ¥82.6 / ¥376.6 / ¥754.6 per month.
  // Existing-subscriber prices (¥49 / ¥149 / ¥469) are not on the signed-out page ("登录 / 注册").
  { plan: "GLM Coding Lite ¥118", currency: "CNY", monthly: 118, annual: 991.2, status: "official", url: "https://bigmodel.cn/glm-coding", checked: C },
  { plan: "GLM Coding Pro ¥538", currency: "CNY", monthly: 538, annual: 4519.2, status: "official", url: "https://bigmodel.cn/glm-coding", checked: C },
  { plan: "GLM Coding Max ¥1078", currency: "CNY", monthly: 1078, annual: 9055.2, status: "official", url: "https://bigmodel.cn/glm-coding", checked: C },
  { plan: "GLM Coding Lite ¥49, existing subscribers", currency: "CNY", monthly: 49, annual: undefined, status: "unknown", url: "https://bigmodel.cn/glm-coding", checked: C, reason: "login", ...T },
  { plan: "GLM Coding Pro ¥149, existing subscribers", currency: "CNY", monthly: 149, annual: undefined, status: "unknown", url: "https://bigmodel.cn/glm-coding", checked: C, reason: "login", ...T },
  { plan: "GLM Coding Max ¥469, existing subscribers", currency: "CNY", monthly: 469, annual: undefined, status: "unknown", url: "https://bigmodel.cn/glm-coding", checked: C, reason: "login", ...T },

  // MiniMax CN — platform.minimaxi.com/subscribe/token-plan: 连续包年 "立省2月" ¥490 / ¥1,190 / ¥4,690. Token Plan Plus / Max / Ultra (CN) are
  // the same ¥49 / ¥119 / ¥469 tiers under their earlier names.
  { plan: "MiniMax M Plan Go (CN)", currency: "CNY", monthly: 49, annual: 490, status: "official", url: "https://platform.minimaxi.com/subscribe/token-plan", checked: C },
  { plan: "MiniMax M Plan Explore (CN)", currency: "CNY", monthly: 119, annual: 1190, status: "official", url: "https://platform.minimaxi.com/subscribe/token-plan", checked: C },
  { plan: "MiniMax M Plan Build (CN)", currency: "CNY", monthly: 469, annual: 4690, status: "official", url: "https://platform.minimaxi.com/subscribe/token-plan", checked: C },
  { plan: "MiniMax Token Plan Plus", currency: "CNY", monthly: 49, annual: 490, status: "official", url: "https://platform.minimaxi.com/subscribe/token-plan", checked: C },
  { plan: "MiniMax Token Plan Max", currency: "CNY", monthly: 119, annual: 1190, status: "official", url: "https://platform.minimaxi.com/subscribe/token-plan", checked: C },
  { plan: "MiniMax Token Plan Ultra", currency: "CNY", monthly: 469, annual: 4690, status: "official", url: "https://platform.minimaxi.com/subscribe/token-plan", checked: C },
  // MiniMax global — platform.minimax.io/subscribe/token-plan: "Yearly · 2 months free" $220 / $550 / $1,320 (Go / Explore / Build at $22 / $55 / $132).
  { plan: "MiniMax Token Plan Plus (Global)", currency: "USD", monthly: 22, annual: 220, status: "official", url: "https://platform.minimax.io/subscribe/token-plan", checked: C },
  { plan: "MiniMax Token Plan Max (Global)", currency: "USD", monthly: 55, annual: 550, status: "official", url: "https://platform.minimax.io/subscribe/token-plan", checked: C },
  { plan: "MiniMax Token Plan Ultra (Global)", currency: "USD", monthly: 132, annual: 1320, status: "official", url: "https://platform.minimax.io/subscribe/token-plan", checked: C },

  // Alibaba Bailian (CN) — aliyun.com/benefit/scene/tokenplan: 年付 list = 12 × monthly (¥468 / ¥948 / ¥1,668); lower "起" prices are promos.
  // Pro: token-plan-personal-overview lists "312 元/月" and "包月、包季、包年订阅" with no annual figure; its price drops next cycle.
  { plan: "阿里云百炼 Token Plan Lite (¥39)", currency: "CNY", monthly: 39, annual: 468, status: "official", url: "https://www.aliyun.com/benefit/scene/tokenplan", checked: C },
  { plan: "阿里云百炼 Token Plan Essential (¥79)", currency: "CNY", monthly: 79, annual: 948, status: "official", url: "https://www.aliyun.com/benefit/scene/tokenplan", checked: C },
  { plan: "阿里云百炼 Token Plan Standard (¥139)", currency: "CNY", monthly: 139, annual: 1668, status: "official", url: "https://www.aliyun.com/benefit/scene/tokenplan", checked: C },
  { plan: "阿里云百炼 Token Plan Pro (¥312)", currency: "CNY", monthly: 312, annual: undefined, status: "unknown", url: "https://help.aliyun.com/zh/model-studio/token-plan-personal-overview", checked: C, reason: "not-stated", ...T },
  // Alibaba Cloud international — Standard $18/mo, $195/yr.
  { plan: "Qwen Token Plan Standard", currency: "USD", monthly: 18, annual: 195, status: "official", url: "https://www.alibabacloud.com/campaign/ai-landing-page-token", checked: C },

  // Tencent — tencentcloud.com doc 1300/81315: monthly only, renews by calendar month.
  { plan: "Tencent Token Plan Lite", currency: "USD", monthly: 7, annual: null, status: "none", url: "https://www.tencentcloud.com/document/product/1300/81315", checked: C },
  { plan: "Tencent Token Plan Standard", currency: "USD", monthly: 17, annual: null, status: "none", url: "https://www.tencentcloud.com/document/product/1300/81315", checked: C },
  { plan: "Tencent Token Plan Pro", currency: "USD", monthly: 51, annual: null, status: "none", url: "https://www.tencentcloud.com/document/product/1300/81315", checked: C },
  { plan: "Tencent Token Plan Max", currency: "USD", monthly: 103, annual: null, status: "none", url: "https://www.tencentcloud.com/document/product/1300/81315", checked: C },

  // Xiaomi MiMo — platform.xiaomimimo.com/token-plan: "Annual subscriptions… 12% off compared with monthly."
  { plan: "MiMo Token Plan Lite", currency: "USD", monthly: 6, annual: 63.36, status: "official", url: "https://platform.xiaomimimo.com/token-plan", checked: C },
  { plan: "MiMo Token Plan Standard", currency: "USD", monthly: 16, annual: 168.96, status: "official", url: "https://platform.xiaomimimo.com/token-plan", checked: C },
  { plan: "MiMo Token Plan Pro", currency: "USD", monthly: 50, annual: 528, status: "official", url: "https://platform.xiaomimimo.com/token-plan", checked: C },
  { plan: "MiMo Token Plan Max", currency: "USD", monthly: 100, annual: 1056, status: "official", url: "https://platform.xiaomimimo.com/token-plan", checked: C },

  // StepFun (CN) — platform.stepfun.com/step-plan (headless Chrome, 年付 tab): Plus ¥936, Pro ¥1860, Max ¥4266 (Max is now ¥399/月).
  // Mini ¥49 and Max ¥699 are no longer listed. The local resolver fails platform.stepfun.com; public DNS resolves it
  // (CHROME_ARGS='--host-resolver-rules=MAP platform.stepfun.com 14.103.2.83'). Global: platform.stepfun.ai/step-plan, Yearly $95.99 / $289 / $589.
  { plan: "Step Plan Plus (¥99)", currency: "CNY", monthly: 99, annual: 936, status: "official", url: "https://platform.stepfun.com/step-plan", checked: C },
  { plan: "Step Plan Pro (¥199)", currency: "CNY", monthly: 199, annual: 1860, status: "official", url: "https://platform.stepfun.com/step-plan", checked: C },
  { plan: "Step Plan Mini (¥49)", currency: "CNY", monthly: 49, annual: undefined, status: "unknown", url: "https://platform.stepfun.com/step-plan", checked: C, reason: "not-stated", ...T },
  { plan: "Step Plan Max (¥699)", currency: "CNY", monthly: 699, annual: undefined, status: "unknown", url: "https://platform.stepfun.com/step-plan", checked: C, reason: "not-stated", ...T },
];

// Quota sub-pool / time-of-day suffixes that share one subscription price.
const SUFFIX_RE = /\s*\((?:off-peak|peak|mixed|Day|Night 0\.8x|Fast|Other Models)\)$/i;
// Rows priced on annual billing; their monthly twin is the name with this marker removed.
const ANNUAL_RE = /\s*\((?:CN )?Annual\)$|\s*年付$/;

/** Billing key of a plan name: sub-pool suffixes removed, ", legacy" kept. */
export function billingKey(plan) {
  let p = String(plan || "").trim();
  const legacy = /,\s*legacy$/i.test(p);
  p = p.replace(/,\s*legacy$/i, "");
  while (SUFFIX_RE.test(p)) p = p.replace(SUFFIX_RE, "");
  return `${p.trim()}${legacy ? ", legacy" : ""}`;
}
export const isAnnualVariant = (plan) => ANNUAL_RE.test(billingKey(plan));
/** "MiniMax M Plan Build (CN Annual)" → "MiniMax M Plan Build (CN)"; "Kilo Pass Pro (Annual)" → "Kilo Pass Pro". */
export const monthlyTwinKey = (plan) => billingKey(plan).replace(/\s*\(CN Annual\)$/, " (CN)").replace(/\s*\(Annual\)$|\s*年付$/, "").trim();

const r4 = (x) => Number(x.toFixed(4));

/** Lookup: exact key, then the key without ", legacy" only when the record opts in (legacy: true). */
function findRecord(key, byPlan) {
  if (byPlan.has(key)) return byPlan.get(key);
  const base = key.replace(/,\s*legacy$/i, "");
  const rec = byPlan.get(base);
  return rec && rec.legacy ? rec : null;
}

/**
 * Adds to every subscription entry:
 *   priceUsdMonthly  monthly fee in USD
 *   priceUsdYearly   annual fee ÷ 12 in USD, or null (no annual option / unknown)
 *   billingYearly    "official" | "none" | "unknown" | "variant" (row itself priced on annual billing)
 *   billingOnly      "yearly" on annual-variant rows (hidden in Monthly mode)
 *   hideYearly       true on a monthly row whose annual-variant twin (same model) is shown in Yearly mode
 *   rel.y            σ of the yearly price step (official list price, S1) when the yearly fee is scaled
 * subsidyMultiple stays relative to priceUsd: the page uses subsidy × priceUsd ÷ fee.
 */
export function applyBillingPeriods(entries, { yearlySigma = 0.03, log = () => {} } = {}) {
  const byPlan = new Map(BILLING_PERIODS.map((r) => [r.plan, r]));
  const subs = entries.filter((e) => e.billing === "subscription");
  const twinRows = new Map(); // `${twinKey}|${modelId}|${offpeak}` → monthly entry
  for (const e of subs) if (!isAnnualVariant(e.plan)) twinRows.set(`${billingKey(e.plan)}|${e.modelId}|${e.isOffPeak}`, e);

  const stats = { checked: BILLING_CHECKED, official: 0, none: 0, unknown: 0, variant: 0, unmatched: [], mismatches: [], linkedTwins: 0 };
  const unmatched = new Set();
  const mismatched = new Map();

  for (const e of subs) {
    const key = billingKey(e.plan);
    if (isAnnualVariant(e.plan)) {
      const tKey = monthlyTwinKey(e.plan);
      const rec = findRecord(tKey, byPlan);
      const twin = twinRows.get(`${tKey}|${e.modelId}|${e.isOffPeak}`);
      let monthly = null;
      if (twin) monthly = twin.priceUsd;
      else if (rec?.status === "official" && rec.annual > 0) monthly = r4((e.priceUsd * rec.monthly) / (rec.annual / 12));
      else if (rec?.sameFee) monthly = e.priceUsd;
      e.priceUsdMonthly = monthly ?? e.priceUsd;
      e.priceUsdYearly = e.priceUsd;
      e.billingYearly = "variant";
      e.billingOnly = "yearly";
      if (twin) {
        twin.hideYearly = true;
        twin._annualTwinPrice = e.priceUsd;
        stats.linkedTwins++;
      }
      stats.variant++;
      continue;
    }
    e.priceUsdMonthly = e.priceUsd;
    const rec = findRecord(key, byPlan);
    if (!rec) {
      unmatched.add(key);
      e.priceUsdYearly = null;
      e.billingYearly = "unknown";
      stats.unknown++;
      continue;
    }
    if (rec.currency === "USD" && rec.monthly > 0 && e.priceUsd > 0 && Math.abs(rec.monthly - e.priceUsd) / e.priceUsd > 0.02) {
      mismatched.set(key, { plan: key, stored: e.priceUsd, official: rec.monthly });
    }
    const cny = Number(String(`${e.plan} ${e.planLocal || ""}`).match(/¥\s*([\d,]+(?:\.\d+)?)/)?.[1]?.replace(/,/g, ""));
    if (rec.currency === "CNY" && cny > 0 && Math.abs(cny - rec.monthly) > 0.5) mismatched.set(key, { plan: key, stored: `¥${cny}`, official: `¥${rec.monthly}` });
    if (rec.status === "official" && rec.annual > 0 && rec.monthly > 0) {
      e.priceUsdYearly = r4((e.priceUsd * rec.annual) / 12 / rec.monthly);
      e.billingYearly = "official";
      if (e.rel) e.rel.y = yearlySigma;
      stats.official++;
    } else {
      e.priceUsdYearly = null;
      e.billingYearly = rec.status === "none" ? "none" : "unknown";
      stats[e.billingYearly]++;
    }
  }

  // A monthly row linked to an annual-variant row takes that row's yearly price when the table has none.
  for (const e of subs) {
    if (e._annualTwinPrice == null) continue;
    if (e.priceUsdYearly == null) {
      e.priceUsdYearly = e._annualTwinPrice;
      e.billingYearly = "official";
    }
    delete e._annualTwinPrice;
  }

  stats.unmatched = [...unmatched].sort();
  stats.mismatches = [...mismatched.values()];
  if (stats.unmatched.length) log(`Billing: no annual record for ${stats.unmatched.length} plans: ${stats.unmatched.join("; ")}`);
  if (stats.mismatches.length) log(`Billing: monthly price differs from official for ${stats.mismatches.map((m) => `${m.plan} ($${m.stored} vs $${m.official})`).join("; ")}`);
  return stats;
}
