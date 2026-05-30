import express from "express";
import fetch from "node-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

/**
 * Converts any Google Drive sharing URL into a direct download URL.
 * Passes non-Drive URLs through unchanged.
 */
function toDirectUrl(input) {
  // Handle: https://drive.google.com/file/d/FILE_ID/view?...
  const viewMatch = input.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (viewMatch) {
    return `https://drive.google.com/uc?export=download&id=${viewMatch[1]}`;
  }

  // Handle: https://drive.google.com/open?id=FILE_ID
  const openMatch = input.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (openMatch) {
    return `https://drive.google.com/uc?export=download&id=${openMatch[1]}`;
  }

  // Handle: bare file ID (no URL)
  if (/^[a-zA-Z0-9_-]{25,}$/.test(input.trim())) {
    return `https://drive.google.com/uc?export=download&id=${input.trim()}`;
  }

  // Already a direct URL — pass through
  return input;
}

/**
 * Calls the Postiz upload-from-url endpoint and returns { id, path }.
 */
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

  if (!data.path) {
    throw new Error(`Postiz returned unexpected response: ${JSON.stringify(data)}`);
  }

  return data; // { id, path }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const app = express();

// Health check
app.get("/health", (_, res) => res.json({ status: "ok", service: "postiz-media-mcp" }));

// SSE transport map — one per connected client
const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  const server = buildMcpServer();
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }

  await transport.handlePostMessage(req, res);
});

// ─── MCP Tool Definitions ─────────────────────────────────────────────────────
function buildMcpServer() {
  const server = new McpServer({
    name: "postiz-media-mcp",
    version: "1.0.0",
  });

  // Tool 1 — upload from URL (Google Drive or any direct URL)
  server.tool(
    "postiz_upload_from_url",
    "Upload a media file (image or video) to Postiz from a URL. Accepts Google Drive share links, Google Drive file IDs, or any direct download URL. Returns the hosted Postiz URL ready to use in schedule calls.",
    {
      url: z.string().describe(
        "Google Drive share link, Google Drive file ID, or any direct media URL (jpg, png, mp4, etc.)"
      ),
    },
    async ({ url }) => {
      try {
        const directUrl = toDirectUrl(url);
        const result = await uploadToPostiz(directUrl);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                id: result.id,
                path: result.path,
                message: `✅ Uploaded successfully. Use this path in schedule calls: ${result.path}`,
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: err.message,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool 2 — bulk upload multiple files at once
  server.tool(
    "postiz_bulk_upload",
    "Upload multiple media files to Postiz in one call. Pass an array of Google Drive links or direct URLs. Returns all hosted Postiz URLs in order.",
    {
      urls: z.array(z.string()).describe(
        "Array of Google Drive share links, file IDs, or direct media URLs to upload"
      ),
    },
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

      const successCount = results.filter(r => r.success).length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: `${successCount}/${urls.length} uploaded successfully`,
              results,
            }, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Postiz Media MCP running on port ${PORT}`);
  console.log(`   SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`   Postiz base:  ${POSTIZ_BASE_URL}`);
});
