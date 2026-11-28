/** Test helpers: fake harness installs in a temp folder and a driver that answers meter prompts. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(here, "..", "scripts", "harness-quota.mjs");

export function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-quota-${name}-`));
}

/** A Gemini CLI npm layout: node_modules/@google/gemini-cli (+ -core) and bin/gemini → dist/index.js. */
export function fakeGeminiInstall(root, { core = true } = {}) {
  const pkg = path.join(root, "node_modules", "@google", "gemini-cli");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@google/gemini-cli", type: "module", bin: { gemini: "dist/index.js" } }));
  fs.copyFileSync(path.join(here, "fake-gemini.mjs"), path.join(pkg, "dist", "index.js"));
  fs.chmodSync(path.join(pkg, "dist", "index.js"), 0o755);
  if (core) {
    const c = path.join(root, "node_modules", "@google", "gemini-cli-core");
    fs.mkdirSync(path.join(c, "dist"), { recursive: true });
    fs.writeFileSync(path.join(c, "package.json"), JSON.stringify({ name: "@google/gemini-cli-core", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
    fs.copyFileSync(path.join(here, "fake-gemini-core.mjs"), path.join(c, "dist", "index.js"));
  }
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const bin = path.join(root, "bin", "gemini");
  fs.symlinkSync(path.join(pkg, "dist", "index.js"), bin);
  return bin;
}

export function fakeGrokInstall(root) {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const bin = path.join(root, "bin", "grok");
  fs.copyFileSync(path.join(here, "fake-grok.mjs"), bin);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** bin/<name> → a copy of test/<fake> (Factory Droid, Kimi Code, Qwen Code, Mistral Vibe, bl). */
export function fakeBin(root, name, fake) {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const bin = path.join(root, "bin", name);
  fs.copyFileSync(path.join(here, fake), bin);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/**
 * Run the kit; answer each "% used: " prompt from `answer(meter, promptText, n)` (default: the
 * meter file's value, floored). Resolves { code, stdout, stderr, prompts }.
 */
export function drive(args, { env = {}, meter, answer = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const prompts = [];
    child.stdout.on("data", (d) => {
      stdout += d;
      pending += d;
      const idx = pending.lastIndexOf("% used: ");
      if (idx >= 0) {
        const line = pending.slice(pending.lastIndexOf("\n", idx) + 1, idx + 8);
        pending = pending.slice(idx + 8);
        prompts.push(line);
        const used = meter && fs.existsSync(meter) ? JSON.parse(fs.readFileSync(meter, "utf8")).used : 0;
        const a = answer ? answer(used, line, prompts.length) : String(Math.floor(used));
        child.stdin.write(`${a}\n`);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); // own child only
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, prompts });
    });
  });
}
