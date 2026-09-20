/**
 * viewServer.js — `mapd view --serve`. A tiny localhost-only HTTP server that
 * serves the HTML view AND backs an embedded chat panel, so you can ask Map'd
 * what's going on and what to work on right in the browser.
 *
 * The chat panel drives the EXACT same engine as `mapd chat` (createChatContext
 * + handleInput), but READ-ONLY: it will run the analysis/reporting commands and
 * answer grounded questions, and it refuses anything that writes to the project
 * (fix, approve/dismiss, shell commands, report-writing commands). Those still
 * require explicit local confirmation in the terminal. Binds to 127.0.0.1 only.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { createChatContext, handleInput } from "../chat/repl.js";
import { classifyIntent } from "../chat/intent.js";
import { recordTurn } from "./session.js";
import { buildViewModel, renderViewHtml } from "./view.js";

// Slash commands that only READ (no .mapd or source writes). Everything else is
// refused in the browser: baseline/check/docs/modernize/transcript write files;
// fix/approve/dismiss/dev-commands mutate or execute.
const READONLY_SLASH = new Set([
  "map", "status", "score", "ceiling", "test-gaps", "test-credit", "improve",
  "verify", "review", "findings", "evidence", "project", "diagnose", "solutions",
  "context", "resolution", "trace", "help", "clear",
]);

const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, "");

export async function answerReadOnly(text, ctx) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return 'Ask me something — e.g. "what should I work on", "what\'s the honest ceiling", "show test gaps", "explain finding <id>", "is the project passing".';
  const intent = classifyIntent(trimmed);
  if (["fix", "review-action", "dev-command", "watch"].includes(intent.type)) {
    return "That action changes the project (a fix, approval, or command), so it's disabled in the read-only browser view. Run it in the terminal with `mapd chat`.";
  }
  if (intent.type === "slash" && !READONLY_SLASH.has(intent.command.replace(/^\//, ""))) {
    return `\`${intent.command}\` writes to the project, so it's disabled here. Use it in \`mapd chat\`.`;
  }
  recordTurn(ctx.session, "user", trimmed);
  const reply = stripAnsi(await handleInput(trimmed, ctx));
  recordTurn(ctx.session, "assistant", reply);
  return reply;
}

export function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* best effort */ }
}

export function startViewServer(rootDir, { port = 0, open = true } = {}) {
  const ctx = createChatContext(rootDir);
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { "content-type": type }); res.end(body); };
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
      return send(200, "text/html; charset=utf-8", renderViewHtml(buildViewModel(rootDir), { serve: true }));
    }
    if (req.method === "GET" && req.url === "/api/model") {
      return send(200, "application/json", JSON.stringify(buildViewModel(rootDir)));
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 8000) req.destroy(); });
      req.on("end", async () => {
        let message = "";
        try { message = JSON.parse(body).message ?? ""; } catch { /* ignore */ }
        try {
          const reply = await answerReadOnly(String(message).slice(0, 2000), ctx);
          send(200, "application/json", JSON.stringify({ reply }));
        } catch (e) {
          send(200, "application/json", JSON.stringify({ reply: `Something went wrong answering that: ${e.message}` }));
        }
      });
      return;
    }
    send(404, "text/plain", "not found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      if (open) openBrowser(url);
      resolve({ server, url, port: server.address().port, providerAvailable: !!ctx.provider?.available?.() });
    });
  });
}
