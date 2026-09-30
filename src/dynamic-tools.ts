/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

/**
 * Per-collection tools, generated from the core's own collection definitions.
 *
 * The generic `list_records` / `create_record` tools are correct for every
 * collection but say nothing about any of them: the model has to call
 * `get_collection`, read the field list, and hold it in its head before it can
 * write anything. A generated tool folds that schema into the tool's own input
 * shape, so `create_blog_post` already knows that `title` is required, that
 * `status` is an enum, that `author_id` points at `authors`, and that `body` is
 * localized markdown.
 *
 * Two constraints shape the implementation:
 *
 * - **It is opt-in and capped.** The operator picks the collections and bounds how
 *   many, because a model carrying 200 tool schemas in every request is worse off
 *   than one that calls `get_collection` when it needs to. Generated tools are a
 *   shortcut, not a replacement. On a console-managed deployment both values come
 *   from the core's instance config, so changing them needs no redeploy.
 * - **The collection's own `mcp` mode decides the verbs.** A `read` collection
 *   registers `list_` and `get_` and no write tool at all; a `hide` collection
 *   registers nothing and never reaches `tools/list`. See `collections.ts`, which
 *   also enforces the same mode on the generic tools and the resources, so
 *   omitting a generated tool is never the only thing standing in the way.
 * - **The schema is the core's schema.** The input shape comes from
 *   `buildEntitySchema` — the exact function `POST /:collection` validates with —
 *   so a generated tool cannot accept something the core would reject, and a new
 *   field type needs no change here.
 *
 * The server is stateless (a fresh `McpServer` per request), so definitions are
 * cached with a short TTL. A cache miss costs two core calls; a
 * `put_collection` / `delete_collection` write drops the entry so the next
 * request sees the change.
 */

import { buildEntitySchema, type CollectionDefinition } from '@hamolus/types'
import { z } from 'zod'
import { isWritable, isHidden as isHiddenForMcp, loadDefinitions } from './collections'
import type { CoreClient } from './core'
import type { Env } from './env'
import { filterArg, format, paginationArgs, run, runWrite, scopeArgs, seg, summarize, type ToolSurface } from './tools/shared'

/** A one-line field digest, so the tool description is useful before the call. */
function fieldDigest(def: CollectionDefinition): string {
  const parts = def.fields
    .filter((field) => field.type !== 'id')
    .slice(0, 12)
    .map((field) => {
      const flags = [
        field.required ? 'required' : '',
        field.localized ? 'localized' : '',
        field.relation ? `-> ${field.relation.collection}.${field.relation.field}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      return `${field.name}: ${field.type}${flags ? ` (${flags})` : ''}`
    })
  const extra = def.fields.length > 12 ? ` … +${def.fields.length - 12} more` : ''
  return parts.join('; ') + extra
}

/** True when the collection's own label/description should lead the description. */
function header(def: CollectionDefinition): string {
  const label = def.label && def.label !== def.name ? ` (${def.label})` : ''
  const about = def.description ? ` ${def.description}` : ''
  const fields = fieldDigest(def)
  return `Records of the ${def.name} collection${label}.${about}${fields ? ` Fields — ${fields}.` : ''}`
}

/**
 * Resolve the configured collection list into the definitions to generate for.
 *
 * `all` keeps the core's own order. An explicit list keeps the order it was
 * written in, because that list is also what the cap truncates — the operator's
 * first choices should be the ones that survive it. A hidden
 * collection is dropped here rather than in the registration loop, so it does
 * not consume one of the cap slots either.
 */
function selection(raw: string | undefined, available: CollectionDefinition[]): CollectionDefinition[] {
  const wanted = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (wanted.length === 0) return []
  const visible = available.filter((def) => !isHiddenForMcp(def))
  if (wanted.includes('all')) return visible
  const byName = new Map(visible.map((def) => [def.name, def]))
  // A name that does not exist is dropped rather than fatal: the list may name a
  // collection another scope has and this one does not.
  return wanted.map((name) => byName.get(name)).filter((def): def is CollectionDefinition => def !== undefined)
}

export async function registerDynamicTools(surface: ToolSurface, core: CoreClient, _env: Env): Promise<void> {
  // Read from the client, not from env: on a console-managed deployment these
  // come from the instance config, and `CoreClient.ready()` has already run.
  const wanted = core.dynamicTools?.trim()
  if (!wanted) return

  const { defs, languages } = await loadDefinitions(core)
  const chosen = selection(wanted, defs).slice(0, core.dynamicMax)

  for (const def of chosen) {
    registerCollection(surface, core, def, languages)
  }
}

function registerCollection(s: ToolSurface, core: CoreClient, def: CollectionDefinition, languages: string[]): void {
  const path = `/${seg(def.name)}`
  const about = header(def)
  // A `read` collection gets the two read verbs and nothing else: the write tools
  // are not registered at all, so a model cannot see them in tools/list and
  // cannot talk itself into trying them. Read-only still wins over `write`,
  // which is why a read-only server registers no write verb for any collection.
  const mayWrite = isWritable(def) && !core.readonly

  // One registration helper: a collection whose verb name is already taken by a
  // static tool is skipped rather than silently replacing it.
  const reg = (verb: string, description: string, inputSchema: z.ZodType, cb: (args: never) => Promise<unknown>): void => {
    const name = `${verb}_${def.name}`
    if (s.names.has(name)) return
    s.tool(name, { description, inputSchema }, cb as never)
  }

  reg(
    'list',
    `Paginated list of ${def.name} records. Honours search, exact field filters, sorting and locale resolution. ${about}`,
    z.object({
      search: z.string().max(200).optional().describe('Full-text LIKE search across string-like fields.'),
      locale: z.string().max(20).optional().describe('Resolve localized fields to this language (e.g. en, id).'),
      sortBy: z.string().max(64).optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
      filter: filterArg,
      ...paginationArgs,
      ...scopeArgs,
    }),
    run((args: Record<string, unknown>) =>
      core
        .get(path, {
          page: args.page as number,
          pageSize: args.pageSize as number,
          locale: args.locale as string | undefined,
          search: args.search as string | undefined,
          sortBy: args.sortBy as string | undefined,
          sortDir: args.sortDir as string | undefined,
          filter: args.filter ? JSON.stringify(args.filter) : undefined,
        }, { land: args.land as string | undefined, colony: args.colony as string | undefined })
        .then((resp) => `${summarize(`records:${def.name}`, resp as { data?: unknown[] })}\n\n${format(resp)}`),
    ),
  )

  reg(
    'get',
    `Read one ${def.name} record by its primary key. ${about}`,
    z.object({
      id: z.string().max(200).describe(`Primary key of the record (usually a UUID; the collection's key field is "${def.primaryKey ?? 'id'}").`),
      locale: z.string().max(20).optional(),
      ...scopeArgs,
    }),
    run((args: Record<string, unknown>) =>
      core.get(`${path}/${seg(String(args.id))}`, { locale: args.locale as string | undefined }, { land: args.land as string | undefined, colony: args.colony as string | undefined }),
    ),
  )

  if (mayWrite) {
    reg(
      'create',
      `Create one ${def.name} record. The data shape below IS the collection definition, validated by the core. ${about}`,
      z.object({
        data: buildEntitySchema(def, languages).describe(`Fields of ${def.name}.`),
        ...scopeArgs,
      }),
      runWrite(core, (args: { data: Record<string, unknown>; land?: string; colony?: string }) =>
        core.post(path, args.data, { land: args.land, colony: args.colony }),
      ),
    )

    reg(
      'update',
      `Update one ${def.name} record by primary key. Send only the fields that change. ${about}`,
      z.object({
        id: z.string().max(200),
        data: buildEntitySchema(def, languages).partial().describe(`Partial fields of ${def.name}.`),
        ...scopeArgs,
      }),
      runWrite(core, (args: { id: string; data: Record<string, unknown>; land?: string; colony?: string }) =>
        core.put(`${path}/${seg(args.id)}`, args.data, { land: args.land, colony: args.colony }),
      ),
    )

    reg(
      'delete',
      `Delete one ${def.name} record by primary key.${def.softDelete ? ' This collection soft-deletes, so the row is marked rather than erased, and nothing here can restore it.' : ' This erases the row.'} ${about}`,
      z.object({ id: z.string().max(200), ...scopeArgs }),
      runWrite(core, (args: { id: string; land?: string; colony?: string }) =>
        core.delete(`${path}/${seg(args.id)}`, { land: args.land, colony: args.colony }),
      ),
    )
  }
}
