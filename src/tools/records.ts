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
 * The `records` tool group: the data model (collection definitions) and the data
 * itself (records). Every tool here is one call to the core's dynamic record
 * routes — there is no second data path and no local cache that could go stale.
 *
 * Collection definitions are dynamic, so the record tools take a `collection`
 * argument rather than having one tool per collection. Per-collection tools add
 * per-collection tools for the schemas a client uses most; see `dynamic-tools.ts`.
 */

import { z } from 'zod'
import { collectionDefinitionSchema, FIELD_TYPES, type CollectionDefinition } from '@hamolus/types'
import {
  assertMcpAllows,
  assertMcpVisible,
  invalidateDefinitionCache,
  visibleDefinitions,
} from '../collections'
import type { CoreClient } from '../core'
import {
  filterArg,
  format,
  nameSchema,
  paginationArgs,
  run,
  runWrite,
  scopeArgs,
  scopeArgsSchema,
  seg,
  summarize,
  type ToolSurface,
} from './shared'

/** Core caps `__bulk_delete` at 200 ids; asking for more is a guaranteed 400. */
const BULK_DELETE_MAX = 200

export function registerRecordTools(s: ToolSurface, core: CoreClient): void {
  /* ------------------------------------------------------------------ */
  /* collection definitions                                              */
  /* ------------------------------------------------------------------ */

  s.tool(
    'list_collections',
    {
      description:
        'List every collection defined on the core with its full field definition (name, label, group, fields, options, mcp mode). ' +
        'Collections whose definition says mcp: "hide" are not listed — they are not part of this server\'s surface.',
      inputSchema: z.object({ ...scopeArgs }),
    },
    run(async ({ land, colony }: z.infer<typeof scopeArgsSchema>) => {
      const resp = (await core.get('/_meta/collections', undefined, { land, colony })) as { data?: unknown[] }
      return { data: visibleDefinitions((resp.data ?? []) as CollectionDefinition[]) }
    }),
  )

  s.tool(
    'get_collection',
    {
      description:
        'Get one collection definition (schema, fields, consoleView/group layout, relation configs, mcp mode). Refused for a collection ' +
        'whose definition says mcp: "hide".',
      inputSchema: z.object({ name: nameSchema, ...scopeArgs }),
    },
    run(async ({ name, land, colony }: { name: string; land?: string; colony?: string }) => {
      await assertMcpAllows(core, name, 'read', { land, colony })
      return core.get(`/_meta/collections/${seg(name)}`, undefined, { land, colony })
    }),
  )

  s.tool(
    'put_collection',
    {
      description:
        'Create or update a collection definition (write tool; disabled in read-only mode). Creating a collection creates its D1 table ' +
        'and exposes CRUD at /api/<name>. Include the full definition; updating an existing collection auto-migrates new fields. ' +
        'It only ever ADDS columns — dropping, renaming or retyping a field is a manual D1 migration and this tool will not do it. ' +
        'Set "mcp" to control what this server may do with the collection: "read" (default, read-only), "write", or "hide". ' +
        'The `definition` argument is validated here against the core\'s own schema before the call goes out, so a wrong field ' +
        'type is reported against its own index (`fields[2].type`) rather than as a blanket 400. The full field-type list and every ' +
        'definition key is readable at the `hamolus://spec/collection-definition` resource.',
      inputSchema: z.object({
        definition: collectionDefinitionSchema.describe(
          'A full CollectionDefinition. Field `type` must be one of: ' +
            FIELD_TYPES.map((t) => `"${t}"`).join(' | ') +
            '. Note there is no "integer" — a whole number is "number".',
        ),
        ...scopeArgs,
      }),
    },
    runWrite(core, async (args: { definition: CollectionDefinition; land?: string; colony?: string }) => {
      const name = args.definition.name
      // No re-validation here: the schema above is the core's own, and the SDK
      // checks it before this body runs — a second pass would only ever agree
      // with the first, and the paths it prints are already the model's to act on.
      //
      // Editing the definition of a collection this server cannot see is how a
      // hidden collection would be un-hidden, so it is refused. A new collection
      // has no stored mode yet and is always allowed — that is how the first one
      // is created, and the mode it declares is the one that counts afterwards.
      await assertMcpVisible(core, name, { land: args.land, colony: args.colony })
      const resp = await core.put(`/_meta/collections/${seg(name)}`, args.definition, { land: args.land, colony: args.colony })
      // A generated tool for this collection is now stale; drop the cache so the
      // next request re-reads the definition.
      invalidateDefinitionCache(core)
      return resp
    }),
  )

  s.tool(
    'delete_collection',
    {
      description:
        'Delete a collection: drops its metadata AND its D1 table and all records (write tool; disabled in read-only mode). Destructive. ' +
        'Refused for a collection whose definition says mcp: "hide".',
      inputSchema: z.object({ name: nameSchema, ...scopeArgs }),
    },
    runWrite(core, async (args: { name: string; land?: string; colony?: string }) => {
      await assertMcpVisible(core, args.name, { land: args.land, colony: args.colony })
      const resp = await core.delete(`/_meta/collections/${seg(args.name)}`, { land: args.land, colony: args.colony })
      invalidateDefinitionCache(core)
      return resp
    }),
  )

  /* ------------------------------------------------------------------ */
  /* records                                                             */
  /* ------------------------------------------------------------------ */

  s.tool(
    'list_records',
    {
      description:
        'Paginated read of a collection. Honours ?search=, locale resolution for localized fields, server-side sorting, and exact ' +
        'field filters. See get_collection for the field schema, and the result meta for the total row count. ' +
        `Refused for a collection whose definition says mcp: 'hide'.`,
      inputSchema: z.object({
        collection: nameSchema,
        search: z.string().max(200).optional().describe('Full-text LIKE search across string-like fields.'),
        locale: z.string().max(20).optional().describe('Resolve localized fields to this language (e.g. en, id).'),
        sortBy: z.string().max(64).optional(),
        sortDir: z.enum(['asc', 'desc']).optional(),
        filter: filterArg,
        ...paginationArgs,
        ...scopeArgs,
      }),
    },
    run(async (args: {
      collection: string
      search?: string
      locale?: string
      sortBy?: string
      sortDir?: string
      filter?: Record<string, { op: string; value: unknown }>
      page?: number
      pageSize?: number
      land?: string
      colony?: string
    }) => {
      await assertMcpAllows(core, args.collection, 'read', { land: args.land, colony: args.colony })
      const resp = await core
          .get(
            `/${seg(args.collection)}`,
            {
              page: args.page,
              pageSize: args.pageSize,
              locale: args.locale,
              search: args.search,
              sortBy: args.sortBy,
              sortDir: args.sortDir,
              filter: args.filter ? JSON.stringify(args.filter) : undefined,
            },
            { land: args.land, colony: args.colony },
          )
      return `${summarize(`records:${args.collection}`, resp as { data?: unknown[] })}\n\n${format(resp)}`
    }),
  )

  s.tool(
    'get_record',
    {
      description:
        'Read a single record by its primary key (usually a UUID). Pass ?locale to resolve localized fields. ' +
        `Refused for a collection whose definition says mcp: 'hide'.`,
      inputSchema: z.object({
        collection: nameSchema,
        id: z.string().max(200),
        locale: z.string().max(20).optional(),
        ...scopeArgs,
      }),
    },
    run(async (args: { collection: string; id: string; locale?: string; land?: string; colony?: string }) => {
      await assertMcpAllows(core, args.collection, 'read', { land: args.land, colony: args.colony })
      return core.get(`/${seg(args.collection)}/${seg(args.id)}`, { locale: args.locale }, { land: args.land, colony: args.colony })
    }),
  )

  s.tool(
    'create_record',
    {
      description:
        'Create a record in a collection (write tool; disabled in read-only mode). Pass the record fields as a snake_case object; ' +
        'the core validates against the collection definition (required fields, enums, relation targets). Call get_collection first to learn the fields. ' +
        `Refused unless the definition says mcp: 'write' — 'read' (the default) and 'hide' both refuse.`,
      inputSchema: z.object({
        collection: nameSchema,
        data: z.record(z.string(), z.unknown()),
        ...scopeArgs,
      }),
    },
    runWrite(core, async (args: { collection: string; data: Record<string, unknown>; land?: string; colony?: string }) => {
      await assertMcpAllows(core, args.collection, 'write', { land: args.land, colony: args.colony })
      return core.post(`/${seg(args.collection)}`, args.data, { land: args.land, colony: args.colony })
    }),
  )

  s.tool(
    'update_record',
    {
      description:
        'Update a record by primary key (write tool; disabled in read-only mode). Send only the fields that change. ' +
        `Refused unless the definition says mcp: 'write'.`,
      inputSchema: z.object({
        collection: nameSchema,
        id: z.string().max(200),
        data: z.record(z.string(), z.unknown()),
        ...scopeArgs,
      }),
    },
    runWrite(core, async (args: { collection: string; id: string; data: Record<string, unknown>; land?: string; colony?: string }) => {
      await assertMcpAllows(core, args.collection, 'write', { land: args.land, colony: args.colony })
      return core.put(`/${seg(args.collection)}/${seg(args.id)}`, args.data, { land: args.land, colony: args.colony })
    }),
  )

  s.tool(
    'delete_record',
    {
      description:
        'Delete a record by primary key (write tool; disabled in read-only mode). A collection with softDelete enabled marks the row deleted instead of erasing it, and there is no restore tool. ' +
        `Refused unless the definition says mcp: 'write'.`,
      inputSchema: z.object({
        collection: nameSchema,
        id: z.string().max(200),
        ...scopeArgs,
      }),
    },
    runWrite(core, async (args: { collection: string; id: string; land?: string; colony?: string }) => {
      await assertMcpAllows(core, args.collection, 'write', { land: args.land, colony: args.colony })
      return core.delete(`/${seg(args.collection)}/${seg(args.id)}`, { land: args.land, colony: args.colony })
    }),
  )

  s.tool(
    'bulk_delete_records',
    {
      description:
        `Delete many records of one collection by id list (write tool; disabled in read-only mode). At most ${BULK_DELETE_MAX} ids per call. ` +
        `Refused unless the definition says mcp: 'write'.`,
      inputSchema: z.object({
        collection: nameSchema,
        ids: z.array(z.string().max(200)).min(1).max(BULK_DELETE_MAX),
        ...scopeArgs,
      }),
    },
    runWrite(core, async (args: { collection: string; ids: string[]; land?: string; colony?: string }) => {
      await assertMcpAllows(core, args.collection, 'write', { land: args.land, colony: args.colony })
      return core.post(`/${seg(args.collection)}/__bulk_delete`, { ids: args.ids }, { land: args.land, colony: args.colony })
    }),
  )

  s.tool(
    'get_collection_last_update',
    {
      description:
        'Read the lastUpdate hash of a collection — one cheap call that says whether anything changed since you last looked. ' +
        'Cheaper than list_records; use it to decide whether a refresh is worth it. ' +
        `Refused for a collection whose definition says mcp: 'hide'.`,
      inputSchema: z.object({ collection: nameSchema, ...scopeArgs }),
    },
    run(async (args: { collection: string; land?: string; colony?: string }) => {
      await assertMcpAllows(core, args.collection, 'read', { land: args.land, colony: args.colony })
      return core.get(`/${seg(args.collection)}/__lastUpdate`, undefined, { land: args.land, colony: args.colony })
    }),
  )
}
