# `@hamolus/mcp` — the MCP server

A Cloudflare Agents worker that exposes a core's API to an AI client as MCP tools.
It is a **thin, deterministic surface over the existing REST API**: every tool is one
HTTP call to the core, with the same auth, the same scope headers, and the same
validation. There is no second data path and no local cache to go stale.

## Ships raw TypeScript

`main` and `types` point at `./src/index.ts` and `files` ships `src/`. Same reasoning
as `@hamolus/core`: a project can wrap or extend the Agent entry without a build
step. A syntax error in `src/` breaks every generated MCP server at once.

`build` is `wrangler deploy --dry-run --outdir=dist` — a compile check, not a bundle.

## Commands

```bash
pnpm -F @hamolus/mcp typecheck
pnpm -F @hamolus/mcp dev              # wrangler dev
pnpm -F @hamolus/mcp deploy
```

## Layout

| Path | Holds |
| ---- | ----- |
| `src/index.ts` | the Agent: name, the root JSON index, `createServer()`, and the bearer-token guard on `POST /mcp` |
| `src/env.ts` | bindings: core credentials, scopes, tool-group and dynamic-tool switches |
| `src/version.ts` | `SERVER_VERSION`, sent as `MCP_WORKER_VERSION_HEADER` on every core call. Its own module because `core.ts` reports it and `index.ts` already imports `core.ts` |
| `src/core.ts` | `CoreClient` — a typed wrapper over the core REST API: auth, scope headers, query building, multipart, error normalisation |
| `src/tools/index.ts` | the tool registry: which group registers what, and the `ToolSurface` the generated tools check for name collisions |
| `src/tools/shared.ts` | schemas every group reuses (paging, `filter`, scope args, id escaping) and the result wrappers |
| `src/tools/{records,media,meta,admin}.ts` | the four tool groups |
| `src/collections.ts` | the shared definition cache and every `mcp`-mode check; both the tools and the resources go through it |
| `src/dynamic-tools.ts` | per-collection tools generated from the core's own definitions |
| `src/resources.ts` | `hamolus://` static resources and `ResourceTemplate`s |
| `src/prompts.ts` | task-shaped prompts, each a single user turn |
| `docs/` | shipped documentation for the host project |

## The tool surface

Tools are **snake_case and verb-first**, in four groups. Which groups a deployment
offers is **its instance's configuration in the core**, fetched at request time — not a
var on this worker. A new instance defaults to `records,media,meta`; `admin` is opt-in
because it can create and delete tenants, users and privileges. On the deprecated
env path the var is `MCP_TOOL_GROUPS` (`all` adds `admin`):

- **records** — `list_collections`, `get_collection`, `put_collection`,
  `delete_collection`, `list_records`, `get_record`, `create_record`,
  `update_record`, `delete_record`, `bulk_delete_records`,
  `get_collection_last_update`
- **media** — `list_media`, `list_documents`, `list_attachments`, `get_asset`,
  `update_asset`, `delete_asset`, `upload_media`, `upload_file`,
  `get_media_taxonomy`, `update_media_taxonomy`
- **meta** — `check_core`, `list_lands`, `list_colonies`, `get_land`,
  `get_colony`, `get_stats`, `get_settings`, `update_settings`,
  `get_localization`, `list_groups`, `get_group`, `put_group`, `delete_group`,
  `list_config`, `get_config`, `put_config`, `delete_config`,
  `list_plugin_values`, `get_plugin_value`, `put_plugin_value`,
  `delete_plugin_value`
- **admin** — `get_current_user`, `list_users`, `create_user`, `update_user`,
  `delete_user`, `list_privileges`, `put_privilege`, `delete_privilege`,
  `put_land`, `delete_land`, `put_colony`, `delete_colony`, `export_scope`,
  `import_scope`

## Invariants

- **One new concept means one new tool, not one new concept plus a new transport.**
  The API already exists; the tool calls it. If a tool needs a bespoke endpoint, the
  endpoint belongs in `@hamolus/core` first.
- **A tool description is the model's only documentation.** Say what the tool returns
  *and* what it refuses or will not do, because the model decides from that text
  alone. Keep them specific: a description that repeats the name helps nobody.
- **The tool is a thin wrapper; `CoreClient` owns the transport.** Auth, scope headers,
  error normalisation and the base URL live in `src/core.ts` and nowhere else.
- **Errors are returned, not thrown at the transport.** A tool that throws kills the
  turn; a tool that returns the core's error payload lets the model adapt. Preserve
  `INVALID_QUERY`, `FORBIDDEN` and `NOT_FOUND` wording.
- **Generated tools must reuse the core's schema, never restate it.** A dynamic
  collection schema comes from `buildEntitySchema()` in `@hamolus/types`; the moment
  this package starts hand-writing a field type, it has forked the core's validation.
- **A static name wins.** Dynamic tools skip a verb whose name a static tool already
  holds, so naming every collection in an instance's dynamic list can only add tools,
  never shadow one. The `reg` helper in `dynamic-tools.ts` is the single place that
  check lives, and it is silent on purpose: `GET /` reports the group and dynamic
  counts, and a `config` collection must not have its generated verbs shadowed by the
  static `list_config` / `get_config` simply because it is enumerated first.

**A collection's `mcp` mode is checked in one place, and every surface goes through
it.** `src/collections.ts` owns the definition cache and the mode rules; `records`,
`dynamic-tools` and `resources` all call its `assertMcpAllows`. A mode enforced on
the tools alone is not enforced, because `hamolus://records/<collection>` is a second
way in — so when you add a surface, the first question is which helper it needs.
- **Await the payload before stringifying it.** `JSON.stringify(promise)` is `"{}"`,
  not an error — `doc()` in `src/resources.ts` takes a `Promise` for that reason.
- **The scope is the instance's, and it is not the caller's to widen.** A worker
  authenticates with an instance id before it knows its own scope, so the scope comes
  from the instance row in the core and nowhere else — not from `?land=`, not from
  `x-land`, and not from the tools' own `land`/`colony` arguments, which the core
  refuses when they point outside the instance. Resources, which take no arguments,
  are pinned to the same scope.
- **Resolve config and session *outside* `createMcpHandler`'s factory.** The SDK
  reports anything its factory throws as a bare JSON-RPC `-32603`, which is useless in
  a worker log and hides a disabled instance behind what looks like a crash. Resolving
  in `src/index.ts` first keeps the core's own `403 MCP_DISABLED` and `401` wording
  intact, which is the difference between an operator reading a log and guessing.
- Keep `sideEffects: false` true in `package.json`; a project imports this entry to
  compose an Agent.

## Gates

There is no gate script in this package. `pnpm typecheck && pnpm build` from the
repository root is the check, and the runtime surface is pinned by
`pnpm check:panel-acl`, `pnpm check:localization-api` and **`pnpm check:mcp-instance-acl`**
on the core side — a tool whose name or payload drifts from the route it calls shows up
there, not here. `check:mcp-instance-acl` is the one that also pins what this worker is
*offered*: a read-only instance must not register a write verb at all, so a drift there
shows up as a tool count, not as a `403` nobody notices until a model tries.

## Conventions

- Copyright/author/SPDX header verbatim (`pnpm check:copyright`).
- Every tool gets a doc comment stating the call it makes, and — when it accepts
  filters — which of the strict list-query keys it honours.
- Comments are English; commit messages follow Conventional Commits with the package as
  the scope.
