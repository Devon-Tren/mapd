/**
 * tests/prototype-methods.test.js — regression tests for the accuracy floor
 * fix: `X.prototype.method = ...` and its variants must be resolved as named,
 * receiver-qualified symbols connected to the workflow graph — not silently
 * dropped as anonymous functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsFile } from "../src/core/parser.js";
import { buildGraph, loadPkg } from "../src/core/graph.js";
import { parseProject } from "../src/core/parser.js";

function writeAndParse(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-proto-"));
  const file = path.join(dir, "index.js");
  fs.writeFileSync(file, code);
  return { dir, node: parseJsFile(file, "index.js") };
}

test("X.prototype.method = function(){} is named and parses cleanly", () => {
  const { node } = writeAndParse(`
    function Animal(name) { this.name = name; }
    Animal.prototype.speak = function () { return this.name + " makes a sound."; };
    module.exports = Animal;
  `);
  assert.equal(node.parsed, true);
  assert.equal(node.parseErrors, 0);
  const fn = node.functions.find((f) => f.name === "Animal.prototype.speak");
  assert.ok(fn, "Animal.prototype.speak must be indexed by its qualified name, not <anon:N>");
  assert.equal(fn.receiver, "Animal");
  assert.ok(!node.functions.some((f) => f.name.startsWith("<anon:")), "no anonymous fallback should remain for this pattern");
});

test("X.prototype.method = async function(){} variant", () => {
  const { node } = writeAndParse(`
    function Client() {}
    Client.prototype.fetchData = async function () { return await fetch("/x"); };
  `);
  const fn = node.functions.find((f) => f.name === "Client.prototype.fetchData");
  assert.ok(fn);
  assert.equal(fn.async, true);
  assert.equal(fn.receiver, "Client");
});

test("X.prototype.method = () => {} arrow variant", () => {
  const { node } = writeAndParse(`
    function Widget() {}
    Widget.prototype.render = () => "<div/>";
  `);
  const fn = node.functions.find((f) => f.name === "Widget.prototype.render");
  assert.ok(fn);
  assert.equal(fn.receiver, "Widget");
});

test("Object.assign(X.prototype, { method(){}, other: function(){} })", () => {
  const { node } = writeAndParse(`
    function Shape() {}
    Object.assign(Shape.prototype, {
      area() { return 0; },
      perimeter: function () { return 0; },
    });
  `);
  const area = node.functions.find((f) => f.name === "Shape.prototype.area");
  const perimeter = node.functions.find((f) => f.name === "Shape.prototype.perimeter");
  assert.ok(area, "ObjectMethod form (area(){}) must be indexed");
  assert.equal(area.receiver, "Shape");
  assert.ok(perimeter, "function-expression-as-property form must be indexed");
  assert.equal(perimeter.receiver, "Shape");
});

test("module.exports = ClassName connects the class identifier to the export surface", () => {
  const { node } = writeAndParse(`
    function Logger() {}
    Logger.prototype.log = function (msg) { console.log(msg); };
    module.exports = Logger;
  `);
  assert.ok(node.exports.includes("Logger"));
});

test("exports.name = value still works alongside prototype methods", () => {
  const { node } = writeAndParse(`
    function Util() {}
    Util.prototype.helper = function () { return 1; };
    exports.Util = Util;
  `);
  assert.ok(node.exports.includes("Util"));
  assert.ok(node.functions.some((f) => f.name === "Util.prototype.helper"));
});

test("this.method() calls between prototype methods resolve as local-receiver graph edges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-proto-graph-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "animal.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "animal.js"), `
    function Animal(name) { this.name = name; }
    Animal.prototype.speak = function () { return this.describe() + " speaks."; };
    Animal.prototype.describe = function () { return this.name; };
    module.exports = Animal;
  `);
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  const speakId = "animal.js#Animal.prototype.speak";
  const describeId = "animal.js#Animal.prototype.describe";
  const edge = graph.callEdges.find((e) => e.from === speakId && e.to === describeId);
  assert.ok(edge, `expected a resolved call edge from speak -> describe; got: ${JSON.stringify(graph.callEdges.filter((e) => e.from === speakId))}`);
  assert.equal(edge.resolution, "local-receiver");
});

test("prototype methods are connected to their file's workflow (reachable from the entry point)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-proto-workflow-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "index.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "animal.js"), `
    function Animal(name) { this.name = name; }
    Animal.prototype.speak = function () { return this.name + " speaks."; };
    module.exports = Animal;
  `);
  fs.writeFileSync(path.join(dir, "index.js"), `
    const Animal = require("./animal.js");
    const a = new Animal("Rex");
    console.log(a.speak());
  `);
  const parsed = parseProject(dir);
  const graph = buildGraph(dir, parsed, loadPkg(dir));
  const workflow = graph.workflows.find((w) => w.files.includes("animal.js"));
  assert.ok(workflow, "animal.js must be part of a workflow reached from index.js's entry point");
  const animalFile = graph.workflows.flatMap((w) => w.files).includes("animal.js");
  assert.ok(animalFile);
});
