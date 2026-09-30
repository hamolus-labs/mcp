/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { CoreClient } from './core'
import { registerDynamicTools } from './dynamic-tools'
import type { Env } from './env'
import { registerPrompts } from './prompts'
import { registerResources } from './resources'
import { registerTools } from './tools'

const SERVER_NAME = 'hamolus'
const SERVER_VERSION = '0.2.10'
const MCP_ROUTE = '/mcp'

/** What this server offers, in one line each — the root JSON and the logs. */
const SURFACE = {
  tools: 'Static tool groups plus optional per-collection tools, as configured for this instance in the console.',
  resources: 'hamolus:// URIs for collections, records, settings, stats and assets (instance default scope).',
  prompts: 'Task-shaped starting points: explore, draft, bulk import, review, migrate, media tidy, provision user.',
} as const

/**
 * Build the MCP server for one request.
 *
 * The handler is stateless, so this runs on every request. The one thing that
 * is *not* re-fetched per request is the instance config: `core.ready()` caches
 * it, which is what lets `defaultScope` and `readonly` be plain getters instead
 * of arguments threaded through every tool.
 *
 * A failure here — a disabled instance, a stale instance id, a core that cannot
 * be reached — becomes a 4xx/5xx on `POST /mcp` with the core's own wording.
 * That is deliberate: an MCP server that answers `/mcp` with an empty tool list
 * looks to a client like a server with nothing to offer, and the actual reason is
 * one click away in the console.
 */
async function createServer(env: Env, core: CoreClient): Promise<McpServer> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const surface = registerTools(server, core)
  await registerDynamicTools(surface, core, env)
  registerResources(server, core)
  registerPrompts(server)
  return server
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** The bearer the client sent, without the scheme. */
function bearerOf(request: Request): string {
  const auth = request.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

function isManaged(env: Env): boolean {
  return Boolean(env.MCP_INSTANCE_ID)
}

function rootJson(env: Env): Response {
  const managed = isManaged(env)
  return json({
    ok: true,
    service: `${SERVER_NAME} MCP server`,
    transport: 'Streamable HTTP (stateless)',
    endpoint: `POST ${MCP_ROUTE} — headers: Authorization: Bearer <token>`,
    mode: managed ? 'console-managed' : 'legacy',
    ...(managed
      ? {
          instance: env.MCP_INSTANCE_ID,
          note: 'Scope, read-only and tool groups come from the console. Issue a token there and send it as the bearer.',
        }
      : {
          warning:
            'No MCP_INSTANCE_ID set. This deployment is on the deprecated env path: it holds an admin key and reaches every land and colony. Create the instance in the console and set MCP_INSTANCE_ID.',
        }),
    ...SURFACE,
    discover: 'initialize / tools/list / resources/list / resources/templates/list / prompts/list',
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (request.method === 'GET' && pathname !== MCP_ROUTE) {
      return rootJson(env)
    }

    const bearer = bearerOf(request)

    if (isManaged(env)) {
      // A console-managed server has no shared secret to compare: the token is
      // per user and is exchanged by the core. Refusing here saves a round trip
      // and turns "you forgot the header" into a sentence instead of a 500 from
      // the exchange.
      if (!bearer) {
        return json(
          {
            error: {
              code: 'UNAUTHORIZED',
              message: 'This MCP server is console-managed. Send `Authorization: Bearer <token>` with a token issued in the console.',
            },
          },
          401,
        )
      }
    } else if (env.MCP_BEARER_TOKEN && bearer !== env.MCP_BEARER_TOKEN) {
      return json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid MCP bearer token' } },
        401,
      )
    }

    try {
      // Resolve the instance config and exchange the token *here*, before the SDK's
      // handler is involved.
      //
      // `createMcpHandler` catches whatever its factory throws and reports it as a
      // generic JSON-RPC `-32603 Internal server error`. So if the config load lived
      // inside the factory — as it did — a disabled instance, a revoked token and a
      // stale instance id all reached the client as the same nameless failure, and
      // the `catch` below that exists precisely to pass the core's wording through
      // never ran. Doing it in this frame means the real status and the core's own
      // `MCP_DISABLED` / `TOKEN_REVOKED` survive to the caller, where they name the
      // thing to fix in the console.
      const core = new CoreClient(env, bearer)
      await core.ready()
      const handler = createMcpHandler(() => createServer(env, core), { route: MCP_ROUTE })
      return await handler(request, env, ctx)
    } catch (err) {
      // `createServer` runs inside the handler, so a config or auth failure lands
      // here. Passing the message through verbatim is the point: "MCP_DISABLED"
      // or "TOKEN_REVOKED" names the thing to fix in the console, where a
      // generic transport error names nothing.
      const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 502
      const code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'CORE_UNAVAILABLE'
      return json({ error: { code, message: (err as Error)?.message ?? 'Upstream error' } }, status)
    }
  },
}
