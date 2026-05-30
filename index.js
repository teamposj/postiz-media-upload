import express from "express";
import fetch from "node-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────
const POSTIZ_BASE_URL = process.env.POSTIZ_BASE_URL;
const POSTIZ_API_KEY  = process.env.POSTIZ_API_KEY;
const PORT            = parseInt(process.env.PORT || "3000", 10);

if (!POSTIZ_BASE_URL || !POSTIZ_API_KEY) {
  console.error("❌ Missing env vars: POSTIZ_BASE_URL and POSTIZ_API_KEY are required.");
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toDirectUrl(input) {
  const viewMatch = input.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (viewMatch) return `https://drive.google.com/uc?export=download&id=${viewMatch[1]}`;

  const openMatch = input.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (openMatch) return `https://drive.google.com/uc?export=download&id=${openMatch[1]}`;

  if (/^[a-zA-Z0-9_-]{25,}$/.test(input.trim()))
    return `https://drive.google.com/uc?export=download&id=${input.trim()}`;

  return input;
}

async function uploadToPostiz(url) {
  const endpoint = `${POSTIZ_BASE_URL.replace(/\/$/, "")}/public/v1/upload-from-url`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": POSTIZ_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Postiz upload failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (!data.path) throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  return data;
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: "postiz-media-mcp", version: "1.0.0" });

  server.tool(
    "postiz_upload_from_url",
    "Upload a media file (image or video) to Postiz from a URL. Accepts Google Drive share links, Google Drive file IDs, or any direct download URL. Returns the hosted Postiz URL ready to use in schedule calls.",
    { url: z.string().describe("Google Drive share link, file ID, or any direct media URL") },
    async ({ url }) => {
      try {
        const directUrl = toDirectUrl(url);
        const result = await uploadToPostiz(directUrl);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, id: result.id, path: result.path, message: `✅ Use this in schedule calls: ${result.path}` }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }, null, 2) }], isError: true };
      }
    }
  );

  server.tool(
    "postiz_bulk_upload",
    "Upload multiple media files to Postiz in one call. Pass an array of Google Drive links or direct URLs. Returns all hosted Postiz URLs in order.",
    { urls: z.array(z.string()).describe("Array of Google Drive links or direct media URLs") },
    async ({ urls }) => {
      const results = [];
      for (const url of urls) {
        try {
          const directUrl = toDirectUrl(url);
          const result = await uploadToPostiz(directUrl);
          results.push({ url, success: true, id: result.id, path: result.path });
        } catch (err) {
          results.push({ url, success: false, error: err.message });
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ summary: `${results.filter(r => r.success).length}/${urls.length} uploaded`, results }, null, 2),
        }],
      };
    }
  );

  return server;
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_, res) => res.json({ status: "ok", service: "postiz-media-mcp" }));

// ─── Streamable HTTP (for Claude.ai connectors) ───────────────────────────────
const httpSessions = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  let transport;
  if (sessionId && httpSessions.has(sessionId)) {
    transport = httpSessions.get(sessionId);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => httpSessions.set(id, transport) });
    transport.onclose = () => { if (transport.sessionId) httpSessions.delete(transport.sessionId); };
    const server = buildMcpServer();
    await server.connect(transport);
  } else {
    return res.status(400).json({ error: "Invalid session" });
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId && httpSessions.get(sessionId);
  if (!transport) return res.status(400).json({ error: "Invalid session" });
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId && httpSessions.get(sessionId);
  if (!transport) return res.status(400).json({ error: "Invalid session" });
  await transport.handleRequest(req, res);
});

// ─── Legacy SSE (fallback) ────────────────────────────────────────────────────
const sseTransports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", () => delete sseTransports[transport.sessionId]);
  const server = buildMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sseTransports[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Postiz Media MCP running on port ${PORT}`);
  console.log(`   StreamableHTTP: http://localhost:${PORT}/mcp`);
  console.log(`   SSE (legacy):   http://localhost:${PORT}/sse`);
  console.log(`   Postiz base:    ${POSTIZ_BASE_URL}`);
});
