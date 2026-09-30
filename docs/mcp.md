# MCP server (`packages/mcp`)

A stateless Cloudflare Worker that exposes the core API to MCP-capable clients
(e.g. opencode). It starts an `McpServer` and registers three things: **tools**
over the core's metadata, records and file libraries; **resources** that make the
same data URI-addressable; and **prompts** that hand the model a task rather than
a blank page.

Transport is **Streamable HTTP** on `POST /mcp` (stateless — every request
stands alone; no session, no progress/notification support).

A deployed server holds exactly **two** vars: `CORE_API_URL` and
`MCP_INSTANCE_ID`. Everything that decides what it may do — which colony it serves,
whether it may write, which tool groups it offers, and which collections have
generated tools — is read from the core at request time and changed from the console,
with no redeploy. The instance id is the only credential, and it is issued by the
console rather than guessed.

Callers send a **per-user token** issued in the console as
`Authorization: Bearer <token>`. The core exchanges it for a short-lived scoped
session; tokens are revocable one at a time and stored only as a hash.

## Why this shape

- **Stateless**: the Worker builds a fresh server + client per request via
  `createMcpHandler(() => createServer(env, core), { route: '/mcp' })`. Fine for
  tool-call only workloads (we never send notifications). The instance config and
  the token exchange are resolved *before* the handler is involved, because the SDK
  reports anything its factory throws as a bare `-32603` — resolving them outside
  keeps the core's own status and wording (`MCP_DISABLED`, `TOKEN_REVOKED`).
- **Generic tools by default**: collections are dynamic (the schema lives in the
  core), so the static surface takes a `collection`/`data` argument and you
  prefix with `get_collection` to learn the fields. Generated per-collection
  tools are available for the collections you name explicitly — see
  [Dynamic tools](#dynamic-tools).
- **Resources and prompts alongside tools**, not instead of them: a tool takes
  arguments and returns text the model must parse, a resource is a URI a client
  can attach or cache, a prompt is a starting point. The three overlap on
  purpose; each is the right shape for a different job.

## Tools (42 static, in four groups)

Every tool also accepts optional `land`/`colony` arguments that override the
server default `x-land`/`x-colony` (multi-scope cores only).

| Group | Tools | Notes |
| --- | --- | --- |
| `records` | `list_collections`, `get_collection`, `put_collection`, `delete_collection`, `list_records`, `get_record`, `create_record`, `update_record`, `delete_record`, `bulk_delete_records`, `get_collection_last_update` | `list_records` honours `search`, `locale`, `sortBy`/`sortDir`, a JSON `filter` map, and paging (`page`, `pageSize` ≤ 100); `bulk_delete_records` caps at 200 ids |
| `media` | `list_media`, `list_documents`, `list_attachments`, `get_asset`, `update_asset`, `delete_asset`, `upload_media`, `upload_file`, `get_media_taxonomy`, `update_media_taxonomy` | taxonomy filters + search; uploads take base64 `data` (≤ 10 MB) and the core's multipart field names |
| `meta` | `check_core`, `list_lands`, `list_colonies`, `get_land`, `get_colony`, `get_stats`, `get_settings`, `update_settings`, `get_localization`, `list_groups`, `get_group`, `put_group`, `delete_group`, `list_config`, `get_config`, `put_config`, `delete_config`, `list_plugin_values`, `get_plugin_value`, `put_plugin_value`, `delete_plugin_value` | `update_settings` is a shallow merge; `put_group` rejects cycles |
| `admin` | `get_current_user`, `list_users`, `create_user`, `update_user`, `delete_user`, `list_privileges`, `put_privilege`, `delete_privilege`, `put_land`, `delete_land`, `put_colony`, `delete_colony`, `export_scope`, `import_scope` | **off by default** — opt in on the instance in the console |

Which groups an instance gets is **its configuration in the core**, not a var on this
worker. The default for a new instance is `records,media,meta`; `admin` is opt-in
because it can create and delete tenants, users and privileges.

A **read-only** instance does not register write tools at all, so they never appear in
`tools/list` — an agent is not offered an action that will be refused. The core refuses
them regardless, which is the boundary that actually holds; hiding them is about not
wasting a turn on a tool that cannot work.

## Resources

Read-only, URI-addressable views of the same endpoints. Every payload is the
core's own JSON, pretty-printed, so a resource and the equivalent tool call
return the same bytes.

| URI | Contents |
| --- | --- |
| `hamolus://spec/collection-definition` | the JSON Schema a collection definition must satisfy — read it before `put_collection` rather than guessing a field type |
| `hamolus://collections` | every collection definition — the natural place to start |
| `hamolus://settings`, `hamolus://localization`, `hamolus://stats`, `hamolus://lands`, `hamolus://groups` | the scope-wide documents, unchanged |
| `hamolus://collection/{collection}` | one collection definition (listed, so the index is browsable) |
| `hamolus://records/{collection}` | first page (25 rows) of a collection |
| `hamolus://record/{collection}/{id}` | one record |
| `hamolus://media/{id}`, `hamolus://document/{id}`, `hamolus://attachment/{id}` | asset metadata and absolute url; the bytes are never inlined |
| `hamolus://group/{id}`, `hamolus://config/{key}` | one navigation group, one config entry |

**One deliberate limitation:** a resource URI carries no arguments, so resources
resolve against the *instance's* land/colony — the colony the instance was created
in — and the default locale. To read another scope or resolve localized fields to a
specific language, use the tools — they take `land`, `colony` and `locale`, and the
core refuses any scope outside the instance's.

A payload over 1 MB is refused rather than truncated; narrow it with a list tool
(`search`, `filter`, `pageSize`) instead.

## Prompts

`prompts/list` returns seven task-shaped starting points, each a single user
turn that names the tools to call and the order:

| Prompt | For |
| --- | --- |
| `explore_content` | mapping the content model: collections, fields, row counts |
| `draft_record` | creating one record from a brief, schema first |
| `bulk_import` | loading many records, validating before writing |
| `review_collection` | auditing duplicates, empty required fields, broken relations |
| `migrate_records` | copying records between collections, field by field |
| `manage_media` | tidying the media library, normalising names and tags |
| `provision_user` | creating an account with the right role |

A prompt never guesses data — it tells the model to fetch the real schema, and
states the refusals (a read-only instance, disabled groups, destructive tools) up
front so the model does not discover them by hitting an error mid-task.

## Per-collection MCP mode

Every collection definition carries an `mcp` key that decides what this server may
do with it. It sits next to `fields`, because it is part of the definition rather
than part of the MCP server's config — the same definition drives the console, the
REST API and this surface, and a collection that must not be writable through an
agent should say so where the collection is declared.

```ts
{
  name: 'salaries',
  label: 'Salaries',
  mcp: 'hide',          // 'read' (default) | 'write' | 'hide'
  fields: [ /* … */ ],
}
```

| Mode | Tools | Resources | In the collection index |
| --- | --- | --- | --- |
| `read` *(default)* | read verbs only — `list_records`, `get_record`, `get_collection_last_update`, and the generated `list_<c>` / `get_<c>` | readable | yes |
| `write` | all of the above plus `create_record`, `update_record`, `delete_record`, `bulk_delete_records`, and the generated `create_` / `update_` / `delete_<c>` | readable | yes |
| `hide` | none — every tool refuses, including `get_collection` and `delete_collection` | every read refuses | **no** |

**The default is `read`, which is a change for existing collections.** A collection
with no `mcp` key used to be fully writable through this server; it now is not. Set
`mcp: 'write'` on the collections an agent should be able to change. This is
deliberate — the mode that is safe is the one you get for free, and the mode that
grants an agent write access is the one somebody has to type on purpose.

Where it is enforced, and why all of it:

- **Generic tools** (`list_records`, `create_record`, …) check the collection they
  were handed, so the mode cannot be side-stepped by using the generic form instead
  of a generated tool.
- **Generated tools** are simply not registered: a `read` collection never appears
  with a `create_` verb in `tools/list`, and a `hide` collection appears at all. A
  model cannot call a tool it was never shown.
- **Resources** enforce it too, because `hamolus://records/<collection>` is a second
  way in and a mode enforced only on the tools would be a mode with a hole in it.
- **The collection index** omits `hide`, so the model is never told about a
  collection it would immediately be refused on.
- **A read-only instance still wins** over `mcp: 'write'`. The two are an intersection,
  not an override: a write needs both. A read-only instance does not even register the
  write tools, so the mode is enforced twice — once by not offering them, and once by
  the core's own permissions.

A refusal names the collection and the fix, e.g. *"The 'blog_posts' collection is
read-only through MCP (mcp: 'read' in its definition). Set mcp to 'write' to let this
server change records."*

`put_collection` and `delete_collection` refuse against a `hide` collection, which
closes the obvious loop: a hidden collection cannot be un-hidden by the same server
that cannot see it. Set it from the console, or the REST API, to change that.

**This is a surface policy, not authorization.** It decides what this server offers.
Who may write at all is still the caller's privilege (`records.write`) and the
core's own scope rules, enforced on every request regardless of `mcp`.

## Dynamic tools

Off by default. The instance's configuration in the core names the collections to
generate tools for, and caps how many. Each collection's `mcp` mode still decides
which of the five verbs it gets (see above). The console calls these "Dynamic
collections" and "Maximum" on the instance, and changing them needs no redeploy.

The two deprecated vars still work on the legacy path only: `MCP_DYNAMIC_TOOLS`
(`all` or a comma-separated list) and `MCP_DYNAMIC_MAX` (cap, default 10).

Each collection yields `list_<c>`, `get_<c>`, `create_<c>`, `update_<c>` and
`delete_<c>`. The `data` argument of `create_`/`update_` is built with
`buildEntitySchema()` from `@hamolus/types` — the exact function the core
validates `POST /:collection` with — so a generated tool cannot accept something
the core would reject, and a new field type needs no change here. A required
field, an enum and a relation target are visible in the tool's own JSON schema
instead of one `get_collection` call away.

- **Capped on purpose.** A model carrying 200 tool schemas in every request is
  worse off than one that calls `get_collection` when it needs to. An explicit
  list keeps its own order, so your first choices survive the cap.
- **Collisions are skipped, never overwritten.** A collection named `config`
  does not replace the static `list_config`/`get_config`; it only adds the verbs
  the static surface lacks (`create_config`, `update_config`).
- **Cached, and invalidated on write.** Definitions are read from
  `/_meta/collections` + `/_meta/localization` and held for 5 minutes per scope.
  `put_collection` / `delete_collection` drop the entry, so the next request sees
  the change. A core that is unreachable yields no generated tools and leaves the
  static surface working.

## Env

**Two vars, and there are no secrets.**

| Var | Meaning |
| --- | --- |
| `CORE_API_URL` | core base URL **including `/api`** (default `http://localhost:8787/api`) |
| `MCP_INSTANCE_ID` | this server's id in the core, created in the console (**Environment → MCP**). Empty means "not configured" and the server says so. |

`MCP_INSTANCE_ID` is a credential, not a label: anyone holding it can read this
server's configuration. It is generated for you precisely so it cannot be guessed, and
`GET /` on the worker echoes it so you can confirm which instance is running.

With `MCP_INSTANCE_ID` set, the server is **console-managed**: it fetches its scope,
read-only state and tool groups from `GET /api/_mcp/config` and refuses everything
until that call succeeds. With it unset it falls back to the deprecated path below.

### Deprecated, still honoured

Read these only when migrating a server that predates the console.

| Var | Why it went away |
| --- | --- |
| `CORE_ADMIN_KEY` | platform-wide: a server serving one colony could reach every land and colony. An instance is scoped to one colony. |
| `CORE_API_TOKEN` | the alternative to the above; a long-lived JWT for the whole platform. Per-user tokens from the console replace it. |
| `MCP_BEARER_TOKEN` | one static shared secret compared verbatim on every request, so it cannot be attributed or revoked per person. Per-user tokens are revocable one at a time. |
| `MCP_READONLY` | narrowed only what the worker *offered*, not what the core *accepted*. The core now enforces it through permissions. |
| `MCP_TOOL_GROUPS` | belonged to the deployment, so changing the tool surface meant a redeploy. It is per-instance configuration now. |
| `MCP_DYNAMIC_TOOLS` / `MCP_DYNAMIC_MAX` | same — per-instance configuration now. |
| `CORE_LAND` / `CORE_COLONY` | the instance knows its own colony. These are consulted only on the legacy path. |

`GET /` reports `mode: "console-managed"` or `mode: "legacy"`, so a half-finished
migration is visible from outside.

The server never proxies `/media`, `/documents`, or `/attachments` public-file routes
— only `/api`.

## Run

```bash
# local
cd packages/mcp
# write .dev.vars (gitignored) with the two vars below
pnpm exec wrangler dev --port 8790 --ip 0.0.0.0
```

`.dev.vars` (gitignored) example — the instance id comes from the console, so create
one first:

```
CORE_API_URL=http://localhost:8787/api
MCP_INSTANCE_ID=mcp_xxxxxxxxxxxxxxxxxxxxxxxxxx
```

Issue a token under that instance in the console and paste it into the `Authorization`
header of the calls below. To watch a change land without a redeploy, flip **Enabled**
off on the instance: the next `POST /mcp` answers `403 FORBIDDEN` — "This MCP instance
is disabled".

Run more than one worker at once and give each its own inspector port, or they collide
on the default:

```bash
pnpm exec wrangler dev --port 8790 --inspector-port 9230 --ip 0.0.0.0
```

Verify with curl (JSON-RPC over Streamable HTTP, SSE accept is required):

```bash
curl -X POST http://localhost:8790/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}'
```

Then `tools/list`, `resources/list`, `resources/templates/list` and
`prompts/list` on the same endpoint. Any `GET` that is not `/mcp` returns a small
JSON index of what this server offers.

## Deploy

```bash
# root
pnpm deploy:mcp
# or from the package
cd packages/mcp && pnpm deploy
```

**There are no secrets to set.** Both vars are plain and belong in `wrangler.jsonc`
`vars`, which the template already does:

```
CORE_API_URL     # with /api, e.g. https://example-core.<account>.workers.dev/api
MCP_INSTANCE_ID  # from the console
```

Migrating an older server: create an instance in the console, set `MCP_INSTANCE_ID`,
deploy, confirm `GET /` says `mode: "console-managed"`, then delete the
`CORE_ADMIN_KEY` and `MCP_BEARER_TOKEN` secrets. The old path keeps working until
`MCP_INSTANCE_ID` is set, so the order above has no outage.

Use the deployed worker URL — e.g. `https://hamolus-mcp.<subdomain>.workers.dev/mcp`
— in opencode's `mcp` config.

## OpenCode registration

Config lives in `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "Hamolus": {
    "type": "remote",
    "url": "https://hamolus-mcp.YOUR_SUBDOMAIN.workers.dev/mcp",
    "headers": { "Authorization": "Bearer {env:HAMOLUS_MCP_TOKEN}" },
    "enabled": false
  },
  "Hamolus-local": {
    "type": "remote",
    "url": "http://localhost:8790/mcp",
    "headers": { "Authorization": "Bearer {env:HAMOLUS_MCP_TOKEN}" },
    "enabled": false
  }
}
```

The header is a **per-user token issued in the console**, not a shared secret. That is
the point of the managed model: revoke one person without touching anyone else's
access, and a leaked token is scoped to one colony and one set of permissions.

Both are registered **disabled**; flip `enabled: true`, set the env var, and restart
opencode (config is loaded once at startup). For read-only exploration, set **Enabled**
on the instance and turn on **Read-only** — the core then enforces it, so it holds
however the server is called.

## Verify the surface

With a core running locally and a token issued for the instance, the cheapest
end-to-end check is a stateless `tools/list`:

```bash
TOKEN=$(cat ~/.hamolus-mcp-token)
curl -sX POST http://localhost:8790/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -c '"name"'
```

Worth checking when something looks wrong:

- **Missing `Authorization` header** → `401`, and it says the server is console-managed.
- **Instance switched off** → `403 FORBIDDEN`, "This MCP instance is disabled".
- **Token revoked** → `401`, distinguishable from a wrong secret by the reason.
- **Read-only instance** → write tools are absent from the count, not merely failing
  when called.
- **A second token passed to another instance** → `401`. A token belongs to one
  instance, and the instance id is held against it.
