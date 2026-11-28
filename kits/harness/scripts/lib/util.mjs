/** Small helpers shared by the harness kit. Zero dependencies (Node ≥ 20). */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** Shell-quote one argument for display. */
export const sq = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

export function parseArgs(argv) {
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

export function round(x, d = 4) {
  if (x == null || !Number.isFinite(x)) return x ?? null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export function roundDeep(o, d = 6) {
  if (Array.isArray(o)) return o.map((x) => roundDeep(x, d));
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) r[k] = roundDeep(v, d);
    return r;
  }
  if (typeof o === "number" && !Number.isInteger(o)) return round(o, d);
  return o;
}

/** Absolute path of `bin` on PATH (or `bin` itself when it contains a slash), else null. */
export function whichBin(bin) {
  if (!bin) return null;
  if (bin.includes("/")) return fs.existsSync(bin) ? path.resolve(bin) : null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/** First line of `<bin> <args>` stdout, or null when it fails. */
export function versionOf(bin, args = ["--version"]) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim().split("\n")[0].trim() || null;
}

/** Other processes whose argv matches `match(argv[])` (read from /proc; nothing is signalled). */
export function otherProcesses(match) {
  const out = [];
  if (!fs.existsSync("/proc")) return out;
  const mine = new Set([process.pid, process.ppid]);
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || mine.has(Number(d))) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!cmd.length || cmd.join(" ").includes("harness-quota.mjs")) continue;
    if (match(cmd)) out.push({ pid: Number(d), cmd: path.basename(cmd[0]) + (cmd[1] ? ` ${path.basename(cmd[1])}` : "") });
  }
  return out;
}

/** Patterns for tokens, keys and emails; used to redact messages and to check result files. */
export const SECRET_RES = [
  /Bearer\s+[\w.~+/=-]+/i,
  /\beyJ[\w-]{10,}\.[\w-]{10,}(?:\.[\w-]+)?/, // JWT
  /\bya29\.[\w-]+/, // Google OAuth access token
  /\b1\/\/[\w-]{20,}/, // Google refresh token
  /\b(?:sk|xai)-[A-Za-z0-9_-]{16,}/,
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // email
];

/** Message with anything token-, key- or email-like replaced by [redacted]. */
export function redact(msg) {
  let s = String(msg ?? "");
  for (const re of SECRET_RES) s = s.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[redacted]");
  return s;
}

/** Dots to hyphens, the site's baseModelId convention ("gemini-3.8-flash" → "gemini-3-8-flash"). */
export const dotsToHyphens = (m) => String(m).toLowerCase().replace(/\./g, "-");

export function isUnder(p, root) {
  if (!p || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Split concatenated JSON values (pretty-printed objects back to back, or JSONL) into parsed
 * objects. Unparseable chunks are counted in `bad`.
 */
export function splitJsonStream(text) {
  const out = [];
  let bad = 0;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(s.slice(start, i + 1)));
        } catch {
          bad++;
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return { values: out, bad };
}
