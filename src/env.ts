/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

/** Tool groups that can be registered; see `src/tools/index.ts` for the members. */
export const TOOL_GROUPS = ['records', 'media', 'meta', 'admin'] as const

export type ToolGroup = (typeof TOOL_GROUPS)[number]

/** Groups registered when `MCP_TOOL_GROUPS` is unset. `admin` is opt-in. */
export const DEFAULT_TOOL_GROUPS: readonly ToolGroup[] = ['records', 'media', 'meta']

export interface Env {
  /** Base URL of the core API, e.g. `http://localhost:8787/api`. */
  CORE_API_URL?: string
  /** Bearer JWT used against the core. If unset, CORE_ADMIN_KEY mints one. */
  CORE_API_TOKEN?: string
  /** Admin key exchanged for a JWT at POST /api/_auth/token. */
  CORE_ADMIN_KEY?: string
  /** Optional land scope sent as `x-land` on every core request. */
  CORE_LAND?: string
  /** Optional tenant colony sent as `x-colony`. */
  CORE_COLONY?: string
  /** When set, the /mcp endpoint requires `Authorization: Bearer <token>`. */
  MCP_BEARER_TOKEN?: string
  /** `"true"` disables every write/mutation tool. */
  MCP_READONLY?: string
  /**
   * Comma-separated tool groups to register. Unset = {@link DEFAULT_TOOL_GROUPS}.
   * Unknown names are ignored; `all` expands to every group.
   */
  MCP_TOOL_GROUPS?: string
  /**
   * Per-collection tools: `all`, or a comma-separated collection list. Unset or
   * empty = off. Read from the core's collection definitions at request time.
   */
  MCP_DYNAMIC_TOOLS?: string
  /** Hard cap on collections that get per-collection tools (default 10). */
  MCP_DYNAMIC_MAX?: string
}

/**
 * Parse `MCP_TOOL_GROUPS` into a set. An unset value means the default set; the
 * literal `all` means every group. Unrecognised names are dropped rather than
 * throwing, so a typo in a wrangler var degrades to a smaller surface instead of
 * a server that will not start.
 */
export function resolveToolGroups(raw: string | undefined): Set<ToolGroup> {
  if (raw === undefined || raw.trim() === '') return new Set(DEFAULT_TOOL_GROUPS)
  const wanted = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (wanted.includes('all')) return new Set(TOOL_GROUPS)
  const set = new Set<ToolGroup>()
  for (const name of wanted) {
    if ((TOOL_GROUPS as readonly string[]).includes(name)) set.add(name as ToolGroup)
  }
  return set
}