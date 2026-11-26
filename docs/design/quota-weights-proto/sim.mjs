// Recovery check and sample-size table for the protocol. node sim.mjs
import { KINDS, rng, fit, simulateSession, quantile } from "./fit-proto.mjs";

const price = { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite5m: 5e-6, cacheWrite1h: 8e-6 }; // Opus 5.5 list
const trueW = { input: 1, output: 1, cacheRead: 0.5, cacheWrite5m: 0.9, cacheWrite1h: 0.6 };
const arms = ["input", "output", "cacheRead", "cacheWrite1h", "cacheWrite5m"];
const free = ["output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];

function run({ pointsPerArm, sessions, parityUsdPerPoint, noise, reps = 300, seed = 1, anchored = true, resolution = 1 }) {
  const rand = rng(seed);
  const est = Object.fromEntries(free.map((k) => [k, []]));
  for (let r = 0; r < reps; r++) {
    const segs = [];
    for (let s = 0; s < sessions; s++) {
      for (const seg of simulateSession({ rand, trueW, parityUsdPerPoint, pointsPerArm, arms, price, noise, resolution })) {
        if (!anchored) {
          // screenshot-style submission: start/end integer readings only -> +-1 point of rounding in y
          seg.anchored = false; seg.y = Math.max(1, seg.y + Math.round(rand() + rand() - 1));
        }
        segs.push({ ...seg, group: "g", session: `s${s}` });
      }
    }
    const f = fit(segs, { free });
    for (const k of free) est[k].push(f.w[k]);
  }
  const row = {};
  for (const k of free) {
    const rel = est[k].map((v) => v / trueW[k] - 1);
    row[k] = { bias: rel.reduce((a, b) => a + b, 0) / rel.length, half95: (quantile(rel, 0.975) - quantile(rel, 0.025)) / 2 };
  }
  return row;
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
console.log("True weights:", JSON.stringify(trueW));
console.log("\nTick-anchored arms, meter noise 3% per arm, Max 5x headless scale ($0.68 parity per 5h point)");
console.log("points/arm  sessions | 95% half-width (bias) of: output | cacheRead | cacheWrite5m | cacheWrite1h");
for (const [p, s] of [[2, 1], [3, 1], [5, 1], [10, 1], [20, 1], [3, 3], [5, 3], [10, 3], [5, 6]]) {
  const r = run({ pointsPerArm: p, sessions: s, parityUsdPerPoint: 0.68, noise: 0.03 });
  console.log(`${String(p).padStart(6)} ${String(s).padStart(9)}   | ` + free.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`).join(" | "));
}
console.log("\nMeter noise 1% per arm (within-session spread seen in Fei #98 group D and kler blocks), anchored");
for (const [p, s] of [[2, 1], [3, 1], [5, 1], [10, 1], [3, 3], [5, 3]]) {
  const r = run({ pointsPerArm: p, sessions: s, parityUsdPerPoint: 0.68, noise: 0.01 });
  console.log(`${String(p).padStart(6)} ${String(s).padStart(9)}   | ` + free.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`).join(" | "));
}
console.log("\nWeekly bar, Max 5x headless scale ($8.3 parity per weekly point), noise 1% and 3%");
for (const [p, s, nz] of [[2, 1, 0.01], [3, 1, 0.01], [4, 1, 0.01], [3, 1, 0.03], [3, 3, 0.03]]) {
  const r = run({ pointsPerArm: p, sessions: s, parityUsdPerPoint: 8.3, noise: nz, reps: 100 });
  console.log(`${String(p).padStart(6)} ${String(s).padStart(9)} ${nz}  | ` + free.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`).join(" | "));
}
console.log("\nSame, Pro interactive scale ($0.29 parity per 5h point; requests are coarser relative to a point)");
for (const [p, s] of [[5, 1], [10, 1], [10, 3]]) {
  const r = run({ pointsPerArm: p, sessions: s, parityUsdPerPoint: 0.29, noise: 0.03 });
  console.log(`${String(p).padStart(6)} ${String(s).padStart(9)}   | ` + free.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`).join(" | "));
}
console.log("\nUnanchored (start/end integer readings only), noise 3%");
for (const [p, s] of [[5, 1], [10, 1], [20, 1], [10, 3], [20, 3]]) {
  const r = run({ pointsPerArm: p, sessions: s, parityUsdPerPoint: 0.68, noise: 0.03, anchored: false });
  console.log(`${String(p).padStart(6)} ${String(s).padStart(9)}   | ` + free.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`).join(" | "));
}
console.log("\nNo meter noise (rounding and lag only), anchored");
for (const [p, s] of [[2, 1], [5, 1], [10, 1]]) {
  const r = run({ pointsPerArm: p, sessions: s, parityUsdPerPoint: 0.68, noise: 0 });
  console.log(`${String(p).padStart(6)} ${String(s).padStart(9)}   | ` + free.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`).join(" | "));
}
console.log("\nMeter noise 6% per arm (two accounts' worth of unexplained spread), anchored");
for (const [p, s] of [[5, 1], [5, 3], [5, 6], [10, 3]]) {
  const r = run({ pointsPerArm: p, sessions: s, parityUsdPerPoint: 0.68, noise: 0.06 });
  console.log(`${String(p).padStart(6)} ${String(s).padStart(9)}   | ` + free.map((k) => `${pct(r[k].half95)} (${pct(r[k].bias)})`).join(" | "));
}
