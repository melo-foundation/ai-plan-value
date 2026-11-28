/**
 * Stand-in for @google/gemini-cli-core in the --auto-meter tests: exports Config and AuthType with
 * the methods the quota probe calls. refreshUserQuota() returns one bucket per model from
 * $FAKE_METER. FAKE_AUTH_FAIL=1 makes refreshAuth throw, as with no stored login.
 */

import fs from "node:fs";

export const AuthType = { LOGIN_WITH_GOOGLE: "oauth-personal", USE_GEMINI: "gemini-api-key" };

export class Config {
  constructor(p) {
    this.p = p;
    this.authed = false;
  }
  async refreshAuth(t) {
    if (process.env.FAKE_AUTH_FAIL === "1") throw new Error("No cached credentials (token ya29.SECRETSECRET)");
    if (t !== AuthType.LOGIN_WITH_GOOGLE) throw new Error("unexpected auth type");
    this.authed = true;
  }
  async refreshUserQuota() {
    if (!this.authed) return undefined;
    const st = JSON.parse(fs.readFileSync(process.env.FAKE_METER, "utf8"));
    const reset = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
    return {
      buckets: [
        { modelId: this.p.model, remainingFraction: Math.max(0, 1 - st.used / 100), remainingAmount: String(Math.round(1500 * (1 - st.used / 100))), resetTime: reset, tokenType: "REQUESTS" },
        { modelId: "gemini-3.1-flash-lite", remainingFraction: 1, resetTime: reset, tokenType: "REQUESTS" },
      ],
    };
  }
}
