# web-render-mcp

An MCP server for fetching and parsing webpages via [Flaresolverr](https://github.com/FlareSolverr/FlareSolverr). Handles Cloudflare challenges automatically.

## Tools

| Tool | Description |
|------|-------------|
| `render_webpage` | Fetches a page and returns Markdown |
| `extract_elements` | Extracts elements matching a CSS selector |

## Quick Start (Docker)

```bash
docker compose up -d
```

MCP endpoint: `http://localhost:3000/mcp`

### Rebuilding after code changes

```bash
docker compose up -d --build --force-recreate web-render-mcp
```

This rebuilds the image from source and restarts only the `web-render-mcp` container, leaving Flaresolverr untouched.

### MCP config

```json
{
  "mcpServers": {
    "web-render": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Local Setup (stdio)

Requires a running Flaresolverr instance.

```bash
npm install
npm run build
```

```json
{
  "mcpServers": {
    "web-render": {
      "command": "node",
      "args": ["/absolute/path/to/web-mcp/build/index.js"],
      "env": {
        "FLARESOLVERR_URL": "http://localhost:8191"
      }
    }
  }
}
```

### Running Flaresolverr standalone

```bash
docker run -d \
  --name flaresolverr \
  -p 8191:8191 \
  -e LOG_LEVEL=info \
  --restart unless-stopped \
  ghcr.io/flaresolverr/flaresolverr:latest
```

## Transports

Controlled by the `TRANSPORT` env var:

| Value | Protocol | Default |
|-------|----------|---------|
| `stdio` | Standard I/O | Yes |
| `http` | Streamable HTTP on `PORT` (default 3000) | No |

The HTTP transport exposes:
- `POST /mcp` — initialize session / send requests
- `GET /mcp` — SSE stream for a session
- `DELETE /mcp` — close a session
- `GET /health` — health check

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `PORT` | `3000` | HTTP server port (only when `TRANSPORT=http`) |
| `FLARESOLVERR_URL` | `http://localhost:8191` | Flaresolverr endpoint |
| `DEBUG` | `false` | Enable debug logging (`true` or `1`) |

## Tool Reference

### `render_webpage`

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to fetch (protocol optional, defaults to `https://`) |

### `extract_elements`

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to fetch |
| `selector` | string | CSS selector |
| `extractType` | `text` \| `html` \| `attribute` | What to extract |
| `attribute` | string? | Attribute name (required for `extractType: attribute`) |
