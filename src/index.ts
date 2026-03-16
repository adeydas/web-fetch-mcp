#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const TRANSPORT = process.env.TRANSPORT || "stdio";
const PORT = parseInt(process.env.PORT || "3000", 10);
const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

function log(message: string, data?: Record<string, unknown>) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const extra = data ? " " + JSON.stringify(data) : "";
  console.error(`[${ts}] ${message}${extra}`);
}

// ---------------------------------------------------------------------------
// Flaresolverr
// ---------------------------------------------------------------------------

async function flaresolverrFetch(url: string): Promise<{ html: string; finalUrl: string }> {
  log("Calling flaresolverr", { url, endpoint: FLARESOLVERR_URL });
  const resp = await fetch(`${FLARESOLVERR_URL}/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 })
  });
  if (!resp.ok) throw new Error(`Flaresolverr returned HTTP ${resp.status}`);
  const data = await resp.json() as { status: string; message?: string; solution: { response: string; url: string } };
  if (data.status !== "ok") throw new Error(`Flaresolverr error: ${data.message}`);
  log("Flaresolverr succeeded", { finalUrl: data.solution.url });
  return { html: data.solution.response, finalUrl: data.solution.url };
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

interface PageContent {
  url: string;
  title: string;
  content: string;
  textContent: string;
  links: Array<{ text: string; href: string }>;
  images: Array<{ alt: string; src: string }>;
}

function parseHtml(html: string, finalUrl: string): PageContent {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();

  const links: Array<{ text: string; href: string }> = [];
  $("a").each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr("href") || "";
    if (text || href) links.push({ text, href });
  });

  const images: Array<{ alt: string; src: string }> = [];
  $("img").each((_, el) => {
    const alt = $(el).attr("alt") || "";
    const src = $(el).attr("src") || "";
    if (src) images.push({ alt, src });
  });

  // Try main content areas, fall back to body
  const mainContent =
    $("main").html() ||
    $("article").html() ||
    $("[role='main']").html() ||
    $(".content").html() ||
    $("#content").html() ||
    $("body").html() ||
    "";

  // Strip tags for clean text
  $("script, style, noscript").remove();
  const textContent = $("body").text().replace(/\s+/g, " ").trim();

  return {
    url: finalUrl,
    title,
    content: mainContent,
    textContent,
    links: links.slice(0, 50),
    images: images.slice(0, 20)
  };
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "web-render-mcp",
    version: "1.0.0"
  });

  // Tool: Render a webpage and return content
  server.tool(
    "render_webpage",
    {
      url: z.string().url().describe("The URL of the webpage to render"),
      format: z.enum(["text", "html", "json"]).optional().describe("Output format: 'text' (clean text), 'html' (raw HTML), or 'json' (structured data)")
    },
    async ({ url, format = "text" }) => {
      try {
        log("render_webpage called", { url, format });
        const { html, finalUrl } = await flaresolverrFetch(url);
        const page = parseHtml(html, finalUrl);

        let output: string;

        switch (format) {
          case "html":
            output = JSON.stringify({
              url: page.url,
              title: page.title,
              html: page.content
            }, null, 2);
            break;
          case "json":
            output = JSON.stringify({
              url: page.url,
              title: page.title,
              textContent: page.textContent.substring(0, 10000),
              links: page.links,
              images: page.images
            }, null, 2);
            break;
          case "text":
          default:
            output = `Title: ${page.title}\nURL: ${page.url}\n\nContent:\n${page.textContent.substring(0, 10000)}`;
            if (page.textContent.length > 10000) {
              output += "\n\n[Content truncated...]";
            }
            break;
        }

        return {
          content: [{ type: "text", text: output }]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error rendering webpage: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  // Tool: Extract specific elements from a webpage
  server.tool(
    "extract_elements",
    {
      url: z.string().url().describe("The URL of the webpage to extract elements from"),
      selector: z.string().describe("CSS selector for the elements to extract"),
      extractType: z.enum(["text", "html", "attribute"]).describe("What to extract: 'text' (inner text), 'html' (inner HTML), or 'attribute'"),
      attribute: z.string().optional().describe("Attribute name to extract (required when extractType is 'attribute')")
    },
    async ({ url, selector, extractType, attribute }) => {
      try {
        log("extract_elements called", { url, selector, extractType });
        const { html } = await flaresolverrFetch(url);
        const $ = cheerio.load(html);

        const results: string[] = [];
        $(selector).each((_, el) => {
          let value = "";
          switch (extractType) {
            case "text": value = $(el).text().trim(); break;
            case "html": value = $(el).html() || ""; break;
            case "attribute": value = attribute ? ($(el).attr(attribute) || "") : ""; break;
          }
          if (value) results.push(value);
        });

        return {
          content: [{
            type: "text",
            text: `Found ${results.length} elements matching "${selector}":\n\n${JSON.stringify(results, null, 2)}`
          }]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error extracting elements: ${errorMessage}` }],
          isError: true
        };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio
// ---------------------------------------------------------------------------

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Web Render MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (Streamable HTTP with session management)
// ---------------------------------------------------------------------------

async function startHttp() {
  const app = express();

  // Session store: maps session ID -> { transport, server }
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    log("POST /mcp", { sessionId, hasSession: sessionId ? sessions.has(sessionId) : false });

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    log("Creating new session");
    const mcpServer = createServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        log("Session initialized", { sid });
        sessions.set(sid, { transport, server: mcpServer });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      log("Session closed", { sid });
      if (sid) sessions.delete(sid);
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: "Invalid or missing session. Send POST /mcp to initialize." });
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: "Invalid or missing session." });
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", sessions: sessions.size });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.error(`Web Render MCP server running on http://0.0.0.0:${PORT}/mcp`);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

async function main() {
  if (TRANSPORT === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch(console.error);
