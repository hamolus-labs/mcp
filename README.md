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

**Two vars. There are no secrets.**

| Variable | Purpose |
| -------- | ------- |
| `CORE_API_URL` | base URL of the core API, including `/api` |
| `MCP_INSTANCE_ID` | this server's id in the core, created in the console under **Environment → MCP** |

Everything else is **per-instance configuration in the core**: which colony the server
serves, whether it is enabled, whether it is read-only, which tool groups it offers,
and which collections get generated tools. Read it from
`GET /api/_mcp/config` at request time and change it from the console — no redeploy, no
secret to rotate.

Callers send a **per-user token** issued in the console as `Authorization: Bearer
<token>`. The core exchanges it for a short-lived scoped session, and each token can be
revoked on its own. Stored hashes only; the plaintext is shown once, at creation.

`MCP_INSTANCE_ID` is a credential rather than a label — anyone holding it can read this
server's configuration — so it is generated rather than chosen. `GET /` echoes it, plus
`mode: "console-managed"`, so a half-finished migration is visible.

Older deployments used `CORE_ADMIN_KEY`, `MCP_BEARER_TOKEN`, `MCP_READONLY`,
`MCP_TOOL_GROUPS`, `MCP_DYNAMIC_TOOLS` and `CORE_LAND`/`CORE_COLONY`. They still run on
the deprecated path, so nothing breaks on upgrade; set `MCP_INSTANCE_ID` and delete the
secrets when you are ready. `GET /` says `mode: "legacy"` and warns until you do.

Every tool also accepts `land`/`colony`, but the core refuses any scope outside the
instance's — an instance serves exactly one colony.

Each collection's `mcp` key (`read` — the default, `write`, or `hide`) decides what
this server may do with it, across tools, generated tools and resources alike. A
read-only instance does not register write tools at all, so they never appear in
`tools/list`.

## Reference

- [MCP server](docs/mcp.md)

## What's new

Resources, prompts, generated per-collection tools, and the per-collection
`mcp` mode — `read` (the default), `write` or `hide`.

See the [changelog](https://github.com/hamolus-labs/hamolus/blob/main/CHANGELOG.md#0210--2026-09-30) for every release.

## License

MIT
