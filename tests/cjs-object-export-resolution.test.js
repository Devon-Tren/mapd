/**
 * tests/cjs-object-export-resolution.test.js — regression test for a real
 * false-positive: `const alpaca = { async getPortfolioHistory() {...} };
 * module.exports = alpaca;` is a common CommonJS pattern (declare an object,
 * export the identifier), but parser.js only recognized inline object
 * literals assigned directly to module.exports, not an identifier reference
 * resolved back to its declaration — so every method on `alpaca` was
 * reported as "not exported" even though it plainly was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsFile } from "../src/core/parser.js";

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-cjsexport-"));
  const p = path.join(dir, "alpaca.js");
  fs.writeFileSync(p, content);
  return p;
}

test("module.exports = <identifier declared as an object literal> exports every method on it", () => {
  const p = tmpFile(`
    const alpaca = {
      async getPortfolioHistory(range) { return range; },
      isEtfOrFund(ticker) { return false; },
    };
    module.exports = alpaca;
  `);
  const n = parseJsFile(p, "alpaca.js");
  assert.ok(n.exports.includes("getPortfolioHistory"));
  assert.ok(n.exports.includes("isEtfOrFund"));
  const history = n.functions.find((f) => f.name === "getPortfolioHistory");
  assert.ok(history.exported, "getPortfolioHistory must be marked exported, not a false 'unexported' finding");
  const isEtf = n.functions.find((f) => f.name === "isEtfOrFund");
  assert.ok(isEtf.exported);
});

test("shorthand property referencing a separately declared function is also resolved", () => {
  const p = tmpFile(`
    function syncForm4ForIssuer(id) { return id; }
    const alpaca = { syncForm4ForIssuer };
    module.exports = alpaca;
  `);
  const n = parseJsFile(p, "alpaca.js");
  assert.ok(n.exports.includes("syncForm4ForIssuer"));
  const fn = n.functions.find((f) => f.name === "syncForm4ForIssuer");
  assert.ok(fn.exported);
});

test("inline object literal assigned directly to module.exports still works (no regression)", () => {
  const p = tmpFile(`module.exports = { async closePosition(t) { return t; } };`);
  const n = parseJsFile(p, "alpaca.js");
  assert.ok(n.exports.includes("closePosition"));
  assert.ok(n.functions.find((f) => f.name === "closePosition").exported);
});

test("an identifier assigned to module.exports that is NOT an object literal (e.g. a class) is unaffected", () => {
  const p = tmpFile(`
    class Alpaca { getPortfolioHistory() {} }
    module.exports = Alpaca;
  `);
  const n = parseJsFile(p, "alpaca.js");
  assert.ok(n.exports.includes("Alpaca"));
});

test("a plain non-exported object literal's methods are not falsely marked exported", () => {
  const p = tmpFile(`
    const internalHelper = { secretMethod() {} };
    function unrelated() {}
    module.exports = unrelated;
  `);
  const n = parseJsFile(p, "alpaca.js");
  assert.ok(!n.exports.includes("secretMethod"), "an object literal never assigned to module.exports must not leak its methods as exported");
});
