/**
 * tests/gates.test.js — regression guard on extracting G1-G3 out of integrate.js
 * into the shared core/gates.js runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runStandardGates, GATES } from "../src/core/gates.js";
import { verifyProposal } from "../src/core/integrate.js";

const conflict = {
  file: "greet.js",
  requiredExports: ["farewell", "greet"],
  requiredFunctions: ["farewell", "greet"],
};

test("runStandardGates: G1 fails on unparseable source", () => {
  const gates = runStandardGates({ source: "function( {{{", label: "x@proposed" });
  assert.equal(gates.length, 1);
  assert.equal(gates[0].gate, GATES.G1);
  assert.equal(gates[0].passed, false);
});

test("runStandardGates: G2/G3 report missing symbols without dropping the finding", () => {
  const bad = `export function greet(n){ return n; }\n`; // drops farewell
  const gates = runStandardGates({
    source: bad, label: "greet.js@proposed",
    requiredExports: conflict.requiredExports, requiredFunctions: conflict.requiredFunctions,
  });
  const g2 = gates.find((g) => g.gate === GATES.G2);
  const g3 = gates.find((g) => g.gate === GATES.G3);
  assert.equal(g2.passed, false);
  assert.deepEqual(g2.missing, ["farewell"]);
  assert.equal(g3.passed, false);
  assert.deepEqual(g3.missing, ["farewell"]);
});

test("runStandardGates: all pass when the union is preserved", () => {
  const good = `export function greet(n){ return n; }\nexport function farewell(n){ return n; }\n`;
  const gates = runStandardGates({
    source: good, label: "greet.js@proposed",
    requiredExports: conflict.requiredExports, requiredFunctions: conflict.requiredFunctions,
  });
  assert.ok(gates.every((g) => g.passed), JSON.stringify(gates));
});

test("integrate.verifyProposal produces results identical to a direct runStandardGates call", () => {
  const good = `export function greet(n){ return n; }\nexport function farewell(n){ return n; }\n`;
  const bad = `export function greet(n){ return n; }\n`;

  for (const src of [good, bad]) {
    const viaIntegrate = verifyProposal(conflict, src);
    const viaGates = runStandardGates({
      source: src, label: `${conflict.file}@proposed`,
      requiredExports: conflict.requiredExports, requiredFunctions: conflict.requiredFunctions,
    });
    assert.deepEqual(viaIntegrate, viaGates);
  }
});

test("runStandardGates: G4 is skipped (not fabricated) when no testCommand is given", () => {
  const gates = runStandardGates({ source: "export function f(){}\n", label: "x" });
  assert.ok(!gates.some((g) => g.gate === GATES.G4));
});
