// node --test kits/harness/test/*.test.mjs
// Manual meter input parsing.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { askReading, lineReader, parseManualReading } from "../scripts/lib/manual.mjs";

test("accepted forms → % used", () => {
  const cases = { "37": 37, "37%": 37, " 37.5 % ": 37.5, "37,5%": 37.5, "37% used": 37, "used 37%": 37, "0": 0, "100%": 100, "63% left": 37, "63 % remaining": 37, "left 12.5%": 87.5, "USED 4%": 4 };
  for (const [s, want] of Object.entries(cases)) assert.equal(parseManualReading(s).pct, want, s);
});

test("rejected forms say what to type", () => {
  for (const s of ["", "abc", "37 pp", "-3", "101", "1e3", "37%%", "50/100", "about 40"]) {
    const r = parseManualReading(s);
    assert.ok(r.error, `${JSON.stringify(s)} → ${JSON.stringify(r)}`);
    assert.match(r.error, /type|outside|number/);
  }
});

test("'left' refused when the meter shows % used only", () => {
  assert.ok(parseManualReading("63% left", { allowLeft: false }).error);
  assert.equal(parseManualReading("37", { allowLeft: false }).pct, 37);
});

test("skip and stop", () => {
  assert.deepEqual(parseManualReading("skip"), { skip: true });
  assert.deepEqual(parseManualReading("Stop"), { stop: true });
  assert.deepEqual(parseManualReading("q"), { stop: true });
});

test("askReading re-asks until valid; end of input stops", async () => {
  const sink = new Writable({ write: (c, e, cb) => cb() });
  const io = lineReader(Readable.from(["nope\n", "250\n", "42.5\n"]), sink);
  const r = await askReading(io, "> ", { out: sink });
  assert.equal(r.pct, 42.5);
  const r2 = await askReading(io, "> ", { out: sink });
  assert.equal(r2.stop, true);
  io.close();
});
