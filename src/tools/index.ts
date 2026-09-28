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
 * Tool registration, grouped so a deployment can choose its blast radius.
 *
 * The whole surface is larger than a model should carry in every request, and
 * part of it is genuinely dangerous, so `MCP_TOOL_GROUPS` picks which modules
 * register. `records`, `media` and `meta` are on by default; `admin` — accounts,
 * roles, land/colony writes, whole-scope import — is opt-in.
 *
 * Splitting by group is also why the modules are separate files: adding a tool
 * means adding it to the surface that owns the concept, and a group you turned
 * off cannot grow a surprise member.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import type { CoreClient } from '../core'
import { resolveToolGroups, type Env, type ToolGroup } from '../env'
import { createToolSurface, type ToolSurface } from './shared'
import { registerAdminTools } from './admin'
import { registerMediaTools } from './media'
import { registerMetaTools } from './meta'
import { registerRecordTools } from './records'

/** Every group in registration order, paired with its registrar. */
const REGISTRARS: ReadonlyArray<readonly [ToolGroup, (s: ToolSurface, c: CoreClient) => void]> = [
  ['records', registerRecordTools],
  ['media', registerMediaTools],
  ['meta', registerMetaTools],
  ['admin', registerAdminTools],
]

/**
 * Register the static tool groups this deployment asked for and hand back the
 * surface, so a caller that adds tools of its own (the per-collection dynamic
 * tools) can see which names are already taken.
 */
export function registerTools(server: McpServer, core: CoreClient, env: Env): ToolSurface {
  const surface = createToolSurface(server)
  const enabled = resolveToolGroups(env.MCP_TOOL_GROUPS)
  for (const [group, register] of REGISTRARS) {
    if (enabled.has(group)) register(surface, core)
  }
  return surface
}
