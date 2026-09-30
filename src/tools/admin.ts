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
 * The `admin` tool group: accounts, roles, the land/colony registry writes, and
 * whole-scope export/import.
 *
 * This group is **off by default** (see `MCP_TOOL_GROUPS` in the console). Everything in it can
 * reshape who else may reach the core or destroy a tenant outright, so a
 * deployment has to name it before the surface appears. A read-only instance still
 * refuses every write here on top of that.
 */

import { PERMISSIONS } from '@hamolus/types'
import { z } from 'zod'
import type { CoreClient } from '../core'
import { filterArg, paginationArgs, run, runWrite, scopeArgs, scopeArgsSchema, seg, type ToolSurface } from './shared'

/** Core land ids end in `_lnd`, colony ids in `_cny`; the core rejects anything else. */
const landIdSchema = z.string().max(40).regex(/^[a-z0-9_]+_lnd$/, 'must be a lowercase name ending in "_lnd"')
const colonyIdSchema = z.string().max(40).regex(/^[a-z0-9_]+_cny$/, 'must be a lowercase name ending in "_cny"')

export function registerAdminTools(s: ToolSurface, core: CoreClient): void {
  /* ------------------------------------------------------------------ */
  /* who am I                                                            */
  /* ------------------------------------------------------------------ */

  s.tool(
    'get_current_user',
    {
      description:
        'Resolve the identity this MCP server authenticates as: the user, its privilege role and the permissions that role carries. ' +
        'A CORE_ADMIN_KEY token resolves to a synthetic admin with every permission. Run this when a call fails with FORBIDDEN to see what is actually granted.',
      inputSchema: z.object({}),
    },
    run(() => core.get('/_auth/me')),
  )

  /* ------------------------------------------------------------------ */
  /* users                                                               */
  /* ------------------------------------------------------------------ */

  s.tool(
    'list_users',
    {
      description: 'List the accounts in the active scope with their privilege role and active flag. Not paginated by the core.',
      inputSchema: z.object({ ...scopeArgs }),
    },
    run(({ land, colony }: z.infer<typeof scopeArgsSchema>) => core.get('/_auth/users', undefined, { land, colony })),
  )

  s.tool(
    'create_user',
    {
      description:
        'Create an account (write tool; disabled in read-only mode). privilegeId must be an existing privileges record id — read them ' +
        'with list_privileges. The password is stored hashed; it is never returned afterwards.',
      inputSchema: z.object({
        username: z.string().min(2).max(40).regex(/^[a-z0-9_]+$/, 'lowercase letters, numbers and underscores'),
        name: z.string().min(1).max(80),
        password: z.string().min(8).max(128),
        privilegeId: z.string().min(1).describe('privileges.id of the role to grant.'),
        isActive: z.boolean().optional().describe('Defaults to active on the core.'),
        ...scopeArgs,
      }),
    },
    runWrite(core, (args: { username: string; name: string; password: string; privilegeId: string; isActive?: boolean; land?: string; colony?: string }) =>
      core.post(
        '/_auth/users',
        { username: args.username, name: args.name, password: args.password, privilegeId: args.privilegeId, isActive: args.isActive },
        { land: args.land, colony: args.colony },
      ),
    ),
  )

  s.tool(
    'update_user',
    {
      description:
        'Update an account (write tool; disabled in read-only mode). Send only what changes: name, password reset, privilegeId, isActive. ' +
        'The core refuses to demote or remove the last active admin in a scope.',
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(80).optional(),
        password: z.string().min(8).max(128).optional().describe('New password; resets the old one without asking for it.'),
        privilegeId: z.string().min(1).optional(),
        isActive: z.boolean().optional().describe('false suspends the account without deleting it.'),
        ...scopeArgs,
      }),
    },
    runWrite(core, (args: { id: string; name?: string; password?: string; privilegeId?: string; isActive?: boolean; land?: string; colony?: string }) => {
      const patch: Record<string, unknown> = {}
      for (const key of ['name', 'password', 'privilegeId', 'isActive'] as const) {
        if (args[key] !== undefined) patch[key] = args[key]
      }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to update: send at least one of name, password, privilegeId, isActive.')
      return core.put(`/_auth/users/${seg(args.id)}`, patch, { land: args.land, colony: args.colony })
    }),
  )

  s.tool(
    'delete_user',
    {
      description:
        'Delete an account (write tool; disabled in read-only mode). Hard delete — use isActive:false via update_user to suspend instead. ' +
        'The core refuses to remove the last active admin in a scope.',
      inputSchema: z.object({ id: z.string().min(1).max(64), ...scopeArgs }),
    },
    runWrite(core, (args: { id: string; land?: string; colony?: string }) =>
      core.delete(`/_auth/users/${seg(args.id)}`, { land: args.land, colony: args.colony }),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* privileges (roles)                                                  */
  /* ------------------------------------------------------------------ */

  s.tool(
    'list_privileges',
    {
      description:
        'List the roles in the active scope and the permissions each one grants. Roles live in the platform-owned `privileges` ' +
        'collection, so this is a record read, not a dedicated endpoint.',
      inputSchema: z.object({ filter: filterArg, ...paginationArgs, ...scopeArgs }),
    },
    run((args: { filter?: Record<string, unknown>; page?: number; pageSize?: number; land?: string; colony?: string }) =>
      core.get(
        '/privileges',
        {
          page: args.page,
          pageSize: args.pageSize,
          filter: args.filter ? JSON.stringify(args.filter) : undefined,
        },
        { land: args.land, colony: args.colony },
      ),
    ),
  )

  s.tool(
    'put_privilege',
    {
      description:
        'Create or update a role (write tool; disabled in read-only mode). The privileges collection is platform-owned, so this tool ' +
        'cannot change its schema — only its records. Omit id to create, supply it to update. `name` is a slug and must be unique; ' +
        '`scope` decides how far the role reaches (universe, land or colony).',
      inputSchema: z.object({
        id: z.string().max(200).optional().describe('Record id. Omit to create a new role.'),
        name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words separated by dashes'),
        label: z.string().min(1).max(255),
        scope: z.enum(['universe', 'land', 'colony']).default('colony'),
        description: z.string().optional(),
        permissions: z
          .array(z.enum(PERMISSIONS))
          .max(PERMISSIONS.length)
          .default([])
          .describe('Grants for this role. Empty means read nothing.'),
        is_system: z.boolean().optional().describe('Marks a platform role; leave unset for your own.'),
        ...scopeArgs,
      }),
    },
    runWrite(
      core,
      (args: {
        id?: string
        name: string
        label: string
        scope: 'universe' | 'land' | 'colony'
        description?: string
        permissions: string[]
        is_system?: boolean
        land?: string
        colony?: string
      }) => {
        const record: Record<string, unknown> = {
          name: args.name,
          label: args.label,
          scope: args.scope,
          permissions: args.permissions,
        }
        if (args.description !== undefined) record.description = args.description
        if (args.is_system !== undefined) record.is_system = args.is_system
        if (args.id === undefined) {
          return core.post('/privileges', record, { land: args.land, colony: args.colony })
        }
        return core.put(`/privileges/${seg(args.id)}`, record, { land: args.land, colony: args.colony })
      },
    ),
  )

  s.tool(
    'delete_privilege',
    {
      description:
        'Delete a role (write tool; disabled in read-only mode). The core does not check for accounts still pointing at it — they simply ' +
        'lose their grants — so run list_users first if the role is in use. Deleting the privileges collection itself re-seeds the five ' +
        'system roles on the next boot.',
      inputSchema: z.object({ id: z.string().max(200), ...scopeArgs }),
    },
    runWrite(core, (args: { id: string; land?: string; colony?: string }) =>
      core.delete(`/privileges/${seg(args.id)}`, { land: args.land, colony: args.colony }),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* land / colony writes                                                */
  /* ------------------------------------------------------------------ */

  s.tool(
    'put_land',
    {
      description:
        'Create or update a land (write tool; disabled in read-only mode). Only a universe-scoped session may do this; a land admin ' +
        'gets FORBIDDEN. The id is permanent once created — the core has no rename.',
      inputSchema: z.object({
        id: landIdSchema,
        label: z.string().min(1).max(80),
        description: z.string().max(255).nullable().optional(),
        ownerUserId: z.string().max(64).nullable().optional().describe('User id of the land admin that owns this land.'),
      }),
    },
    runWrite(core, (args: { id: string; label: string; description?: string | null; ownerUserId?: string | null }) =>
      core.put(`/_meta/universe/lands/${seg(args.id)}`, {
        id: args.id,
        label: args.label,
        description: args.description,
        ownerUserId: args.ownerUserId,
      }),
    ),
  )

  s.tool(
    'delete_land',
    {
      description:
        'Delete a land and everything inside it (write tool; disabled in read-only mode). Cascades over collections, records, groups, ' +
        'config, accounts, settings, media, documents, attachments, panels and panel assets. There is no undo and no dry run.',
      inputSchema: z.object({ id: landIdSchema }),
    },
    runWrite(core, ({ id }: { id: string }) => core.delete(`/_meta/universe/lands/${seg(id)}`)),
  )

  s.tool(
    'put_colony',
    {
      description:
        'Create or update a colony under a land (write tool; disabled in read-only mode). A colony is a full data namespace: give it a ' +
        'distinct id and the core will bootstrap its privileges and its own collections.',
      inputSchema: z.object({
        id: colonyIdSchema,
        landId: landIdSchema.describe('The land this colony belongs to.'),
        label: z.string().min(1).max(80),
        description: z.string().max(255).nullable().optional(),
        ownerUserId: z.string().max(64).nullable().optional(),
      }),
    },
    runWrite(core, (args: { id: string; landId: string; label: string; description?: string | null; ownerUserId?: string | null }) =>
      core.put(
        `/_meta/universe/colonies/${seg(args.id)}`,
        { id: args.id, landId: args.landId, label: args.label, description: args.description, ownerUserId: args.ownerUserId },
        { land: args.landId },
      ),
    ),
  )

  s.tool(
    'delete_colony',
    {
      description: 'Delete a colony and its data (write tool; disabled in read-only mode). There is no undo and no dry run.',
      inputSchema: z.object({ id: colonyIdSchema, withinLand: landIdSchema.optional() }),
    },
    runWrite(core, ({ id, withinLand }: { id: string; withinLand?: string }) =>
      core.delete(`/_meta/universe/colonies/${seg(id)}`, { land: withinLand }),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* whole-scope export / import                                         */
  /* ------------------------------------------------------------------ */

  s.tool(
    'export_scope',
    {
      description:
        'Export a scope as a seed snapshot: settings, groups, collection definitions, records and media metadata. `scope: all` (the ' +
        'default) takes the whole land or colony; pass a collection name to take just that one. `media: bytes` inlines the R2 objects as ' +
        'base64 and makes the response far larger. Excludes the privileges collection, panel manifests, panel assets, documents and attachments. ' +
        'Returns a snapshot you can feed straight back to import_scope.',
      inputSchema: z.object({
        scope: z.string().max(64).optional().describe('"all" (default) or a single collection name.'),
        media: z.enum(['none', 'bytes']).optional().describe('"none" (default) keeps metadata only; "bytes" inlines the R2 objects.'),
        ...scopeArgs,
      }),
    },
    run(({ scope, media, land, colony }: { scope?: string; media?: 'none' | 'bytes'; land?: string; colony?: string }) =>
      core.get('/_meta/seed/export', { scope, media }, { land, colony }),
    ),
  )

  s.tool(
    'import_scope',
    {
      description:
        'Restore a scope from a seed snapshot (write tool; disabled in read-only mode). DESTRUCTIVE: `wipe` defaults to true, which clears ' +
        'the target scope before restoring. Pass wipe:false to merge instead. Does not restore panel manifests, panel assets, documents or ' +
        'attachments — those are not in the snapshot. Take an export_scope first if the target has content you care about.',
      inputSchema: z.object({
        snapshot: z.record(z.string(), z.unknown()).describe('A SeedSnapshot JSON, as returned by export_scope.'),
        wipe: z.boolean().default(true).describe('true (default) clears the scope first; false merges into what is there.'),
        ...scopeArgs,
      }),
    },
    runWrite(core, ({ snapshot, wipe, land, colony }: { snapshot: Record<string, unknown>; wipe: boolean; land?: string; colony?: string }) =>
      core.post('/_meta/seed/apply', snapshot, { land, colony }, { wipe }),
    ),
  )
}
