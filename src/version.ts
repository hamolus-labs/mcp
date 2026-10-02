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
 * The release this MCP server is.
 *
 * A literal in a module of its own for two reasons. It is reported to the core on every
 * machine call, so the console can show which release is actually deployed behind an
 * instance — but `index.ts` is the Agent entry that already imports `core.ts`, so
 * reading the constant from there would make `core.ts` import its own entry.
 * And it is a literal rather than the manifest for the same reason as `CORE_VERSION`:
 * `main` points at `src/`, so a generated MCP project compiles the TypeScript directly
 * and there is no bundler step to read `package.json` from.
 *
 * Load-bearing: `scripts/release.mjs` rewrites this line on every bump and
 * `packages/cli/scripts/check-package-versions.mjs` fails when it drifts from the
 * lockstep version.
 */
export const SERVER_VERSION = '0.2.11'
