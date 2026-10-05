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
const MCP_ACCESS_KEY  = process.env.MCP_ACCESS_KEY;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_ACCOUNTS     = JSON.parse(process.env.IG_ACCOUNTS || "{}");
const IG_ACCOUNT_NAMES = Object.keys(IG_ACCOUNTS);
const GRAPH_URL       = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v26.0"}`;

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

// ─── Instagram Graph API ──────────────────────────────────────────────────────

function getIgAccount(name) {
  const account = IG_ACCOUNTS[name];
  if (!account) throw new Error(`Unknown Instagram account "${name}". Configured: ${IG_ACCOUNT_NAMES.join(", ") || "none"}`);
  if (!IG_ACCESS_TOKEN) throw new Error("IG_ACCESS_TOKEN is not set.");
  return account;
}

async function graph(method, path, params = {}) {
  const query = new URLSearchParams({ ...params, access_token: IG_ACCESS_TOKEN });
  const url = method === "GET" ? `${GRAPH_URL}${path}?${query}` : `${GRAPH_URL}${path}`;
  const resp = await fetch(url, method === "GET" ? {} : { method, body: query });
  const data = await resp.json();
  if (data.error) throw new Error(`Instagram API: ${data.error.message}`);
  return data;
}

/** Instagram processes reels asynchronously and rejects media_publish until the container is FINISHED. */
async function waitForContainer(containerId, timeoutMs = 10 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { status_code, status } = await graph("GET", `/${containerId}`, { fields: "status_code,status" });
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error(`Reel processing failed: ${status}`);
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error("Timed out waiting for Instagram to process the reel.");
}

function jsonResult(payload, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], ...(isError && { isError }) };
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

  const accountParam = z.string().default(IG_ACCOUNT_NAMES[0] || "thedrapingqueen")
    .describe(`Instagram account. Configured: ${IG_ACCOUNT_NAMES.join(", ") || "none"}`);

  server.tool(
    "instagram_check_shopping",
    "Check whether an Instagram account can tag products and list its catalogs.",
    { account: accountParam },
    async ({ account }) => {
      try {
        const { ig_user_id } = getIgAccount(account);
        const profile = await graph("GET", `/${ig_user_id}`, { fields: "username,shopping_product_tag_eligibility" });
        const catalogs = await graph("GET", `/${ig_user_id}/available_catalogs`);
        return jsonResult({ profile, catalogs: catalogs.data });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    "instagram_search_products",
    "Search an Instagram Shop catalog by product name or SKU. Returns only approved products (tags for unapproved products never appear on posts). Pass the product_id values to instagram_publish_reel_with_products.",
    {
      account: accountParam,
      query: z.string().describe("Product name or SKU, e.g. 'baroque swag'"),
    },
    async ({ account, query }) => {
      try {
        const { ig_user_id, catalog_id } = getIgAccount(account);
        const result = await graph("GET", `/${ig_user_id}/catalog_product_search`, { catalog_id, q: query });
        const products = result.data
          .filter((p) => p.review_status === "approved")
          .map((p) => ({ product_id: String(p.product_id), name: p.product_name, image_url: p.image_url }));
        return jsonResult({ count: products.length, products });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    "instagram_publish_reel_with_products",
    "Publish a Reel directly to Instagram with product tags and an optional custom cover image. Publishes IMMEDIATELY (no scheduling) and does not appear in Postiz. Instagram allows at most 25 product-tagged posts per account per 24h.",
    {
      account: accountParam,
      video_url: z.string().describe("Public .mp4 URL, e.g. a Postiz /uploads/ path from postiz_upload_from_url"),
      caption: z.string().max(2200).describe("Plain-text caption (not HTML)"),
      product_ids: z.array(z.string()).min(1).max(5).describe("product_id values from instagram_search_products"),
      cover_url: z.string().optional().describe("Public JPG/PNG cover image URL, ideally 1080x1920"),
      share_to_feed: z.boolean().default(true),
    },
    async ({ account, video_url, caption, product_ids, cover_url, share_to_feed = true }) => {
      try {
        const { ig_user_id } = getIgAccount(account);
        const container = await graph("POST", `/${ig_user_id}/media`, {
          media_type: "REELS",
          video_url,
          caption,
          share_to_feed: String(share_to_feed),
          product_tags: JSON.stringify(product_ids.map((product_id) => ({ product_id }))),
          ...(cover_url && { cover_url }),
        });
        await waitForContainer(container.id);
        const published = await graph("POST", `/${ig_user_id}/media_publish`, { creation_id: container.id });
        const media = await graph("GET", `/${published.id}`, { fields: "permalink" });
        return jsonResult({ success: true, account, media_id: published.id, permalink: media.permalink });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
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

function requireAccessKey(req, res, next) {
  if (!MCP_ACCESS_KEY) return next();
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (req.query.key === MCP_ACCESS_KEY || bearer === MCP_ACCESS_KEY) return next();
  res.status(401).json({ error: "Unauthorized" });
}
app.use(["/mcp", "/sse"], requireAccessKey);

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
