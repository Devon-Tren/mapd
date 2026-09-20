#!/usr/bin/env node
/**
 * server.js — runnable GitHub App wrapper. Zero framework deps (node:http).
 *
 * Env:
 *   MAPD_WEBHOOK_SECRET  HMAC secret from the GitHub App settings.
 *                        REQUIRED in production; if unset the server starts in
 *                        --insecure-dev mode ONLY when that flag is passed,
 *                        otherwise it refuses to boot. No silent insecurity.
 *   PORT                 default 8787
 *
 * Endpoints:
 *   POST /webhook   GitHub events (push, pull_request) → adapters/github-app.js
 *   GET  /healthz   liveness probe
 *
 * Local test without GitHub:
 *   MAPD_WEBHOOK_SECRET=s node src/server.js
 *   BODY='{"zen":"ok"}'
 *   SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac s | cut -d' ' -f2)
 *   curl -s -X POST localhost:8787/webhook -H "x-github-event: ping" \
 *        -H "x-hub-signature-256: sha256=$SIG" -d "$BODY"
 */

import http from "node:http";
import crypto from "node:crypto";
import { handleWebhook } from "./adapters/github-app.js";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.MAPD_WEBHOOK_SECRET;
const insecureDev = process.argv.includes("--insecure-dev");

if (!SECRET && !insecureDev) {
  console.error("Refusing to start: MAPD_WEBHOOK_SECRET is unset. For local testing only, pass --insecure-dev.");
  process.exit(1);
}

function verifySignature(body, signatureHeader) {
  if (!SECRET) return insecureDev; // explicit dev mode only
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const a = Buffer.from(signatureHeader), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && req.url === "/healthz") return json(200, { ok: true, service: "mapd-github-app" });
  if (req.method !== "POST" || req.url !== "/webhook") return json(404, { error: "not found" });

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 5 * 1024 * 1024) { req.destroy(); return; } // 5MB cap
    chunks.push(c);
  });
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (!verifySignature(body, req.headers["x-hub-signature-256"])) {
      return json(401, { error: "invalid signature" });
    }
    const event = req.headers["x-github-event"];
    if (event === "ping") return json(200, { pong: true });

    let payload;
    try { payload = JSON.parse(body); } catch { return json(400, { error: "invalid JSON" }); }

    try {
      const result = await handleWebhook(event, payload);
      return json(200, { received: event, result: result ?? { action: "ignored" } });
    } catch (e) {
      console.error(`[mapd] ${event} handler error:`, e.message);
      return json(500, { error: "handler failure", detail: e.message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`mapd github-app listening on :${PORT} (${SECRET ? "signature verification ON" : "INSECURE DEV MODE"})`);
});
