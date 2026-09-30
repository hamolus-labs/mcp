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
 * part of it is genuinely dangerous, so the operator picks which modules
 * register. `records`, `media` and `meta` are on by default; `admin` — accounts,
 * roles, land/colony writes, whole-scope import — is opt-in.
 *
 * The choice comes from `core.toolGroups()`, not from env. On a console-managed
 * deployment that is the instance config the core handed us, so narrowing the
 * surface is a console action rather than a redeploy — and the core's own
 * permission set narrows with it, which is what actually stops the calls.
 *
 * Splitting by group is also why the modules are separate files: adding a tool
 * means adding it to the surface that owns the concept, and a group you turned
 * off cannot grow a surprise member.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import type { CoreClient } from '../core'
import type { McpToolGroup } from '../env'
import { registerAdminTools } from './admin'
import { registerMediaTools } from './media'
import { registerMetaTools } from './meta'
import { registerRecordTools } from './records'
import { createToolSurface, type ToolSurface } from './shared'

type Registrar = (surface: ToolSurface, core: CoreClient) => void

/** Every group in registration order, paired with its registrar. */
const REGISTRARS: ReadonlyArray<readonly [McpToolGroup, Registrar]> = [
  ['records', registerRecordTools],
  ['media', registerMediaTools],
  ['meta', registerMetaTools],
  ['admin', registerAdminTools],
]

/**
 * Register the static tool groups this deployment is allowed and hand back the
 * surface, so a caller that adds tools of its own (the per-collection dynamic
 * tools) can see which names are already taken.
 */
export function registerTools(server: McpServer, core: CoreClient): ToolSurface {
  // `core` is handed to the surface so a read-only instance never registers a write
  // tool in the first place, rather than advertising one that refuses on call.
  const surface = createToolSurface(server, core)
  const enabled = core.toolGroups()
  for (const [group, register] of REGISTRARS) {
    if (enabled.has(group)) register(surface, core)
  }
  return surface
}
