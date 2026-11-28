// node --test kits/api-plan/test/*.test.mjs
// Adapters: request format per API style, usage parsing, meter parsing against recorded shapes,
// manual input.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, adapterFor, adapterForPlan, baseUrlFor, MeterShapeError, parseGlm, parseMinimax, parseBailian, parseDeeprelay, parseOllama, parseMimo, toEpochS } from "../scripts/adapters.mjs";
import { requestFor, usageFrom, parseManual, redact } from "../scripts/api-plan.mjs";
import { promptAt, workloadHash, CYCLE } from "../workload/prompts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "meters.json"), "utf8"));

test("every adapter has an env var, a base URL, a meter mode, a dashboard and a primary window with a month factor", () => {
  const ids = Object.keys(ADAPTERS);
  assert.deepEqual(ids.sort(), ["bailian", "deeprelay", "glm", "kimi", "mimo", "minimax", "ollama", "step"]);
  for (const ad of Object.values(ADAPTERS)) {
    assert.match(ad.env, /^[A-Z][A-Z0-9_]*_API_KEY$/, ad.id);
    assert.match(baseUrlFor(ad), /^https:\/\//, ad.id);
    assert.ok(ad.meter.modes.includes(ad.meter.default), ad.id);
    assert.match(ad.meter.dashboard, /^https:\/\//, ad.id);
    assert.ok(ad.meter.windows[ad.meter.primary]?.monthFactor > 0, `${ad.id} primary ${ad.meter.primary}`);
    if (ad.meter.default === "auto") assert.equal(typeof ad.meter.parse, "function", ad.id);
    assert.ok(ad.meter.target > 0);
  }
  assert.equal(ADAPTERS.kimi.meter.default, "manual");
  assert.equal(ADAPTERS.step.meter.default, "manual");
  for (const id of ["glm", "minimax", "bailian", "deeprelay", "ollama", "mimo"]) assert.equal(ADAPTERS[id].meter.default, "auto", id);
  assert.equal(ADAPTERS.glm.meter.endpoint, "undocumented");
});

test("site plan names map to their adapter", () => {
  const cases = {
    "Kimi Allegretto": "kimi",
    "Kimi Ultra": "kimi",
    "GLM Coding Lite ¥118 (mixed)": "glm",
    "MiniMax M Plan Go (CN)": "minimax",
    "MiniMax Token Plan Plus (Global)": "minimax",
    "阿里云百炼 Token Plan Pro (¥312)": "bailian",
    "Qwen Token Plan Standard": "bailian",
    "DeepRelay Base": "deeprelay",
    "Ollama Pro": "ollama",
    "Step Plan Plus (¥99)": "step",
    "MiMo Token Plan Lite (peak)": "mimo",
  };
  for (const [plan, id] of Object.entries(cases)) assert.equal(adapterForPlan(plan)?.id, id, plan);
  assert.equal(adapterForPlan("Tencent Token Plan Lite"), null);
  assert.equal(adapterForPlan("ChatGPT Plus"), null);
});

test("base URLs per region and API style; --base-url wins", () => {
  assert.equal(baseUrlFor(ADAPTERS.glm), "https://api.z.ai/api/coding/paas/v4");
  assert.equal(baseUrlFor(ADAPTERS.glm, { region: "cn" }), "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(baseUrlFor(ADAPTERS.glm, { api: "anthropic" }), "https://api.z.ai/api/anthropic");
  assert.equal(baseUrlFor(ADAPTERS.minimax), "https://api.minimax.io/anthropic");
  assert.equal(baseUrlFor(ADAPTERS.bailian, { region: "intl" }), "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(baseUrlFor(ADAPTERS.mimo, { region: "sgp" }), "https://token-plan-sgp.xiaomimimo.com/v1");
  assert.equal(baseUrlFor(ADAPTERS.ollama), "https://ollama.com");
  assert.equal(baseUrlFor(ADAPTERS.kimi, { override: "http://127.0.0.1:9/x/" }), "http://127.0.0.1:9/x");
  assert.throws(() => baseUrlFor(ADAPTERS.deeprelay, { api: "anthropic" }), /no anthropic endpoint/);
});

test("request format: OpenAI chat/completions, Anthropic messages with a cached system block, Ollama /api/chat", () => {
  const shared = promptAt(0, "t");
  const unique = promptAt(2, "t");
  const o = requestFor("openai", "https://h/v1", "KEY", "glm-5.3", shared, 4000);
  assert.equal(o.url, "https://h/v1/chat/completions");
  assert.equal(o.headers.authorization, "Bearer KEY");
  assert.equal(o.body.model, "glm-5.3");
  assert.equal(o.body.max_tokens, 4000);
  assert.equal(o.body.stream, false);
  assert.deepEqual(o.body.messages.map((m) => m.role), ["system", "user"]);
  const a = requestFor("anthropic", "https://h/anthropic", "KEY", "MiniMax-M3", shared, 1000);
  assert.equal(a.url, "https://h/anthropic/v1/messages");
  assert.equal(a.headers["x-api-key"], "KEY");
  assert.equal(a.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(a.body.system[0].cache_control, { type: "ephemeral" });
  assert.equal(typeof requestFor("anthropic", "https://h", "K", "m", unique, 10).body.system, "string", "unique prompts are not cache-marked");
  const l = requestFor("ollama", "https://ollama.com", "KEY", "deepseek-v4.1-flash", shared, 500);
  assert.equal(l.url, "https://ollama.com/api/chat");
  assert.equal(l.body.stream, false);
  assert.equal(l.body.options.num_predict, 500);
});

test("usage: OpenAI cached variants, Anthropic cache read / write, Ollama counts, missing usage", () => {
  assert.deepEqual(usageFrom("openai", { usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 50 } } }), { uncached: 200, cached: 800, cacheWrite: 0, output: 200, reasoning: 50 });
  assert.equal(usageFrom("openai", { usage: { prompt_tokens: 1000, completion_tokens: 5, cached_tokens: 300 } }).cached, 300, "Moonshot-style cached_tokens");
  assert.equal(usageFrom("openai", { usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 600 } }).cached, 600, "DeepSeek-style prompt_cache_hit_tokens");
  const over = usageFrom("openai", { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 400 } } });
  assert.equal(over.uncached, 100);
  assert.equal(over.cached, 0);
  assert.equal(over.cachedExceedsInput, true);
  assert.deepEqual(usageFrom("anthropic", { usage: { input_tokens: 50, cache_read_input_tokens: 7000, cache_creation_input_tokens: 10, output_tokens: 900 } }), { uncached: 50, cached: 7000, cacheWrite: 10, output: 900, reasoning: 0 });
  assert.deepEqual(usageFrom("ollama", { prompt_eval_count: 3000, eval_count: 700 }), { uncached: 3000, cached: 0, cacheWrite: 0, output: 700, reasoning: 0 });
  assert.equal(usageFrom("openai", { choices: [] }), null);
  assert.equal(usageFrom("ollama", { message: {} }), null);
});

test("meter: GLM windows by unit + number, MCP pool ignored, ordinal fallback", () => {
  const r = parseGlm(FX.glm);
  assert.deepEqual(Object.keys(r.windows).sort(), ["5h", "weekly"]);
  assert.deepEqual(r.windows["5h"], { used: 23, capacity: 100, unit: "%", resetsAt: 1764337200 });
  assert.equal(r.windows.weekly.used, 41);
  assert.equal(r.windows.weekly.resetsAt, 1764806400);
  const n = parseGlm(FX.glmNoUnits);
  assert.equal(n.windows["5h"].used, 7);
  assert.equal(n.windows.weekly.used, 2);
  assert.throws(() => parseGlm({ data: {} }), (e) => e instanceof MeterShapeError && /--manual/.test(e.message));
  assert.throws(() => parseGlm({ data: { limits: [{ type: "TIME_LIMIT", percentage: 1 }] } }), /no TOKENS_LIMIT/);
});

test("meter: MiniMax counts are remaining (used = total − remaining); percent variant; text model picked; bad key", () => {
  const r = parseMinimax(FX.minimax, { model: "MiniMax-M3" });
  assert.deepEqual(r.windows["5h"], { used: 363, capacity: 1500, unit: "count", resetsAt: 1764334800 });
  assert.deepEqual(r.windows.weekly, { used: 1350, capacity: 15000, unit: "count", resetsAt: 1764633600 });
  assert.equal(r.meterModel, "MiniMax-M*");
  const p = parseMinimax(FX.minimaxPercent);
  assert.equal(p.windows["5h"].used, 12);
  assert.equal(p.windows["5h"].unit, "%");
  assert.equal(p.windows.weekly.used, 7.5);
  assert.throws(() => parseMinimax(FX.minimaxBadKey), /status_code 1004 .*Token Plan key/);
  assert.throws(() => parseMinimax({ hello: 1 }), (e) => e instanceof MeterShapeError && /top-level keys: hello/.test(e.message));
});

test("meter: Bailian ratios inside an embedded JSON string; hasQuotaData false", () => {
  const r = parseBailian(FX.bailian);
  assert.ok(Math.abs(r.windows["5h"].used - 12.34) < 1e-9);
  assert.ok(Math.abs(r.windows.weekly.used - 5.67) < 1e-9);
  assert.ok(Math.abs(r.windows.monthly.used - 2.1) < 1e-9);
  assert.equal(r.windows.monthly.resetsAt, Date.parse("2026-12-01T00:00:00Z") / 1000);
  assert.throws(() => parseBailian(FX.bailianNoPlan), /hasQuotaData is false/);
  assert.throws(() => parseBailian({ requestId: "x", data: { other: 1 } }), (e) => e instanceof MeterShapeError && /--manual/.test(e.message));
});

test("meter: DeepRelay weighted tokens, monthly from usage and by_model, weekly from weekly_by_model", () => {
  const r = parseDeeprelay(FX.deeprelay);
  assert.deepEqual(r.windows["monthly-input"], { used: 41250000, capacity: 500000000, unit: "weighted tokens", resetsAt: null });
  assert.equal(r.windows["monthly-output"].used, 950000);
  assert.equal(r.windows["weekly-input"].used, 9000000);
  assert.equal(r.windows["weekly-input"].capacity, 125000000);
  assert.equal(r.windows["weekly-output"].used, 200000);
  assert.equal(r.windows["weekly-input"].resetsAt, Date.parse("2026-12-01T10:00:00Z") / 1000);
  assert.throws(() => parseDeeprelay(FX.deeprelayUnsubscribed), /usage is null/);
  assert.throws(() => parseDeeprelay({ quota: { foo: 1 }, usage: {} }), (e) => e instanceof MeterShapeError);
});

test("meter: Ollama current plan in USD credits, legacy plan in percent", () => {
  const r = parseOllama(FX.ollama);
  assert.deepEqual(r.windows.monthly, { used: 27.5, capacity: 100, unit: "USD credits", resetsAt: Date.parse("2026-10-15T09:30:00Z") / 1000 });
  const l = parseOllama(FX.ollamaLegacy);
  assert.equal(l.windows.session.used, 25);
  assert.equal(l.windows.weekly.used, 60);
  assert.equal(l.windows.monthly, undefined);
  assert.throws(() => parseOllama({ purchased: {} }), MeterShapeError);
});

test("meter: MiMo credits and UTC period end", () => {
  const r = parseMimo(FX.mimo);
  assert.deepEqual(r.windows.monthly, { used: 4500000, capacity: 60000000, unit: "credits", resetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000 });
  assert.throws(() => parseMimo({ object: "token_plan" }), MeterShapeError);
});

test("toEpochS reads ms, s, ISO and space-separated UTC", () => {
  assert.equal(toEpochS(1764334800000), 1764334800);
  assert.equal(toEpochS(1764334800), 1764334800);
  assert.equal(toEpochS("1764334800000"), 1764334800);
  assert.equal(toEpochS("2026-12-01 00:00:00"), Date.parse("2026-12-01T00:00:00Z") / 1000);
  assert.equal(toEpochS(0), null);
  assert.equal(toEpochS("soon"), null);
});

test("manual input: %, left, credits, commas, resolution; bad values rejected", () => {
  assert.deepEqual(parseManual("37.5%"), { used: 37.5, q: 0.1, left: false });
  assert.deepEqual(parseManual(" 1.92 "), { used: 1.92, q: 0.01, left: false });
  assert.deepEqual(parseManual("62.5% left"), { used: 37.5, q: 0.1, left: true });
  assert.deepEqual(parseManual("left 40%"), { used: 60, q: 1, left: true });
  assert.deepEqual(parseManual("1,234,567", { unit: "credits" }), { used: 1234567, q: 1, left: false });
  assert.deepEqual(parseManual("900 left", { unit: "credits", capacity: 1000 }), { used: 100, q: 1, left: true });
  assert.equal(parseManual("900 left", { unit: "credits" }).used, -900, "no capacity: left kept as a negative, the change is still right");
  assert.throws(() => parseManual("abc"), /type a number/);
  assert.throws(() => parseManual("120%"), /above 100/);
  assert.throws(() => parseManual("5%", { unit: "credits" }), /not %/);
  assert.throws(() => parseManual(""), /type a number/);
});

test("kits/NEEDED.md names this kit with each plan's meter mode", async () => {
  const MN = await import("../../../scripts/measurement-needs.mjs");
  const site = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "public", "data", "combined.json"), "utf8"));
  let n = 0;
  for (const plan of new Set(site.entries.map((e) => e.plan))) {
    const ad = adapterForPlan(plan);
    if (!ad) continue;
    n++;
    const mode = ad.meter.default === "auto" ? "automatic" : "manual";
    const KS = await import("../../../scripts/kit-status.mjs");
    const suffix = KS.isTested(KS.entryOf(KS.loadStatus(), "api-plan", ad.id)) ? "" : MN.UNTESTED_SUFFIX;
    assert.equal(MN.kitText(plan), `[Kit: API plans (${mode})](api-plan/README.md)${suffix}`, plan);
  }
  assert.ok(n > 30);
});

test("adapterFor is case-insensitive; unknown is null", () => {
  assert.equal(adapterFor("GLM").id, "glm");
  assert.equal(adapterFor("nope"), null);
});

test("workload is fixed: same tag, same prompts; unique prompts differ by tag; 2:1 shared:unique", () => {
  assert.deepEqual(CYCLE, ["shared", "shared", "unique"]);
  assert.deepEqual(promptAt(5, "a"), promptAt(5, "a"));
  assert.notEqual(promptAt(2, "a").user, promptAt(2, "b").user);
  assert.equal(promptAt(0, "a").system, promptAt(1, "b").system, "shared prefix identical across runs");
  assert.ok(promptAt(0).system.length > 20000);
  assert.match(workloadHash(), /^[0-9a-f]{16}$/);
});

test("redact replaces registered keys only", () => {
  assert.equal(redact("nothing here"), "nothing here");
});
