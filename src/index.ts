#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import TurndownService from "turndown";
import { createRequire } from "module";
const { gfm } = createRequire(import.meta.url)("turndown-plugin-gfm") as { gfm: TurndownService.Plugin };

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
  markdown: string;
}

const td = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced"
});
td.use(gfm);

function parseHtml(html: string, finalUrl: string): PageContent {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();

  // Strip noise before capturing anything
  $("script, style, noscript, head").remove();

  // Try main content areas, fall back to body
  const mainHtml =
    $("main").html() ||
    $("article").html() ||
    $("[role='main']").html() ||
    $(".content").html() ||
    $("#content").html() ||
    $("body").html() ||
    "";

  const markdown = td.turndown(mainHtml);

  return { url: finalUrl, title, markdown };
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "web-render-mcp",
    version: "1.0.0"
  });

  // Tool: Render a webpage and return content as Markdown
  server.tool(
    "render_webpage",
    {
      url: z.string().url().describe("The URL of the webpage to render")
    },
    async ({ url }) => {
      try {
        log("render_webpage called", { url });
        const { html, finalUrl } = await flaresolverrFetch(url);
        const page = parseHtml(html, finalUrl);

        let output = `# ${page.title}\n\n${page.markdown.substring(0, 15000)}`;
        if (page.markdown.length > 15000) {
          output += "\n\n[Content truncated...]";
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
