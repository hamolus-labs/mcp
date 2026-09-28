# @hamolus/mcp

<!-- deploy:begin -->
<!-- Written by scripts/export-deploy-repo.mjs — do not edit by hand. -->

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hamolus-labs/mcp)

That button forks this repository into your own GitHub account, names the Worker,
provisions the KV namespace, D1 database and R2 bucket on your account, and wires
up Workers Builds so later pushes deploy themselves.

**Point it at your core first.** `CORE_API_URL` ships as
`http://localhost:8787/api`, so a fresh deploy answers every tool call with a
connection error until you set it:

```bash
wrangler secret put CORE_ADMIN_KEY
# and set the CORE_API_URL var to https://<your-core>.workers.dev/api
```
<!-- deploy:end -->

Model Context Protocol server for Hamolus. It exposes the core API — collections,
records, media, files, panels, lands — as MCP **tools**, **resources** and
**prompts** over Streamable HTTP on Cloudflare Workers, so an AI agent can read
and write your data directly.

## Use it

```bash
hamolus add mcp        # copy this server into ./mcp
```

## Configure

| Variable | Purpose |
| -------- | ------- |
| `CORE_API_URL` | base URL of the core API |
| `CORE_API_TOKEN` | bearer token; omit to mint one from `CORE_ADMIN_KEY` |
| `CORE_ADMIN_KEY` | admin key used to mint a token when no token is set |
| `CORE_LAND` / `CORE_COLONY` | default scope for every request, and the scope resources resolve against |
| `MCP_BEARER_TOKEN` | when set, clients must send `Authorization: Bearer …` |
| `MCP_READONLY` | `true` refuses every write tool |
| `MCP_TOOL_GROUPS` | which tool groups to expose; default `records,media,meta`, `all` adds `admin` |
| `MCP_DYNAMIC_TOOLS` | `all` or a list of collection names to generate per-collection tools for |
| `MCP_DYNAMIC_MAX` | cap on generated collections, default 10 |

Every tool also accepts `land`/`colony` to override the default scope per call.

Each collection's `mcp` key (`read` — the default, `write`, or `hide`) decides what
this server may do with it, across tools, generated tools and resources alike.

## Reference

- [MCP server](docs/mcp.md)

## What's new

Resources, prompts, generated per-collection tools, and the per-collection
`mcp` mode — `read` (the default), `write` or `hide`.

See the [changelog](https://github.com/hamolus-labs/hamolus/blob/main/CHANGELOG.md#022--2026-09-28) for every release.

## License

MIT
