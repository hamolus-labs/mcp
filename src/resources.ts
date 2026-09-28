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
 * MCP resources: a read-only, URI-addressable view of the same core API the
 * tools call.
 *
 * **Why both.** A tool takes arguments and returns text the model has to parse;
 * a resource takes a URI and returns a document the client can attach, diff or
 * cache. The one thing worth having twice is "what does this collection look
 * like" and "what is in this record" — a client UI can list
 * `hamolus://collection/<name>` and follow links without spending a tool call.
 *
 * **One deliberate limitation.** A resource URI carries no arguments, so every
 * resource resolves against the *server's* land/colony (`CORE_LAND`/`CORE_COLONY`)
 * and the default locale. To read another scope or resolve localized fields to a
 * specific language, use the tools — they take `land`, `colony` and `locale`.
 *
 * **The collection's own `mcp` mode applies here too.** A `hide` collection is
 * absent from `hamolus://collections`, absent from the enumerated
 * `hamolus://collection/{collection}` URIs, and refused on read; a `read`
 * collection reads fine. Resources are a second way in, so a mode enforced only
 * on the tools would be a mode with a hole in it.
 *
 * Every payload is the core's own JSON, pretty-printed, so a resource and the
 * equivalent tool call return the same bytes.
 */

import { z } from 'zod'
import { ResourceTemplate, type McpServer, type ReadResourceResult, type Variables } from '@modelcontextprotocol/server'
import { collectionDefinitionSchema, type CollectionDefinition } from '@hamolus/types'
import { assertMcpAllows, visibleDefinitions } from './collections'
import type { CoreClient } from './core'
import { seg } from './tools/shared'

/** The URI scheme every resource lives under. */
export const RESOURCE_SCHEME = 'hamolus'

/** Cap on a resource payload; past this the read is refused rather than truncated. */
const RESOURCE_MAX = 1_000_000

/**
 * Wrap a *pending* core payload as a JSON resource document.
 *
 * The parameter is a Promise on purpose, so that the `await` cannot be left out
 * at a call site. `JSON.stringify` on a pending promise does not throw — it
 * returns `"{}"`, which reaches the client as a resource that looks perfectly
 * valid and is empty. Making the argument a promise moves the mistake from a
 * silent data bug to a compile error.
 */
async function doc(uri: string, pending: Promise<unknown>): Promise<ReadResourceResult> {
  return docOf(uri, await pending)
}

/** The same document, for a payload that is already in hand. */
async function docOf(uri: string, value: unknown): Promise<ReadResourceResult> {
  const text = JSON.stringify(value, null, 2)
  if (text.length > RESOURCE_MAX) {
    throw new Error(
      `Resource payload is ${text.length} chars, over the ${RESOURCE_MAX} limit. Narrow it with a list tool (search, filter, pageSize) instead.`,
    )
  }
  return { contents: [{ uri, mimeType: 'application/json', text }] }
}

export function registerResources(server: McpServer, core: CoreClient): void {
  /* ------------------------------------------------------------------ */
  /* scope-wide documents                                                */
  /* ------------------------------------------------------------------ */

  server.registerResource(
    'collections',
    `${RESOURCE_SCHEME}://collections`,
    {
      title: 'Collection index',
      description: 'Every collection defined in this scope, with its full field definition. Start here.',
      mimeType: 'application/json',
    },
    // A hidden collection is not part of this server's surface, so it is not in
    // the index either — a model that finds it in tools/list and then gets a
    // refusal on every read is worse off than one that never saw it.
    async (uri) => {
      const resp = (await core.get('/_meta/collections')) as { data?: CollectionDefinition[] }
      return docOf(uri.href, { data: visibleDefinitions(resp.data ?? []) })
    },
  )

  server.registerResource(
    'settings',
    `${RESOURCE_SCHEME}://settings`,
    {
      title: 'Settings',
      description: 'The KV settings blob of this scope: site name, navigation, localization and anything else an operator changed.',
      mimeType: 'application/json',
    },
    (uri) => doc(uri.href, core.get('/_meta/settings')),
  )

  server.registerResource(
    'localization',
    `${RESOURCE_SCHEME}://localization`,
    {
      title: 'Localization',
      description: 'Resolved localization config: default locale, declared locales, multilingual flag. null when none are declared.',
      mimeType: 'application/json',
    },
    (uri) => doc(uri.href, core.get('/_meta/localization')),
  )

  server.registerResource(
    'stats',
    `${RESOURCE_SCHEME}://stats`,
    {
      title: 'Dashboard stats',
      description: 'Collection count, total records, media assets, groups and a per-collection row count.',
      mimeType: 'application/json',
    },
    (uri) => doc(uri.href, core.get('/_meta/stats')),
  )

  server.registerResource(
    'lands',
    `${RESOURCE_SCHEME}://lands`,
    {
      title: 'Land registry',
      description: 'Every land registered on the core.',
      mimeType: 'application/json',
    },
    (uri) => doc(uri.href, core.get('/_meta/universe/lands')),
  )

  server.registerResource(
    'groups',
    `${RESOURCE_SCHEME}://groups`,
    {
      title: 'Navigation groups',
      description: 'The navigation group tree of this scope.',
      mimeType: 'application/json',
    },
    (uri) => doc(uri.href, core.get('/_meta/groups')),
  )

  /* ------------------------------------------------------------------ */
  /* the shape itself                                                     */
  /* ------------------------------------------------------------------ */

  server.registerResource(
    'spec',
    `${RESOURCE_SCHEME}://spec/collection-definition`,
    {
      title: 'Collection definition schema',
      description:
        'The JSON Schema a collection definition must satisfy: every key, every field type, and which are required. ' +
        'Read this before put_collection rather than guessing a field type — a wrong type is the single most common ' +
        'rejection, and there is no "integer" (a whole number is "number").',
      mimeType: 'application/schema+json',
    },
    // Rendered from the core's own schema rather than written out here. The MCP
    // package must never restate a field type: the moment it does, a type added
    // to `@hamolus/types` reaches the core and not this document, and the model
    // is told a list that has already drifted.
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/schema+json',
          text: JSON.stringify(z.toJSONSchema(collectionDefinitionSchema, { io: 'input' }), null, 2),
        },
      ],
    }),
  )

  /* ------------------------------------------------------------------ */
  /* templated documents                                                 */
  /* ------------------------------------------------------------------ */

  server.registerResource(
    'collection',
    new ResourceTemplate(`${RESOURCE_SCHEME}://collection/{collection}`, {
      // Enumerating here is what makes the collection index browsable: a client
      // lists `resources/list` and gets one URI per real collection.
      //
      // The SDK folds this into the `resources/list` response, which has no
      // per-item error channel — a throwing callback would cost the caller the
      // six static resources above as well. So a core that is unreachable or
      // unauthenticated yields no generated URIs instead of failing the whole
      // listing; `hamolus://collections` still returns the real error on read.
      list: async () => {
        try {
          const resp = (await core.get('/_meta/collections')) as { data?: CollectionDefinition[] }
          return {
            resources: visibleDefinitions(resp.data ?? []).map((def) => ({
              uri: `${RESOURCE_SCHEME}://collection/${encodeURIComponent(def.name)}`,
              name: def.name,
              title: def.label ?? def.name,
              description: def.description ?? `Field definition of the ${def.name} collection`,
              mimeType: 'application/json',
            })),
          }
        } catch {
          return { resources: [] }
        }
      },
    }),
    {
      title: 'Collection definition',
      description: 'Field definition of one collection: types, required flags, relations, localization, console layout.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const name = first(variables, 'collection')
      await assertMcpAllows(core, name, 'read')
      return doc(uri.href, core.get(`/_meta/collections/${seg(name)}`))
    },
  )

  server.registerResource(
    'records',
    new ResourceTemplate(`${RESOURCE_SCHEME}://records/{collection}`, { list: undefined }),
    {
      title: 'Record list',
      description: 'First page (25 rows) of one collection. Paginate with the list_records tool.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const name = first(variables, 'collection')
      await assertMcpAllows(core, name, 'read')
      return doc(uri.href, core.get(`/${seg(name)}`, { page: 1, pageSize: 25 }))
    },
  )

  server.registerResource(
    'record',
    new ResourceTemplate(`${RESOURCE_SCHEME}://record/{collection}/{id}`, { list: undefined }),
    {
      title: 'Record',
      description: 'One record by primary key, in the default locale.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const name = first(variables, 'collection')
      await assertMcpAllows(core, name, 'read')
      return doc(uri.href, core.get(`/${seg(name)}/${seg(first(variables, 'id'))}`))
    },
  )

  for (const [name, path, label] of [
    ['media', '/_media', 'Media asset'],
    ['document', '/_documents', 'Document'],
    ['attachment', '/_attachments', 'Attachment'],
  ] as const) {
    server.registerResource(
      name,
      new ResourceTemplate(`${RESOURCE_SCHEME}://${name}/{id}`, { list: undefined }),
      {
        title: label,
        description: `Metadata and absolute url of one ${name} asset. The bytes themselves are not inlined.`,
        mimeType: 'application/json',
      },
      (uri, variables) => doc(uri.href, core.get(`${path}/${seg(first(variables, 'id'))}`)),
    )
  }

  server.registerResource(
    'group',
    new ResourceTemplate(`${RESOURCE_SCHEME}://group/{id}`, { list: undefined }),
    {
      title: 'Navigation group',
      description: 'One navigation group by id.',
      mimeType: 'application/json',
    },
    (uri, variables) => doc(uri.href, core.get(`/_meta/groups/${seg(first(variables, 'id'))}`)),
  )

  server.registerResource(
    'config',
    new ResourceTemplate(`${RESOURCE_SCHEME}://config/{key}`, { list: undefined }),
    {
      title: 'Config entry',
      description: 'One key/value configuration entry.',
      mimeType: 'application/json',
    },
    (uri, variables) => doc(uri.href, core.get(`/_config/${seg(first(variables, 'key'))}`)),
  )
}

/** RFC 6570 lets a variable expand to several values; a resource path wants one. */
function first(variables: Variables, name: string): string {
  const value = variables[name]
  const single = Array.isArray(value) ? value[0] : value
  if (typeof single !== 'string' || single === '') {
    throw new Error(`Resource URI is missing the {${name}} segment.`)
  }
  return single
}
