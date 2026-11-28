#!/usr/bin/env node
/**
 * api-plan: measures the API dollars behind a coding plan's quota meter when the plan is used
 * through an API key (Kimi, MiniMax, GLM Coding, 百炼 / Qwen Token Plan, DeepRelay, Ollama Cloud,
 * StepFun Step Plan, Xiaomi MiMo Token Plan), and the plan's monthly API value and subsidy
 * multiple. Usage: kits/api-plan/README.md.
 *
 *   node kits/api-plan/scripts/api-plan.mjs providers
 *   node kits/api-plan/scripts/api-plan.mjs plans --provider <id>
 *   node kits/api-plan/scripts/api-plan.mjs check --provider <id> --model <model> [--plan <name>]
 *   node kits/api-plan/scripts/api-plan.mjs run --provider <id> --model <model> --plan <name> [options]
 *   node kits/api-plan/scripts/api-plan.mjs analyse --run <tag>
 *   node kits/api-plan/scripts/api-plan.mjs estimate
 *
 * Sends a fixed workload (workload/prompts.mjs) straight to the provider's OpenAI- or
 * Anthropic-compatible endpoint, one call at a time, reads each response's usage field, prices it
 * at the model's API list price, and reads the plan's meter (automatically, or typed from the
 * dashboard) before, during and after the run.
 *
 * Keys: read from the adapter's environment variable only. A key is never printed, logged or
 * written: every line this script prints passes through redact(), and run / result files hold
 * token counts, prices and meter numbers only (no prompts, no raw responses, no account ids).
 * Zero dependencies (Node ≥ 20).
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ADAPTERS, adapterFor, baseUrlFor, windowDef, MeterShapeError } from "./adapters.mjs";
import { siteModelId, priceFromSite, parsePriceOption, nearModels, priceUsage, plansFor, planFee, siteRef } from "./site.mjs";
import { analyseRun, RUN_SCHEMA, typedResolution } from "./fit.mjs";
import { promptAt, WORKLOAD_VERSION, workloadHash, approxTokens } from "../workload/prompts.mjs";

const __filename = fileURLToPath(import.meta.url);
export const KIT_VERSION = "1.0.0";
const KIT_DIR = path.resolve(path.dirname(__filename), "..");
const REPO_ROOT = path.resolve(KIT_DIR, "..", "..");
const DEFAULT_SITE = path.join(REPO_ROOT, "public", "data", "combined.json");
// API_PLAN_SCRATCH (tests): runs and results go under it.
const SCRATCH = process.env.API_PLAN_SCRATCH ? path.resolve(process.env.API_PLAN_SCRATCH) : null;
const RESULTS_DIR = SCRATCH ? path.join(SCRATCH, "results") : path.join(KIT_DIR, "results");
const RUNS_DIR = path.join(RESULTS_DIR, "runs");

// ---------------------------------------------------------------------------------------------
// Output with key redaction
// ---------------------------------------------------------------------------------------------

const SECRETS = new Set();
export function redact(s) {
  let out = String(s);
  for (const k of SECRETS) if (k && k.length >= 6) out = out.split(k).join("[key]");
  return out;
}
const log = (...a) => console.log(redact(a.join(" ")));
const fail = (msg) => {
  console.error(redact(`error: ${msg}`));
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[k] = true;
    else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

const numOpt = (a, k, dflt) => {
  if (a[k] == null) return dflt;
  const n = Number(a[k]);
  if (!Number.isFinite(n) || n < 0) fail(`--${k} takes a number (got ${a[k]})`);
  return n;
};

// ---------------------------------------------------------------------------------------------
// Context: adapter, key, prices, plan
// ---------------------------------------------------------------------------------------------

function loadSite(a) {
  const p = typeof a.site === "string" ? path.resolve(a.site) : DEFAULT_SITE;
  if (!fs.existsSync(p)) fail(`${p} not found: pass --site <path to public/data/combined.json>`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function context(a, { needModel = true } = {}) {
  const adapter = adapterFor(a.provider);
  if (!adapter) fail(`--provider ${Object.keys(ADAPTERS).join(" | ")}`);
  const region = typeof a.region === "string" ? a.region : null;
  if (region && !adapter.base[region]) fail(`--region for ${adapter.id}: ${Object.keys(adapter.base).filter((r) => r !== "default").join(", ") || "none"}`);
  const api = typeof a.api === "string" ? a.api : adapter.api;
  if (!["openai", "anthropic", "ollama"].includes(api)) fail("--api openai | anthropic | ollama");
  let baseUrl;
  try {
    baseUrl = baseUrlFor(adapter, { region, api, override: typeof a["base-url"] === "string" ? a["base-url"] : null });
  } catch (err) {
    fail(err.message);
  }
  const key = process.env[adapter.env] || null;
  if (key) SECRETS.add(key);
  const mode = a.manual ? "manual" : adapter.meter.default;
  if (!adapter.meter.modes.includes(mode)) fail(`${adapter.id} meter modes: ${adapter.meter.modes.join(", ")}`);
  const site = loadSite(a);
  const model = typeof a.model === "string" ? a.model : null;
  if (needModel && !model) fail("--model <model name as the provider's API takes it>, e.g. --model glm-5.3");
  const siteModel = typeof a["site-model"] === "string" ? a["site-model"] : siteModelId(model);
  let price = null;
  if (typeof a.price === "string") {
    try {
      price = parsePriceOption(a.price);
    } catch (err) {
      fail(err.message);
    }
  } else if (model) {
    price = priceFromSite(site, siteModel);
    if (!price && needModel) fail(`no API price for ${siteModel} in combined.json: pass --site-model <id> (priced: ${nearModels(site, siteModel).join(", ")}) or --price input,cached,output`);
  }
  let fee = null;
  let ref = null;
  if (typeof a.plan === "string") {
    if (!adapter.planTest(a.plan)) fail(`plan "${a.plan}" is not a ${adapter.provider} plan; run: node kits/api-plan/scripts/api-plan.mjs plans --provider ${adapter.id}`);
    try {
      fee = planFee(site, a.plan);
    } catch (err) {
      fail(`${err.message}; run: node kits/api-plan/scripts/api-plan.mjs plans --provider ${adapter.id}`);
    }
    ref = siteRef(site, a.plan, siteModel);
  }
  const meterUrl = typeof a["meter-url"] === "string" ? a["meter-url"] : adapter.meter.url ? adapter.meter.url[region || "default"] || adapter.meter.url.default : null;
  const cliBin = adapter.meter.cli ? (typeof a[adapter.meter.cli.option] === "string" ? a[adapter.meter.cli.option] : adapter.meter.cli.bin) : null;
  return { adapter, region, api, baseUrl, key, mode, site, model, siteModel, price, fee, ref, meterUrl, cliBin, expectModel: typeof a["expect-model"] === "string" ? a["expect-model"] : null };
}

const hostOf = (u) => {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------------------------

export function requestFor(api, baseUrl, key, model, prompt, maxTokens) {
  if (api === "anthropic") {
    const system = prompt.cacheSystem ? [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }] : prompt.system;
    return {
      url: `${baseUrl}/v1/messages`,
      headers: { "content-type": "application/json", "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
      body: { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt.user }] },
    };
  }
  if (api === "ollama") {
    return {
      url: `${baseUrl}/api/chat`,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: { model, stream: false, options: { num_predict: maxTokens }, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] },
    };
  }
  return {
    url: `${baseUrl}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: { model, max_tokens: maxTokens, stream: false, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] },
  };
}

/**
 * Normalized usage { uncached, cached, cacheWrite, output, reasoning } from a response body, or null.
 * OpenAI: prompt_tokens includes cached (prompt_tokens_details.cached_tokens; also the
 * cached_tokens and prompt_cache_hit_tokens variants); completion_tokens includes reasoning.
 * Anthropic: input_tokens excludes cache reads and writes. Ollama: prompt_eval_count, eval_count.
 */
export function usageFrom(api, body) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (api === "ollama") {
    if (body?.prompt_eval_count == null && body?.eval_count == null) return null;
    return { uncached: n(body.prompt_eval_count), cached: 0, cacheWrite: 0, output: n(body.eval_count), reasoning: 0 };
  }
  const u = body?.usage;
  if (!u || typeof u !== "object") return null;
  if (api === "anthropic" || (u.input_tokens != null && u.prompt_tokens == null)) {
    return { uncached: n(u.input_tokens), cached: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens), reasoning: 0 };
  }
  const prompt = n(u.prompt_tokens);
  const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.prompt_cache_hit_tokens);
  const exceeds = cached > prompt;
  return { uncached: exceeds ? prompt : prompt - cached, cached: exceeds ? 0 : cached, cacheWrite: 0, output: n(u.completion_tokens), reasoning: n(u.completion_tokens_details?.reasoning_tokens), ...(exceeds ? { cachedExceedsInput: true } : {}) };
}

async function httpJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 300000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { status: null, error: err?.cause?.code || err?.name || "network error", json: null, text: "" };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, retryAfter: Number(res.headers.get("retry-after")) || null };
}

const excerpt = (r) => redact((r.json?.error?.message || r.json?.message || r.json?.msg || r.text || r.error || "").toString().replace(/\s+/g, " ").slice(0, 200));

async function callOnce(ctx, prompt, maxTokens, timeoutMs) {
  const req = requestFor(ctx.api, ctx.baseUrl, ctx.key, ctx.model, prompt, maxTokens);
  const delays = [5000, 20000, 60000];
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const r = await httpJson(req.url, { method: "POST", headers: req.headers, body: req.body, timeoutMs });
    const t1 = Date.now();
    if (r.status === 200 && r.json) {
      return { ok: true, status: 200, t0, t1, usage: usageFrom(ctx.api, r.json), responseModel: r.json.model ?? null };
    }
    if (r.status === 401 || r.status === 403) fail(`${ctx.adapter.provider} rejected the key in $${ctx.adapter.env} (HTTP ${r.status}): ${excerpt(r)}`);
    const retry = r.status == null || r.status === 429 || r.status >= 500;
    if (retry && attempt < delays.length && !interrupted) {
      const wait = r.retryAfter ? r.retryAfter * 1000 : delays[attempt] * (process.env.API_PLAN_FAST_RETRY ? 0.001 : 1);
      log(`  HTTP ${r.status ?? r.error}: retry in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      continue;
    }
    return { ok: false, status: r.status ?? r.error, t0, t1, usage: null, responseModel: null, error: excerpt(r) };
  }
}

// ---------------------------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------------------------

/** Typed dashboard value → { used, q }. Formats: 37.5%, 37.5, 62.5% left, 1,234,567, 1234567 left. */
export function parseManual(text, { unit = "%", capacity = null } = {}) {
  const t = String(text).trim().toLowerCase();
  const m = t.match(/^(left|remaining)?\s*([\d][\d,]*(?:\.\d+)?)\s*(%)?\s*(left|remaining|used)?$/);
  if (!m) throw new Error(`type a number like ${unit === "%" ? "37.5% or 62.5% left" : "1234567 or 1234567 left"}`);
  const raw = m[2].replace(/,/g, "");
  const v = Number(raw);
  const pct = !!m[3];
  if (pct && unit !== "%") throw new Error(`this window counts ${unit}, not %: type the ${unit} figure`);
  if (unit === "%" && v > 100) throw new Error("a percentage cannot be above 100");
  const left = !!m[1] || m[4] === "left" || m[4] === "remaining";
  const cap = unit === "%" ? 100 : capacity;
  if (left && !(cap > 0)) return { used: -v, q: typedResolution(raw), left: true };
  return { used: left ? cap - v : v, q: typedResolution(raw), left };
}

let lineReader = null;
let pendingLines = [];
let lineWaiters = [];
function nextLine() {
  if (!lineReader) {
    lineReader = readline.createInterface({ input: process.stdin });
    lineReader.on("line", (l) => (lineWaiters.length ? lineWaiters.shift()(l) : pendingLines.push(l)));
    lineReader.on("close", () => {
      for (const w of lineWaiters) w(null);
      lineWaiters = [];
      pendingLines.push(null);
    });
  }
  if (pendingLines.length) return Promise.resolve(pendingLines.shift());
  return new Promise((r) => lineWaiters.push(r));
}

async function readManual(ctx, w, label, capacity) {
  const def = windowDef(ctx.adapter, w);
  for (;;) {
    process.stdout.write(redact(`\n${label}: open ${ctx.adapter.meter.dashboard} and type the ${def.label} usage (${def.unit === "%" ? "% used, or N% left" : `${def.unit} used, or N left`})\nmeter> `));
    const line = await nextLine();
    if (line == null) fail("stdin closed before a meter value was typed");
    try {
      const r = parseManual(line, { unit: def.unit, capacity });
      return { windows: { [w]: { used: r.used, capacity: def.unit === "%" ? 100 : capacity, unit: def.unit, resetsAt: null } }, resolution: { [w]: r.q } };
    } catch (err) {
      log(`  ${err.message}`);
    }
  }
}

async function readAuto(ctx) {
  const m = ctx.adapter.meter;
  let json;
  if (m.cli) {
    const r = spawnSync(ctx.cliBin, m.cli.args, { encoding: "utf8", timeout: 60000, env: process.env });
    if (r.error?.code === "ENOENT") throw new Error(`${ctx.cliBin} not found: install it, pass --${m.cli.option} <path>, or rerun with --manual`);
    if (r.status !== 0) throw new Error(`\`${m.cli.bin} ${m.cli.args.join(" ")}\` exited ${r.status}: ${redact((r.stderr || "").trim().split("\n")[0] || "").slice(0, 200)}`);
    try {
      json = JSON.parse(r.stdout);
    } catch {
      throw new MeterShapeError(ctx.adapter.provider, `\`${m.cli.bin}\` printed no JSON`);
    }
  } else {
    const r = await httpJson(ctx.meterUrl, { headers: { accept: "application/json", ...m.headers(ctx.key) }, timeoutMs: 60000 });
    if (r.status === 401 || r.status === 403) throw new Error(`${ctx.adapter.provider} meter rejected the key in $${ctx.adapter.env} (HTTP ${r.status}): ${excerpt(r)}`);
    if (r.status === 429) {
      await sleep((r.retryAfter || 10) * 1000);
      return readAuto(ctx);
    }
    if (r.status !== 200) throw new Error(`${ctx.adapter.provider} meter HTTP ${r.status ?? r.error}: ${excerpt(r)}. Rerun with --manual.`);
    if (!r.json) throw new MeterShapeError(ctx.adapter.provider, "body is not JSON");
    json = r.json;
  }
  const parsed = m.parse(json, { model: ctx.model });
  return { windows: parsed.windows };
}

const pctOf = (x) => (x && x.capacity > 0 ? (100 * x.used) / x.capacity : null);
const fmtReading = (r) =>
  Object.entries(r.windows)
    .map(([w, x]) => `${w} ${x.unit === "%" ? `${f(x.used, 2)}%` : `${f(x.used, 0)}${x.capacity ? `/${f(x.capacity, 0)}` : ""} ${x.unit}`}${x.resetsAt ? ` (resets ${new Date(x.resetsAt * 1000).toLocaleString()})` : ""}`)
    .join(" · ");

function choosePrimary(adapter, reading, override) {
  const ws = Object.keys(reading.windows);
  if (override) {
    if (!ws.includes(override)) fail(`--window ${override}: the meter reports ${ws.join(", ")}`);
    return override;
  }
  for (const w of [adapter.meter.primary, adapter.meter.fallbackPrimary]) if (w && ws.includes(w)) return w;
  return ws.find((w) => windowDef(adapter, w).monthFactor) || ws[0];
}

/** Expected API $ per percentage point of a window, from the site's multiple. */
function expectedUsdPerPp(ctx, w) {
  const mf = windowDef(ctx.adapter, w).monthFactor;
  if (!ctx.ref?.subsidy || !ctx.fee?.feeUsd || !mf) return null;
  return (ctx.ref.subsidy * ctx.fee.feeUsd) / mf / 100;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function cmdProviders() {
  log("provider   env var            meter    endpoint                                  plans");
  for (const ad of Object.values(ADAPTERS)) {
    log(`${ad.id.padEnd(10)} ${ad.env.padEnd(18)} ${ad.meter.default.padEnd(8)} ${ad.meter.endpoint.padEnd(41)} ${ad.provider}: ${ad.plans.join(", ")}`);
  }
}

function cmdPlans(a) {
  const ad = adapterFor(a.provider);
  if (!ad) fail(`--provider ${Object.keys(ADAPTERS).join(" | ")}`);
  const site = loadSite(a);
  for (const p of plansFor(site, ad)) {
    const fee = planFee(site, p);
    const models = [...new Set(site.entries.filter((e) => e.plan === p && e.billing === "subscription").map((e) => e.baseModelId))].sort();
    log(`${p}  ·  ${fee.currency === "CNY" ? `¥${fee.feeLocal} = ` : ""}$${f(fee.feeUsd)}/month  ·  models: ${models.join(", ")}`);
  }
}

async function cmdCheck(a) {
  const ctx = context(a, { needModel: !!a.model });
  const warn = [];
  log(`node ${process.versions.node}${Number(process.versions.node.split(".")[0]) < 20 ? "  (needs 20+)" : ""}`);
  log(`provider ${ctx.adapter.provider} · api ${ctx.api} ${ctx.baseUrl}`);
  log(`key $${ctx.adapter.env} ${ctx.key ? "set" : "not set"}`);
  if (!ctx.key) warn.push(`set ${ctx.adapter.env}`);
  if (ctx.model) log(`price ${ctx.siteModel}: ${ctx.price ? `$${ctx.price.input} / $${ctx.price.cachedInput} / $${ctx.price.output} per 1M (input / cached / output), ${ctx.price.source}${ctx.price.asOf ? `, as of ${ctx.price.asOf}` : ""}` : "none"}`);
  if (ctx.fee) log(`plan ${ctx.fee.plan} · ${ctx.fee.currency === "CNY" ? `¥${ctx.fee.feeLocal} at ${ctx.fee.cnyPerUsd} CNY/USD = ` : ""}$${f(ctx.fee.feeUsd)}/month · site ${ctx.ref ? `${f(ctx.ref.subsidy)}× (${ctx.ref.id})` : `no ${ctx.siteModel} row`}`);
  else warn.push("pass --plan (see the plans command)");
  log(`meter ${ctx.mode} · ${ctx.mode === "manual" ? ctx.adapter.meter.dashboard : ctx.adapter.meter.cli ? `${ctx.cliBin} ${ctx.adapter.meter.cli.args.join(" ")}` : ctx.meterUrl}`);
  if (ctx.mode === "auto" && (ctx.key || ctx.adapter.meter.cli)) {
    try {
      const r = await readAuto(ctx);
      log(`meter reading ${fmtReading(r)}`);
    } catch (err) {
      log(`meter reading failed: ${err.message}`);
      warn.push("meter unreadable: fix the error above or use --manual");
    }
  }
  log(`workload v${WORKLOAD_VERSION} ${workloadHash()}`);
  if (warn.length) {
    log("\nwarnings:");
    for (const w of warn) log(`  ${w}`);
    process.exitCode = 1;
  } else log("\nok");
}

let interrupted = 0;

async function cmdRun(a) {
  const ctx = context(a);
  const ad = ctx.adapter;
  const tag = typeof a.tag === "string" ? a.tag : `${new Date().toISOString().slice(0, 10)}-${ad.id}`;
  if (!/^[\w.-]+$/.test(tag)) fail("--tag: letters, digits, . _ - only");
  const maxTokens = numOpt(a, "max-tokens", 4000);
  const idleMin = numOpt(a, "idle-min", ctx.mode === "manual" ? 2 : 3);
  const settleMin = numOpt(a, "settle-min", ctx.mode === "manual" ? 5 : 2);
  const maxPct = numOpt(a, "max-pct", 90);
  const maxCalls = numOpt(a, "max-calls", 3000);
  const pollEvery = Math.max(1, Math.round(numOpt(a, "poll-every", 1)));
  const callTimeoutMs = numOpt(a, "call-timeout-s", 300) * 1000;
  const capacityOpt = a.capacity != null ? numOpt(a, "capacity", null) : null;
  const dry = !!a["dry-run"];
  const runDir = path.join(RUNS_DIR, tag);

  const prompt0 = promptAt(0, tag);
  if (dry) {
    const req = requestFor(ctx.api, ctx.baseUrl, `$${ad.env}`, ctx.model, prompt0, maxTokens);
    log(`dry run · ${ad.provider} · tag ${tag} · model ${ctx.model} · meter ${ctx.mode}`);
    log(`price     ${ctx.siteModel} $${ctx.price.input} / $${ctx.price.cachedInput} / $${ctx.price.output} per 1M (input / cached / output) · ${ctx.price.source}`);
    if (ctx.fee) log(`plan      ${ctx.fee.plan} · $${f(ctx.fee.feeUsd)}/month${ctx.fee.currency === "CNY" ? ` (¥${ctx.fee.feeLocal})` : ""} · site ${ctx.ref ? `${f(ctx.ref.subsidy)}×` : "none"}`);
    log(`key       $${ad.env} ${ctx.key ? "set" : "not set"}`);
    log(`request   POST ${req.url}`);
    for (const [k, v] of Object.entries(req.headers)) log(`  ${k}: ${v}`);
    log(`  body: ${JSON.stringify({ ...req.body, system: "…", messages: "…" })}`);
    log(`meter     ${ctx.mode === "manual" ? `typed from ${ad.meter.dashboard}` : ad.meter.cli ? `${ctx.cliBin} ${ad.meter.cli.args.join(" ")}` : `GET ${ctx.meterUrl}`}`);
    const w = typeof a.window === "string" ? a.window : ad.meter.primary;
    const per = expectedUsdPerPp(ctx, w);
    const target = numOpt(a, "target", ad.meter.target);
    log(`target    +${target} pp of ${w}${per ? ` ≈ $${f(per * target)} of API usage` : ""} · stop at ${maxPct}% · max ${maxCalls} calls`);
    log(`workload  v${WORKLOAD_VERSION} ${workloadHash()} · shared, shared, unique · ~${approxTokens().shared} / ~${approxTokens().unique} input tokens · max_tokens ${maxTokens}`);
    log("\nNo calls made.");
    return;
  }

  if (!ctx.key) fail(`set ${ad.env} to the plan's API key`);
  if (!ctx.fee) fail(`--plan <name>; run: node kits/api-plan/scripts/api-plan.mjs plans --provider ${ad.id}`);
  if (fs.existsSync(path.join(runDir, "run.json")) && !a.force) fail(`run ${tag} exists: pick another --tag`);
  fs.mkdirSync(runDir, { recursive: true });

  const run = {
    schema: RUN_SCHEMA,
    kitVersion: KIT_VERSION,
    tag,
    adapter: ad.id,
    provider: ad.provider,
    region: ctx.region,
    api: ctx.api,
    apiHost: hostOf(ctx.baseUrl),
    meterEndpoint: ctx.mode === "manual" ? "manual" : ad.meter.endpoint,
    mode: ctx.mode,
    model: ctx.model,
    expectModel: ctx.expectModel,
    siteModel: ctx.siteModel,
    price: ctx.price,
    fee: ctx.fee,
    siteRef: ctx.ref,
    workload: { version: WORKLOAD_VERSION, hash: workloadHash() },
    maxTokens,
    primary: null,
    target: null,
    startedAt: nowIso(),
    endedAt: null,
    stopReason: null,
    calls: [],
    readings: [],
    idle: [],
    pauses: [],
  };
  const save = () => fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n");
  save();
  log(`run ${tag} · ${ad.provider} · ${ctx.model} · plan ${ctx.fee.plan} · meter ${ctx.mode}`);
  log(`run file ${path.join(runDir, "run.json")}`);

  process.on("SIGINT", () => {
    interrupted++;
    if (interrupted === 1) log("\nstopping after the current call; Ctrl-C again to quit now");
    else process.exit(130);
  });

  let lastPollMs = 0;
  let primary = typeof a.window === "string" ? a.window : null;
  const read = async (phase) => {
    let r;
    if (ctx.mode === "manual") {
      const w = primary || ad.meter.primary;
      r = await readManual(ctx, w, phase, capacityOpt);
    } else {
      // API_PLAN_MIN_POLL_SEC (tests) overrides the provider's meter rate limit
      const minPoll = process.env.API_PLAN_MIN_POLL_SEC != null ? Number(process.env.API_PLAN_MIN_POLL_SEC) : ad.meter.minPollSec || 0;
      const wait = minPoll * 1000 - (Date.now() - lastPollMs);
      if (wait > 0) await sleep(wait);
      try {
        r = await readAuto(ctx);
      } catch (err) {
        run.stopReason = `meter error: ${redact(err.message)}`;
        save();
        fail(err.message);
      }
      lastPollMs = Date.now();
      if (capacityOpt) for (const x of Object.values(r.windows)) if (!x.capacity) x.capacity = capacityOpt;
    }
    const rec = { ts: Date.now(), phase, afterCall: run.calls.length, windows: r.windows, ...(r.resolution ? { resolution: r.resolution } : {}) };
    run.readings.push(rec);
    save();
    return rec;
  };
  const idle = async (phase, minutes) => {
    const from = run.readings.length;
    await read(`${phase}-0`);
    log(`idle check (${phase}): ${minutes} min with no calls`);
    await sleep(minutes * 60000);
    await read(`${phase}-1`);
    run.idle.push({ phase, from, to: run.readings.length - 1 });
    save();
  };

  // before
  if (ctx.mode === "auto") {
    const first = await read("first");
    run.readings.pop();
    primary = choosePrimary(ad, first, primary);
    log(`meter ${fmtReading(first)}`);
  } else primary ||= ad.meter.primary;
  run.primary = primary;
  await idle("before", idleMin);
  const start = run.readings[run.readings.length - 1];
  const startX = start.windows[primary];
  const cap = startX?.capacity || null;
  const target = numOpt(a, "target", ad.meter.target);
  run.target = { window: primary, value: target, unit: cap ? "pp" : startX?.unit };
  const per = expectedUsdPerPp(ctx, primary);
  const usdTarget = a["usd-target"] != null ? numOpt(a, "usd-target", null) : per ? per * target : null;
  const maxUsd = a["max-usd"] != null ? numOpt(a, "max-usd", null) : usdTarget ? 3 * usdTarget : Infinity;
  if (ctx.mode === "manual" && !usdTarget) fail(`no site multiple for ${ctx.siteModel} on ${ctx.fee.plan} to pace a manual run: pass --usd-target <API $ to spend>`);
  const startPct = pctOf(startX);
  if (startPct != null && startPct + (cap ? target : 0) > maxPct) fail(`${primary} at ${f(startPct, 1)}%: +${target} pp would pass ${maxPct}%; run after the reset`);
  log(`target +${target} ${cap ? "pp" : startX?.unit} of ${primary}${usdTarget ? ` (about $${f(usdTarget)} of API usage)` : ""} · stop at ${maxPct}%${Number.isFinite(maxUsd) ? ` or $${f(maxUsd)}` : ""}`);

  let usd = 0;
  let fails = 0;
  let n = 0;
  const loopStart = Date.now();
  let last = start;
  while (!interrupted) {
    const p = promptAt(n, tag);
    const r = await callOnce(ctx, p, maxTokens, callTimeoutMs);
    const rec = { n, id: p.id, profile: p.profile, t0: r.t0, t1: r.t1, ok: r.ok, status: r.status, usage: r.usage, responseModel: r.responseModel, usd: 0, parts: null };
    if (r.ok && r.usage) {
      const pr = priceUsage(r.usage, ctx.price);
      rec.usd = pr.usd;
      rec.parts = pr.parts;
    }
    if (!r.ok) rec.error = r.error;
    run.calls.push(rec);
    usd += rec.usd;
    n++;
    save();
    if (ctx.mode === "auto" && (n % pollEvery === 0)) last = await read("run");
    const x = last.windows[primary];
    const moved = x && startX ? x.used - startX.used : 0;
    const movedPp = cap ? (100 * moved) / cap : moved;
    const mins = (Date.now() - loopStart) / 60000;
    const frac = ctx.mode === "manual" ? usd / usdTarget : movedPp / target;
    const eta = frac > 0 ? ((1 - frac) / frac) * mins : null;
    const others = ctx.mode === "auto" ? Object.entries(last.windows).filter(([w]) => w !== primary).map(([w, y]) => `${w} ${f(pctOf(y) ?? y.used, 1)}${pctOf(y) != null ? "%" : ""}`).join("  ") : "";
    const u = r.usage;
    log(`${hhmm(Date.now())} ${p.id} ${p.profile.padEnd(6)} ${String(r.status).padEnd(3)} in ${u ? u.uncached + u.cached + u.cacheWrite : "—"} (cached ${u ? u.cached : "—"}) out ${u ? u.output : "—"}  $${f(rec.usd, 4)}  Σ$${f(usd, 3)}  ${ctx.mode === "auto" ? `${primary} ${f(pctOf(x) ?? x?.used, 2)}${cap ? "%" : ""} +${f(movedPp, 2)}/${target}` : `$${f(usd, 2)}/${f(usdTarget, 2)}`}  ${others}${eta != null && eta > 0 ? `  ~${Math.round(eta)} min left` : ""}`);
    if (!r.ok) {
      fails++;
      log(`  failed: ${r.error || r.status}`);
      if (n === 1) {
        run.stopReason = "first call failed";
        break;
      }
    } else fails = 0;
    if (fails >= 3) {
      run.stopReason = "3 failed calls in a row";
      break;
    }
    if (interrupted) break;
    if (ctx.mode === "auto" && movedPp >= target) {
      run.stopReason = "target reached";
      break;
    }
    if (ctx.mode === "manual" && usd >= usdTarget) {
      run.stopReason = "target reached ($ target)";
      break;
    }
    if (usd >= maxUsd) {
      run.stopReason = `ceiling: max-usd ${f(maxUsd)}`;
      break;
    }
    if (n >= maxCalls) {
      run.stopReason = `ceiling: max-calls ${maxCalls}`;
      break;
    }
    if (ctx.mode === "auto") {
      const over = Object.entries(last.windows).find(([w, y]) => windowDef(ad, w).monthFactor && pctOf(y) != null && pctOf(y) >= maxPct);
      if (over) {
        run.stopReason = `ceiling: ${over[0]} at ${f(pctOf(over[1]), 1)}%`;
        break;
      }
      const short = Object.entries(last.windows).find(([w, y]) => !windowDef(ad, w).monthFactor && pctOf(y) != null && pctOf(y) >= 95);
      if (short) {
        const until = (short[1].resetsAt ? short[1].resetsAt * 1000 : Date.now() + 1800000) + 60000;
        log(`${short[0]} at ${f(pctOf(short[1]), 1)}%: paused until ${hhmm(until)}`);
        run.pauses.push({ from: nowIso(), until: new Date(until).toISOString(), window: short[0] });
        save();
        while (Date.now() < until && !interrupted) await sleep(Math.min(60000, until - Date.now()));
        last = await read("run");
      }
    }
  }
  if (interrupted) run.stopReason = "interrupted";
  log(`\nstopped: ${run.stopReason}`);
  if (interrupted < 2) {
    if (ctx.mode === "manual") log(`waiting ${settleMin} min for the dashboard to update`);
    await sleep(settleMin * 60000);
    await idle("after", idleMin);
  }
  run.endedAt = nowIso();
  save();
  if (lineReader) lineReader.close();
  analyseAndWrite({ run: tag });
}

function analyseAndWrite(a) {
  if (typeof a.run !== "string") fail("analyse --run <tag>");
  const p = path.join(RUNS_DIR, a.run, "run.json");
  if (!fs.existsSync(p)) fail(`${p} not found`);
  const run = JSON.parse(fs.readFileSync(p, "utf8"));
  const res = analyseRun(run);
  res.generatedAt = nowIso();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = typeof a.out === "string" ? path.resolve(a.out) : path.join(RESULTS_DIR, `${run.tag}.json`);
  fs.writeFileSync(out, redact(JSON.stringify(res, null, 2)) + "\n");
  printSummary(res);
  log(`\nwrote ${out}`);
  return res;
}

function printSummary(r) {
  log(`\n${r.tag} · ${r.provider} · ${r.model} · ${r.plan ?? "no plan"} · verdict ${r.verdict}`);
  log(`calls ${r.run.okCalls}/${r.run.calls} · ${f(r.run.minutes, 0)} min · stopped: ${r.run.stopReason}`);
  log(`tokens input ${r.tokens.input} (cached ${r.tokens.cachedInput}, cache write ${r.tokens.cacheWrite}) · output ${r.tokens.output} (reasoning ${r.tokens.reasoning}) · cache share ${r.cacheShare == null ? "—" : `${f(100 * r.cacheShare, 1)}%`}`);
  log(`API $${f(r.usd.total, 4)} at ${r.prices.input} / ${r.prices.cachedInput} / ${r.prices.output} per 1M (${r.prices.source})`);
  for (const [w, x] of Object.entries(r.windows)) {
    if (!x.usable) {
      log(`${w.padEnd(14)} ${x.first ?? "—"} → ${x.last ?? "—"} · ${x.reason}`);
      continue;
    }
    const u = x.usdPerUnit;
    const ci = u.ci95 ? `${f(u.ci95[0], 6)}–${f(u.ci95[1], 6)}` : "—";
    log(`${w.padEnd(14)} ${f(x.first, 4)} → ${f(x.last, 4)} ${x.unit} · $${f(u.est, 6)} per ${x.unit === "%" ? "pp" : x.unit} (95% ${ci})${x.poolUsd ? ` · window $${f(x.poolUsd.est)}` : ""}${x.monthlyApiUsd ? ` · month $${f(x.monthlyApiUsd.est)}` : ""}`);
  }
  if (r.subsidy) {
    const s = r.subsidy;
    const ci = (c) => (c ? `${f(c[0])}–${f(c[1])}` : "—");
    log(`monthly API value $${f(s.monthlyApiUsd.est)} (95% ${ci(s.monthlyApiUsd.ci95)}) from ${s.window}${s.multiple ? ` · subsidy ${f(s.multiple.est)}× (95% ${ci(s.multiple.ci95)}) on $${f(r.fee.feeUsd)}${r.fee.currency === "CNY" ? ` (¥${r.fee.feeLocal})` : ""}` : ""}`);
    if (s.site) log(`site ${f(s.site.value)}× · measured ÷ site ${f(s.site.ratio, 3)}`);
  }
  for (const fl of r.flags) log(`${fl.severity.padEnd(7)} ${fl.code}: ${fl.detail}`);
}

/** Per-plan run estimates from the site's multiples and the workload's token sizes. */
export function estimates(site, { secondsPerCall = 20, outputTokens = 1200 } = {}) {
  const tk = approxTokens();
  const rows = [];
  for (const ad of Object.values(ADAPTERS)) {
    const w = ad.meter.primary;
    const mf = windowDef(ad, w).monthFactor;
    for (const plan of plansFor(site, ad)) {
      const fee = planFee(site, plan);
      const cand = site.entries.filter((e) => e.plan === plan && Number.isFinite(e.subsidyMultiple) && priceFromSite(site, e.baseModelId));
      if (!cand.length) continue;
      cand.sort((a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1) || (a.id < b.id ? -1 : 1));
      const e = cand[0];
      const p = priceFromSite(site, e.baseModelId);
      const shared = (0.05 * tk.shared * p.input + 0.95 * tk.shared * p.cachedInput + outputTokens * p.output) / 1e6;
      const unique = (tk.unique * p.input + outputTokens * p.output) / 1e6;
      const perCall = (2 * shared + unique) / 3;
      const perPp = (e.subsidyMultiple * fee.feeUsd) / mf / 100;
      const usd = perPp * ad.meter.target;
      const calls = Math.ceil(usd / perCall);
      const idle = ad.meter.default === "manual" ? 2 * 2 + 5 : 2 * 3 + 2;
      rows.push({ adapter: ad.id, plan, model: e.baseModelId, subsidy: e.subsidyMultiple, feeUsd: fee.feeUsd, window: w, target: ad.meter.target, usdPerPp: perPp, usd, perCall, calls, minutes: Math.round((calls * secondsPerCall) / 60 + idle) });
    }
  }
  return rows;
}

function cmdEstimate(a) {
  const rows = estimates(loadSite(a));
  log("| Plan | Model | Site multiple | Meter use | API $ | Calls | Time |");
  log("|---|---|---|---|---|---|---|");
  for (const r of rows) log(`| ${r.plan} | ${r.model} | ${f(r.subsidy, 1)}× | +${r.target}% of ${r.window} | $${f(r.usd)} | ${r.calls} | ${r.minutes < 90 ? `${r.minutes} min` : `${f(r.minutes / 60, 1)} h`} |`);
}

const HELP = `api-plan ${KIT_VERSION}

  node kits/api-plan/scripts/api-plan.mjs providers
  node kits/api-plan/scripts/api-plan.mjs plans --provider <id>
  node kits/api-plan/scripts/api-plan.mjs check --provider <id> [--model <m>] [--plan <name>]
  node kits/api-plan/scripts/api-plan.mjs run --provider <id> --model <m> --plan <name> [options]
  node kits/api-plan/scripts/api-plan.mjs analyse --run <tag> [--out <file>]
  node kits/api-plan/scripts/api-plan.mjs estimate

providers: ${Object.keys(ADAPTERS).join(", ")}

run options
  --manual            type the meter from the dashboard
  --window <name>     meter window to pace on (default: the adapter's)
  --target N          pp of that window (default per adapter)
  --tag <tag>         run name (default <date>-<provider>)
  --region <r>        cn | intl | sgp (per adapter)
  --api <style>       openai | anthropic | ollama
  --base-url <url>    API base URL
  --meter-url <url>   meter URL
  --bl / --deeprelay <path>   meter CLI
  --price i,c,o       USD per 1M tokens: input, cached input, output
  --site-model <id>   combined.json baseModelId for the price and site multiple
  --expect-model <m>  model name the responses carry
  --capacity N        window size when the meter does not report it
  --usd-target N      API $ to spend (manual runs without a site multiple)
  --max-pct N         stop when a window reaches N% (default 90)
  --max-usd N         stop at N API $ (default 3 × the expected $)
  --max-calls N       default 3000
  --max-tokens N      default 4000
  --poll-every N      calls between meter reads (default 1)
  --idle-min N        idle check length (default 3; manual 2)
  --settle-min N      wait after the run (default 2; manual 5)
  --force             reuse a tag
  --dry-run           print the request and plan; no calls
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help || cmd === "help") return log(HELP);
  if (cmd === "providers") return cmdProviders();
  if (cmd === "plans") return cmdPlans(a);
  if (cmd === "check") return cmdCheck(a);
  if (cmd === "run") return cmdRun(a);
  if (cmd === "analyse" || cmd === "analyze") return analyseAndWrite(a);
  if (cmd === "estimate") return cmdEstimate(a);
  fail(`unknown command ${cmd}\n${HELP}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(redact(err?.stack || err));
    process.exit(1);
  });
}
