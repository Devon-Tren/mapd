/**
 * server.js — `mapd mcp`: a local MCP server over stdio, exposing Map'd's
 * project-understanding and verification layer to any MCP-compatible agent
 * (Claude Code, Cursor, MITRI, ...). No GitHub required; works over stdio
 * against a local project directory.
 */

import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolHandlers } from "./tools.js";

const pkgVersion = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function createMcpServer() {
  const tools = createToolHandlers();
  const server = new Server({ name: "mapd", version: pkgVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, def]) => ({
      name, description: def.description, inputSchema: def.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = tools[name];
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, denied: true, reason: `Unknown tool: ${name}` }) }] };
    }
    try {
      const result = await tool.handler(args);
      return { isError: result.ok === false, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, denied: true, reason: e.message }) }] };
    }
  });

  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
