#!/usr/bin/env node
/**
 * quota-probe: runs the quota-weight protocol arms (input, output, read, write1h, write5m) in
 * Claude Code on your own subscription and writes a quota-weights.session/1 (anchored meter) or
 * quota-weights.segments/1 (polled / typed meter) file into data/quota-weights/submissions/.
 *
 * Spec: docs/design/quota-weight-methodology.md §1.2–§1.5, §2. Usage: kits/claude-code/README.md.
 *
 *   node scripts/quota-probe.mjs probe [--ping]
 *   node scripts/quota-probe.mjs run --model claude-opus-5-5 --bar 7d --class interactive --plan max [options]
 *   node scripts/quota-probe.mjs run ... --dry-run          simulated meter and usage, no API calls, no credentials
 *   node scripts/quota-probe.mjs record-holdout --dir <project> ...  log ordinary work as a G4 holdout session
 *   node scripts/quota-probe.mjs set-raw <file> <url>       record where the raw log bundle was uploaded
 *   node scripts/quota-probe.mjs statusline-log <file>      status line command used by the interactive class
 *
 * Client classes:
 *   sdk          headless `claude -p --input-format stream-json --output-format stream-json --verbose`,
 *                meter from rate_limit_event (anchored).
 *   interactive  the Claude Code TUI, meter from a status line script (anchored), tokens from the
 *                session transcripts. --drive tmux sends the prompts; --drive guided prints each line
 *                to paste and waits for Enter. --meter manual|oauth: start/end readings only (unanchored).
 *
 * Privacy: credentials are read in memory only (OAuth usage endpoint, opt-in) and never written.
 * The account is stored as account_hash = first 8 hex of SHA-256(account UUID + a local random salt).
 * No email address is read or written. Submitter defaults to the placeholder "anonymous".
 * Zero dependencies (Node ≥ 20).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as QW from "../../../scripts/fit-quota-weights.mjs";

const __filename = fileURLToPath(import.meta.url);
const PROBE_VERSION = "1.0.0";
const OUT_DIR = path.join(QW.SUBMISSIONS_DIR, "anthropic");
const STOP_PCT = { "5h": 85, "7d": 95 };
const START_MAX_PCT = 60;
const MAX_REQUEST_POINTS = 0.1; // §1.2.9
const TARGET_REQUEST_POINTS = 0.06;
const MAX_REQUESTS_PER_ARM = 4000;
const READ_TURNS_PER_SESSION = 400;
const CAP_TOKENS = { input: 60000, output: 8000, read: 150000, write1h: 60000, write5m: 60000 };
const MIN_TOKENS = { input: 2000, output: 300, read: 25000, write1h: 2000, write5m: 2000 };
const ARM_ENV = {
  input: { DISABLE_PROMPT_CACHING: "1" },
  output: { DISABLE_PROMPT_CACHING: "1" },
  read: {},
  write1h: { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" },
  write5m: { FORCE_PROMPT_CACHING_5M: "1" },
};
const CLEAR_ENV = ["CLAUDE_CODE_ENTRYPOINT", "DISABLE_PROMPT_CACHING", "CLAUDE_CODE_PROMPT_CACHE_TTL", "FORCE_PROMPT_CACHING_5M"];

// Starting list-$ per meter point, used only to size the first requests; the run re-estimates it
// from its own ticks. Sources: methodology §1.6 and §1.5 (Pro 5h ≈ $0.27, Max ≈ $1.4 interactive /
// $0.68 headless, weekly ≈ 7.7 (interactive) / 12.2 (headless) windows), kler run (Team).
const PARITY_GUESS = {
  pro: { interactive: { "5h": 0.27, "7d": 2.1 }, sdk: { "5h": 0.13, "7d": 1.6 } },
  max: { interactive: { "5h": 1.4, "7d": 10.7 }, sdk: { "5h": 0.68, "7d": 8.3 } },
  ultra: { interactive: { "5h": 5.6, "7d": 21.4 }, sdk: { "5h": 2.7, "7d": 16.6 } },
  team: { interactive: { "5h": 0.62, "7d": 4.8 }, sdk: { "5h": 0.28, "7d": 3.4 } },
};
const PLAN_PRICE = { pro: 20, max: 100, ultra: 200, team: null };
// Current Claude plans are Pro, Max ($100) and Ultra ($200). Older names map onto them.
const PLAN_ALIASES = { max_5x: "max", max_20x: "ultra" };
const normPlan = (p) => PLAN_ALIASES[p] || p;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`quota-probe: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

/** Deterministic filler text: random lowercase syllable words (no real content). ≈ 3.6 chars per token. */
function fillerText(tokens, rand) {
  const syl = ["ka", "lo", "mi", "ren", "sa", "tu", "vex", "no", "pal", "qui", "dor", "fe", "zan", "ru", "bo", "lis", "ten", "ga", "wim", "ox"];
  const words = [];
  let chars = 0;
  const target = tokens * 3.6;
  while (chars < target) {
    const n = 1 + Math.floor(rand() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += syl[Math.floor(rand() * syl.length)];
    words.push(w);
    chars += w.length + 1;
  }
  const lines = [];
  for (let i = 0; i < words.length; i += 14) lines.push(words.slice(i, i + 14).join(" "));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Account hash (provenance only)
// ---------------------------------------------------------------------------------------------

function saltPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ai-plan-value", "quota-probe-salt");
}
function localSalt() {
  const p = saltPath();
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const s = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, s + "\n", { mode: 0o600 });
  return s;
}
/** First 8 hex of SHA-256(account UUID + salt). Reads only oauthAccount.accountUuid from ~/.claude.json. */
function accountHash(label) {
  let id = label || null;
  if (!id) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
      id = j?.oauthAccount?.accountUuid || null;
    } catch {
      id = null;
    }
  }
  if (!id) return null;
  return crypto.createHash("sha256").update(`${id}${localSalt()}`).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------------------------

/** Undocumented GET api.anthropic.com/api/oauth/usage (fields per methodology §1.1). Token read in memory only. */
async function readOauthUsage() {
  let token = process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
  if (!token) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8"));
      token = j?.claudeAiOauth?.accessToken || null;
    } catch {
      token = null;
    }
  }
  if (!token) return { ok: false, error: "no OAuth token in ~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN" };
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": `quota-probe/${PROBE_VERSION}` },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    const bar = (b) => (b && b.utilization != null ? { used_pct: Number(b.utilization), resets_at: b.resets_at || null } : null);
    return { ok: true, at: nowIso(), "5h": bar(j.five_hour), "7d": bar(j.seven_day), extraUsage: j.extra_usage ?? null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** Status line command: append the meter fields of stdin's JSON to <file>; print a short status. */
async function statuslineLog(file) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let j = {};
  try {
    j = JSON.parse(input);
  } catch {
    process.stdout.write("quota-probe: no status input");
    return;
  }
  const rl = j.rate_limits || {};
  const rec = {
    ts: nowIso(),
    session_id: j.session_id || null,
    five_hour: rl.five_hour ? { used_pct: rl.five_hour.used_percentage ?? null, resets_at: rl.five_hour.resets_at ?? null } : null,
    seven_day: rl.seven_day ? { used_pct: rl.seven_day.used_percentage ?? null, resets_at: rl.seven_day.resets_at ?? null } : null,
    version: j.version || null,
  };
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  const f = (b) => (b?.used_pct == null ? "—" : `${b.used_pct}%`);
  process.stdout.write(`quota-probe · 5h ${f(rec.five_hour)} · 7d ${f(rec.seven_day)}`);
}
function readStatusLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
const epochIso = (v) => (v == null ? null : typeof v === "number" ? new Date(v * (v < 1e12 ? 1000 : 1)).toISOString() : String(v));

/** rate_limit_event → { "5h": {used_pct, resets_at}, "7d": ..., overage } */
function parseRateLimitEvent(ev) {
  const info = ev.rate_limit_info || ev.rateLimitInfo || ev;
  const uw = info.unifiedWindows || info.unified_windows || {};
  const bar = (b) => (b && b.utilization != null ? { used_pct: Math.round(Number(b.utilization) * 10000) / 100, resets_at: epochIso(b.resetsAt ?? b.resets_at) } : null);
  return {
    "5h": bar(uw.five_hour),
    "7d": bar(uw.seven_day),
    overage: info.isUsingOverage === true || /rejected/.test(String(info.status || "")),
    raw: { status: info.status ?? null, rateLimitType: info.rateLimitType ?? null, utilization: info.utilization ?? null, unifiedWindows: uw, isUsingOverage: info.isUsingOverage ?? null },
  };
}

// ---------------------------------------------------------------------------------------------
// Transcripts (interactive class tokens, entrypoint check)
// ---------------------------------------------------------------------------------------------

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
/** Transcript files whose entries ran in `cwd` (one arm directory per arm). */
function transcriptsFor(cwd) {
  const dir = projectsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const p of fs.readdirSync(dir)) {
    const pd = path.join(dir, p);
    let files;
    try {
      files = fs.readdirSync(pd).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(pd, f);
      const head = fs.readFileSync(fp, "utf8").slice(0, 20000);
      if (head.includes(JSON.stringify(cwd).slice(1, -1))) out.push(fp);
    }
  }
  return out;
}
/** API calls in transcripts: one per message.id + requestId, with usage by kind. */
function transcriptCalls(files) {
  const seen = new Map();
  for (const fp of files) {
    for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const u = e?.message?.usage;
      if (e.type !== "assistant" || !u) continue;
      const key = `${e.message.id || ""}|${e.requestId || ""}`;
      const cc = u.cache_creation || {};
      const w1h = cc.ephemeral_1h_input_tokens;
      const w5m = cc.ephemeral_5m_input_tokens;
      const total = u.cache_creation_input_tokens || 0;
      seen.set(key, {
        ts: e.timestamp || nowIso(),
        id: e.message.id || key,
        model: e.message.model || null,
        entrypoint: e.entrypoint || null,
        stop: e.message.stop_reason || null,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0,
        cache_write_5m: w5m ?? (w1h == null ? total : Math.max(0, total - w1h)),
        cache_write_1h: w1h ?? 0,
        usageRaw: u,
      });
    }
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

// ---------------------------------------------------------------------------------------------
// Prompts per arm
// ---------------------------------------------------------------------------------------------

class PromptMaker {
  constructor(seed) {
    this.rand = QW.rng(seed);
    this.n = 0;
  }
  nonce() {
    return `nonce-${crypto.randomBytes(8).toString("hex")}-${++this.n}`;
  }
  /** { text, newSession } for one request of `arm` at `size` tokens. */
  make(arm, size, state) {
    switch (arm) {
      case "input":
        return { text: `${this.nonce()}\n${fillerText(size, this.rand)}\n\nReply with the single word: ok`, newSession: true };
      case "output":
        return { text: `Count from 1 to ${Math.max(50, Math.round(size / 1.9))}, separated by single spaces. Output only the numbers.`, newSession: true };
      case "read":
        // A fresh session every READ_TURNS_PER_SESSION turns keeps the context below auto-compaction.
        state.turns = (state.turns || 0) + 1;
        if (state.turns > READ_TURNS_PER_SESSION) {
          state.turns = 1;
          state.corpus = null;
        }
        if (!state.corpus) {
          state.corpus = fillerText(size, this.rand);
          return { text: `${this.nonce()}\n${state.corpus}\n\nReply with the single word: ok`, newSession: true, first: true };
        }
        return { text: `Reply with one word: word number ${1 + Math.floor(this.rand() * 200)} of the text above.`, newSession: false };
      case "write1h":
      case "write5m":
        return { text: `${this.nonce()}\n${fillerText(size, this.rand)}\n\nReply with the single word: ok`, newSession: true };
      default:
        throw new Error(arm);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Backends: each send() returns { request, meters, overage, entrypoint } for one API request
// ---------------------------------------------------------------------------------------------

/** Simulated backend for --dry-run: no processes, no network. */
class DryRunBackend {
  constructor(opts) {
    this.opts = opts;
    this.rand = QW.rng(Number(opts.seed || 1));
    const price = QW.priceFor(QW.loadPrices(), opts.model) || Object.fromEntries(QW.KINDS.map((k) => [k, QW.SIM_PRICE[k]]));
    this.price = price;
    const g = PARITY_GUESS[opts.plan]?.[opts.class] || PARITY_GUESS.max.sdk;
    this.m5 = QW.simMeter({ rand: this.rand, parity: g["5h"], price, start: 20 + this.rand() });
    this.m7 = QW.simMeter({ rand: this.rand, parity: g["7d"], price, start: 30 + this.rand() });
    this.t = Date.parse("2026-11-02T00:00:00Z");
    this.mult = 1;
    this.kind = "simulated";
  }
  async start() {}
  async beginArm(arm) {
    this.arm = arm;
    this.mult = 1 + 0.02 * (this.rand() + this.rand() - 1);
    this.firstRead = true;
  }
  async endArm() {}
  async idle() {
    return { ticks: 0, method: "simulated" };
  }
  readings() {
    return { "5h": { used_pct: this.m5.read(), resets_at: "2026-11-02T05:00:00.000Z" }, "7d": { used_pct: this.m7.read(), resets_at: "2026-11-08T00:00:00.000Z" } };
  }
  async send(arm, prompt) {
    const tok = Math.round(prompt.text.length / 3.6);
    const sys = 3000; // system prompt of an empty-directory session
    const u = { input: 0, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    if (arm === "input") u.input = sys + tok;
    else if (arm === "output") {
      u.input = sys + tok;
      u.output = Math.round(prompt.text.match(/to (\d+)/)?.[1] * 1.9 || 500);
    } else if (arm === "read") {
      if (prompt.first) {
        u.cacheRead = sys;
        u.cacheWrite1h = tok;
      } else {
        u.cacheRead = sys + this.corpusTok;
        u.cacheWrite1h = 40;
      }
      if (prompt.first) this.corpusTok = tok;
    } else {
      u.cacheRead = sys;
      u[arm === "write1h" ? "cacheWrite1h" : "cacheWrite5m"] = tok;
    }
    this.m5.push(u, this.mult);
    this.m7.push(u, this.mult);
    this.t += 4000;
    const ts = new Date(this.t).toISOString();
    return {
      request: { ts, request_id: `sim-${uuid().slice(0, 8)}`, input: u.input, output: u.output, cache_read: u.cacheRead, cache_write_5m: u.cacheWrite5m, cache_write_1h: u.cacheWrite1h },
      meters: this.readings(),
      overage: false,
      entrypoint: this.opts.class === "sdk" ? "sdk-cli" : "cli",
      raw: null,
    };
  }
  async stop() {}
}

/** Headless `claude -p` with stream-json in and out. One process per request, or one per arm for `read`. */
class SdkBackend {
  constructor(opts, workDir) {
    this.opts = opts;
    this.workDir = workDir;
    this.kind = "sdk";
    this.proc = null;
    this.last = { "5h": null, "7d": null };
    this.raw = [];
  }
  args() {
    const a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", this.opts.model, "--effort", this.opts.effort, "--tools", "", "--strict-mcp-config"];
    if (!this.opts["no-safe-mode"]) a.push("--safe-mode");
    return a;
  }
  env(arm) {
    const env = { ...process.env, ...ARM_ENV[arm] };
    for (const k of CLEAR_ENV) if (!(k in ARM_ENV[arm])) delete env[k];
    return env;
  }
  async start() {}
  spawnProc(arm) {
    const cwd = path.join(this.workDir, arm);
    fs.mkdirSync(cwd, { recursive: true });
    const p = spawn(this.opts.claude, this.args(), { cwd, env: this.env(arm), stdio: ["pipe", "pipe", "pipe"] });
    const st = { proc: p, buf: "", waiters: [], events: [], err: "" };
    p.stdout.on("data", (d) => {
      st.buf += d.toString();
      let i;
      while ((i = st.buf.indexOf("\n")) >= 0) {
        const line = st.buf.slice(0, i);
        st.buf = st.buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        st.events.push(ev);
        for (const w of st.waiters.splice(0)) w();
      }
    });
    p.stderr.on("data", (d) => (st.err += d.toString()));
    p.on("exit", (code) => {
      st.exited = code ?? 0;
      for (const w of st.waiters.splice(0)) w();
    });
    return st;
  }
  async turn(st, text) {
    const from = st.events.length;
    st.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      const evs = st.events.slice(from);
      const res = evs.find((e) => e.type === "result");
      if (res) return { evs, res };
      if (st.exited != null) throw new Error(`claude exited (${st.exited}): ${st.err.slice(-400)}`);
      if (Date.now() > deadline) throw new Error("no result within 10 minutes");
      await new Promise((r) => {
        st.waiters.push(r);
        setTimeout(r, 1000);
      });
    }
  }
  async beginArm(arm) {
    this.arm = arm;
    if (arm === "read") this.proc = this.spawnProc(arm);
  }
  async endArm() {
    if (this.proc) {
      this.proc.proc.stdin.end();
      this.proc = null;
    }
  }
  async idle(minutes) {
    // Two tiny requests `minutes` apart: any meter movement between them fails the session.
    const ping = async () => (await this.send("read", { text: "Reply with the single word: ok", newSession: true, ping: true })).meters;
    const a = await ping();
    log(`  idle baseline: ${minutes} min without requests…`);
    await sleep(minutes * 60 * 1000);
    const b = await ping();
    let ticks = 0;
    for (const bar of ["5h", "7d"]) if (a[bar] && b[bar] && a[bar].resets_at === b[bar].resets_at) ticks += Math.max(0, Math.floor(b[bar].used_pct) - Math.floor(a[bar].used_pct));
    return { ticks, method: "ping" };
  }
  async send(arm, prompt) {
    // read arm: one session for the whole arm; every other request (and pings): a fresh session
    const persistent = arm === "read" && !prompt.ping;
    let st;
    if (persistent) {
      if (!this.proc || prompt.newSession) {
        await this.endArm();
        this.proc = this.spawnProc(arm);
      }
      st = this.proc;
    } else st = this.spawnProc(arm);
    const { evs, res } = await this.turn(st, prompt.text);
    if (!persistent) st.proc.stdin.end();
    let overage = false;
    for (const ev of evs.filter((e) => e.type === "rate_limit_event")) {
      const r = parseRateLimitEvent(ev);
      for (const bar of ["5h", "7d"]) if (r[bar]) this.last[bar] = r[bar];
      overage ||= r.overage;
      this.raw.push({ t: "rate_limit_event", ts: nowIso(), ...r.raw });
    }
    const u = res.usage || {};
    const cc = u.cache_creation || {};
    const total = u.cache_creation_input_tokens || 0;
    const w1h = cc.ephemeral_1h_input_tokens ?? (arm === "write5m" ? 0 : total);
    const w5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, total - w1h);
    const request = {
      ts: nowIso(),
      request_id: `req-${uuid().slice(0, 12)}`,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_write_5m: w5m,
      cache_write_1h: w1h,
      ...(res.num_turns > 1 ? { api_calls: res.num_turns } : {}),
    };
    this.raw.push({ t: "usage", ts: request.ts, request_id: request.request_id, usage: u, total_cost_usd: res.total_cost_usd ?? null, ttl_split: cc.ephemeral_1h_input_tokens != null ? "reported" : "inferred" });
    const sid = res.session_id || evs.find((e) => e.session_id)?.session_id;
    const entrypoint = sid ? transcriptEntrypoint(sid) : null;
    return { request, meters: { ...this.last }, overage, entrypoint };
  }
  async stop() {
    await this.endArm();
  }
}
function transcriptEntrypoint(sessionId) {
  const dir = projectsDir();
  if (!fs.existsSync(dir)) return null;
  for (const p of fs.readdirSync(dir)) {
    const fp = path.join(dir, p, `${sessionId}.jsonl`);
    if (!fs.existsSync(fp)) continue;
    for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.entrypoint) return e.entrypoint;
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

/** The Claude Code TUI, driven through tmux or by you (guided). Meter from the status line log. */
class InteractiveBackend {
  constructor(opts, workDir) {
    this.opts = opts;
    this.workDir = workDir;
    this.drive = opts.drive === "tmux" ? "tmux" : "guided";
    this.kind = `interactive-${this.drive}`;
    this.statusFile = path.join(workDir, "statusline.jsonl");
    this.tmux = `qp-${crypto.randomBytes(3).toString("hex")}`;
    this.usedCalls = new Set();
    this.raw = [];
    this.seq = 0;
  }
  settingsJson() {
    const cmd = `node "${__filename}" statusline-log "${this.statusFile}"`;
    return JSON.stringify({ statusLine: { type: "command", command: cmd, padding: 0 } });
  }
  command(arm) {
    const env = Object.entries(ARM_ENV[arm]).map(([k, v]) => `${k}=${v}`);
    const unset = CLEAR_ENV.filter((k) => !(k in ARM_ENV[arm])).flatMap((k) => ["-u", k]);
    const flags = ["--model", this.opts.model, "--effort", this.opts.effort, "--strict-mcp-config", ...(this.opts["no-safe-mode"] ? [] : ["--safe-mode"]), "--settings", this.settingsJson()];
    return `cd ${sq(path.join(this.workDir, arm))} && env ${unset.join(" ")} ${env.join(" ")} ${sq(this.opts.claude)} ${flags.map(sq).join(" ")}`;
  }
  async start() {
    fs.writeFileSync(this.statusFile, "");
  }
  latestReading(afterTs = 0) {
    const recs = readStatusLog(this.statusFile).filter((r) => Date.parse(r.ts) >= afterTs);
    const r = recs[recs.length - 1];
    if (!r) return null;
    return {
      "5h": r.five_hour?.used_pct != null ? { used_pct: Number(r.five_hour.used_pct), resets_at: epochIso(r.five_hour.resets_at) } : null,
      "7d": r.seven_day?.used_pct != null ? { used_pct: Number(r.seven_day.used_pct), resets_at: epochIso(r.seven_day.resets_at) } : null,
      ts: r.ts,
    };
  }
  async beginArm(arm) {
    this.arm = arm;
    const dir = path.join(this.workDir, arm);
    fs.mkdirSync(dir, { recursive: true });
    const cmd = this.command(arm);
    if (this.drive === "tmux") {
      spawnSync("tmux", ["kill-session", "-t", this.tmux], { stdio: "ignore" });
      const r = spawnSync("tmux", ["new-session", "-d", "-s", this.tmux, "-x", "220", "-y", "50", cmd], { stdio: "inherit" });
      if (r.status !== 0) fail("tmux new-session failed");
      log(`  arm ${arm}: Claude Code running in tmux session ${this.tmux} (watch: tmux attach -t ${this.tmux})`);
      const t0 = Date.now();
      for (;;) {
        await sleep(1500);
        const pane = spawnSync("tmux", ["capture-pane", "-p", "-t", this.tmux], { encoding: "utf8" }).stdout || "";
        if (/trust the files|Do you trust/i.test(pane)) spawnSync("tmux", ["send-keys", "-t", this.tmux, "Enter"]);
        if (readStatusLog(this.statusFile).length && Date.parse(readStatusLog(this.statusFile).slice(-1)[0].ts) > t0) break;
        if (Date.now() - t0 > 60000) fail("status line not running after 60 s: rerun with --no-safe-mode, or check `tmux attach -t " + this.tmux + "`");
      }
    } else {
      log(`\n=== Arm ${arm} ===`);
      log("1. In a second terminal, start Claude Code with exactly this command:\n");
      log(`   ${cmd}\n`);
      log("2. Accept the folder trust prompt if shown. Do not type anything else into Claude.");
      await ask("3. Press Enter here when the Claude prompt is showing… ");
    }
  }
  async endArm() {
    if (this.drive === "tmux") {
      spawnSync("tmux", ["send-keys", "-t", this.tmux, "/exit", "Enter"]);
      await sleep(2000);
      spawnSync("tmux", ["kill-session", "-t", this.tmux], { stdio: "ignore" });
    } else {
      log("   Arm done: type /exit in Claude.");
    }
  }
  async sendText(text, file) {
    if (this.drive === "tmux") {
      const buf = `qp${this.seq}`;
      spawnSync("tmux", ["load-buffer", "-b", buf, file]);
      spawnSync("tmux", ["paste-buffer", "-p", "-d", "-b", buf, "-t", this.tmux]);
      await sleep(400);
      spawnSync("tmux", ["send-keys", "-t", this.tmux, "Enter"]);
    } else {
      const rel = path.basename(file);
      log(`   [${this.seq}] paste:  @${rel} Reply with the single word: ok`);
      await ask("        press Enter here after Claude answers… ");
    }
  }
  async clear() {
    if (this.drive === "tmux") {
      spawnSync("tmux", ["send-keys", "-t", this.tmux, "/clear", "Enter"]);
      await sleep(1500);
    } else {
      log("   paste:  /clear");
    }
  }
  async idle(minutes) {
    const o = this.opts.oauth ? await readOauthUsage() : { ok: false, error: "--oauth not given" };
    if (!o.ok) {
      log(`  idle baseline: type the bars from /usage (${o.error}).`);
      const a = await askReadings("now");
      log(`  wait ${minutes} min without using the account anywhere…`);
      await sleep(minutes * 60 * 1000);
      const b = await askReadings("now (after the wait)");
      return { ticks: Math.max(0, b["5h"] - a["5h"]) + Math.max(0, b["7d"] - a["7d"]), method: "manual" };
    }
    log(`  idle baseline: ${minutes} min, meter from /api/oauth/usage…`);
    await sleep(minutes * 60 * 1000);
    const b = await readOauthUsage();
    if (!b.ok) return { ticks: null, method: "oauth_usage" };
    const d = (bar) => (o[bar] && b[bar] && o[bar].resets_at === b[bar].resets_at ? Math.max(0, Math.floor(b[bar].used_pct) - Math.floor(o[bar].used_pct)) : 0);
    return { ticks: d("5h") + d("7d"), method: "oauth_usage" };
  }
  async send(arm, prompt) {
    const dir = path.join(this.workDir, arm);
    this.seq++;
    const file = path.join(dir, `prompt-${String(this.seq).padStart(4, "0")}.txt`);
    // Guided: the prompt file holds the text that @-mentions attach; the pasted line asks for one word.
    fs.writeFileSync(file, prompt.text);
    if (prompt.newSession && this.seq > 1) await this.clear();
    const t0 = Date.now();
    if (this.drive === "guided" && arm === "read" && !prompt.first) {
      log(`   [${this.seq}] paste:  ${prompt.text}`);
      await ask("        press Enter here after Claude answers… ");
    } else if (this.drive === "guided" && arm === "output") {
      log(`   [${this.seq}] paste:  ${prompt.text}`);
      await ask("        press Enter here after Claude answers… ");
    } else await this.sendText(prompt.text, file);
    // wait for the new API call(s) in the transcripts and a status line refresh after them
    let calls = [];
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      calls = transcriptCalls(transcriptsFor(dir)).filter((c) => !this.usedCalls.has(c.id) && Date.parse(c.ts) >= t0 - 5000);
      if (calls.some((c) => c.stop === "end_turn")) break;
      await sleep(1000);
    }
    if (!calls.length) throw new Error(`no API call found in transcripts under ${dir}`);
    const lastTs = Math.max(...calls.map((c) => Date.parse(c.ts)));
    let reading = null;
    for (let i = 0; i < 10 && !reading; i++) {
      reading = this.latestReading(lastTs);
      if (!reading) await sleep(500);
    }
    reading ||= this.latestReading(0);
    for (const c of calls) this.usedCalls.add(c.id);
    const sum = (k) => calls.reduce((a, c) => a + (c[k] || 0), 0);
    const request = {
      ts: new Date(lastTs).toISOString(),
      request_id: `req-${uuid().slice(0, 12)}`,
      input: sum("input"),
      output: sum("output"),
      cache_read: sum("cache_read"),
      cache_write_5m: sum("cache_write_5m"),
      cache_write_1h: sum("cache_write_1h"),
      ...(calls.length > 1 ? { api_calls: calls.length } : {}),
    };
    for (const c of calls) this.raw.push({ t: "usage", ts: c.ts, request_id: request.request_id, model: c.model, usage: c.usageRaw });
    if (reading) this.raw.push({ t: "statusline", ts: reading.ts, "5h": reading["5h"], "7d": reading["7d"] });
    return { request, meters: reading ? { "5h": reading["5h"], "7d": reading["7d"] } : {}, overage: false, entrypoint: calls.find((c) => c.entrypoint)?.entrypoint || null };
  }
  async stop() {
    if (this.drive === "tmux") spawnSync("tmux", ["kill-session", "-t", this.tmux], { stdio: "ignore" });
  }
}

async function askReadings(when) {
  for (;;) {
    const a = await ask(`  Run /usage in Claude Code and type the two bars ${when} as "<5h%> <weekly%>" (e.g. 37 12): `);
    const m = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(a);
    if (m) return { "5h": Number(m[1]), "7d": Number(m[2]) };
    log("  format: two numbers separated by a space");
  }
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

function nextFile(submitter, date) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (let n = 1; ; n++) {
    const f = path.join(OUT_DIR, `${date}-${submitter}-${n}.jsonl`);
    if (!fs.existsSync(f)) return { file: f, n };
  }
}

function plannedBudget(opts) {
  const arms = opts.arms.length;
  const pts = arms * (opts.points + 2);
  return `${arms} arms × ${opts.points} anchored points + about 2 warm-up points each ≈ ${pts} points of the ${opts.bar} bar`;
}

export async function runProbe(opts) {
  const dry = Boolean(opts["dry-run"]);
  const bar = opts.bar;
  const otherBar = bar === "5h" ? "7d" : "5h";
  const date = (dry ? "2026-11-02" : nowIso()).slice(0, 10);
  const submitter = String(opts.submitter || "anonymous").replace(/[^A-Za-z0-9_.-]/g, "-");
  const sessionN = opts["session-n"] != null ? Number(opts["session-n"]) : null;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-probe-"));
  const backend = dry ? new DryRunBackend(opts) : opts.class === "sdk" ? new SdkBackend(opts, workDir) : new InteractiveBackend(opts, workDir);
  const unanchored = opts.class === "interactive" && (opts.meter === "manual" || opts.meter === "oauth");
  const prices = QW.loadPrices();
  const price = QW.priceFor(prices, opts.model);
  if (!price) fail(`no list price for ${opts.model} in data/quota-weights/prices.json`);
  const usdOf = (r) => QW.KINDS.reduce((a, k) => a + (r[QW.TOKEN_FIELD[k]] || 0) * price[k], 0);
  let P = (PARITY_GUESS[opts.plan] || PARITY_GUESS.max)[opts.class][bar];

  let out;
  if (dry) {
    const dir = opts.out ? path.resolve(opts.out) : path.join(os.tmpdir(), "quota-probe-dry-run");
    fs.mkdirSync(dir, { recursive: true });
    out = { file: path.join(dir, `${date}-${submitter}-dry-run-${Date.now()}.jsonl`), n: 0 };
  } else out = nextFile(submitter, date);
  const n = sessionN ?? out.n - 1;
  const k = opts.arms.length;
  const arms = opts.arms.map((_, i) => opts.arms[(i + (n % k) + k) % k]); // §1.2.8 rotation

  log(`quota-probe ${PROBE_VERSION}${dry ? " (dry run: simulated meter, no API calls)" : ""}`);
  log(`  model ${opts.model} · effort ${opts.effort} · class ${opts.class}${opts.class === "interactive" ? ` (${dry ? "simulated" : backend.drive})` : ""} · bar ${bar} · plan ${opts.plan}`);
  log(`  arms ${arms.join(" → ")} · budget: ${plannedBudget(opts)}`);
  log(`  work dir ${workDir}`);

  const acct = dry ? "dryrun00" : accountHash(opts["account-label"]);
  if (!acct) fail("no account id found in ~/.claude.json (oauthAccount.accountUuid): pass --account-label <any stable private string>");

  await backend.start();
  const rows = [];
  const raw = [];
  const header = {
    schema: unanchored ? QW.SCHEMA.segments : QW.SCHEMA.session,
    session_id: `${date}-${submitter}-${out.n || "dry"}-${crypto.randomBytes(3).toString("hex")}`,
    submitter,
    account_hash: acct,
    vendor: "anthropic",
    plan: opts.plan,
    plan_price_usd: PLAN_PRICE[opts.plan] ?? null,
    model: opts.model,
    effort: opts.effort,
    client: "claude-code",
    client_version: dry ? "dry-run" : claudeVersion(opts.claude),
    entrypoint: opts.class === "sdk" ? "sdk-cli" : "cli",
    client_class: opts.class,
    label_emulated: false,
    meter_source: dry ? "rate_limit_event" : opts.class === "sdk" ? "rate_limit_event" : unanchored ? (opts.meter === "oauth" ? "oauth_usage" : "manual") : "statusline",
    meter_resolution: 1,
    bar_under_test: bar,
    bars: [
      { id: "5h", resets_at: null },
      { id: "7d", resets_at: null },
    ],
    cache_ttl: "mixed",
    shared_account: false,
    idle_before_min: Number(opts["idle-min"]),
    idle_after_min: Number(opts["idle-min"]),
    idle_ticks: null,
    arms,
    points_per_arm: opts.points,
    prices_usd_per_mtok: Object.fromEntries(QW.KINDS.map((kk) => [kk, Number((price[kk] * 1e6).toFixed(6))])),
    raw: { url: null, sha256: null },
    probe_version: PROBE_VERSION,
    client_flags: opts.class === "sdk" ? "-p --input-format stream-json --output-format stream-json --verbose --tools '' --strict-mcp-config" + (opts["no-safe-mode"] ? "" : " --safe-mode") : `TUI --strict-mcp-config${opts["no-safe-mode"] ? "" : " --safe-mode"} --settings statusLine`,
    started_at: nowIso(),
    ...(dry ? { simulated: true } : {}),
    notes: "",
  };

  // Idle baseline before
  const idleMin = Number(opts["idle-min"]);
  const idleBefore = dry || idleMin === 0 ? { ticks: 0, method: dry ? "simulated" : "skipped" } : await backend.idle(idleMin);
  log(`  idle before: ${idleBefore.ticks} ticks (${idleBefore.method})`);
  if (idleBefore.ticks > 0) fail("meter moved while idle: something else is using the account. Stop it and rerun.");

  const prompts = new PromptMaker(Number(opts.seed || Date.now() % 1e9));
  const scale = Number(opts.scale || 1);
  const size = {};
  for (const a of QW.ARMS) {
    // tokens per request so one request ≈ TARGET_REQUEST_POINTS of the bar under test
    const perTok = a === "output" ? price.output : a === "read" ? price.cacheRead : a === "write1h" ? price.cacheWrite1h : a === "write5m" ? price.cacheWrite5m : price.input;
    const want = a === "read" ? 150000 : (TARGET_REQUEST_POINTS * P) / perTok;
    size[a] = Math.round(Math.max(MIN_TOKENS[a], Math.min(CAP_TOKENS[a], want * scale)));
  }
  const segRows = [];
  let stopReason = "all arms measured";
  let lastMeters = {};
  const meterRow = (req, m) => {
    for (const b of ["5h", "7d"]) if (m?.[b]) rows.push({ t: "meter", ts: req.ts, after_request_id: req.request_id, bar: b, used_pct: m[b].used_pct, resets_at: m[b].resets_at });
  };
  outer: for (const arm of arms) {
    await backend.beginArm(arm);
    const state = {};
    const tracker = new QW.AnchorTracker(P);
    tracker.last = lastMeters[bar]?.used_pct ?? null;
    let armStartResets = null;
    let armUsd = 0;
    let firstTick = null;
    let reqCount = 0;
    const startReading = unanchored ? (opts.meter === "oauth" ? await oauthReadings() : await askReadings("at the start of this arm")) : null;
    const targetReqs = unanchored ? Math.ceil((opts.points * P) / Math.max(1e-6, size[arm] * (arm === "read" ? price.cacheRead : arm === "output" ? price.output : arm === "write1h" ? price.cacheWrite1h : arm === "write5m" ? price.cacheWrite5m : price.input))) + 1 : Infinity;
    log(`  arm ${arm}: ${size[arm]} tokens per request${unanchored ? `, ${targetReqs} requests` : `, until ${opts.points + 1} anchor ticks`}`);
    const tokSum = Object.fromEntries(QW.KINDS.map((kk) => [kk, 0]));
    while ((unanchored ? reqCount < targetReqs : tracker.anchors < opts.points + 1) && reqCount < MAX_REQUESTS_PER_ARM) {
      // stop / wait conditions on the last readings
      const mb = lastMeters[bar];
      if (mb && mb.used_pct >= STOP_PCT[bar]) {
        stopReason = `stopped at ${mb.used_pct}% of the ${bar} bar`;
        break outer;
      }
      const mo = lastMeters[otherBar];
      if (otherBar === "5h" && mo && mo.used_pct >= STOP_PCT["5h"] && !dry) {
        const until = Date.parse(mo.resets_at) + 60000;
        log(`  5h bar at ${mo.used_pct}%: waiting for its reset at ${mo.resets_at}`);
        await sleep(Math.max(60000, until - Date.now()));
        lastMeters[otherBar] = null;
      }
      const pr = prompts.make(arm, size[arm], state);
      let res;
      try {
        res = await backend.send(arm, pr);
      } catch (err) {
        stopReason = `request failed: ${err.message}`;
        break outer;
      }
      reqCount++;
      if (res.overage) {
        stopReason = "overage status reported";
        break outer;
      }
      if (res.entrypoint && res.entrypoint !== header.entrypoint && !dry) fail(`entrypoint mismatch: transcript says ${res.entrypoint}, expected ${header.entrypoint}. Unset CLAUDE_CODE_ENTRYPOINT and restart the terminal.`);
      const req = { t: "req", ...res.request, arm };
      req.ts = res.request.ts;
      rows.push(req);
      meterRow(req, res.meters);
      if (res.meters) for (const b of ["5h", "7d"]) if (res.meters[b]) lastMeters[b] = res.meters[b];
      for (const kk of QW.KINDS) tokSum[kk] += req[QW.TOKEN_FIELD[kk]] || 0;
      const usd = usdOf(req);
      armUsd += usd;
      const m = res.meters?.[bar];
      if (!unanchored && m) {
        if (armStartResets == null) armStartResets = m.resets_at;
        if (m.resets_at !== armStartResets) {
          log(`  window reset during arm ${arm}: arm dropped, restarting it`);
          for (const r of rows) if (r.t === "req" && r.arm === arm) r.arm = "context";
          armStartResets = m.resets_at;
          tracker.anchors = 0;
          tracker.last = m.used_pct;
          continue;
        }
        const wasAnchor = tracker.feed(usd, m.used_pct);
        if (wasAnchor) {
          if (firstTick == null) firstTick = { usd: armUsd, pct: m.used_pct };
          else if (m.used_pct > firstTick.pct) P = Math.max(P * 0.25, Math.min(P * 4, (armUsd - firstTick.usd) / (m.used_pct - firstTick.pct)));
          log(`    anchor ${tracker.anchors}/${opts.points + 1} · ${bar} ${m.used_pct}% · ${reqCount} requests`);
        }
      }
      // keep requests under 0.1 point of the bar under test (§1.2.9)
      const pts = usd / P;
      if (arm !== "read" && pts > MAX_REQUEST_POINTS) size[arm] = Math.max(MIN_TOKENS[arm], Math.round(size[arm] * (TARGET_REQUEST_POINTS / pts)));
      if (arm === "read" && pr.first === undefined && pts > MAX_REQUEST_POINTS) log(`    request larger than 0.1 point (${pts.toFixed(2)}): rerun with --scale 0.5`);
    }
    if (unanchored) {
      log("  waiting 2 minutes for the meter to settle…");
      if (!dry) await sleep(120000);
      const endReading = opts.meter === "oauth" ? await oauthReadings() : await askReadings("at the end of this arm");
      for (const b of ["5h", "7d"]) {
        const pts = endReading[b] - startReading[b];
        if (pts > 0) segRows.push({ t: "seg", arm, bar: b, points: pts, anchored: false, ...Object.fromEntries(QW.KINDS.map((kk) => [QW.TOKEN_FIELD[kk], tokSum[kk]])), ts_start: rows.find((r) => r.t === "req" && r.arm === arm)?.ts, ts_end: nowIso() });
      }
    }
    await backend.endArm();
  }
  const idleAfter = dry || idleMin === 0 ? { ticks: 0, method: dry ? "simulated" : "skipped" } : await backend.idle(idleMin);
  log(`  idle after: ${idleAfter.ticks} ticks (${idleAfter.method})`);
  await backend.stop();

  header.idle_ticks = idleBefore.ticks == null || idleAfter.ticks == null ? null : idleBefore.ticks + idleAfter.ticks;
  header.bars = ["5h", "7d"].map((b) => ({ id: b, resets_at: rows.filter((r) => r.t === "meter" && r.bar === b).slice(-1)[0]?.resets_at ?? null }));
  header.ended_at = nowIso();
  header.stop_reason = stopReason;
  const startPct = rows.find((r) => r.t === "meter" && r.bar === bar)?.used_pct;
  if (startPct != null && startPct >= START_MAX_PCT) header.notes += `Started at ${startPct}% of the ${bar} bar (protocol: below ${START_MAX_PCT}%). `;
  header.notes += `Stop: ${stopReason}.`;

  // Raw bundle: per-request usage objects and meter events only (no prompts, paths or ids).
  const rawFile = out.file.replace(/\.jsonl$/, ".raw.jsonl");
  const rawRows = (backend.raw || []).map((r) => r);
  fs.writeFileSync(rawFile, rawRows.map((r) => JSON.stringify(r)).join("\n") + (rawRows.length ? "\n" : ""));
  header.raw.sha256 = crypto.createHash("sha256").update(fs.readFileSync(rawFile)).digest("hex");
  const body = unanchored ? segRows : rows;
  fs.writeFileSync(out.file, [header, ...body].map((r) => JSON.stringify(r)).join("\n") + "\n");
  log(`\nwrote ${out.file} (${body.length} rows)`);
  log(`raw bundle ${rawFile} (sha256 ${header.raw.sha256.slice(0, 12)}…)`);

  // Segments this file yields under the fitter's anchor rule
  const sub = { file: out.file, header: { ...header, simulated: false, idle_ticks: 0, raw: { url: "check" } }, rows: body };
  const err = QW.validateSubmission(sub, prices);
  if (err) log(`fitter check: ${err}`);
  const segs = QW.buildSegments([{ ...sub, error: err }], prices);
  const sumPts = segs.filter((s) => s.bar === bar).reduce((a, s) => a + s.y, 0);
  log(`fitter check: ${segs.filter((s) => s.bar === bar).length} ${bar} segments, ${sumPts} points (${[...new Set(segs.filter((s) => s.bar === bar).map((s) => s.arm))].join(", ") || "none"})`);
  if (!dry) {
    log("\nNext:");
    log(`  1. Upload ${path.basename(rawFile)} (gist or issue attachment).`);
    log(`  2. node scripts/quota-probe.mjs set-raw ${sq(out.file)} <url>`);
    log("  3. Open a pull request with the .jsonl, or attach it to a \"Quota weights\" issue.");
  }
  if (!fs.readdirSync(workDir).length) fs.rmSync(workDir, { recursive: true, force: true });
  return { file: out.file, rawFile, header, rows: body, segments: segs };
}

async function oauthReadings() {
  const r = await readOauthUsage();
  if (!r.ok) fail(`OAuth usage unavailable (${r.error}): use --meter manual`);
  return { "5h": r["5h"]?.used_pct ?? NaN, "7d": r["7d"]?.used_pct ?? NaN };
}

function claudeVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) fail(`cannot run ${bin} --version: install Claude Code or pass --claude <path>`);
  return (r.stdout.match(/\d+\.\d+\.\d+/) || ["unknown"])[0];
}

function checkEnv(opts) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT) fail(`CLAUDE_CODE_ENTRYPOINT=${process.env.CLAUDE_CODE_ENTRYPOINT} is set in this shell: unset CLAUDE_CODE_ENTRYPOINT and restart the terminal.`);
  if (opts.class === "interactive" && opts.drive === "tmux" && spawnSync("tmux", ["-V"]).status !== 0) fail("tmux not found: install tmux, or use --drive guided");
  if (opts.meter === "oauth" && !opts.oauth) fail("--meter oauth needs --oauth");
  claudeVersion(opts.claude);
}

// ---------------------------------------------------------------------------------------------
// Holdout recording (G4): ordinary work in your own project, meter from the status line
// ---------------------------------------------------------------------------------------------

async function recordHoldout(a) {
  const dir = path.resolve(a.dir || process.cwd());
  const model = a.model || "claude-opus-5-5";
  const plan = normPlan(a.plan || "max");
  const bar = a.bar || "7d";
  const bin = a.claude || "claude";
  const submitter = String(a.submitter || "anonymous").replace(/[^A-Za-z0-9_.-]/g, "-");
  if (process.env.CLAUDE_CODE_ENTRYPOINT) fail("CLAUDE_CODE_ENTRYPOINT is set in this shell: unset CLAUDE_CODE_ENTRYPOINT and restart the terminal.");
  const price = QW.priceFor(QW.loadPrices(), model);
  if (!price) fail(`no list price for ${model} in data/quota-weights/prices.json`);
  const acct = accountHash(a["account-label"]);
  if (!acct) fail("no account id found in ~/.claude.json (oauthAccount.accountUuid): pass --account-label <any stable private string>");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "quota-probe-holdout-"));
  const be = new InteractiveBackend({ model, effort: a.effort || "medium", claude: bin, "no-safe-mode": true }, work);
  await be.start();
  const t0 = Date.now();
  const cmd = `cd ${sq(dir)} && env -u CLAUDE_CODE_ENTRYPOINT ${sq(bin)} --model ${sq(model)} --settings ${sq(be.settingsJson())}`;
  log("Holdout recording: work normally in Claude Code for at least 20 points of the bar, using only this session.");
  log("Mix cache-heavy turns (long conversations) with write-heavy ones (new sessions, large files).\n");
  log(`   ${cmd}\n`);
  await ask("Press Enter here when you have exited Claude Code… ");
  const calls = transcriptCalls(transcriptsFor(dir)).filter((c) => Date.parse(c.ts) >= t0 && (!c.model || c.model.startsWith(model)));
  const status = readStatusLog(be.statusFile);
  const rows = [];
  for (const c of calls) rows.push({ t: "req", ts: c.ts, arm: "mixed", request_id: `req-${uuid().slice(0, 12)}`, input: c.input, output: c.output, cache_read: c.cache_read, cache_write_5m: c.cache_write_5m, cache_write_1h: c.cache_write_1h });
  for (const r of status) {
    if (r.five_hour?.used_pct != null) rows.push({ t: "meter", ts: r.ts, bar: "5h", used_pct: Number(r.five_hour.used_pct), resets_at: epochIso(r.five_hour.resets_at) });
    if (r.seven_day?.used_pct != null) rows.push({ t: "meter", ts: r.ts, bar: "7d", used_pct: Number(r.seven_day.used_pct), resets_at: epochIso(r.seven_day.resets_at) });
  }
  rows.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts) || (x.t === "req" ? -1 : 1));
  const date = nowIso().slice(0, 10);
  const out = nextFile(`${submitter}-holdout`, date);
  const header = {
    schema: QW.SCHEMA.session,
    session_id: `${date}-${submitter}-holdout-${out.n}-${crypto.randomBytes(3).toString("hex")}`,
    submitter,
    account_hash: acct,
    vendor: "anthropic",
    plan,
    plan_price_usd: PLAN_PRICE[plan] ?? null,
    model,
    effort: a.effort || "medium",
    client: "claude-code",
    client_version: claudeVersion(bin),
    entrypoint: calls.find((c) => c.entrypoint)?.entrypoint || "cli",
    client_class: "interactive",
    label_emulated: false,
    meter_source: "statusline",
    meter_resolution: 1,
    bar_under_test: bar,
    bars: ["5h", "7d"].map((b) => ({ id: b, resets_at: rows.filter((r) => r.t === "meter" && r.bar === b).slice(-1)[0]?.resets_at ?? null })),
    cache_ttl: "mixed",
    shared_account: false,
    idle_before_min: 0,
    idle_after_min: 0,
    idle_ticks: 0,
    holdout: true,
    segmenting: "point",
    prices_usd_per_mtok: Object.fromEntries(QW.KINDS.map((k) => [k, Number((price[k] * 1e6).toFixed(6))])),
    raw: { url: null, sha256: null },
    probe_version: PROBE_VERSION,
    started_at: new Date(t0).toISOString(),
    ended_at: nowIso(),
    notes: "Ordinary work, one session at a time; holdout for G4 (not fitted).",
  };
  const rawFile = out.file.replace(/\.jsonl$/, ".raw.jsonl");
  fs.writeFileSync(rawFile, calls.map((c) => JSON.stringify({ t: "usage", ts: c.ts, model: c.model, usage: c.usageRaw })).join("\n") + "\n");
  header.raw.sha256 = crypto.createHash("sha256").update(fs.readFileSync(rawFile)).digest("hex");
  fs.writeFileSync(out.file, [header, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const pts = (b) => {
    const m = rows.filter((r) => r.t === "meter" && r.bar === b);
    return m.length ? m[m.length - 1].used_pct - m[0].used_pct : 0;
  };
  log(`wrote ${out.file}: ${calls.length} API calls, ${bar} moved ${pts(bar)} points`);
  if (pts(bar) < 20) log(`fewer than 20 points on the ${bar} bar: G4 needs ≥ 5-point chunks with a spread of cache-read share; record more.`);
  log(`raw bundle ${rawFile}`);
  log(`Next: upload the raw bundle, then node scripts/quota-probe.mjs set-raw ${sq(out.file)} <url>`);
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const HELP = `quota-probe ${PROBE_VERSION}

  node scripts/quota-probe.mjs probe [--oauth] [--ping]
  node scripts/quota-probe.mjs run --model <id> --bar 5h|7d --class sdk|interactive --plan <plan> [options]
  node scripts/quota-probe.mjs record-holdout --dir <project> --model <id> --plan <plan> [--bar 7d] [--submitter <login>]
  node scripts/quota-probe.mjs set-raw <submission.jsonl> <url>

run options
  --model        claude-opus-5-5 | claude-sonnet-5-5 | claude-haiku-5-5 | claude-fable-5-2
  --bar          7d (default) | 5h
  --class        interactive (default) | sdk
  --plan         pro | max (default) | ultra | team
  --arms         default 7d: input,read,write1h · 5h: input,output,read,write1h,write5m
  --points       anchored points per arm (default 7d: 3, 5h: 5)
  --effort       low (default)
  --drive        tmux (default when tmux exists) | guided      interactive class
  --meter        statusline (default) | manual | oauth          interactive class; manual / oauth = unanchored
  --oauth        allow reads of api.anthropic.com/api/oauth/usage (idle baseline, --meter oauth, probe)
  --idle-min     idle baseline before and after, minutes (default 10)
  --scale        request size multiplier (default 1)
  --submitter    GitHub login (default anonymous)
  --account-label  stable private string when ~/.claude.json has no account id
  --session-n    arm rotation index (default: number of your earlier files today)
  --claude       path to the claude binary (default claude)
  --no-safe-mode run Claude Code without --safe-mode
  --dry-run      simulated meter and usage; no API calls, no credentials; writes to --out or the OS temp dir
  --out          output directory for --dry-run
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help || cmd === "help") {
    log(HELP);
    return;
  }
  if (cmd === "statusline-log") return statuslineLog(a._[1]);
  if (cmd === "set-raw") {
    const [file, url] = a._.slice(1);
    if (!file || !url) fail("usage: set-raw <submission.jsonl> <url>");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const h = JSON.parse(lines[0]);
    h.raw = { ...(h.raw || {}), url };
    lines[0] = JSON.stringify(h);
    fs.writeFileSync(file, lines.join("\n"));
    log(`raw.url = ${url}`);
    return;
  }
  if (cmd === "probe") {
    const bin = a.claude || "claude";
    log(`Claude Code ${claudeVersion(bin)}`);
    log(`CLAUDE_CODE_ENTRYPOINT ${process.env.CLAUDE_CODE_ENTRYPOINT ? `set (${process.env.CLAUDE_CODE_ENTRYPOINT}): unset it and restart the terminal` : "unset"}`);
    log(`tmux ${spawnSync("tmux", ["-V"]).status === 0 ? "found" : "not found (needed for --drive tmux)"}`);
    log(`account hash ${accountHash(a["account-label"]) || "unavailable: pass --account-label"}`);
    if (a.oauth) {
      const o = await readOauthUsage();
      if (o.ok) {
        for (const b of ["5h", "7d"]) log(`${b} bar ${o[b]?.used_pct ?? "—"}% · resets ${o[b]?.resets_at ?? "—"}`);
      } else log(`OAuth usage: ${o.error}`);
    }
    if (a.ping) {
      const be = new SdkBackend({ model: a.model || "claude-haiku-5-5", effort: "low", claude: bin, "no-safe-mode": a["no-safe-mode"] }, fs.mkdtempSync(path.join(os.tmpdir(), "quota-probe-")));
      const r = await be.send("read", { text: "Reply with the single word: ok", newSession: true, ping: true });
      for (const b of ["5h", "7d"]) log(`${b} bar (rate_limit_event) ${r.meters[b]?.used_pct ?? "—"}% · resets ${r.meters[b]?.resets_at ?? "—"}`);
      log(`entrypoint ${r.entrypoint || "—"}`);
    }
    log("Plan: read it from /usage or your account page; pass it as --plan.");
    return;
  }
  if (cmd === "record-holdout") return recordHoldout(a);
  if (cmd !== "run") fail(`unknown command ${cmd}\n${HELP}`);
  const bar = a.bar || "7d";
  if (!QW.BARS.includes(bar)) fail("--bar must be 5h or 7d");
  const cls = a.class || "interactive";
  if (!QW.CLASSES.includes(cls)) fail("--class must be interactive or sdk");
  const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
  const opts = {
    ...a,
    model: a.model || "claude-opus-5-5",
    bar,
    class: cls,
    plan: normPlan(a.plan || "max"),
    effort: a.effort || "low",
    drive: a.drive || (hasTmux ? "tmux" : "guided"),
    meter: a.meter || "statusline",
    points: Number(a.points || (bar === "7d" ? 3 : 5)),
    arms: String(a.arms || (bar === "7d" ? "input,read,write1h" : "input,output,read,write1h,write5m")).split(","),
    claude: a.claude || "claude",
    "idle-min": a["idle-min"] != null ? Number(a["idle-min"]) : a["dry-run"] ? 0 : 10,
  };
  for (const arm of opts.arms) if (!QW.ARMS.includes(arm)) fail(`unknown arm ${arm}`);
  if (!PARITY_GUESS[opts.plan]) fail(`unknown plan ${opts.plan}`);
  if (!a["dry-run"]) checkEnv(opts);
  await runProbe(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}

export { InteractiveBackend, SdkBackend, DryRunBackend, parseRateLimitEvent, transcriptCalls, PromptMaker };
