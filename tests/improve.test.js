/**
 * tests/improve.test.js — `mapd improve` must produce a ranked, budget/risk-bounded
 * plan whose lifts are MEASURED (positive), whose combined projection beats the
 * current score, and which never omits the "do not do" honesty guardrails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planImprovements, parseBudget, renderAgentPack } from "../src/core/improve.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapd-imp-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", main: "entry.js", type: "module" }));
  fs.writeFileSync(path.join(dir, "entry.js"),
    `import { a } from "./a.js";\nimport { b } from "./b.js";\nimport { c } from "./c.js";\nexport function run(){ return a()+b()+c(); }\nrun();\n`);
  fs.writeFileSync(path.join(dir, "a.js"), `export function a(){ return 1; }\n`);
  fs.writeFileSync(path.join(dir, "b.js"), `export function b(){ return 2; }\n`);
  fs.writeFileSync(path.join(dir, "c.js"), `export function c(){ return 3; }\n`);
  fs.mkdirSync(path.join(dir, "tests"));
  // padding: filename contains "a" region... use explicit padding for b.js
  fs.writeFileSync(path.join(dir, "tests", "b.test.js"), `const x=1; if(x!==1) throw new Error("x");\n`);
  return dir;
}

test("parseBudget understands hours, minutes, bare numbers, and missing", () => {
  assert.equal(parseBudget("2h"), 120);
  assert.equal(parseBudget("90m"), 90);
  assert.equal(parseBudget("45"), 45);
  assert.equal(parseBudget(undefined), Infinity);
});

test("plan is ranked by lift-per-effort with measured positive lifts", () => {
  const plan = planImprovements(fixture(), { risk: "low" });
  assert.ok(plan.tasks.length > 0, "should propose work");
  for (const t of plan.tasks) assert.ok(t.lift > 0, "every task has a measured positive lift");
  for (let i = 1; i < plan.tasks.length; i++) {
    const prev = plan.tasks[i - 1], cur = plan.tasks[i];
    assert.ok((prev.lift / prev.effortMin) >= (cur.lift / cur.effortMin) - 1e-9, "tasks are ordered by lift/effort");
  }
});

test("combined projection beats current confidence", () => {
  const plan = planImprovements(fixture(), { risk: "low" });
  assert.ok(plan.projected > plan.current, `projected ${plan.projected} should beat current ${plan.current}`);
  assert.ok(plan.totalLift > 0);
});

test("risk filter and budget cap are enforced", () => {
  const low = planImprovements(fixture(), { risk: "low" });
  for (const t of low.tasks) assert.equal(t.risk, "low", "low risk plan contains only low-risk tasks");

  const tiny = planImprovements(fixture(), { risk: "low", budget: "10m" });
  assert.ok(tiny.effortMin <= 10, "selected effort must respect the budget");
  assert.ok(tiny.tasks.length <= low.tasks.length);
});

test("agent-pack renders a paste-ready pack with files, risk, and the do-not-fake line", () => {
  const pack = renderAgentPack(planImprovements(fixture(), { risk: "low" }));
  assert.match(pack, /# Map'd improvement task pack/);
  assert.match(pack, /Do NOT fake/);
  assert.match(pack, /Verify when done/);
  assert.match(pack, /target/);
});

test("plan always carries honesty guardrails and a verify recipe", () => {
  const plan = planImprovements(fixture(), { risk: "low" });
  assert.ok(plan.doNotDo.length > 0, "must tell you what not to fake");
  assert.ok(plan.doNotDo.some((d) => /empty or import-only/.test(d)), "must warn against padding");
  assert.ok(plan.verify.some((v) => /score delta|check/.test(v)), "must say how to verify");
});
