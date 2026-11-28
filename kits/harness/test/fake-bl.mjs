#!/usr/bin/env node
/**
 * Stand-in for `bl` (Bailian CLI): `bl usage token-plan --output json` prints the token-plan
 * windows from $FAKE_METER (monthly = meter used, as a 0–1 ratio). FAKE_BL_FAIL=1 exits 1 with a
 * token-like line on stderr.
 */

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.join(" ") !== "usage token-plan --output json") process.exit(2);
if (process.env.FAKE_BL_FAIL === "1") {
  console.error("Error: console session expired for sk-sp-ABCDEFGHIJKLMNOPQRSTUV (user@example.com)");
  process.exit(1);
}
const st = JSON.parse(fs.readFileSync(process.env.FAKE_METER, "utf8"));
const reset = Date.now() + 10 * 86400000;
console.log(JSON.stringify({ per5HourPercentage: 0.02, per5HourResetTime: Date.now() + 3600000, per1WeekPercentage: Math.min(1, (st.used * 3) / 100), per1MonthPercentage: st.used / 100, per1MonthResetTime: reset, hasQuotaData: true }));
