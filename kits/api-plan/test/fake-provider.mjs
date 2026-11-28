#!/usr/bin/env node
/**
 * Fake provider for the API plan kit tests: one HTTP server on a free random port (127.0.0.1:0),
 * started as its own child process so a test can stop it by that PID. Makes no outside call.
 *
 * Serves the model endpoints (…/chat/completions, …/v1/messages, …/api/chat) and the meter
 * endpoints in the recorded shapes of kits/api-plan/scripts/adapters.mjs. Each successful call
 * moves a hidden meter: true usage per window += call $ (at FAKE_PRICE) ÷ β[window]; readings are
 * floored to the window's resolution.
 *
 * Config: FAKE_CONFIG (JSON)
 *   key        expected API key
 *   kind       glm | minimax | ollama | ollama-legacy | mimo | bailian | deeprelay | kimi
 *   price      { input, cachedInput, output, cacheWrite? } USD per 1M
 *   beta       { <window>: $ per native unit }
 *   start      { <window>: native units used at start }
 *   capacity   { <window>: window size } (count / credit / token meters)
 *   resolution { <window>: reading step } (default 1)
 *   model      model name to put in responses (default: the requested one)
 *   bumpOnRead { n, window, amount } add outside use when the n-th meter read is served (1-based)
 *   resetAtCall { n, window } reset a window before call n (0-based)
 *   reject     true: every call gets 401 with the received key echoed in the body
 *   noUsage    true: responses carry no usage field
 *   shape      "bad": meter responses have an unknown shape
 *   leak       a string added as account_email to every JSON response
 * Prints {"port": N} on stdout once listening.
 *
 * Test-only routes: GET /__requests (recorded request summaries), GET /__state (true usage),
 * GET /__cli/<kind> (the JSON a fake meter CLI prints).
 */

import http from "node:http";

const cfg = JSON.parse(process.env.FAKE_CONFIG || "{}");
const KEY = cfg.key || "sk-test";
const price = cfg.price || { input: 1, cachedInput: 0.1, output: 4 };
const beta = cfg.beta || {};
const used = { ...(cfg.start || {}) };
for (const w of Object.keys(beta)) used[w] ??= 0;
const resolution = cfg.resolution || {};
const capacity = cfg.capacity || {};
const nowS = Math.floor(Date.now() / 1000);
const resets = { "5h": nowS + 4 * 3600, session: nowS + 4 * 3600, weekly: nowS + 5 * 86400, monthly: nowS + 20 * 86400, "monthly-input": nowS + 20 * 86400, "monthly-output": nowS + 20 * 86400, "weekly-input": nowS + 5 * 86400, "weekly-output": nowS + 5 * 86400 };
const requests = [];
let calls = 0;
let reads = 0;
let sharedSeen = false;

const authKind = (h) => (h == null ? "none" : h === KEY ? "raw" : h === `Bearer ${KEY}` ? "bearer" : "other");
const reading = (w) => {
  const q = resolution[w] ?? 1;
  return Math.floor((used[w] ?? 0) / q + 1e-9) * q;
};
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function usageFor(body, api) {
  const sys = api === "anthropic" ? (Array.isArray(body.system) ? body.system.map((b) => b.text).join("") : body.system || "") : (body.messages || []).filter((m) => m.role === "system").map((m) => m.content).join("");
  const user = (body.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("");
  const sysT = Math.ceil(sys.length / 4);
  const userT = Math.ceil(user.length / 4) + 8;
  const shared = sysT > 2000;
  let cached = 0;
  let write = 0;
  if (shared && api !== "ollama") {
    if (sharedSeen) cached = Math.floor(sysT * 0.9);
    else if (api === "anthropic") write = sysT;
    sharedSeen = true;
  }
  const output = 700 + ((calls * 37) % 400);
  const uncached = sysT + userT - cached - write;
  const usd = (uncached * price.input + cached * price.cachedInput + write * (price.cacheWrite ?? price.input) + output * price.output) / 1e6;
  return { uncached, cached, write, output, usd };
}

function charge(usd, u) {
  for (const w of Object.keys(beta)) {
    if (cfg.kind === "deeprelay") {
      // weighted tokens: input (cached counts in full) or output
      used[w] += /output/.test(w) ? u.output : u.uncached + u.cached + u.write;
    } else used[w] += usd / beta[w];
  }
}

function meterJson(kind) {
  reads++;
  if (cfg.bumpOnRead && reads === cfg.bumpOnRead.n) used[cfg.bumpOnRead.window] += cfg.bumpOnRead.amount;
  if (cfg.shape === "bad") return { ok: true, something: { else: 1 } };
  if (kind === "glm") {
    return {
      code: 200,
      msg: "ok",
      data: {
        limits: [
          { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 3, percentage: 3 },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: reading("5h"), nextResetTime: resets["5h"] * 1000 },
          ...(beta.weekly ? [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: reading("weekly"), nextResetTime: resets.weekly * 1000 }] : []),
        ],
        planName: "Lite",
      },
      success: true,
    };
  }
  if (kind === "minimax") {
    return {
      model_remains: [
        { model_name: "speech-2.8-hd", current_interval_total_count: 0, current_interval_usage_count: 0 },
        {
          model_name: "MiniMax-M*",
          start_time: (resets["5h"] - 5 * 3600) * 1000,
          end_time: resets["5h"] * 1000,
          remains_time: 3600000,
          current_interval_total_count: capacity["5h"],
          current_interval_usage_count: capacity["5h"] - reading("5h"),
          current_weekly_total_count: capacity.weekly,
          current_weekly_usage_count: capacity.weekly - reading("weekly"),
          weekly_start_time: (resets.weekly - 7 * 86400) * 1000,
          weekly_end_time: resets.weekly * 1000,
        },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    };
  }
  if (kind === "ollama") {
    return { included: { balance_usd: r6(capacity.monthly - reading("monthly")), allowance_usd: capacity.monthly, period: { from: new Date((resets.monthly - 10 * 86400) * 1000).toISOString(), until: new Date(resets.monthly * 1000).toISOString() } }, purchased: { balance_usd: 25 } };
  }
  if (kind === "ollama-legacy") {
    return { included: { session: { remaining_percent: r6(100 - reading("session")), resets_at: new Date(resets.session * 1000).toISOString() }, weekly: { remaining_percent: r6(100 - reading("weekly")), resets_at: new Date(resets.weekly * 1000).toISOString() } }, purchased: { balance_usd: 0 } };
  }
  if (kind === "mimo") {
    const total = capacity.monthly;
    const u = reading("monthly");
    return { object: "token_plan", plan_code: "lite", period: { start_at: "2026-11-01 00:00:00", end_at: "2026-12-01 00:00:00" }, quota: { total_credits: total, used_credits: u, remaining_credits: Math.max(0, total - u) }, auto_renew: true, claw_enabled: false };
  }
  if (kind === "bailian") {
    return {
      requestId: "00000000-test",
      hasQuotaData: true,
      data: {
        specCode: "lite",
        usage: JSON.stringify({
          per5HourPercentage: r6(reading("5h") / 100),
          per5HourResetTime: resets["5h"] * 1000,
          per1WeekPercentage: r6(reading("weekly") / 100),
          per1WeekResetTime: resets.weekly * 1000,
          per1MonthPercentage: r6(reading("monthly") / 100),
          per1MonthResetTime: resets.monthly * 1000,
        }),
      },
    };
  }
  if (kind === "deeprelay") {
    return {
      subscribed: true,
      status: "active",
      cancel_at_period_end: false,
      plan: { id: "base", name: "Base" },
      quota: { input_tokens_monthly: capacity["monthly-input"], output_tokens_monthly: capacity["monthly-output"], input_tokens_weekly: capacity["weekly-input"], output_tokens_weekly: capacity["weekly-output"] },
      usage: {
        weighted_input_tokens: reading("monthly-input"),
        week_start: new Date((resets.weekly - 7 * 86400) * 1000).toISOString(),
        week_resets_at: new Date(resets["weekly-input"] * 1000).toISOString(),
        by_model: [{ model: "deepseek-v4.1-flash", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, usage_factor_milli: 1000, weighted_input_tokens: reading("monthly-input"), weighted_output_tokens: reading("monthly-output") }],
        weekly_by_model: [{ model: "deepseek-v4.1-flash", usage_factor_milli: 1000, weighted_input_tokens: reading("weekly-input"), weighted_output_tokens: reading("weekly-output") }],
      },
      balance_payment: { balance_cents: 0, spendable_cents: 0, free_credit_cents: 0 },
    };
  }
  return { error: "unknown kind" };
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  // leak: an account email / id on every response object, as a real API might return
  const body = cfg.leak && obj && typeof obj === "object" && !Array.isArray(obj) ? { ...obj, account_email: cfg.leak } : obj;
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (d) => (data += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/__requests") return send(res, 200, requests);
    if (p === "/__state") return send(res, 200, { used, calls, reads, reading: Object.fromEntries(Object.keys(used).map((w) => [w, reading(w)])) });
    if (p.startsWith("/__cli/")) return send(res, 200, meterJson(p.slice(7)));
    const isCall = req.method === "POST" && (p.endsWith("/chat/completions") || p.endsWith("/v1/messages") || p.endsWith("/api/chat"));
    const api = p.endsWith("/v1/messages") ? "anthropic" : p.endsWith("/api/chat") ? "ollama" : "openai";
    const auth = req.headers.authorization;
    let body = {};
    try {
      body = data ? JSON.parse(data) : {};
    } catch {
      return send(res, 400, { error: { message: "bad json" } });
    }
    requests.push({
      method: req.method,
      path: p,
      auth: authKind(auth),
      xApiKey: authKind(req.headers["x-api-key"]),
      anthropicVersion: req.headers["anthropic-version"] ?? null,
      model: body.model ?? null,
      maxTokens: body.max_tokens ?? body.options?.num_predict ?? null,
      stream: body.stream ?? null,
      systemCache: Array.isArray(body.system) ? !!body.system[0]?.cache_control : null,
      roles: (body.messages || []).map((m) => m.role),
    });
    if (!isCall) {
      const kinds = { "/api/monitor/usage/quota/limit": "glm", "/v1/token_plan/remains": "minimax", "/api/balance": cfg.kind === "ollama-legacy" ? "ollama-legacy" : "ollama", "/v1/platform/token_plan": "mimo" };
      const kind = kinds[p];
      if (!kind) return send(res, 404, { error: "not found" });
      const okAuth = kind === "glm" ? authKind(auth) === "raw" || authKind(auth) === "bearer" : authKind(auth) === "bearer";
      if (!okAuth) return send(res, 401, { error: { message: `invalid key ${auth}` } });
      return send(res, 200, meterJson(kind));
    }
    const okAuth = api === "anthropic" ? authKind(req.headers["x-api-key"]) === "raw" : authKind(auth) === "bearer";
    if (cfg.reject || !okAuth) return send(res, 401, { error: { message: `Invalid API key: ${auth || req.headers["x-api-key"]}` } });
    if (cfg.resetAtCall && cfg.resetAtCall.n === calls) {
      used[cfg.resetAtCall.window] = 0;
      resets[cfg.resetAtCall.window] += 7 * 86400;
    }
    const u = usageFor(body, api);
    calls++;
    charge(u.usd, u);
    const model = cfg.model || body.model;
    const text = "```js\nexport const ok = true;\n```\n- done";
    if (cfg.noUsage) return send(res, 200, { id: `c${calls}`, model, choices: [{ message: { role: "assistant", content: text } }] });
    if (api === "anthropic") {
      return send(res, 200, { id: `m${calls}`, type: "message", model, content: [{ type: "text", text }], usage: { input_tokens: u.uncached, cache_read_input_tokens: u.cached, cache_creation_input_tokens: u.write, output_tokens: u.output } });
    }
    if (api === "ollama") return send(res, 200, { model, message: { role: "assistant", content: text }, done: true, prompt_eval_count: u.uncached, eval_count: u.output });
    return send(res, 200, {
      id: `c${calls}`,
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: u.uncached + u.cached, completion_tokens: u.output, total_tokens: u.uncached + u.cached + u.output, prompt_tokens_details: { cached_tokens: u.cached }, completion_tokens_details: { reasoning_tokens: Math.round(u.output * 0.3) } },
    });
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port, pid: process.pid }) + "\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
