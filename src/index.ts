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
const SERVER_VERSION = '0.2.9'
const MCP_ROUTE = '/mcp'

/** What this server offers, in one line each — the root JSON and the logs. */
const SURFACE = {
  tools: 'Static tool groups plus optional per-collection tools (MCP_TOOL_GROUPS, MCP_DYNAMIC_TOOLS).',
  resources: 'hamolus:// URIs for collections, records, settings, stats and assets (server default scope).',
  prompts: 'Task-shaped starting points: explore, draft, bulk import, review, migrate, media tidy, provision user.',
} as const

/**
 * Build the MCP server for one request.
 *
 * The handler is stateless, so this runs on every request and everything
 * expensive is either cached (`dynamic-tools.ts`) or skipped
 * (`MCP_DYNAMIC_TOOLS` unset). Generated tools are registered last so they can
 * see which static names are already taken.
 */
async function createServer(env: Env): Promise<McpServer> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const core = new CoreClient(env)
  const surface = registerTools(server, core, env)
  await registerDynamicTools(surface, core, env)
  registerResources(server, core)
  registerPrompts(server)
  return server
}

const ROOT_JSON = JSON.stringify(
  {
    ok: true,
    service: `${SERVER_NAME} MCP server`,
    transport: 'Streamable HTTP (stateless)',
    endpoint: `POST ${MCP_ROUTE} — headers: Authorization: Bearer <token>`,
    ...SURFACE,
    discover: 'initialize / tools/list / resources/list / resources/templates/list / prompts/list',
  },
  null,
  2,
)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (request.method === 'GET' && pathname !== MCP_ROUTE) {
      return new Response(ROOT_JSON, { headers: { 'content-type': 'application/json; charset=utf-8' } })
    }

    const bearer = env.MCP_BEARER_TOKEN
    if (bearer) {
      const auth = request.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${bearer}`) {
        return new Response(
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid MCP bearer token' } }),
          { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } },
        )
      }
    }

    const handler = createMcpHandler(() => createServer(env), { route: MCP_ROUTE })
    return handler(request, env, ctx)
  },
}
