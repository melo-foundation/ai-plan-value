#!/usr/bin/env node
/**
 * Reads the Gemini Code Assist quota through the installed Gemini CLI's own core package, the
 * same path `/stats model` takes: Config.refreshAuth(LOGIN_WITH_GOOGLE) loads the CLI's stored
 * login, then Config.refreshUserQuota() calls retrieveUserQuota
 * (packages/core/src/config/config.ts, packages/core/src/code_assist/server.ts in
 * google-gemini/gemini-cli).
 *
 * Prints one JSON line: { ok: true, buckets: [{ modelId, remainingFraction, remainingAmount,
 * resetTime, tokenType }] } or { ok: false, error }. No token, project id, email or tier id is
 * printed. The kit never opens the credentials file; NO_BROWSER=true and a closed stdin stop
 * any login flow from waiting.
 *
 *   node gemini-quota-probe.mjs --cli-root <@google/gemini-cli folder> --model <id> --dir <folder>
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : null;
};
const SECRETS = [/Bearer\s+[\w.~+/=-]+/gi, /\beyJ[\w-]{10,}\.[\w-]{10,}(?:\.[\w-]+)?/g, /\bya29\.[\w-]+/g, /\b1\/\/[\w-]{20,}/g, /[\w.+-]+@[\w-]+\.[\w.-]+/g];
const done = (o) => {
  if (o.error) for (const re of SECRETS) o.error = o.error.replace(re, "[redacted]");
  process.stdout.write(JSON.stringify(o) + "\n");
  process.exit(o.ok ? 0 : 1);
};

/** Entry file of @google/gemini-cli-core next to or under the CLI package. */
export function coreEntry(cliRoot) {
  const candidates = [path.join(cliRoot, "node_modules", "@google", "gemini-cli-core"), path.join(path.dirname(cliRoot), "gemini-cli-core")];
  for (const dir of candidates) {
    const pj = path.join(dir, "package.json");
    if (!fs.existsSync(pj)) continue;
    const p = JSON.parse(fs.readFileSync(pj, "utf8"));
    const dot = p.exports?.["."] ?? p.exports;
    const rel = typeof dot === "string" ? dot : dot?.import || dot?.default || p.main || "index.js";
    const file = path.join(dir, typeof rel === "string" ? rel : rel.default || "index.js");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function main() {
  const cliRoot = opt("cli-root");
  const model = opt("model");
  const dir = opt("dir") || process.cwd();
  if (!cliRoot || !model) done({ ok: false, error: "usage: --cli-root <dir> --model <id> --dir <dir>" });
  const entry = coreEntry(cliRoot);
  if (!entry) done({ ok: false, error: "@google/gemini-cli-core not found in the Gemini CLI install (bundled build?)" });
  let core;
  try {
    core = await import(pathToFileURL(entry).href);
  } catch (e) {
    done({ ok: false, error: `cannot load @google/gemini-cli-core: ${String(e?.message || e).split("\n")[0]}` });
  }
  const { Config, AuthType } = core;
  if (typeof Config !== "function" || !AuthType?.LOGIN_WITH_GOOGLE) done({ ok: false, error: "this Gemini CLI version has no Config / AuthType.LOGIN_WITH_GOOGLE export" });
  const config = new Config({ sessionId: crypto.randomUUID(), targetDir: dir, cwd: dir, debugMode: false, model, interactive: false });
  if (typeof config.refreshAuth !== "function" || typeof config.refreshUserQuota !== "function") done({ ok: false, error: "this Gemini CLI version has no refreshAuth / refreshUserQuota" });
  try {
    try {
      await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
    } catch (e) {
      if (typeof config.initialize !== "function") throw e;
      await config.initialize();
      await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
    }
  } catch (e) {
    done({ ok: false, error: `login not usable (${String(e?.message || e).split("\n")[0].slice(0, 160)}): run \`gemini\` once and sign in with Google` });
  }
  let q;
  try {
    q = await config.refreshUserQuota();
  } catch (e) {
    done({ ok: false, error: `retrieveUserQuota failed: ${String(e?.message || e).split("\n")[0].slice(0, 160)}` });
  }
  if (!q?.buckets?.length) done({ ok: false, error: "retrieveUserQuota returned no buckets (not a Code Assist login, or no project)" });
  const n = (x) => (x == null ? null : Number(x));
  done({
    ok: true,
    buckets: q.buckets.map((b) => ({ modelId: b.modelId ?? null, remainingFraction: n(b.remainingFraction), remainingAmount: b.remainingAmount != null ? n(b.remainingAmount) : null, resetTime: b.resetTime ?? null, tokenType: b.tokenType ?? null })),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => done({ ok: false, error: String(e?.message || e).split("\n")[0].slice(0, 200) }));
}
