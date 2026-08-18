# SEO Toolkit MCP

MCP server for Ahrefs free-tool data: backlinks, keyword research, keyword difficulty, and traffic estimation.

## Requirements

- Bun 1.3 or newer
- A [CapSolver](https://capsolver.com) API key

## Setup

```bash
bun install
CAPSOLVER_API_KEY="your-capsolver-api-key" bun run build
```

Run the server:

```bash
CAPSOLVER_API_KEY="your-capsolver-api-key" bun run src/index.ts
```

## Usage with MCP clients

### Installed from npm

```json
{
  "mcpServers": {
    "SEO Toolkit MCP": {
      "command": "bunx",
      "args": ["@qexle/seo-mcp"],
      "env": {
        "CAPSOLVER_API_KEY": "your-capsolver-api-key"
      }
    }
  }
}
```

### Local build

```json
{
  "mcpServers": {
    "SEO Toolkit MCP": {
      "command": "bun",
      "args": ["/absolute/path/to/seo-mcp/dist/index.js"],
      "env": {
        "CAPSOLVER_API_KEY": "your-capsolver-api-key"
      }
    }
  }
}
```

## Tools

- `get_backlinks_list(domain)`
- `keyword_generator(keyword, country = "us", search_engine = "Google")`
- `get_traffic(domain_or_url, country = "None", mode = "subdomains")`
- `keyword_difficulty(keyword, country = "us")`

Tools cache signatures to `signature_cache.json` in the working directory.

## Development

```bash
bun test          # fails if coverage drops below 100%
bun run typecheck
bunx oxlint .
bun run build
```

## License

MIT. See [LICENSE](./LICENSE).
