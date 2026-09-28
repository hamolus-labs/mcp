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
 * Collection definitions, and the per-collection MCP policy that reads them.
 *
 * Everything the server knows about a collection's *shape* comes from the core,
 * never from a local copy — `/_meta/collections` plus `/_meta/localization` for
 * the locale codes `buildEntitySchema` needs. The server is stateless (a fresh
 * `McpServer` per request), so that pair is cached in a module-level map with a
 * short TTL and dropped whenever a definition is written.
 *
 * The cache is what makes enforcement affordable. A `mcp: 'read'` collection has
 * to be refused on `create_record`, `update_record`, `delete_record`,
 * `bulk_delete_records`, the generated tools, and three resource templates — and
 * a check that re-fetched the definition on each of those would be a core call
 * per tool call for a decision that changes about once a month.
 */

import { collectionMcpMode, type CollectionDefinition, type McpCollectionMode, type ResolvedLocalization } from '@hamolus/types'
import type { CoreClient, ScopeOpt } from './core'

/** How long a fetched definition set stays valid, in milliseconds. */
const TTL_MS = 5 * 60 * 1000

const globalStore = globalThis as {
  __mcpDefinitionCache?: Map<string, { at: number; defs: CollectionDefinition[]; languages: string[] }>
} & typeof globalThis

export interface Definitions {
  defs: CollectionDefinition[]
  languages: string[]
}

/** Drop every cached definition belonging to `core`'s base URL. */
export function invalidateDefinitionCache(core: CoreClient): void {
  const cache = globalStore.__mcpDefinitionCache
  if (!cache) return
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${core.baseUrl}|`)) cache.delete(key)
  }
}

/** The cache key for one effective scope. */
function cacheKey(core: CoreClient, scope: ScopeOpt): string {
  return `${core.baseUrl}|${scope.land ?? core.defaultScope.land ?? ''}|${scope.colony ?? core.defaultScope.colony ?? ''}`
}

/**
 * Fetch the collection definitions and locale codes for one scope, cached.
 *
 * A core that is unreachable or answers an error yields an empty set: the static
 * tools stay usable, and enforcement degrades to the default mode rather than
 * taking the whole `/mcp` endpoint down with it.
 */
export async function loadDefinitions(core: CoreClient, scope: ScopeOpt = {}): Promise<Definitions> {
  const key = cacheKey(core, scope)
  const cache = (globalStore.__mcpDefinitionCache ??= new Map())
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit

  let defs: CollectionDefinition[] = []
  let languages: string[] = []
  try {
    const [collections, localization] = await Promise.all([
      core.get('/_meta/collections', {}, scope) as Promise<{ data?: CollectionDefinition[] }>,
      core.get('/_meta/localization', {}, scope) as Promise<{ data?: ResolvedLocalization | null }>,
    ])
    defs = collections.data ?? []
    languages = localization.data?.locales?.map((locale) => locale.code) ?? []
  } catch {
    defs = []
    languages = []
  }
  cache.set(key, { at: Date.now(), defs, languages })
  return { defs, languages }
}

/** One definition by name, or `undefined` if this scope has no such collection. */
export async function findDefinition(
  core: CoreClient,
  name: string,
  scope: ScopeOpt = {},
): Promise<CollectionDefinition | undefined> {
  const { defs } = await loadDefinitions(core, scope)
  return defs.find((def) => def.name === name)
}

/**
 * The MCP mode of a collection.
 *
 * A name this scope does not register resolves to `read`, the documented
 * default. That is the safe order of operations: the core is about to reject an
 * unregistered collection anyway, and inventing a stricter mode for a typo would
 * turn a clear 404 into a confusing policy refusal.
 */
export async function mcpModeOf(core: CoreClient, name: string, scope: ScopeOpt = {}): Promise<McpCollectionMode> {
  const def = await findDefinition(core, name, scope)
  return def ? collectionMcpMode(def) : 'read'
}

/** Whether a definition is visible to MCP at all. */
export function isHidden(def: CollectionDefinition): boolean {
  return collectionMcpMode(def) === 'hide'
}

/** Whether a definition's records may be written through MCP. */
export function isWritable(def: CollectionDefinition): boolean {
  return collectionMcpMode(def) === 'write'
}

/** Strip the hidden collections out of a listing before it reaches the model. */
export function visibleDefinitions(defs: CollectionDefinition[]): CollectionDefinition[] {
  return defs.filter((def) => !isHidden(def))
}

/**
 * Refuse anything at all against a collection this server may not see.
 *
 * Separate from `assertMcpAllows` because collection *management* has a different
 * rule from record access: a `read` collection still needs its definition
 * editable (that is how a collection is set up in the first place), but a
 * `hide` one does not — otherwise "hidden" would be undone by the very tool that
 * declares it.
 */
export async function assertMcpVisible(core: CoreClient, name: string, scope: ScopeOpt = {}): Promise<void> {
  if ((await mcpModeOf(core, name, scope)) !== 'hide') return
  throw new Error(
    `The '${name}' collection is hidden from MCP (mcp: 'hide' in its definition). This server may not read it, list it, or change it.`,
  )
}

/**
 * Refuse a call the collection's `mcp` mode does not permit.
 *
 * The message names the collection and both modes on purpose: the model has to be
 * able to explain *why* without reading this file, and the fix ("set mcp to
 * 'write'") has to be in the message.
 */
export async function assertMcpAllows(
  core: CoreClient,
  name: string,
  verb: 'read' | 'write',
  scope: ScopeOpt = {},
): Promise<void> {
  const mode = await mcpModeOf(core, name, scope)
  if (mode === 'hide') {
    throw new Error(
      `The '${name}' collection is hidden from MCP (mcp: 'hide' in its definition). This server may not read it, list it, or change it.`,
    )
  }
  if (verb === 'write' && mode === 'read') {
    throw new Error(
      `The '${name}' collection is read-only through MCP (mcp: 'read' in its definition). Set mcp to 'write' to let this server change records.`,
    )
  }
}
