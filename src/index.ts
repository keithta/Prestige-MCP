import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTaskTools } from "./tools/tasks.js";

function buildServer(): McpServer {
  const server = new McpServer({
    name: "prestige-agentic-mcp-server",
    version: "1.0.0",
  });

  registerTaskTools(server);

  return server;
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.error(`prestige-agentic-mcp-server listening on http://0.0.0.0:${port}/mcp`);
  });
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const transport = process.env.TRANSPORT || "http";
if (transport === "http") {
  runHTTP().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Server error:", error);
    process.exit(1);
  });
}
