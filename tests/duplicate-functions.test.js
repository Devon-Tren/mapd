/**
 * tests/duplicate-functions.test.js — AST shape-hash near-duplicate function
 * detection: normalizes local variable names and literal values, but keeps
 * operators, control-flow shape, and called-function/property names literal,
 * so it can't be fooled into matching genuinely different logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsFile, parseProject } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";
import { runModernizationScan } from "../src/core/modernize.js";

function writeAndParse(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-dup-"));
  const file = path.join(dir, "index.js");
  fs.writeFileSync(file, code);
  return parseJsFile(file, "index.js");
}

test("computeShapeHash: two functions differing only by variable names hash identically", () => {
  const node = writeAndParse(`
    export function calcTotalA(items) {
      let sum = 0;
      for (const item of items) { sum = sum + item.price; }
      return sum;
    }
    export function calcTotalB(products) {
      let total = 0;
      for (const product of products) { total = total + product.price; }
      return total;
    }
  `);
  const a = node.functions.find((f) => f.name === "calcTotalA");
  const b = node.functions.find((f) => f.name === "calcTotalB");
  assert.ok(a.shapeHash);
  assert.equal(a.shapeHash, b.shapeHash);
});

test("computeShapeHash: two functions differing only by literal constants also hash identically (Type-2 clone definition)", () => {
  const node = writeAndParse(`
    export function greetHello(n) {
      const prefix = "hello";
      const suffix = "!";
      return prefix + " " + n + suffix;
    }
    export function greetGoodbye(n) {
      const prefix = "goodbye";
      const suffix = ".";
      return prefix + " " + n + suffix;
    }
  `);
  const a = node.functions.find((f) => f.name === "greetHello");
  const b = node.functions.find((f) => f.name === "greetGoodbye");
  assert.ok(a.shapeHash);
  assert.equal(a.shapeHash, b.shapeHash);
});

test("computeShapeHash: functions with a different operator do NOT hash the same (never a false positive on real logic differences)", () => {
  const node = writeAndParse(`
    export function addAB(a, b) {
      const x = a;
      const y = b;
      return x + y;
    }
    export function subAB(a, b) {
      const x = a;
      const y = b;
      return x - y;
    }
  `);
  const add = node.functions.find((f) => f.name === "addAB");
  const sub = node.functions.find((f) => f.name === "subAB");
  assert.ok(add.shapeHash);
  assert.notEqual(add.shapeHash, sub.shapeHash);
});

test("computeShapeHash: calling a different method is a real logic difference, not a rename — must not match", () => {
  const node = writeAndParse(`
    export function upperIt(s) {
      const trimmed = s.trim();
      const result = trimmed.toUpperCase();
      return result;
    }
    export function lowerIt(s) {
      const trimmed = s.trim();
      const result = trimmed.toLowerCase();
      return result;
    }
  `);
  const upper = node.functions.find((f) => f.name === "upperIt");
  const lower = node.functions.find((f) => f.name === "lowerIt");
  assert.ok(upper.shapeHash);
  assert.notEqual(upper.shapeHash, lower.shapeHash, "different methods called must never be treated as a rename");
});

test("computeShapeHash: the function's own name never affects the hash", () => {
  const node = writeAndParse(`
    export function foo(n) { return n + 1; }
    export function bar(n) { return n + 1; }
  `);
  const foo = node.functions.find((f) => f.name === "foo");
  const bar = node.functions.find((f) => f.name === "bar");
  assert.equal(foo.shapeHash, bar.shapeHash);
});

test("computeShapeHash: trivial functions below the minimum line threshold get shapeHash null, never fabricated", () => {
  const node = writeAndParse(`export function tiny() { return 1; }`);
  const fn = node.functions.find((f) => f.name === "tiny");
  assert.equal(fn.shapeHash, null);
});

test("computeShapeHash: unrelated real-world functions of similar size do not collide", () => {
  const node = writeAndParse(`
    export function validateEmail(input) {
      if (!input) return false;
      const parts = input.split("@");
      if (parts.length !== 2) return false;
      return parts[1].includes(".");
    }
    export function formatCurrency(value) {
      const rounded = Math.round(value * 100) / 100;
      const parts = rounded.toString().split(".");
      return "$" + parts.join(".");
    }
  `);
  const a = node.functions.find((f) => f.name === "validateEmail");
  const b = node.functions.find((f) => f.name === "formatCurrency");
  assert.notEqual(a.shapeHash, b.shapeHash);
});

test("mapd modernize --mode heavy: reports duplicate-functions across different files, never in light/medium", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-dup-modernize-"));
  const pkg = { name: "t", main: "index.js", type: "module" };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "index.js"), `
    import { calcA } from "./a.js";
    import { calcB } from "./b.js";
    export function main() { return calcA([]) + calcB([]); }
  `);
  fs.writeFileSync(path.join(dir, "a.js"), `
    export function calcA(items) {
      let sum = 0;
      for (const item of items) { sum = sum + item.price; }
      return sum;
    }
  `);
  fs.writeFileSync(path.join(dir, "b.js"), `
    export function calcB(products) {
      let total = 0;
      for (const product of products) { total = total + product.price; }
      return total;
    }
  `);
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));

  const heavy = runModernizationScan(dir, graph, pkg, "heavy");
  const dupFinding = heavy.findings.find((f) => f.rule === "duplicate-functions");
  assert.ok(dupFinding, "heavy mode must surface the cross-file duplicate");
  assert.equal(dupFinding.certainty, 1.0);
  assert.ok(dupFinding.operationalImpact);
  assert.match(dupFinding.detail, /a\.js#calcA/);
  assert.match(dupFinding.detail, /b\.js#calcB/);

  const medium = runModernizationScan(dir, graph, pkg, "medium");
  assert.ok(!medium.findings.some((f) => f.rule === "duplicate-functions"), "architecture tier (and thus duplicate-functions) is heavy-only");
});

test("runModernizationScan: profile mode reports deterministic phase timings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-modernize-profile-"));
  const pkg = { name: "t", main: "index.js", type: "module" };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "index.js"), `export function main(){ return 1; }\n`);
  const graph = buildGraph(dir, parseProject(dir), pkg);
  const report = runModernizationScan(dir, graph, pkg, "heavy", { profile: true, checkRegistry: false });
  assert.ok(report.profile.totalMs >= 0);
  assert.ok(report.profile.steps.some((s) => s.name === "dependency-health"));
  assert.ok(report.profile.steps.some((s) => s.name === "code-patterns"));
  assert.ok(report.profile.steps.some((s) => s.name === "architecture"));
  assert.ok(report.profile.steps.some((s) => s.name === "score-and-sort"));
});
