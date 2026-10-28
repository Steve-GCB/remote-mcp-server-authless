import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({ name: "GCB MCP Test", version: "1.0.0" });
  server.registerTool("hello", {
    description: "Returns a greeting only. No external access or side effects.",
    inputSchema: { name: z.string().max(100).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name ?? "World"}!` }]
  }));
  return server;
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("GCB MCP Test: connect at /mcp", { status: 404 });
    }
    return createMcpHandler(createServer)(request, env, ctx);
  }
} satisfies ExportedHandler;
