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
 * The `meta` tool group: everything about the *shape* of a scope rather than its
 * content — the land/colony registry, settings, dashboard stats, localization,
 * navigation groups, the key/value config table and plugin storage.
 *
 * Group `meta` is on by default. The land/colony *writes* live in the `admin`
 * group instead (`admin.ts`): reading the registry is harmless, and deleting a
 * land cascades over its collections, users, media and panels.
 */

import { z } from 'zod'
import type { CoreClient } from '../core'
import { nameSchema, run, runWrite, scopeArgs, scopeArgsSchema, seg, type ToolSurface } from './shared'

const pluginIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'lowercase, dashes and underscores, 1-32 chars (core plugin id)')
const pluginKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9._:-]+$/, 'letters, digits, dot, underscore, colon or dash (core plugin key)')
const configKeySchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9._-]*$/, 'lowercase, may contain digits, dots, dashes and underscores')

/** Core land ids end in `_lnd`, colony ids in `_cny`; the core rejects anything else. */
const landIdSchema = z.string().max(40).regex(/^[a-z0-9_]+_lnd$/, 'must be a lowercase name ending in "_lnd"')
const colonyIdSchema = z.string().max(40).regex(/^[a-z0-9_]+_cny$/, 'must be a lowercase name ending in "_cny"')

export function registerMetaTools(s: ToolSurface, core: CoreClient): void {
  /* ------------------------------------------------------------------ */
  /* connectivity                                                        */
  /* ------------------------------------------------------------------ */

  s.tool(
    'check_core',
    {
      description:
        'Confirm the configured core is reachable and authenticated. Returns the core health payload. Use it first when a call fails with a connection or token error, or to confirm which core this MCP server points at. Does not read any content.',
      inputSchema: z.object({}),
    },
    run(() => core.get('/health')),
  )

  /* ------------------------------------------------------------------ */
  /* land / colony registry (reads)                                      */
  /* ------------------------------------------------------------------ */

  s.tool(
    'list_lands',
    {
      description: 'List all lands registered on the core (global, scope-agnostic).',
      inputSchema: z.object({}),
    },
    run(() => core.get('/_meta/universe/lands')),
  )

  s.tool(
    'list_colonies',
    {
      description:
        'List colonies registered on the core (global, scope-agnostic). withinLand narrows the list to one land; leave it out for every colony the session can see.',
      inputSchema: z.object({ withinLand: z.string().optional(), ...scopeArgs }),
    },
    run(({ withinLand, ...scope }: { withinLand?: string } & z.infer<typeof scopeArgsSchema>) =>
      core.get('/_meta/universe/colonies', { land: withinLand }, scope),
    ),
  )

  s.tool(
    'get_land',
    {
      description: 'Read one land from the core registry. Returns FORBIDDEN when the session is not scoped to it.',
      inputSchema: z.object({ id: landIdSchema }),
    },
    run(({ id }: { id: string }) => core.get(`/_meta/universe/lands/${seg(id)}`)),
  )

  s.tool(
    'get_colony',
    {
      description: 'Read one colony from the core registry. withinLand is only needed when the session is not already pinned to a land.',
      inputSchema: z.object({ id: colonyIdSchema, withinLand: landIdSchema.optional() }),
    },
    run(({ id, withinLand }: { id: string; withinLand?: string }) =>
      core.get(`/_meta/universe/colonies/${seg(id)}`, { land: withinLand }),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* stats + settings + localization                                     */
  /* ------------------------------------------------------------------ */

  s.tool(
    'get_stats',
    {
      description: 'Dashboard stats from the core: collection count, total records, media assets, groups, and a per-collection breakdown.',
      inputSchema: z.object({ ...scopeArgs }),
    },
    run(({ land, colony }: z.infer<typeof scopeArgsSchema>) => core.get('/_meta/stats', undefined, { land, colony })),
  )

  s.tool(
    'get_settings',
    {
      description: 'Read the KV settings blob (site name, navigation, localization, etc.) of the active land/colony scope.',
      inputSchema: z.object({ ...scopeArgs }),
    },
    run(({ land, colony }: z.infer<typeof scopeArgsSchema>) => core.get('/_meta/settings', undefined, { land, colony })),
  )

  s.tool(
    'update_settings',
    {
      description: 'Shallow-merge a patch into the KV settings blob of the active land/colony scope (write tool; disabled in read-only mode). Nested objects are replaced whole, not merged.',
      inputSchema: z.object({
        patch: z.record(z.string(), z.unknown()).describe('Partial settings object merged into the stored settings.'),
        ...scopeArgs,
      }),
    },
    runWrite(core, ({ patch, land, colony }: { patch: Record<string, unknown>; land?: string; colony?: string }) =>
      core.put('/_meta/settings', patch, { land, colony }),
    ),
  )

  s.tool(
    'get_localization',
    {
      description:
        'Read the resolved localization config: default locale, every declared locale, and whether the project is multilingual. Returns null when the project declares no locales. Read-only — locales themselves come from core.config.ts, not from this tool.',
      inputSchema: z.object({ ...scopeArgs }),
    },
    run(({ land, colony }: z.infer<typeof scopeArgsSchema>) => core.get('/_meta/localization', undefined, { land, colony })),
  )

  /* ------------------------------------------------------------------ */
  /* navigation groups                                                   */
  /* ------------------------------------------------------------------ */

  s.tool(
    'list_groups',
    {
      description: 'List navigation groups registered on the core (id, label, optional parent group id, icon).',
      inputSchema: z.object({ ...scopeArgs }),
    },
    run(({ land, colony }: z.infer<typeof scopeArgsSchema>) => core.get('/_meta/groups', undefined, { land, colony })),
  )

  s.tool(
    'get_group',
    {
      description: 'Read one navigation group by id.',
      inputSchema: z.object({ id: nameSchema, ...scopeArgs }),
    },
    run(({ id, land, colony }: { id: string; land?: string; colony?: string }) =>
      core.get(`/_meta/groups/${seg(id)}`, undefined, { land, colony }),
    ),
  )

  s.tool(
    'put_group',
    {
      description: 'Create or update a navigation group (write tool; disabled in read-only mode). parent must already exist; cycles are rejected.',
      inputSchema: z.object({
        id: nameSchema,
        label: z.string().min(1).max(80),
        parent: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .optional()
          .describe('Parent group id for nesting (must already be registered).'),
        icon: z.string().max(40).optional(),
        ...scopeArgs,
      }),
    },
    runWrite(core, (args: { id: string; label: string; parent?: string; icon?: string; land?: string; colony?: string }) =>
      core.put(`/_meta/groups/${seg(args.id)}`, { id: args.id, label: args.label, parent: args.parent, icon: args.icon }, { land: args.land, colony: args.colony }),
    ),
  )

  s.tool(
    'delete_group',
    {
      description: 'Delete a navigation group (write tool; disabled in read-only mode). Fails while child groups or referencing collections exist.',
      inputSchema: z.object({ id: nameSchema, ...scopeArgs }),
    },
    runWrite(core, (args: { id: string; land?: string; colony?: string }) =>
      core.delete(`/_meta/groups/${seg(args.id)}`, { land: args.land, colony: args.colony }),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* key/value config table                                              */
  /* ------------------------------------------------------------------ */

  /**
   * A `_configs` row belongs to a colony, so every config tool targets one with a query
   * parameter — `scopeArgs` stays what it is everywhere else, the scope the request is
   * *made* from. They are not the same thing: a land admin must be able to read a land
   * (all of its colonies) and write one named colony of it, without that naming becoming
   * the session's scope.
   */
  const configTargetArgs = {
    withinLand: z
      .string()
      .optional()
      .describe('Read every colony of this land. Rejected when withinColony names a colony of another land.'),
    withinColony: z
      .string()
      .optional()
      .describe('One colony. A land-scoped session must name it — the core will not guess which colony to write.'),
  }

  s.tool(
    'list_config',
    {
      description:
        'List key/value configuration entries. Each row carries its own land and colony. With neither withinLand nor withinColony, the core returns everything this session may see; a target it cannot reach is refused rather than silently narrowed.',
      inputSchema: z.object({ ...configTargetArgs, ...scopeArgs }),
    },
    run(({ withinLand, withinColony, ...scope }: { withinLand?: string; withinColony?: string } & z.infer<typeof scopeArgsSchema>) =>
      core.get('/_config', { land: withinLand, colony: withinColony }, scope),
    ),
  )

  s.tool(
    'get_config',
    {
      description:
        'Read one configuration entry by key. A land-scoped session must pass withinColony, because the same key can hold a different value in each colony.',
      inputSchema: z.object({ key: configKeySchema, ...configTargetArgs, ...scopeArgs }),
    },
    run(({ key, withinLand, withinColony, ...scope }: { key: string; withinLand?: string; withinColony?: string } & z.infer<typeof scopeArgsSchema>) =>
      core.get(`/_config/${seg(key)}`, { land: withinLand, colony: withinColony }, scope),
    ),
  )

  s.tool(
    'put_config',
    {
      description:
        'Create or replace a configuration entry (write tool; disabled in read-only mode). value is arbitrary JSON. Upserts on (land, colony, key), so writing a key that exists replaces its value in that colony only. A land-scoped session must pass withinColony.',
      inputSchema: z.object({
        key: configKeySchema,
        value: z.unknown().describe('Arbitrary JSON value stored under this key.'),
        description: z.string().max(255).nullable().optional(),
        ...configTargetArgs,
        ...scopeArgs,
      }),
    },
    runWrite(
      core,
      (args: { key: string; value: unknown; description?: string | null; withinLand?: string; withinColony?: string; land?: string; colony?: string }) =>
        core.put(
          `/_config/${seg(args.key)}`,
          { value: args.value, description: args.description },
          { land: args.land, colony: args.colony },
          { land: args.withinLand, colony: args.withinColony },
        ),
    ),
  )

  s.tool(
    'delete_config',
    {
      description:
        'Delete a configuration entry (write tool; disabled in read-only mode). Deletes it in the named colony only; a land-scoped session must pass withinColony.',
      inputSchema: z.object({ key: configKeySchema, ...configTargetArgs, ...scopeArgs }),
    },
    runWrite(core, (args: { key: string; withinLand?: string; withinColony?: string; land?: string; colony?: string }) =>
      core.delete(`/_config/${seg(args.key)}`, { land: args.land, colony: args.colony }, { land: args.withinLand, colony: args.withinColony }),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* plugin storage                                                      */
  /* ------------------------------------------------------------------ */

  s.tool(
    'list_plugin_values',
    {
      description: 'List every key a plugin has stored in the core (the plugin KV prefix, e.g. the console todo or kanban plugin).',
      inputSchema: z.object({ plugin: pluginIdSchema, ...scopeArgs }),
    },
    run(({ plugin, land, colony }: { plugin: string; land?: string; colony?: string }) =>
      core.get(`/_plugins/${seg(plugin)}`, undefined, { land, colony }),
    ),
  )

  s.tool(
    'get_plugin_value',
    {
      description: 'Read one plugin entry. The value is arbitrary JSON as the plugin wrote it.',
      inputSchema: z.object({ plugin: pluginIdSchema, key: pluginKeySchema, ...scopeArgs }),
    },
    run(({ plugin, key, land, colony }: { plugin: string; key: string; land?: string; colony?: string }) =>
      core.get(`/_plugins/${seg(plugin)}/${seg(key)}`, undefined, { land, colony }),
    ),
  )

  s.tool(
    'put_plugin_value',
    {
      description: 'Create or replace a plugin entry (write tool; disabled in read-only mode). The body may be any JSON value, including null, an object or an array.',
      inputSchema: z.object({
        plugin: pluginIdSchema,
        key: pluginKeySchema,
        value: z.unknown().describe('Any JSON value; stored verbatim.'),
        ...scopeArgs,
      }),
    },
    runWrite(core, (args: { plugin: string; key: string; value: unknown; land?: string; colony?: string }) =>
      core.put(`/_plugins/${seg(args.plugin)}/${seg(args.key)}`, args.value, { land: args.land, colony: args.colony }),
    ),
  )

  s.tool(
    'delete_plugin_value',
    {
      description: 'Delete a plugin entry (write tool; disabled in read-only mode).',
      inputSchema: z.object({ plugin: pluginIdSchema, key: pluginKeySchema, ...scopeArgs }),
    },
    runWrite(core, (args: { plugin: string; key: string; land?: string; colony?: string }) =>
      core.delete(`/_plugins/${seg(args.plugin)}/${seg(args.key)}`, { land: args.land, colony: args.colony }),
    ),
  )
}
