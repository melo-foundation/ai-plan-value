/** Assertions shared by the kits' smoke tests: report shape, nothing private in it, a valid issue URL. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { ISSUE_TEMPLATE, REPO_URL, RESULTS, SMOKE_PROMPT, SMOKE_SCHEMA, STATUSES, URL_LIMIT, issueUrl } from "./smoke.mjs";

/**
 * report: parsed smoke report. secrets: strings that must not appear (keys, leaked emails, ids).
 * numbers: token counts or meter values the fake produced, as strings. root: temp folder of the test.
 */
export function assertReport(report, { secrets = [], numbers = [], root = null } = {}) {
  assert.equal(report.schema, SMOKE_SCHEMA);
  assert.ok(RESULTS.includes(report.result), report.result);
  assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(["linux", "macos", "windows", "other"].includes(report.os));
  assert.ok(report.kitCommit === null || /^[0-9a-f]{4,40}$/.test(report.kitCommit));
  for (const s of report.steps) {
    assert.ok(STATUSES.includes(s.status), JSON.stringify(s));
    assert.equal(typeof s.reason, "string");
    assert.ok(!s.reason.includes("\n"));
  }
  for (const k of [...report.fields.usage, ...report.fields.meter]) assert.match(k, /^[A-Za-z_][A-Za-z0-9_.]*$/);
  const text = JSON.stringify(report);
  const walk = (v) => {
    assert.notEqual(typeof v, "number", `number in report: ${v}`);
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(report);
  for (const s of secrets) assert.ok(!text.includes(s), `secret in report: ${s.slice(0, 6)}…`);
  for (const n of numbers) assert.ok(!new RegExp(`(^|\\D)${n}(\\D|$)`).test(text), `value ${n} in report`);
  assert.ok(!text.includes(SMOKE_PROMPT), "prompt in report");
  if (root) assert.ok(!text.includes(root), "test folder path in report");
  assert.ok(!text.includes(os.homedir()), "home path in report");
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text), "email in report");
  assert.ok(!/(^|[\s"(])\/(home|Users|tmp|var|private)\//.test(text), "path in report");
}

/** The printed link is a valid prefilled Kit check URL under the limit, carrying this report. */
export function assertIssueUrl(stdout, report) {
  const line = stdout.split("\n").find((l) => l.startsWith(`${REPO_URL}/issues/new?`));
  assert.ok(line, "no issue URL printed");
  assert.ok(line.length <= URL_LIMIT, `URL is ${line.length} characters`);
  const u = new URL(line);
  assert.equal(u.origin + u.pathname, `${REPO_URL}/issues/new`);
  assert.equal(u.searchParams.get("template"), ISSUE_TEMPLATE);
  assert.equal(u.searchParams.get("kit"), report.kit);
  assert.equal(u.searchParams.get("adapter"), report.adapter);
  assert.equal(u.searchParams.get("result"), report.result);
  assert.equal(u.searchParams.get("plan"), report.plan ?? "");
  assert.match(u.searchParams.get("title"), new RegExp(`^\\[kit-check\\] ${report.kit} · `));
  assert.deepEqual(JSON.parse(u.searchParams.get("report")), report);
  assert.equal(line, issueUrl(report).url);
  return line;
}

export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
