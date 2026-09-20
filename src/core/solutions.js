/**
 * solutions.js — `mapd solutions`: the "bigger picture" layer above raw
 * findings. Two layers, deliberately separated:
 *
 * Layer 1 (buildSolutions, this file's core) is 100% deterministic and
 * always complete on its own, with zero LLM/network involvement:
 *   - clusters related findings by real file overlap (Union-Find) — so
 *     e.g. 5 separate duplicate-function findings that all touch the same
 *     files surface as ONE problem, not 5 unrelated line items
 *   - scores each cluster's blast radius from the actual import graph and
 *     workflow membership already computed by graph.js — how many
 *     workflows does this touch, how depended-upon are its files
 *   - ranks clusters by (finding severity/priority) × blast radius
 * Every fact in the output — file, workflow ID, suggestion — traces back to
 * a real finding already in the review queue. Nothing here is invented.
 *
 * Layer 2 (narrateSolutions) is optional and additive: if a provider is
 * configured, it asks the LLM to write a short "why this matters" paragraph
 * per cluster — but it may ONLY rephrase/argue from the facts layer 1
 * already produced. The response is mechanically verified afterward (every
 * file path and workflow ID the narrative mentions must already appear in
 * that cluster's own data); a narrative that fails verification is thrown
 * away, never surfaced. Layer 1's output is always complete without layer 2.
 */

import path from "node:path";
import { buildScoredGraph } from "./intelligence.js";
import { pending, loadQueue } from "./review.js";
import { loadFinding } from "./fix.js";
import { priorityOf, filesOf } from "./findingScoring.js";
import { checkReportFreshness } from "./staleness.js";
import { verifyGrounding } from "./grounding.js";

/** Iterative Union-Find (path compression, union by nothing fancy — inputs are small). */
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) { const next = parent[x]; parent[x] = root; x = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  return { find, union };
}

/**
 * Groups findings that share at least one file. Dependency- and
 * architecture-tier findings are excluded from this step and always kept
 * standalone: they're already whole-repo-scope facts by construction
 * (orphan-cluster, cjs-in-esm-project, monolithic-workflow, etc. — see
 * modernize.js's own tiering), so letting them act as file-overlap bridges
 * would merge unrelated local findings into one meaningless mega-cluster
 * just because both happen to touch a widely-shared file.
 */
function clusterByFileOverlap(resolved) {
  const { find, union } = makeUnionFind(resolved.length);
  const fileToIndices = new Map();
  resolved.forEach((r, i) => {
    for (const f of r.files) {
      if (!fileToIndices.has(f)) fileToIndices.set(f, []);
      fileToIndices.get(f).push(i);
    }
  });
  for (const indices of fileToIndices.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }
  const groups = new Map();
  resolved.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });
  return [...groups.values()];
}

/**
 * Blast radius of a file set: how many of the project's own workflows
 * include at least one of these files, and how depended-upon the
 * most-imported file among them is (import in-degree) — both read directly
 * off graph.js's already-computed workflow membership and import edges,
 * never estimated.
 */
function computeBlastRadius(graph, files) {
  const fileSet = new Set(files);
  const workflowsTouched = graph.workflows.filter((w) => w.files.some((f) => fileSet.has(f))).map((w) => w.id);
  const inDegree = new Map();
  for (const e of graph.importEdges) if (e.to) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  const maxImportInDegree = files.reduce((max, f) => Math.max(max, inDegree.get(f) ?? 0), 0);
  const totalWorkflows = Math.max(1, graph.workflows.length);
  const totalFiles = Math.max(1, graph.files.length);
  const workflowShare = workflowsTouched.length / totalWorkflows;
  const score = Math.min(1, workflowShare + maxImportInDegree / totalFiles);
  return {
    workflowsTouched,
    workflowShare: Number(workflowShare.toFixed(3)),
    maxImportInDegree,
    score: Number(score.toFixed(3)),
    method: "blast-radius-v1 (share of all workflows touched + max import in-degree, both normalized by repo size)",
  };
}

/** Layer 1: fully deterministic, no provider required. */
export function buildSolutions(rootDir, { top = 5 } = {}) {
  const abs = path.resolve(rootDir);
  const graph = buildScoredGraph(abs);
  const freshness = checkReportFreshness(abs);
  const staleSet = new Set(freshness.staleReports);
  const allItems = pending(loadQueue(abs)).filter((i) => i.source === "check" || i.source.startsWith("modernize-"));
  // Same enforcement as handoff.js: findings from a stale report are excluded
  // from clustering/ranking entirely (with the count disclosed), never mixed
  // into an action plan with only a banner asking the reader to discount them.
  const items = allItems.filter((i) => !staleSet.has(path.basename(i.file)));
  const excludedStaleCount = allItems.length - items.length;

  const resolved = items
    .map((item) => {
      const loaded = loadFinding(abs, item.id);
      if (!loaded) return null;
      const finding = loaded.finding;
      return { item, finding, tier: finding.tier ?? "check", files: filesOf(finding), priority: priorityOf(finding, item) };
    })
    .filter(Boolean);

  const standalone = resolved.filter((r) => r.tier === "dependency" || r.tier === "architecture");
  const clusterable = resolved.filter((r) => r.tier !== "dependency" && r.tier !== "architecture");
  const groups = [...standalone.map((r) => [r]), ...clusterByFileOverlap(clusterable)];

  const solutions = groups
    .map((group) => {
      const files = [...new Set(group.flatMap((r) => r.files))];
      const blastRadius = computeBlastRadius(graph, files);
      const memberPriority = Math.max(...group.map((r) => r.priority));
      const priority = Number((memberPriority * (0.5 + 0.5 * blastRadius.score)).toFixed(3));
      return {
        clusterId: group.map((r) => r.item.id).sort().join("+"),
        kinds: [...new Set(group.map((r) => r.finding.kind ?? r.finding.rule))],
        files,
        priority,
        blastRadius,
        members: group.map((r) => ({
          id: r.item.id, source: r.item.source, kind: r.finding.kind ?? r.finding.rule,
          severity: r.finding.severity ?? null, detail: r.finding.detail,
          files: r.files, suggestion: r.finding.suggestion ?? null,
        })),
        narrative: null,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, top);

  return {
    root: abs, fileCount: graph.stats.fileCount, workflowCount: graph.workflows.length,
    freshness, excludedStaleCount, solutions,
  };
}

const NARRATE_SYSTEM_PROMPT =
  "You will receive a JSON array of \"clusters\" — groups of related, already-verified static-analysis " +
  "findings from a tool called Map'd, each with real file paths, workflow IDs, and numeric scores.\n\n" +
  "Your ONLY job: for each cluster, write a short \"whyItMatters\" paragraph (2-4 sentences) explaining " +
  "its priority, using ONLY the facts given.\n\n" +
  "Strict rules:\n" +
  "- Never mention a file path that is not in that cluster's \"files\" list.\n" +
  "- Never mention a workflow ID that is not in that cluster's \"blastRadius.workflowsTouched\" list.\n" +
  "- Never state a suggestion beyond what is already in that cluster's members' \"suggestion\" fields — " +
  "you may combine or rephrase them, never invent a new one.\n" +
  "- Never state a number that is not already present in the cluster's data.\n" +
  "- If you are not confident you can do this without adding anything new, write \"\" for that cluster instead of guessing.\n\n" +
  "Respond with ONLY a JSON array, same length and order as the input, each element: {\"whyItMatters\": \"...\"}";

/**
 * Layer 2: optional. `data` is buildSolutions' output. Every candidate
 * narrative is mechanically checked against that same cluster's real data
 * before being attached — a narrative that cites a file or workflow ID not
 * already present in the cluster is discarded, never surfaced, regardless
 * of how plausible the prose reads. Fails safe to the unmodified layer-1
 * data on no provider, no response, malformed JSON, or a shape mismatch.
 */
export async function narrateSolutions(data, provider) {
  if (!provider?.available?.() || !data.solutions.length) return data;

  const payload = data.solutions.map((s) => ({
    kinds: s.kinds, files: s.files, priority: s.priority, blastRadius: s.blastRadius,
    members: s.members.map((m) => ({ kind: m.kind, severity: m.severity, detail: m.detail, suggestion: m.suggestion })),
  }));

  let raw;
  try { raw = await provider.complete(NARRATE_SYSTEM_PROMPT, JSON.stringify(payload), 2000); }
  catch { return data; }
  if (!raw) return data;

  let parsed;
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch { return data; }
  if (!Array.isArray(parsed) || parsed.length !== data.solutions.length) return data;

  const solutions = data.solutions.map((s, i) => {
    const text = parsed[i]?.whyItMatters;
    if (typeof text !== "string" || !text.trim()) return s;

    const check = verifyGrounding(text, { files: s.files, workflowIds: s.blastRadius.workflowsTouched });
    if (!check.grounded) {
      const v = check.violations[0];
      return { ...s, narrative: null, narrativeSkippedReason: `mentioned a ${v.type} ("${v.value}") not in this cluster's data` };
    }

    return { ...s, narrative: text.trim() };
  });
  return { ...data, solutions };
}

/** Renders buildSolutions' (optionally narrateSolutions'd) data as plain text. */
export function renderSolutions(data) {
  if (!data.solutions.length) {
    // "no open findings" and "every finding was excluded as stale" are very
    // different situations — say which one actually happened.
    return data.excludedStaleCount > 0
      ? `All ${data.excludedStaleCount} open finding(s) come from stale report(s) (${data.freshness.staleReports.join(", ")}) that ` +
        "predate a more recent source change — nothing current to synthesize. Re-run `mapd check`/`mapd modernize` first."
      : "No open findings — nothing to synthesize. Run `mapd check` / `mapd modernize` first.";
  }

  const lines = [];
  if (data.freshness?.stale && data.excludedStaleCount > 0) {
    lines.push(`⚠ STALE REPORTS EXCLUDED: ${data.freshness.staleReports.join(", ")} predate a more recent source change. ` +
      `${data.excludedStaleCount} finding(s) sourced from them were EXCLUDED from the solutions below (not just flagged). ` +
      "Re-run `mapd check`/`mapd modernize` to refresh and include them.");
    lines.push("");
  } else if (data.freshness?.stale) {
    // stale report(s) exist but contributed no open findings — one quiet line,
    // not a warning banner about zero exclusions
    lines.push(`note: ${data.freshness.staleReports.join(", ")} predate a more recent source change but contributed no open findings; re-run \`mapd check\`/\`mapd modernize\` to refresh.`);
    lines.push("");
  }
  lines.push(`Map'd solutions — ${data.fileCount} files, ${data.workflowCount} workflows`, "");
  data.solutions.forEach((s, i) => {
    const header = `${i + 1}. ${s.kinds.join(" + ").toUpperCase()}  (priority ${s.priority}, ${s.members.length} finding(s))`;
    lines.push(header);
    lines.push("-".repeat(header.length));
    lines.push(`Blast radius: touches ${s.blastRadius.workflowsTouched.length} workflow(s) ` +
      `(${(s.blastRadius.workflowShare * 100).toFixed(0)}% of all workflows), ` +
      `most-depended-upon file has ${s.blastRadius.maxImportInDegree} importer(s).`);
    if (s.blastRadius.workflowsTouched.length) lines.push(`Workflows: ${s.blastRadius.workflowsTouched.join(", ")}`);
    lines.push(`Files: ${s.files.join(", ")}`);
    if (s.narrative) lines.push(`Why it matters: ${s.narrative}`);
    else if (s.narrativeSkippedReason) lines.push(`(narrative skipped — ${s.narrativeSkippedReason})`);
    for (const m of s.members) lines.push(`  - [${m.id}] ${m.kind}${m.severity ? ` (${m.severity})` : ""}: ${m.detail}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
