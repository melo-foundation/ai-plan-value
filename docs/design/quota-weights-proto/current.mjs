// Current best estimate from public primary data. node current.mjs
// Sources: Fei-Craft/real-api-pricing#98 (issue body) and kler/claude-usage-ab results/2026-10-17T09-41-03Z-run.jsonl
import fs from "node:fs";
import { KINDS, rng, fit, quantile, phi } from "./fit-proto.mjs";

const P = { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite5m: 5e-6, cacheWrite1h: 8e-6 }; // Opus 5.5 list

// ---- Fei #98, control groups (per complete 1% interval of the 5h bar) ----
const f98 = {
  B: { perPoint: { input: 168726 * P.input, output: 124 * P.output }, intervals: [0.68, 0.68, 0.68, 0.68, 0.68], stated: 0.677 },
  C: { perPoint: { input: 4182 * P.input, output: 33165 * P.output }, intervals: [0.7, 0.67, 0.66, 0.73, 0.65], stated: 0.68 },
  D: { perPoint: { cacheRead: 4132092 * P.cacheRead, cacheWrite1h: 51123 * P.cacheWrite1h, output: 523 * P.output }, intervals: [1.26, 1.25, 1.24, 1.24], stated: 1.247 },
};
function f98Segments(jitter = () => 1) {
  const segs = [];
  for (const [arm, g] of Object.entries(f98)) {
    const tot = Object.values(g.perPoint).reduce((a, b) => a + b, 0);
    g.intervals.forEach((usd, i) => {
      const k = (usd / tot) * jitter(arm);
      segs.push({ group: "fei98:max5x:5h:sdk-cli", session: `${arm}${i}`, arm, y: 1, anchored: true, boundaryUsd: [0, 0], usd: Object.fromEntries(Object.entries(g.perPoint).map(([kk, v]) => [kk, v * k])) });
    });
  }
  return segs;
}

// ---- kler run ----
const rows = fs.readFileSync(new URL("./raw/kler-run.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const samples = rows.filter((r) => r.kind === "sample");
const blocks = {};
for (const s of samples) (blocks[s.block] ||= []).push(s);
// split cumulative cacheWrite into 1h / 5m from the SDK's list-price cost
function usdAt(s) {
  if (!s) return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, w1hShare: null };
  const t = s.tokens;
  const known = t.input * P.input + t.output * P.output + t.cacheRead * P.cacheRead;
  const w1h = Math.max(0, Math.min(t.cacheWrite, (s.costUsd - known - t.cacheWrite * P.cacheWrite5m) / (P.cacheWrite1h - P.cacheWrite5m)));
  return { input: t.input * P.input, output: t.output * P.output, cacheRead: t.cacheRead * P.cacheRead, cacheWrite1h: w1h * P.cacheWrite1h, cacheWrite5m: (t.cacheWrite - w1h) * P.cacheWrite5m, w1hShare: w1h / t.cacheWrite };
}
const diff = (a, b) => Object.fromEntries(KINDS.map((k) => [k, a[k] - b[k]]));
function klerSegments(lagOf = () => 0, posOf = () => 0) {
  const segs = [];
  for (const [b, S] of Object.entries(blocks)) {
    if (b === "0") continue; // warm-up
    const arm = S[0].arm;
    const tickIdx = [];
    for (let i = 1; i < S.length; i++) if (S[i].fiveHour > S[i - 1].fiveHour) tickIdx.push(i);
    // a tick seen at request i was caused by request i - lag (or earlier inside that request)
    const at = (i) => { const j = Math.max(-1, Math.min(S.length - 1, i - lagOf() + posOf())); return j < 0 ? usdAt(null) : usdAt(S[j]); };
    const group = arm === "claude-vscode" ? "kler:team:5h:claude-vscode" : "kler:team:5h:sdk";
    if (arm === "claude-vscode") {
      // one segment per point; the block start is the previous block's last tick
      let prev = usdAt(null), prevV = S[0].fiveHour;
      for (const i of tickIdx) {
        const cur = at(i);
        segs.push({ group, session: `b${b}`, arm, y: S[i].fiveHour - prevV, anchored: true, boundaryUsd: [0.01, 0.01], usd: diff(cur, prev) });
        prev = cur; prevV = S[i].fiveHour;
      }
    } else {
      // SDK arms: the first tick is caused by the 40k-token write (more than one point), so use the whole block
      const i = tickIdx[tickIdx.length - 1];
      segs.push({ group, session: `b${b}`, arm, y: S[i].fiveHour - S[0].fiveHour + (S[0].fiveHour - S[0].fiveHour), anchored: true, boundaryUsd: [0.01, 0.01], usd: diff(at(i), usdAt(null)), blockPoints: 2 });
      segs[segs.length - 1].y = 2;
    }
  }
  return segs;
}

const free = ["output", "cacheRead", "cacheWrite1h"];
const opts = { free, tau: 0.01 };

// ---- point estimates ----
const only98 = fit(f98Segments(), opts);
console.log("Fei #98 alone (cacheRead and cacheWrite1h are collinear in group D; NNLS picks one corner):", JSON.stringify(only98.w));
const q = (f98.B.stated + f98.C.stated) / 2;
const dTot = Object.values(f98.D.perPoint).reduce((a, b) => a + b, 0);
console.log(`#98 line: ${f98.D.perPoint.cacheRead.toFixed(4)}*w_read + ${f98.D.perPoint.cacheWrite1h.toFixed(4)}*w_1h + ${f98.D.perPoint.output.toFixed(4)} = ${q.toFixed(4)} * ${dTot.toFixed(4)}/${f98.D.stated}`);
for (const w1h of [1, 0.625, 0.5, 0]) console.log(`  w_1h=${w1h} -> w_read=${((q * dTot / f98.D.stated - f98.D.perPoint.output - w1h * f98.D.perPoint.cacheWrite1h) / f98.D.perPoint.cacheRead).toFixed(3)}`);

const ks = klerSegments();
console.log("\nkler segments (list-$ by kind):");
for (const s of ks) console.log(` ${s.group} ${s.session} y=${s.y} ` + KINDS.map((k) => `${k}=${(s.usd[k] || 0).toFixed(4)}`).join(" "));
console.log(" 1h share of cache writes at first sample of block 3:", usdAt(blocks[3][0]).w1hShare.toFixed(3));

const joint = fit([...f98Segments(), ...ks], opts);
console.log("\nJoint fit (#98 + kler), shared weights, one gamma per group:");
console.log(" weights:", JSON.stringify(Object.fromEntries(Object.entries(joint.w).map(([k, v]) => [k, +v.toFixed(3)]))));
console.log(" parity-$ per 5h point:", JSON.stringify(Object.fromEntries(Object.entries(joint.gamma).map(([k, v]) => [k, +(1 / v).toFixed(3)]))));
console.log(" sdk / vscode drain ratio:", (joint.gamma["kler:team:5h:sdk"] / joint.gamma["kler:team:5h:claude-vscode"]).toFixed(2));
for (const r of joint.resid) if (Math.abs(r.r) > 0.05) console.log("  resid", r.s.group, r.s.session, r.s.arm, r.r.toFixed(3));

// scenario test on the kler vscode arm alone: predicted points for point 1 vs point 2 must be equal
console.log("\nkler vscode arm: quota-$ of point 1 / point 2 under each #98 scenario (1.00 = consistent)");
const vs = ks.filter((s) => s.group.endsWith("vscode"));
const p1 = vs.filter((_, i) => i % 2 === 0), p2 = vs.filter((_, i) => i % 2 === 1);
const mean = (S, w) => S.reduce((a, s) => a + KINDS.reduce((qq, k) => qq + (w[k] ?? 1) * (s.usd[k] || 0), 0), 0) / S.length;
for (const [r, h] of [[0.31, 1], [0.5, 0.625], [0.56, 0.5], [0.81, 0], [1, 1]]) {
  const w = { input: 1, output: 1, cacheRead: r, cacheWrite1h: h, cacheWrite5m: 1 };
  console.log(`  read ${r}, 1h write ${h}: ${(mean(p1, w) / mean(p2, w)).toFixed(2)}`);
}

// ---- Monte Carlo over measurement error ----
const rand = rng(98);
const gauss = () => (rand() + rand() + rand() + rand() + rand() + rand() - 3) * Math.SQRT2;
const draws = [];
for (let b = 0; b < 4000; b++) {
  // #98: arm-level error = sd of its intervals / sqrt(n) (B stated to 2 decimals: 1%), plus 1% common meter noise per arm
  const armErr = { B: 0.01, C: 0.0468 / Math.sqrt(5), D: 0.0077 / Math.sqrt(4) };
  const e = Object.fromEntries(Object.keys(armErr).map((a) => [a, 1 + Math.hypot(armErr[a], 0.01) * gauss()]));
  const lag = rand() < 0.5 ? 0 : 1;
  const segs = [
    ...f98Segments((arm) => e[arm]),
    ...klerSegments(() => lag, () => 0).map((s) => ({ ...s, usd: Object.fromEntries(KINDS.map((k) => [k, (s.usd[k] || 0) * (1 + 0.03 * gauss())])) })),
  ];
  // resample kler blocks (3 vscode, 6 sdk) with replacement
  const pick = (g) => { const ss = [...new Set(segs.filter((s) => s.group === g).map((s) => s.session))]; return ss.map(() => ss[Math.floor(rand() * ss.length)]).flatMap((id, i) => segs.filter((s) => s.group === g && s.session === id).map((s) => ({ ...s, session: id + "#" + i }))); };
  const sample = [...segs.filter((s) => s.group.startsWith("fei98")), ...pick("kler:team:5h:claude-vscode"), ...pick("kler:team:5h:sdk")];
  const f = fit(sample, opts);
  draws.push({ ...f.w, cacheWrite5m: 0.8 + 0.2 * rand(), M: f.gamma["kler:team:5h:sdk"] / f.gamma["kler:team:5h:claude-vscode"] });
}
const ci = (f) => { const a = draws.map(f); return `${quantile(a, 0.5).toFixed(3)} (${quantile(a, 0.025).toFixed(3)}-${quantile(a, 0.975).toFixed(3)})`; };
console.log("\nMonte Carlo (4000 draws): median (2.5%-97.5%)");
for (const k of ["output", "cacheRead", "cacheWrite1h"]) console.log(` ${k}: ${ci((d) => d[k])}`);
console.log(` cacheRead / cacheWrite1h: ${ci((d) => d.cacheRead / d.cacheWrite1h)}`);
console.log(` sdk / vscode drain ratio: ${ci((d) => d.M)}`);
console.log(` implied quota price per 1M tokens (Opus 5.5): read $${ci((d) => d.cacheRead * 0.2)}, 1h write $${ci((d) => d.cacheWrite1h * 8)}`);

// ---- correction factors ----
const mixes = {
  "Fei Max 5x x Opus 5.5 sample": { cacheRead: 260, cacheWrite1h: 44.8, input: 0.092, output: 60 },
  "Fei Pro x Opus 5.5 maintainer 5h window (writes as 1h)": { cacheRead: 26.62, cacheWrite1h: 7.398, output: 7.18 },
  "Fei Pro x Fable 5.2 sample": { cacheRead: 9410355 * 0.2e-6, cacheWrite1h: 282950 * 16e-6, input: 89 * 8e-6, output: 60022 * 40e-6 },
  "Fei #124 Pro x Opus 5.5 week": { cacheRead: 805.94, cacheWrite1h: 241.75, cacheWrite5m: 8.86, input: 0.11, output: 209.49 },
  "Fei #96 Max 20x week A (Opus 5.5 prices)": { cacheRead: 4944.11 * 0.2, cacheWrite1h: 104.7 * 8, cacheWrite5m: 5.5 * 5, input: 0.1 * 4, output: 36.65 * 20 },
};
const aa = {
  "AA Opus 5.5 max": { cacheRead: 4.738378, cacheWrite5m: 1.795895, input: 0.035678, output: 3.466458 },
  "AA Sonnet 5.5 max": { cacheRead: 4.879029, cacheWrite5m: 2.26992, input: 0.017801, output: 2.853871 },
  "AA Fable 5.2 max": { cacheRead: 8.525356, cacheWrite5m: 7.050314, input: 0.071111, output: 10.891777 },
};
const share = (m) => { const t = KINDS.reduce((a, k) => a + (m[k] || 0), 0); return KINDS.filter((k) => m[k]).map((k) => `${k} ${(100 * m[k] / t).toFixed(1)}%`).join(", "); };
console.log("\n$ shares");
for (const [n, m] of Object.entries({ ...mixes, ...aa })) console.log(` ${n}: ${share(m)}`);
const W = (d, readMult = 1) => ({ input: 1, output: d.output, cacheRead: d.cacheRead * readMult, cacheWrite5m: d.cacheWrite5m, cacheWrite1h: d.cacheWrite1h });
console.log("\nphi under the joint fit");
for (const [n, m] of Object.entries({ ...mixes, ...aa })) console.log(` ${n}: ${ci((d) => phi(m, W(d)))}`);
const lnsd = (f) => { const a = draws.map((d) => Math.log(f(d))); const mu = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / a.length); };
console.log("\nCorrection factor F = phi(sample) / phi(metric): median (95%) [sd of ln F]");
const cases = [
  ["Max 5x x Opus 5.5 -> AA Opus 5.5", "Fei Max 5x x Opus 5.5 sample", "AA Opus 5.5 max", 1, 1],
  ["Pro x Opus 5.5 -> AA Opus 5.5", "Fei Pro x Opus 5.5 maintainer 5h window (writes as 1h)", "AA Opus 5.5 max", 1, 1],
  ["Max 5x Opus sample -> AA Sonnet 5.5, Opus weights transfer", "Fei Max 5x x Opus 5.5 sample", "AA Sonnet 5.5 max", 1, 1],
  ["Max 5x Opus sample -> AA Sonnet 5.5, Sonnet reads at 2x (quota unchanged by the Oct 8 price cut)", "Fei Max 5x x Opus 5.5 sample", "AA Sonnet 5.5 max", 1, 2],
  ["Pro x Fable 5.2 -> AA Fable 5.2, Opus weights transfer", "Fei Pro x Fable 5.2 sample", "AA Fable 5.2 max", 1, 1],
  ["Pro x Fable 5.2 -> AA Fable 5.2, Fable reads at 2x (same quota rate per input-$ as Opus)", "Fei Pro x Fable 5.2 sample", "AA Fable 5.2 max", 2, 2],
];
for (const [name, s, m, rs, rm] of cases) console.log(` ${name}: ${ci((d) => phi(mixes[s], W(d, rs)) / phi(aa[m], W(d, rm)))} [${lnsd((d) => phi(mixes[s], W(d, rs)) / phi(aa[m], W(d, rm))).toFixed(3)}]`);
console.log("\nSame factors on the whole #98 line (w_1h uniform 0..1, w_5m uniform 0.8..1), no kler constraint");
const lineDraws = Array.from({ length: 4000 }, () => { const h = rand(); return { output: 1, cacheWrite1h: h, cacheRead: (q * dTot / f98.D.stated - f98.D.perPoint.output - h * f98.D.perPoint.cacheWrite1h) / f98.D.perPoint.cacheRead, cacheWrite5m: 0.8 + 0.2 * rand() }; });
for (const [name, s, m, rs, rm] of cases.slice(0, 2)) { const a = lineDraws.map((d) => phi(mixes[s], W(d, rs)) / phi(aa[m], W(d, rm))); console.log(` ${name}: ${quantile(a, 0.5).toFixed(3)} (${quantile(a, 0).toFixed(3)}-${quantile(a, 1).toFixed(3)})`); }
console.log(" weekly bar counts reads and writes at list (claude-code #58786 hypothesis): F = 1.000");
