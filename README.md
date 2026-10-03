# @hamolus/mcp

<!-- deploy:begin -->
<!-- Written by scripts/export-deploy-repo.mjs — do not edit by hand. -->

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hamolus-labs/mcp)

That button forks this repository into your own GitHub account, names the Worker,
provisions the KV namespace, D1 database and R2 bucket on your account, and wires
up Workers Builds so later pushes deploy themselves.

**Register it before anything works.** A fresh deploy has an empty `MCP_INSTANCE_ID`,
so it runs on the deprecated path with no credential and answers every tool call with
a configuration error. Create the instance in the core console under
**Environment → MCP**, then set its id as a var:

```bash
# Settings → Variables and Secrets, or:
# wrangler deploy --var MCP_INSTANCE_ID:<id> --var CORE_API_URL:https://<core>/api
```

Callers then present a per-user token from the console as `Authorization: Bearer …`.
`CORE_API_URL` ships as `http://localhost:8787/api`, so an online deploy has to be
pointed at your core.

**If every call fails with `CORE_UNAVAILABLE` and a `404`,** your account cannot reach
`workers.dev` from inside the Workers runtime — the URL is correct and editing it will
not help. Add a service binding to the core instead:

```jsonc
"services": [{ "binding": "CORE", "service": "<your-core-worker-name>" }]
```

It is in `wrangler.jsonc` commented out: leave it out for `wrangler dev`, where the
local core is a separate process on `http://localhost:8787`.
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

Every call to the core sends this server's release in `x-hamolus-mcp-version`, and the
core records it with a last-seen time. **Environment → MCP** then shows whether the
instance is actually deployed, which version it runs, and when it was last heard from —
an instance row exists from the moment it is created, so `enabled` alone cannot tell you
a worker is behind it. Nothing is configured to make this work, and an older worker that
sends no header is still served; it just records liveness without a version.

Older deployments used `CORE_ADMIN_KEY`, `MCP_BEARER_TOKEN`, `MCP_READONLY`,
`MCP_TOOL_GROUPS`, `MCP_DYNAMIC_TOOLS` and `CORE_LAND`/`CORE_COLONY`. They still run on
the deprecated path, so nothing breaks on upgrade; set `MCP_INSTANCE_ID` and delete the
secrets when you are ready. `GET /` says `mode: "legacy"` and warns until you do.

### Reaching the core when the URL does not work

`CORE_API_URL` is enough on most accounts. On some accounts it is not: a request from
the worker to a `workers.dev` address — **including the worker's own hostname** — comes
back as a `404` with no body at all, from the edge, before it ever reaches your code. The
symptom is a `CORE_UNAVAILABLE` error mentioning a config read, and the URL in it is
correct, so nothing you change about that URL will fix it.

Use a service binding to the core worker instead:

```jsonc
"services": [{ "binding": "CORE", "service": "your-core-worker-name" }]
```

The binding dispatches straight to that worker in the same account — no DNS, no TLS, no
public edge — and `CORE_API_URL` then only supplies the paths. With the binding present
every request goes through it. Leave it out for `pnpm dev`, where the local core is a
separate process on `http://localhost:8787` and a service binding would take precedence
over it.

Every failure to read the configuration now names the URL it called and says so when the
response carried no error body, so an unreachable core is distinguishable from a core
that rejected the instance id.

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
