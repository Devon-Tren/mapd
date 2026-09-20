/**
 * commandRunner.js — safe dev-command execution for chat/mcp. Never executes
 * arbitrary shell text: every call is (cmd, args[]) through execFile/spawn
 * (argument arrays, no shell interpolation), classified through
 * core/policy.js before it's allowed to run at all, with a controlled cwd,
 * a timeout, an output-character cap, and secret redaction on the way out.
 *
 * Long-running ("networked") commands (e.g. a dev server) are tracked in
 * `activeChildren` so `mapd chat end` can terminate them before the chat
 * process exits — nothing spawned by a chat session is left running after
 * the session ends.
 */

import { execFile, spawn } from "node:child_process";
import { classifyCommand, isPermitted } from "../core/policy.js";
import { redactSecrets } from "../core/security.js";

const activeChildren = new Set();

export function getActiveChildren() { return activeChildren; }

export function killActiveChildren() {
  for (const child of activeChildren) {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  activeChildren.clear();
}

/**
 * Runs a classified, policy-checked command. Returns:
 *   { ok:false, denied:true, reason }                      — refused outright
 *   { ok, classification, exitCode, stdout, stderr }         — completed
 *   { ok:true, classification:"networked", longRunning:true, pid } — dev server started
 */
export async function runCommand(cmd, args, { cwd, config = {}, approved = false, timeoutMs = 120_000, maxOutputChars } = {}) {
  const { classification, allowed, reason } = classifyCommand(cmd, args);
  if (!allowed) return { ok: false, denied: true, reason };

  const { permitted, requiresApproval } = isPermitted(classification, config, { approved });
  if (!permitted) {
    return {
      ok: false, denied: true, classification, requiresApproval,
      reason: `'${cmd} ${args.join(" ")}' is classified as '${classification}' and requires explicit approval`,
    };
  }

  const outCap = maxOutputChars ?? config.chat?.maxCommandOutputCharacters ?? 30_000;

  if (classification === "networked") {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      activeChildren.add(child);
      let out = "";
      child.stdout?.on("data", (d) => { out += d; });
      child.stderr?.on("data", (d) => { out += d; });
      child.on("exit", () => activeChildren.delete(child));
      child.on("error", () => activeChildren.delete(child));
      setTimeout(() => resolve({
        ok: true, classification, longRunning: true, pid: child.pid,
        initialOutput: redactSecrets(out.slice(0, outCap)),
      }), 300);
    });
  }

  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      activeChildren.delete(child);
      resolve({
        ok: !err, classification,
        exitCode: err?.code ?? 0,
        stdout: redactSecrets((stdout ?? "").toString().slice(0, outCap)),
        stderr: redactSecrets((stderr ?? "").toString().slice(0, outCap)),
        timedOut: !!(err?.killed && err?.signal === "SIGTERM"),
      });
    });
    activeChildren.add(child);
  });
}
