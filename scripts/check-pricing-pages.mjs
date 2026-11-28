#!/usr/bin/env node
/**
 * Pricing page watch: renders every official page cited in scripts/billing-periods.mjs and
 * scripts/included-credits.mjs with headless Chrome, hashes the price-relevant text, and diffs
 * it against data/pricing-pages/baseline.json.
 *
 *   node scripts/check-pricing-pages.mjs                     report to stdout (JSON)
 *   node scripts/check-pricing-pages.mjs --out FILE          also write the report to FILE
 *   node scripts/check-pricing-pages.mjs --update-baseline   rewrite the baseline from this run
 *   node scripts/check-pricing-pages.mjs --issue             open / comment on one "Pricing pages changed" issue
 *   node scripts/check-pricing-pages.mjs --only SUBSTRING    render only matching URLs (no baseline write)
 *   node scripts/check-pricing-pages.mjs --url URL --text    render any URL (repeatable) and keep its innerText
 *   node scripts/check-pricing-pages.mjs ... --click TEXT     click the element labelled TEXT (e.g. 年付, Yearly) before reading
 *
 * Chrome: $CHROME_BIN, else google-chrome, chromium-browser, chromium on PATH. Extra flags: $CHROME_ARGS.
 * Exit code is 0 unless Chrome cannot start; the workflow step also runs with continue-on-error.
 * Zero dependencies (Node >= 22 for the global WebSocket).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BILLING_PERIODS } from "./billing-periods.mjs";
import { INCLUDED_CREDITS } from "./included-credits.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const BASELINE_PATH = path.join(ROOT, "data", "pricing-pages", "baseline.json");
export const ISSUE_TITLE = "Pricing pages changed";
export const PAGE_STATES = ["ok", "blocked", "login", "dns", "error", "empty"];
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** Every URL cited by either table (record url + credit urls), deduplicated, sorted. */
export function watchUrls(billing = BILLING_PERIODS, credits = INCLUDED_CREDITS) {
  const urls = new Set();
  for (const r of billing) if (r.url) urls.add(r.url);
  for (const r of credits) {
    if (r.url) urls.add(r.url);
    for (const c of r.credits || []) if (c.url) urls.add(c.url);
  }
  return [...urls].sort();
}

/** url → plans whose record is "unknown" and cites that url. */
export function unknownPlansByUrl(billing = BILLING_PERIODS, credits = INCLUDED_CREDITS) {
  const map = {};
  const add = (url, label) => (map[url] ||= []).push(label);
  for (const r of billing) if (r.status === "unknown") add(r.url, `${r.plan} (annual)`);
  for (const r of credits) if (r.status === "unknown") add(r.url, `${r.plan} (credits)`);
  return map;
}

const PRICE_LINE = /[$€£¥￥]|\b(?:usd|cny|rmb|eur|gbp|cad)\b|元|\/\s*(?:mo|month|yr|year|seat)\b|per (?:month|year|seat)|[月年]付|包[月年]|annual|yearly|billed|credits?\b|额度|积分/i;
const BLOCK_PAGE = /attention required|just a moment\.\.\.|verify you are human|checking your browser|access denied|request blocked|captcha|\b403 forbidden\b|are you a robot|unusual traffic/i;
const LOGIN_PAGE = /^(?:log ?in|sign ?in|登录|登錄)(?![a-z])|请先登录|please (?:log|sign) in/im;

const normLines = (text) => String(text || "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
// Unique and sorted, so carousels, A/B card order and repeated mobile/desktop copies hash the same.
const uniqSorted = (lines) => [...new Set(lines)].sort();

/** Lines of the page that carry a price, currency, billing period or credit amount (unique, sorted). */
export function priceLines(text) {
  return uniqSorted(normLines(text).filter((l) => /\d/.test(l) && PRICE_LINE.test(l)));
}

/** sha256 (16 hex) of the price lines; when there are none, of the body lines that carry a digit (digits and currency kept). */
export function textHash(text) {
  const lines = priceLines(text);
  const basis = lines.length ? lines : uniqSorted(normLines(text).filter((l) => /\d/.test(l)));
  return {
    hash: crypto.createHash("sha256").update(basis.join("\n")).digest("hex").slice(0, 16),
    priceLines: lines.length,
    region: lines.length ? "price-lines" : "body",
    // Kept (each line ≤ 300 chars) so a change can be shown as lines added and removed
    lines: basis.map((l) => l.slice(0, 300)),
  };
}

/** Page state from a render result: ok | blocked | login | dns | error | empty. */
export function classify({ errorText = "", status = 0, title = "", text = "" }) {
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_ADDRESS_UNREACHABLE/.test(errorText)) return "dns";
  if (errorText) return "error";
  const body = String(text || "").trim();
  if (status === 401 || status === 403 || status === 429 || BLOCK_PAGE.test(`${title}\n${body.slice(0, 2000)}`)) return "blocked";
  if (status >= 400) return "error";
  if (body.length < 200) return LOGIN_PAGE.test(`${title}\n${body}`) ? "login" : "empty";
  return "ok";
}

/**
 * Diff a run against the baseline.
 *   readable: was not ok (or missing) and is ok now
 *   changed:  ok in both and the hash differs
 *   stopped:  was ok and is not ok now
 */
export function diffPages(baseline, report, unknownPlans = {}) {
  const prev = baseline?.pages || {};
  const out = { readable: [], changed: [], stopped: [] };
  for (const [url, now] of Object.entries(report?.pages || {})) {
    const was = prev[url];
    const wasOk = was?.state === "ok";
    const isOk = now.state === "ok";
    const extra = unknownPlans[url]?.length ? { unknownPlans: unknownPlans[url] } : {};
    if (isOk && !wasOk) out.readable.push({ url, was: was?.state ?? "missing", hash: now.hash, ...extra });
    else if (isOk && wasOk && was.hash !== now.hash) {
      const lineDiff = Array.isArray(was.lines) && Array.isArray(now.lines)
        ? { removed: was.lines.filter((l) => !now.lines.includes(l)), added: now.lines.filter((l) => !was.lines.includes(l)) }
        : {};
      out.changed.push({ url, was: was.hash, now: now.hash, ...lineDiff, ...extra });
    }
    else if (!isOk && wasOk) out.stopped.push({ url, now: now.state, ...extra });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.url.localeCompare(b.url));
  return out;
}

export const hasChanges = (d) => d.readable.length + d.changed.length + d.stopped.length > 0;

export function findChrome(env = process.env) {
  const candidates = [env.CHROME_BIN, "google-chrome", "google-chrome-stable", "chromium-browser", "chromium"].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 15000 });
    if (r.status === 0) return c;
  }
  return null;
}

/** Minimal CDP client over the browser websocket (flattened sessions). */
async function launch(chrome) {
  if (typeof WebSocket !== "function") throw new Error("Node >= 22 required (global WebSocket)");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-pages-"));
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--user-agent=${UA}`, "--lang=en-US", "--window-size=1366,900"];
  if (process.env.CI || process.getuid?.() === 0) args.push("--no-sandbox");
  // e.g. CHROME_ARGS='--host-resolver-rules=MAP platform.stepfun.com 14.103.2.83' when the local resolver fails a host
  if (process.env.CHROME_ARGS) args.push(...process.env.CHROME_ARGS.split(/\s+(?=--)/).filter(Boolean));
  const proc = spawn(chrome, [...args, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`Chrome did not start: ${buf.slice(-500)}`)), 30000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const close = async () => {
    try {
      await send("Browser.close");
    } catch {}
    ws.close();
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
    fs.rmSync(profile, { recursive: true, force: true });
  };
  return { send, listeners, close };
}

/** Render one URL: navigate, wait for load + network idle (≤ 2 requests in flight for idleMs), read innerText. */
async function render(cdp, url, { timeoutMs = 45000, idleMs = 1500, click = null } = {}) {
  // Fresh browser context per page: no cookies or bot-score carry over between sites.
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  const inflight = new Set();
  let lastActivity = Date.now();
  let loaded = false;
  let status = 0;
  let mainFrame = null;
  const onMsg = (msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    if (msg.method === "Network.requestWillBeSent") {
      inflight.add(p.requestId);
      lastActivity = Date.now();
    } else if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") {
      inflight.delete(p.requestId);
      lastActivity = Date.now();
    } else if (msg.method === "Network.responseReceived" && p.type === "Document" && (!mainFrame || p.frameId === mainFrame)) {
      status = p.response.status;
    } else if (msg.method === "Page.loadEventFired") loaded = true;
  };
  cdp.listeners.add(onMsg);
  const started = Date.now();
  try {
    await s("Page.enable");
    await s("Network.enable");
    await s("Network.setUserAgentOverride", { userAgent: UA, acceptLanguage: "en-US,en;q=0.9" });
    const nav = await Promise.race([s("Page.navigate", { url }), new Promise((r) => setTimeout(() => r({ errorText: "navigation timeout" }), timeoutMs))]);
    mainFrame = nav.frameId;
    if (nav.errorText) return { url, errorText: nav.errorText, status: 0, title: "", text: "", ms: Date.now() - started };
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
      if (loaded && inflight.size <= 2 && Date.now() - lastActivity >= idleMs) break;
    }
    if (click) {
      // Click the smallest element whose own text is exactly `click` (a billing-period toggle), then let the page settle.
      const expr = `(() => { const t = ${JSON.stringify(click)}; const el = [...document.querySelectorAll("button,label,[role=tab],[role=radio],span,div,li,a")].filter((e) => e.innerText && e.innerText.trim() === t).sort((a, b) => a.innerText.length - b.innerText.length || a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0]; if (!el) return false; el.click(); return true; })()`;
      await s("Runtime.evaluate", { expression: expr, returnByValue: true });
      await new Promise((r) => setTimeout(r, 2500));
    }
    const ev = await s("Runtime.evaluate", { expression: "JSON.stringify({ title: document.title, text: document.body ? document.body.innerText : '' })", returnByValue: true });
    const { title, text } = JSON.parse(ev.result.value || "{}");
    return { url, errorText: "", status, title: title || "", text: text || "", ms: Date.now() - started, idle: loaded && inflight.size <= 2 };
  } catch (e) {
    return { url, errorText: String(e.message || e), status, title: "", text: "", ms: Date.now() - started };
  } finally {
    cdp.listeners.delete(onMsg);
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  }
}

/** Render every URL (concurrency tabs at a time) and build the report pages map. */
export async function renderAll(urls, { chrome, concurrency = 4, log = () => {}, keepText = false, click = null } = {}) {
  const cdp = await launch(chrome);
  const pages = {};
  const queue = [...urls];
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) {
          const url = queue.shift();
          let r = await render(cdp, url, { click });
          let state = classify(r);
          // One retry after a pause: bot walls and 403s are often per-burst (x.ai/pricing).
          if (state !== "ok" && state !== "dns") {
            await new Promise((res) => setTimeout(res, 5000));
            r = await render(cdp, url, { click });
            state = classify(r);
          }
          const h = state === "ok" ? textHash(r.text) : { hash: null, priceLines: 0, region: null };
          pages[url] = { state, status: r.status, title: r.title.slice(0, 120), textLength: r.text.length, ...h, ...(r.errorText ? { error: r.errorText } : {}), ...(keepText ? { text: r.text } : {}) };
          log(`${state.padEnd(7)} ${String(r.status).padEnd(3)} ${String(r.text.length).padStart(6)}c ${h.priceLines ?? 0}p ${Math.round(r.ms / 1000)}s ${url}`);
        }
      })
    );
  } finally {
    await cdp.close();
  }
  return Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)));
}

export function readBaseline(file = BASELINE_PATH) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, generated: null, pages: {} };
}

export function baselineFrom(pages, generated = new Date().toISOString().slice(0, 10)) {
  const out = {};
  for (const [url, p] of Object.entries(pages)) out[url] = { state: p.state, hash: p.hash, priceLines: p.priceLines, ...(p.lines ? { lines: p.lines } : {}) };
  return { version: 1, generated, pages: out };
}

export function issueBody(diff, { runUrl = null, generated = null } = {}) {
  const lines = [];
  const sec = (title, rows, fmt) => {
    if (!rows.length) return;
    lines.push(`### ${title} (${rows.length})`, "");
    for (const r of rows) lines.push(`- ${fmt(r)}${r.unknownPlans ? ` — unknown: ${r.unknownPlans.join("; ")}` : ""}`);
    lines.push("");
  };
  sec("Readable now", diff.readable, (r) => `${r.url} (was ${r.was})`);
  sec("Prices changed", diff.changed, (r) => {
    if (!r.added && !r.removed) return `${r.url} (${r.was} → ${r.now}; no saved lines to compare)`;
    const show = (sign, ls) => ls.slice(0, 12).map((l) => `\n  ${sign} \`${l.replace(/`/g, "'").slice(0, 160)}\``).join("");
    return `${r.url}${show("−", r.removed)}${show("+", r.added)}`;
  });
  sec("Stopped loading", diff.stopped, (r) => `${r.url} (now ${r.now})`);
  lines.push(`Baseline: \`data/pricing-pages/baseline.json\` (${generated || "none"}).`);
  lines.push("Update the tables in `scripts/billing-periods.mjs` / `scripts/included-credits.mjs`, then run `node scripts/check-pricing-pages.mjs --update-baseline` and commit the baseline.");
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  return lines.join("\n");
}

async function ghApi(endpoint, { method = "GET", body = null } = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ai-plan-value-monitor",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${method} ${endpoint} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Comment on the open "Pricing pages changed" issue, or create it. Dry run without GITHUB_TOKEN / GITHUB_REPOSITORY. */
async function upsertIssue(body) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!process.env.GITHUB_TOKEN || !repo) {
    console.error(`[pricing-pages][dry-run] WOULD OPEN/UPDATE "${ISSUE_TITLE}":\n${body}`);
    return;
  }
  const issues = await ghApi(`/repos/${repo}/issues?state=open&per_page=100`);
  const open = issues.find((i) => !i.pull_request && i.title === ISSUE_TITLE);
  if (open) {
    await ghApi(`/repos/${repo}/issues/${open.number}/comments`, { method: "POST", body: { body } });
    console.error(`[pricing-pages] Commented on #${open.number}`);
  } else {
    const i = await ghApi(`/repos/${repo}/issues`, { method: "POST", body: { title: ISSUE_TITLE, body } });
    console.error(`[pricing-pages] Created #${i.number}: ${i.html_url}`);
  }
}

async function main(argv) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : null;
  };
  const chrome = findChrome();
  if (!chrome) {
    console.error("No Chrome found: set CHROME_BIN or install google-chrome / chromium-browser / chromium.");
    process.exit(2);
  }
  const extra = argv.flatMap((a, i) => (a === "--url" && argv[i + 1] ? [argv[i + 1]] : []));
  const only = arg("--only") || (extra.length ? "\0" : null);
  const urls = extra.length ? extra : watchUrls().filter((u) => !only || u.includes(only));
  console.error(`[pricing-pages] ${chrome}: rendering ${urls.length} pages`);
  const pages = await renderAll(urls, { chrome, log: (l) => console.error(`[pricing-pages] ${l}`), keepText: argv.includes("--text"), click: arg("--click") });
  const baseline = readBaseline();
  let diff = diffPages(baseline, { pages }, unknownPlansByUrl());
  // Confirm changed / stopped pages with a second render; a page counts only if both renders disagree with the baseline.
  const recheck = [...diff.changed, ...diff.stopped].map((r) => r.url);
  if (recheck.length && !argv.includes("--update-baseline")) {
    console.error(`[pricing-pages] confirming ${recheck.length} pages`);
    const again = await renderAll(recheck, { chrome, log: (l) => console.error(`[pricing-pages] ${l}`), click: arg("--click") });
    for (const url of recheck) {
      const prev = baseline.pages[url];
      if (again[url].state === prev?.state && again[url].hash === prev?.hash) pages[url] = { ...again[url], flaky: { state: pages[url].state, hash: pages[url].hash } };
    }
    diff = diffPages(baseline, { pages }, unknownPlansByUrl());
  }
  const report = { generated: new Date().toISOString(), baseline: baseline.generated, pages, ...diff };
  const json = JSON.stringify(report, null, 2);
  if (arg("--out")) fs.writeFileSync(arg("--out"), json + "\n");
  console.log(json);
  if (argv.includes("--update-baseline") && !only) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineFrom(pages), null, 2) + "\n");
    console.error(`[pricing-pages] Baseline written: ${Object.keys(pages).length} pages`);
  }
  if (argv.includes("--issue") && hasChanges(diff)) {
    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
    await upsertIssue(issueBody(diff, { runUrl, generated: baseline.generated }));
  }
  console.error(`[pricing-pages] readable ${diff.readable.length}, changed ${diff.changed.length}, stopped ${diff.stopped.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[pricing-pages] ${e.stack || e}`);
    process.exit(1);
  });
}
