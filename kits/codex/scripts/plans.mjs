/**
 * ChatGPT plans the Codex kit measures: site plan name, the `rate_limits.plan_type` strings Codex
 * writes for it, and the monthly fee from scripts/billing-periods.mjs (never a number written here).
 *
 * plan_type strings are the wire names of codex-rs PlanType (protocol/src/account.rs,
 * codex-backend-openapi-models rate_limit_status_payload.rs): plus, pro, prolite, promax, team,
 * business, self_serve_business_*. Which Pro string each Pro tier reports is not documented, so every
 * Pro string matches all three Pro tiers and the run needs --plan to pick one. Business has no
 * billing record yet: it is recognised, measured in $/pp, and has no subsidy until a fee is added.
 */

import { BILLING_PERIODS } from "../../../scripts/billing-periods.mjs";

const PRO_TYPES = ["pro", "prolite", "promax"];
const BUSINESS_TYPES = ["team", "business", "self_serve_business_prolite", "self_serve_business_usage_based"];

export const PLANS = [
  { id: "plus", name: "ChatGPT Plus", short: "Plus", planTypes: ["plus"] },
  { id: "pro-10x", name: "ChatGPT Pro 10x", short: "Pro 10x", planTypes: PRO_TYPES },
  { id: "pro-20x", name: "ChatGPT Pro 20x", short: "Pro 20x", planTypes: PRO_TYPES },
  { id: "pro-500", name: "ChatGPT Pro 500", short: "Pro 500", planTypes: PRO_TYPES },
  { id: "business", name: "ChatGPT Business", short: "Business", planTypes: BUSINESS_TYPES },
];
export const PLAN_IDS = PLANS.map((p) => p.id);
export const DEFAULT_PLAN_ID = "plus";

/** "Pro 20x", "ChatGPT Pro 20x", "pro-20x", "PRO_20X" → "pro-20x"; "team" → "business". */
function normalise(s) {
  const k = String(s || "")
    .toLowerCase()
    .replace(/chatgpt/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return k === "team" ? "business" : k;
}

/** Plan record by id or name, or null. */
export function planById(s) {
  const k = normalise(s);
  return PLANS.find((p) => p.id === k) || null;
}

/** Monthly USD fee of a plan from scripts/billing-periods.mjs; null when there is no USD record. */
export function planFee(plan) {
  const rec = BILLING_PERIODS.find((r) => r.plan === plan?.name && r.currency === "USD");
  return rec && Number.isFinite(rec.monthly) && rec.monthly > 0 ? rec.monthly : null;
}

/** Plans that report one plan_type string. */
export const plansForType = (t) => PLANS.filter((p) => p.planTypes.includes(t));

/**
 * Plan of a run from the plan_type strings in its rollouts and an optional --plan.
 * Returns the plan record, or null when there are no readings and no --plan. Throws on an unknown
 * plan_type, a --plan that does not match, more than one plan_type, or a plan_type that several
 * plans share with no --plan.
 */
export function resolvePlan({ planTypes = [], requested = null } = {}) {
  const types = [...new Set(planTypes.filter(Boolean))];
  const unknown = types.filter((t) => !plansForType(t).length);
  if (unknown.length) throw new Error(`plan_type ${unknown.join(", ")} is not a plan this kit measures (${PLANS.map((p) => p.name).join(", ")})`);
  if (requested != null && requested !== true) {
    const p = planById(requested);
    if (!p) throw new Error(`--plan ${requested}: use ${PLAN_IDS.join(", ")}`);
    const bad = types.filter((t) => !p.planTypes.includes(t));
    if (bad.length) throw new Error(`--plan ${p.id} does not match plan_type ${bad.join(", ")}; ${p.name} reports ${p.planTypes.join(" or ")}`);
    return p;
  }
  if (requested === true) throw new Error(`--plan needs a value: ${PLAN_IDS.join(", ")}`);
  if (types.length > 1) throw new Error(`plan_type changes: ${types.join(", ")}`);
  if (!types.length) return null;
  const c = plansForType(types[0]);
  if (c.length > 1) throw new Error(`plan_type ${types[0]} is one of ${c.map((p) => p.name).join(", ")}: pass --plan ${c.map((p) => p.id).join(" | ")}`);
  return c[0];
}
