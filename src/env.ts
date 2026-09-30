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
 * Bindings for the MCP server.
 *
 * On the console-managed path a deployment sets exactly two vars: `CORE_API_URL`
 * and `MCP_INSTANCE_ID`. Everything that decides what this server may do — scope,
 * read-only, tool groups — is fetched from the core at request time, so an
 * operator changes it in the console and does not redeploy.
 *
 * The `LEGACY_*` fields are the pre-console arrangement (`CORE_ADMIN_KEY`,
 * `MCP_BEARER_TOKEN`, and friends). They still work so an existing deployment
 * keeps serving, but they are deprecated: with an admin key the worker's reach is
 * the whole platform, and `MCP_READONLY` only narrows what the worker *offers* —
 * not what the core accepts. Remove them when the instance exists in the console.
 */

import {
  DEFAULT_MCP_TOOL_GROUPS,
  MCP_TOOL_GROUPS,
  type McpToolGroup,
  parseMcpToolGroups,
} from '@hamolus/types'

export { MCP_TOOL_GROUPS, DEFAULT_MCP_TOOL_GROUPS }
export type { McpToolGroup }

/** `resolveToolGroups` kept as the legacy env entry point. */
export function resolveToolGroups(raw: string | undefined): Set<McpToolGroup> {
  return new Set(parseMcpToolGroups(raw))
}

export interface Env {
  /** Base URL of the core API, including the `/api` prefix. */
  CORE_API_URL?: string

  /**
   * This server's id in the core's console. When set, the server is
   * console-managed: it reads its configuration from the core and mints its
   * sessions from a per-user token.
   */
  MCP_INSTANCE_ID?: string

  /**
   * @deprecated Console-managed deployments leave this unset. A bearer JWT used
   * against the core; when unset, `CORE_ADMIN_KEY` mints one.
   */
  CORE_API_TOKEN?: string
  /**
   * @deprecated A platform-wide admin key. Gives this server every land and
   * colony, not one — prefer `MCP_INSTANCE_ID`.
   */
  CORE_ADMIN_KEY?: string
  /** @deprecated Only consulted when `MCP_INSTANCE_ID` is unset. */
  CORE_LAND?: string
  /** @deprecated Only consulted when `MCP_INSTANCE_ID` is unset. */
  CORE_COLONY?: string
  /**
   * @deprecated A static shared secret compared verbatim on every request. Use
   * per-user tokens from the console instead.
   */
  MCP_BEARER_TOKEN?: string
  /** @deprecated Only consulted when `MCP_INSTANCE_ID` is unset. */
  MCP_READONLY?: string
  /** @deprecated Only consulted when `MCP_INSTANCE_ID` is unset. */
  MCP_TOOL_GROUPS?: string
  /** @deprecated Only consulted when `MCP_INSTANCE_ID` is unset. */
  MCP_DYNAMIC_TOOLS?: string
  /** @deprecated Only consulted when `MCP_INSTANCE_ID` is unset. */
  MCP_DYNAMIC_MAX?: string
}
