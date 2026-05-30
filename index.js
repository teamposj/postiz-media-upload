import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
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

function extractDriveId(input) {
  const viewMatch = input.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (viewMatch) return viewMatch[1];

  const openMatch = input.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (openMatch) return openMatch[1];

  const ucMatch = input.match(/drive\.google\.com\/uc\?.*id=([^&]+)/);
  if (ucMatch) return ucMatch[1];

  if (/^[a-zA-Z0-9_-]{25,}$/.test(input.trim())) return input.trim();

  return null;
}

function toDownloadUrl(input) {
  const driveId = extractDriveId(input);
  if (driveId) return `https://drive.usercontent.google.com/download?id=${driveId}&export=download`;
  return input;
}

function getMimeType(fileType) {
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", mp4: "video/mp4" };
  return map[fileType.toLowerCase()] || "image/jpeg";
}

/**
 * Downloads a file from a URL and uploads it to Postiz as multipart.
 * This bypasses the extension validation bug in Postiz < v2.19.
 */
async function downloadAndUploadToPostiz(sourceUrl, fileType = "jpg") {
  const ext = fileType.toLowerCase().replace("jpeg", "jpg");
  const filename = `media.${ext}`;
  const mimeType = getMimeType(ext);

  // Step 1 — Download the file
  const downloadResp = await fetch(sourceUrl, { redirect: "follow" });
  if (!downloadResp.ok) throw new Error(`Failed to download file (${downloadResp.status}): ${sourceUrl}`);

  const buffer = await downloadResp.buffer();

  // Step 2 — Upload to Postiz as multipart
  const form = new FormData();
  form.append("file", buffer, { filename, contentType: mimeType });

  const endpoint = `${POSTIZ_BASE_URL.replace(/\/$/, "")}/public/v1/upload`;
  const uploadResp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": POSTIZ_API_KEY,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!uploadResp.ok) {
    const errorText = await uploadResp.text();
    throw new Error(`Postiz upload failed (${uploadResp.status}): ${errorText}`);
  }

  const data = await uploadResp.json();
  if (!data.path) throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  return data;
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({ name: "postiz-media-mcp", version: "1.0.0" });

  server.tool(
    "postiz_upload_from_url",
    "Upload a media file (image or video) to Postiz from a Google Drive link or any direct URL. Returns the hosted Postiz URL ready to use in schedule calls.",
    {
      url: z.string().describe("Google Drive share link, file ID, or any direct media URL"),
      file_type: z.enum(["jpg", "png", "gif", "mp4"]).default("jpg").describe("File type: jpg, png, gif, or mp4. Default is jpg."),
    },
    async ({ url, file_type = "jpg" }) => {
      try {
        const downloadUrl = toDownloadUrl(url);
        const result = await downloadAndUploadToPostiz(downloadUrl, file_type);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              id: result.id,
              path: result.path,
              message: `✅ Uploaded! Use this in schedule calls: ${result.path}`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "postiz_bulk_upload",
    "Upload multiple media files to Postiz in one call. Pass an array of objects with url and file_type. Returns all hosted Postiz URLs in order.",
    {
      files: z.array(z.object({
        url: z.string().describe("Google Drive share link or direct media URL"),
        file_type: z.enum(["jpg", "png", "gif", "mp4"]).default("jpg").describe("File type: jpg, png, gif, or mp4"),
      })).describe("Array of files to upload"),
    },
    async ({ files }) => {
      const results = [];
      for (const file of files) {
        try {
          const downloadUrl = toDownloadUrl(file.url);
          const result = await downloadAndUploadToPostiz(downloadUrl, file.file_type || "jpg");
          results.push({ url: file.url, success: true, id: result.id, path: result.path });
        } catch (err) {
          results.push({ url: file.url, success: false, error: err.message });
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: `${results.filter(r => r.success).length}/${files.length} uploaded successfully`,
            results,
          }, null, 2),
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

// ─── Streamable HTTP ──────────────────────────────────────────────────────────
const httpSessions = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && httpSessions.has(sessionId)) {
    transport = httpSessions.get(sessionId);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => httpSessions.set(id, transport),
    });
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

// ─── Legacy SSE ───────────────────────────────────────────────────────────────
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
  console.log(`   Postiz base:    ${POSTIZ_BASE_URL}`);
});
