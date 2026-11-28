/**
 * Provider adapters for the API plan kit. Each adapter names its API base URLs, the environment
 * variable holding the key, its meter (automatic reader or manual dashboard), the meter's windows,
 * and how one window converts to a month.
 *
 * A meter reading is { windows: { <name>: { used, capacity, unit, resetsAt } } }:
 *   used      amount of the window spent, in the window's own unit (never "remaining")
 *   capacity  size of the window in the same unit (100 for percentages; null when unknown)
 *   resetsAt  next reset, epoch seconds, or null
 *
 * Parsers are pure and exported for the fixture tests. They read numbers only: raw responses are
 * never stored or printed, so account ids, emails and keys in a response cannot reach a log or a
 * result file. On an unexpected shape they throw MeterShapeError naming the top-level keys only.
 *
 * Month conversion (monthFactor per window): monthly windows ×1; weekly windows ×4 (the site's
 * convention, Fei2411 "×4周"); Kimi legacy weekly ×5 (Kimi's monthly pool = 5 weekly pools, the
 * ratio the site's Kimi rows use); 5-hour and session windows have no month factor and are
 * reported per window only.
 *
 * Sources: kits/METHODS.md, and per adapter below.
 */

export class MeterShapeError extends Error {
  constructor(provider, detail) {
    super(`${provider} meter: unexpected response (${detail}). Rerun with --manual and type the dashboard value.`);
    this.name = "MeterShapeError";
  }
}

const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).slice(0, 12).join(", ") || "none" : typeof o);
const num = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(/%$/, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Epoch seconds from epoch ms, epoch s, or an ISO / "YYYY-MM-DD HH:mm:ss" (UTC) string. */
export function toEpochS(v) {
  if (v == null || v === "" || v === 0) return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n > 1e12 ? Math.floor(n / 1000) : n > 1e9 ? n : null;
  }
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
const pctWindow = (used, resetsAt = null) => ({ used, capacity: 100, unit: "%", resetsAt });

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

/**
 * GLM Coding (Z.ai / BigModel): GET <host>/api/monitor/usage/quota/limit.
 * Shape from zai-org/zai-coding-plugins query-usage.mjs and CodexBar docs/zai.md:
 *   { data: { limits: [ { type: "TOKENS_LIMIT", percentage, unit?, number?, nextResetTime? }, { type: "TIME_LIMIT", … } ] } }
 * TOKENS_LIMIT (and CREDIT_LIMIT) entries are the coding windows; TIME_LIMIT is the MCP tool pool.
 * Window length from unit + number (CodexBar Plugins/zai.js) when present; otherwise the first
 * window is 5h, the second weekly.
 */
export function parseGlm(json) {
  const data = json?.data ?? json;
  const limits = data?.limits;
  if (!Array.isArray(limits)) throw new MeterShapeError("GLM", `no data.limits; top-level keys: ${keysOf(json)}`);
  const unitMin = { MINUTE: 1, MINUTES: 1, HOUR: 60, HOURS: 60, DAY: 1440, DAYS: 1440, WEEK: 10080, WEEKS: 10080, MONTH: 43200, MONTHS: 43200 };
  const coding = limits.filter((l) => l && (l.type === "TOKENS_LIMIT" || l.type === "CREDIT_LIMIT"));
  if (!coding.length) throw new MeterShapeError("GLM", `no TOKENS_LIMIT entry; limit types: ${limits.map((l) => l?.type).join(", ") || "none"}`);
  const withMin = coding.map((l, i) => {
    // numeric unit codes as CodexBar's zai.js reads them: 1 day, 3 hour, 5 minute, 6 week
    const u = typeof l.unit === "string" ? unitMin[l.unit.toUpperCase()] : { 1: 1440, 3: 60, 5: 1, 6: 10080 }[l.unit] ?? null;
    const minutes = u && num(l.number) ? u * num(l.number) : null;
    return { l, i, minutes };
  });
  withMin.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || a.i - b.i);
  const windows = {};
  withMin.forEach(({ l, minutes }, j) => {
    let pct = num(l.percentage);
    const total = num(l.usage);
    const cur = num(l.currentValue);
    const rem = num(l.remaining);
    if (total > 0 && (cur != null || rem != null)) pct = (100 * (cur ?? total - rem)) / total;
    if (pct == null) throw new MeterShapeError("GLM", `TOKENS_LIMIT without percentage; fields: ${keysOf(l)}`);
    const name = minutes == null ? (j === 0 ? "5h" : "weekly") : minutes <= 300 ? "5h" : minutes <= 10080 ? "weekly" : "monthly";
    windows[windows[name] ? `${name}-${j}` : name] = pctWindow(pct, toEpochS(l.nextResetTime));
  });
  return { windows };
}

/**
 * MiniMax: GET https://www.minimax.io/v1/token_plan/remains (documented in the Token Plan FAQ;
 * fields undocumented). Field names from CodexBar MiniMaxModelRemains.swift:
 *   { model_remains: [ { model_name, current_interval_total_count, current_interval_usage_count,
 *     end_time, current_weekly_total_count, current_weekly_usage_count, weekly_end_time, … } ],
 *     base_resp: { status_code, status_msg } }   (sometimes wrapped in { data: … })
 * The *_usage_count fields hold the REMAINING count; used = total − remaining.
 * Some responses carry only current_interval_used_percent / current_weekly_used_percent.
 */
export function parseMinimax(json, { model = null } = {}) {
  const d = json?.data && !Array.isArray(json.data) ? json.data : json;
  const base = d?.base_resp ?? json?.base_resp;
  if (base && Number(base.status_code) !== 0) {
    const e = new Error(`MiniMax meter: status_code ${base.status_code}${Number(base.status_code) === 1004 ? " (key rejected: use the Token Plan key)" : ""}`);
    e.auth = Number(base.status_code) === 1004;
    throw e;
  }
  const list = d?.model_remains;
  if (!Array.isArray(list) || !list.length) throw new MeterShapeError("MiniMax", `no model_remains; top-level keys: ${keysOf(json)}`);
  const m = String(model || "").toLowerCase();
  const textLike = (x) => !/(image|video|speech|tts|music|hailuo|audio)/i.test(String(x.model_name || ""));
  const item = list.find((x) => m && String(x.model_name || "").toLowerCase() === m) || list.find((x) => m && m.startsWith(String(x.model_name || "").toLowerCase().replace(/\*$/, ""))) || list.find(textLike) || list[0];
  const win = (total, remaining, usedPct, end) => {
    const t = num(total);
    const r = num(remaining);
    if (t > 0 && r != null) return { used: t - r, capacity: t, unit: "count", resetsAt: toEpochS(end) };
    const p = num(usedPct);
    if (p != null) return pctWindow(p, toEpochS(end));
    return null;
  };
  const windows = {};
  const iv = win(item.current_interval_total_count, item.current_interval_usage_count, item.current_interval_used_percent, item.end_time);
  const wk = win(item.current_weekly_total_count, item.current_weekly_usage_count, item.current_weekly_used_percent, item.weekly_end_time);
  if (iv) windows["5h"] = iv;
  if (wk) windows.weekly = wk;
  if (!iv && !wk) throw new MeterShapeError("MiniMax", `model_remains entry without counts; fields: ${keysOf(item)}`);
  return { windows, meterModel: item.model_name ?? null };
}

/**
 * 阿里云百炼 / Qwen Token Plan: `bl usage token-plan --output json` (documented command; the
 * only documented field is hasQuotaData). Window fields from CodexBar OneConsoleTokenPlanSnapshot
 * (personal usage API v2): per5HourPercentage, per1WeekPercentage, per1MonthPercentage as used
 * ratios 0–1, with per5HourResetTime, per1WeekResetTime, per1MonthResetTime. Searched anywhere in
 * the output; values above 1 are read as percentages.
 */
export function parseBailian(json) {
  if (json && json.hasQuotaData === false) throw new Error("Bailian meter: hasQuotaData is false (no Token Plan on this login). Run `bl auth login` with the account that holds the plan.");
  const KEYS = [
    ["5h", "per5HourPercentage", "per5HourResetTime"],
    ["weekly", "per1WeekPercentage", "per1WeekResetTime"],
    ["monthly", "per1MonthPercentage", "per1MonthResetTime"],
  ];
  let found = null;
  const seen = new Set();
  const walk = (o, depth) => {
    if (found || !o || typeof o !== "object" || depth > 8 || seen.has(o)) return;
    seen.add(o);
    if (KEYS.some(([, k]) => k in o)) {
      found = o;
      return;
    }
    for (const v of Object.values(o)) {
      if (typeof v === "string" && /^\s*[{[]/.test(v)) {
        try {
          walk(JSON.parse(v), depth + 1);
        } catch {
          /* not JSON */
        }
      } else walk(v, depth + 1);
    }
  };
  walk(json, 0);
  if (!found) throw new MeterShapeError("Bailian", `no per5HourPercentage / per1WeekPercentage / per1MonthPercentage; top-level keys: ${keysOf(json)}`);
  const windows = {};
  for (const [name, k, r] of KEYS) {
    const v = num(found[k]);
    if (v == null) continue;
    windows[name] = pctWindow(v <= 1 ? v * 100 : v, toEpochS(found[r]));
  }
  if (!Object.keys(windows).length) throw new MeterShapeError("Bailian", "window fields present but not numeric");
  return { windows };
}

/**
 * DeepRelay: `deeprelay billing subscription -o json` (documented). Fields from the docs page:
 * quota.input_tokens_monthly, usage.weighted_input_tokens, usage.week_resets_at, usage.by_model[],
 * usage.weekly_by_model[] with weighted_input_tokens / weighted_output_tokens. Monthly output and
 * weekly quota field names are not documented: read as quota.output_tokens_monthly,
 * quota.input_tokens_weekly, quota.output_tokens_weekly when present.
 * Windows: monthly-input, monthly-output, weekly-input, weekly-output (weighted tokens).
 */
export function parseDeeprelay(json) {
  if (!json || typeof json !== "object") throw new MeterShapeError("DeepRelay", `not a JSON object (${typeof json})`);
  if (json.usage === null) throw new Error("DeepRelay meter: usage is null (not subscribed, or the meter is unavailable). Check `deeprelay billing subscription`.");
  const q = json.quota;
  const u = json.usage;
  if (!q || !u) throw new MeterShapeError("DeepRelay", `no quota / usage; top-level keys: ${keysOf(json)}`);
  const sum = (list, k) => (Array.isArray(list) ? list.reduce((s, x) => s + (num(x?.[k]) ?? 0), 0) : null);
  const reset = toEpochS(u.week_resets_at);
  const windows = {};
  const add = (name, used, cap, resetsAt) => {
    if (used != null && num(cap) > 0) windows[name] = { used, capacity: num(cap), unit: "weighted tokens", resetsAt };
  };
  add("monthly-input", num(u.weighted_input_tokens) ?? sum(u.by_model, "weighted_input_tokens"), q.input_tokens_monthly, toEpochS(json.current_period_end ?? json.period_end) ?? null);
  add("monthly-output", num(u.weighted_output_tokens) ?? sum(u.by_model, "weighted_output_tokens"), q.output_tokens_monthly, toEpochS(json.current_period_end ?? json.period_end) ?? null);
  add("weekly-input", num(u.weekly_weighted_input_tokens) ?? sum(u.weekly_by_model, "weighted_input_tokens"), q.input_tokens_weekly, reset);
  add("weekly-output", num(u.weekly_weighted_output_tokens) ?? sum(u.weekly_by_model, "weighted_output_tokens"), q.output_tokens_weekly, reset);
  if (!windows["monthly-input"]) throw new MeterShapeError("DeepRelay", `no usage.weighted_input_tokens with quota.input_tokens_monthly; quota keys: ${keysOf(q)}`);
  return { windows };
}

/**
 * Ollama Cloud: GET https://ollama.com/api/balance (documented).
 *   current plans: { included: { balance_usd, allowance_usd, period: { from, until } }, purchased }
 *   legacy plans:  { included: { session: { remaining_percent, resets_at }, weekly: { … } }, purchased }
 * Current plans: one monthly window in USD credits, used = allowance − balance.
 */
export function parseOllama(json) {
  const inc = json?.included;
  if (!inc || typeof inc !== "object") throw new MeterShapeError("Ollama", `no included; top-level keys: ${keysOf(json)}`);
  const windows = {};
  if (num(inc.allowance_usd) > 0 && num(inc.balance_usd) != null) {
    windows.monthly = { used: num(inc.allowance_usd) - num(inc.balance_usd), capacity: num(inc.allowance_usd), unit: "USD credits", resetsAt: toEpochS(inc.period?.until) };
  }
  for (const [src, name] of [["session", "session"], ["weekly", "weekly"]]) {
    const w = inc[src];
    if (w && num(w.remaining_percent) != null) windows[name] = pctWindow(100 - num(w.remaining_percent), toEpochS(w.resets_at));
  }
  if (!Object.keys(windows).length) throw new MeterShapeError("Ollama", `included has no allowance_usd or remaining_percent; fields: ${keysOf(inc)}`);
  return { windows };
}

/**
 * Xiaomi MiMo Token Plan: GET https://token-plan-{cn|sgp}.xiaomimimo.com/v1/platform/token_plan
 * (documented: mimo.mi.com/docs/en-US/api/asset/credits-get).
 *   { object: "token_plan", period: { start_at, end_at }, quota: { total_credits, used_credits, remaining_credits } }
 */
export function parseMimo(json) {
  const q = json?.quota ?? json?.data?.quota;
  const total = num(q?.total_credits);
  const used = num(q?.used_credits) ?? (total != null && num(q?.remaining_credits) != null ? total - num(q.remaining_credits) : null);
  if (!(total > 0) || used == null) throw new MeterShapeError("MiMo", `no quota.total_credits / used_credits; top-level keys: ${keysOf(json)}`);
  const end = json?.period?.end_at ?? json?.data?.period?.end_at;
  return { windows: { monthly: { used, capacity: total, unit: "credits", resetsAt: toEpochS(end) } } };
}

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

const PCT = (monthFactor, label) => ({ unit: "%", capacity: 100, monthFactor, label });

export const ADAPTERS = {
  kimi: {
    id: "kimi",
    provider: "Kimi",
    plans: ["Moderato", "Allegretto", "Allegro", "Plus", "Pro", "Max", "Ultra"],
    planTest: (p) => /^Kimi\b/.test(p),
    env: "KIMI_API_KEY",
    api: "openai",
    base: { default: { openai: "https://api.kimi.com/coding/v1", anthropic: "https://api.kimi.com/coding" } },
    meter: {
      modes: ["manual"],
      default: "manual",
      endpoint: "manual",
      dashboard: "https://www.kimi.com/membership/subscription?tab=quota",
      windows: { monthly: PCT(1, "monthly total"), weekly: PCT(5, "weekly (legacy plans)"), "5h": PCT(null, "5-hour") },
      primary: "monthly",
      target: 1,
    },
  },
  glm: {
    id: "glm",
    provider: "GLM Coding (Z.ai)",
    plans: ["Lite", "Pro", "Max"],
    planTest: (p) => /^GLM Coding\b/.test(p),
    env: "ZAI_API_KEY",
    api: "openai",
    base: {
      default: { openai: "https://api.z.ai/api/coding/paas/v4", anthropic: "https://api.z.ai/api/anthropic" },
      cn: { openai: "https://open.bigmodel.cn/api/coding/paas/v4", anthropic: "https://open.bigmodel.cn/api/anthropic" },
    },
    meter: {
      modes: ["auto", "manual"],
      default: "auto",
      endpoint: "undocumented",
      url: { default: "https://api.z.ai/api/monitor/usage/quota/limit", cn: "https://open.bigmodel.cn/api/monitor/usage/quota/limit" },
      // official plugin sends the key without "Bearer"
      headers: (key) => ({ Authorization: key, "Accept-Language": "en-US,en" }),
      parse: parseGlm,
      dashboard: "https://z.ai/manage-apikey/coding-plan/personal/my-plan",
      windows: { weekly: PCT(4, "weekly"), "5h": PCT(null, "5-hour") },
      primary: "weekly",
      fallbackPrimary: "5h",
      target: 5,
    },
  },
  minimax: {
    id: "minimax",
    provider: "MiniMax",
    plans: ["M Plan Go / Explore / Build", "Token Plan Plus / Max / Ultra"],
    planTest: (p) => /^MiniMax\b/.test(p),
    env: "MINIMAX_API_KEY",
    api: "anthropic",
    base: {
      default: { openai: "https://api.minimax.io/v1", anthropic: "https://api.minimax.io/anthropic" },
      cn: { openai: "https://api.minimaxi.com/v1", anthropic: "https://api.minimaxi.com/anthropic" },
    },
    meter: {
      modes: ["auto", "manual"],
      default: "auto",
      endpoint: "documented endpoint, undocumented fields",
      url: { default: "https://www.minimax.io/v1/token_plan/remains", cn: "https://www.minimaxi.com/v1/token_plan/remains" },
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
      parse: parseMinimax,
      dashboard: "https://platform.minimax.io/console/usage",
      windows: { weekly: { unit: "count", capacity: null, monthFactor: 4, label: "weekly" }, "5h": { unit: "count", capacity: null, monthFactor: null, label: "5-hour" } },
      primary: "weekly",
      fallbackPrimary: "5h",
      target: 3,
    },
  },
  bailian: {
    id: "bailian",
    provider: "阿里云百炼 / Qwen Token Plan",
    plans: ["Lite", "Essential", "Standard", "Pro", "Qwen Token Plan Standard (intl)"],
    planTest: (p) => /阿里云百炼|^Qwen Token Plan\b/.test(p),
    env: "BAILIAN_API_KEY",
    api: "openai",
    base: {
      default: { openai: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", anthropic: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic" },
      intl: { openai: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", anthropic: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic" },
    },
    meter: {
      modes: ["auto", "manual"],
      default: "auto",
      endpoint: "documented command, undocumented fields",
      cli: { bin: "bl", option: "bl", args: ["usage", "token-plan", "--output", "json"] },
      parse: parseBailian,
      dashboard: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan",
      windows: { monthly: PCT(1, "monthly"), weekly: PCT(4, "7-day"), "5h": PCT(null, "5-hour") },
      primary: "monthly",
      fallbackPrimary: "weekly",
      target: 1,
    },
  },
  deeprelay: {
    id: "deeprelay",
    provider: "DeepRelay",
    plans: ["Base", "Plus"],
    planTest: (p) => /^DeepRelay\b/.test(p),
    env: "DEEPRELAY_API_KEY",
    api: "openai",
    base: { default: { openai: "https://api.deeprelay.ai/v1" } },
    meter: {
      modes: ["auto", "manual"],
      default: "auto",
      endpoint: "documented",
      cli: { bin: "deeprelay", option: "deeprelay", args: ["billing", "subscription", "-o", "json"] },
      parse: parseDeeprelay,
      dashboard: "https://deeprelay.ai/dashboard",
      windows: {
        "monthly-input": { unit: "weighted tokens", capacity: null, monthFactor: 1, label: "monthly input" },
        "monthly-output": { unit: "weighted tokens", capacity: null, monthFactor: 1, label: "monthly output" },
        "weekly-input": { unit: "weighted tokens", capacity: null, monthFactor: 4, label: "weekly input" },
        "weekly-output": { unit: "weighted tokens", capacity: null, monthFactor: 4, label: "weekly output" },
      },
      primary: "monthly-input",
      target: 1,
    },
  },
  ollama: {
    id: "ollama",
    provider: "Ollama Cloud",
    plans: ["Pro", "Max"],
    planTest: (p) => /^Ollama\b/.test(p),
    env: "OLLAMA_API_KEY",
    api: "ollama",
    base: { default: { ollama: "https://ollama.com", openai: "https://ollama.com/v1" } },
    meter: {
      modes: ["auto", "manual"],
      default: "auto",
      endpoint: "documented",
      url: { default: "https://ollama.com/api/balance" },
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
      parse: parseOllama,
      minPollSec: 7, // 10 requests per minute per user
      dashboard: "https://ollama.com/settings",
      windows: { monthly: { unit: "USD credits", capacity: null, monthFactor: 1, label: "monthly credits" }, weekly: PCT(4, "weekly (legacy plans)"), session: PCT(null, "session (legacy plans)") },
      primary: "monthly",
      fallbackPrimary: "weekly",
      target: 1,
    },
  },
  step: {
    id: "step",
    provider: "StepFun Step Plan",
    plans: ["Mini", "Plus", "Pro", "Max"],
    planTest: (p) => /^Step Plan\b/.test(p),
    env: "STEPFUN_API_KEY",
    api: "openai",
    base: {
      default: { openai: "https://api.stepfun.com/step_plan/v1", anthropic: "https://api.stepfun.com/step_plan" },
      intl: { openai: "https://api.stepfun.ai/step_plan/v1", anthropic: "https://api.stepfun.ai/step_plan" },
    },
    meter: {
      modes: ["manual"],
      default: "manual",
      endpoint: "manual",
      dashboard: "https://platform.stepfun.com/step-plan",
      windows: { monthly: PCT(1, "monthly credits"), weekly: PCT(4, "weekly"), "5h": PCT(null, "5-hour") },
      primary: "monthly",
      target: 1,
    },
  },
  mimo: {
    id: "mimo",
    provider: "Xiaomi MiMo Token Plan",
    plans: ["Lite", "Standard", "Pro", "Max"],
    planTest: (p) => /^MiMo\b/.test(p),
    env: "MIMO_API_KEY",
    api: "openai",
    base: {
      default: { openai: "https://token-plan-cn.xiaomimimo.com/v1", anthropic: "https://token-plan-cn.xiaomimimo.com/anthropic" },
      sgp: { openai: "https://token-plan-sgp.xiaomimimo.com/v1", anthropic: "https://token-plan-sgp.xiaomimimo.com/anthropic" },
    },
    meter: {
      modes: ["auto", "manual"],
      default: "auto",
      endpoint: "documented",
      url: { default: "https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan", sgp: "https://token-plan-sgp.xiaomimimo.com/v1/platform/token_plan" },
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
      parse: parseMimo,
      dashboard: "https://platform.xiaomimimo.com/#/console/plan-manage",
      windows: { monthly: { unit: "credits", capacity: null, monthFactor: 1, label: "monthly credits" } },
      primary: "monthly",
      target: 1,
    },
  },
};

export const adapterFor = (id) => ADAPTERS[String(id || "").toLowerCase()] || null;

/** Adapter whose plans include this site plan name, or null. */
export const adapterForPlan = (plan) => Object.values(ADAPTERS).find((a) => a.planTest(plan)) || null;

/** API base URL for a region and API style; --base-url overrides. */
export function baseUrlFor(adapter, { region = null, api = null, override = null } = {}) {
  const style = api || adapter.api;
  if (override) return String(override).replace(/\/+$/, "");
  const r = adapter.base[region || "default"] || adapter.base.default;
  const url = r[style] || adapter.base.default[style];
  if (!url) throw new Error(`${adapter.id}: no ${style} endpoint; use --api ${Object.keys(adapter.base.default).join(" or ")} or --base-url`);
  return url;
}

/** Window definition, also for windows the adapter did not list (e.g. a second GLM window). */
export function windowDef(adapter, name) {
  return adapter.meter.windows[name] || { unit: null, capacity: null, monthFactor: null, label: name };
}
