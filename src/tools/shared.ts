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
 * Argument schemas and result helpers shared by every tool module.
 *
 * The rule that shapes this file: a tool never throws at the transport. A throw
 * kills the turn; a returned error payload lets the model read the core's own
 * wording (`INVALID_QUERY`, `FORBIDDEN`, `NOT_FOUND`) and pick another argument.
 * So `run`/`runWrite` are the only two ways a tool body is wrapped, and they
 * both return a `CallToolResult`.
 */

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { CoreClient } from '../core'

/**
 * The registration surface every tool module writes to.
 *
 * It exists for one reason: the SDK keeps its registry private, and both the
 * group registrar and the per-collection dynamic tools need to know which names
 * are taken. Tracking them here means a clash is a duplicate in a `Set`, not a
 * silently overwritten tool.
 */
export interface ToolSurface {
  readonly names: ReadonlySet<string>
  /** Register a tool, refusing a name that is already taken. */
  tool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: z.ZodType; annotations?: Record<string, unknown> },
    cb: (args: never) => Promise<CallToolResult>,
  ): void
}

export function createToolSurface(server: McpServer): ToolSurface {
  const names = new Set<string>()
  return {
    names,
    tool(name, config, cb) {
      if (names.has(name)) {
        throw new Error(`Duplicate MCP tool name: ${name}. Two tools in the same surface cannot share a name.`)
      }
      names.add(name)
      // The SDK's callback type is generic over the input schema; the `never`
      // cast keeps each module free to type its own handler precisely.
      server.registerTool(name, config as never, cb as never)
    },
  }
}

/** Tool result ceiling, in characters. Past this the model gets a truncation note. */
export const MAX = 250_000

/** Core metadata identifiers are snake_case; the core rejects anything else. */
export const nameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'snake_case, must start with a lowercase letter (core metadata identifiers)')

/** Optional tenant override, used by every scope-bound tool. */
export const scopeArgs = {
  land: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'snake_case')
    .max(64)
    .optional()
    .describe('Tenant land; overrides the server CORE_LAND. Required when the core runs in centralized mode without a server default.'),
  colony: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'snake_case')
    .max(64)
    .optional()
    .describe('Tenant colony within the land (optional).'),
}

export type ScopeArgs = z.infer<typeof scopeArgsSchema>

export const scopeArgsSchema = z.object({ ...scopeArgs })

export const paginationArgs = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25).describe('Rows per page (core caps at 100).'),
}

export type PaginationArgs = z.infer<typeof paginationArgsSchema>

export const paginationArgsSchema = z.object({ ...paginationArgs })

/** `filter` as the core expects it: a JSON-encoded FilterMap, `field -> { op, value }`. */
export const filterArg = z
  .record(z.string(), z.object({ op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'contains']), value: z.unknown() }))
  .optional()
  .describe('Exact field predicates, e.g. {"published":{"op":"eq","value":true}}. Operators: eq, neq, gt, gte, lt, lte, like, in, contains.')

/** Shared list arguments for the three R2-backed libraries. */
export const fileListArgs = {
  search: z.string().max(200).optional(),
  group: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  tag: z.string().max(100).optional(),
  ...paginationArgs,
  ...scopeArgs,
}

/** The three asset libraries the core keeps, addressed by one path prefix each. */
export const libraryArg = z
  .enum(['media', 'document', 'attachment'])
  .describe('Asset library: media (images only), document (office/pdf files), attachment (any file).')

export type Library = z.infer<typeof libraryArg>

/** Core path prefix for a library — `/_media`, `/_documents`, `/_attachments`. */
export function libraryPath(library: Library): string {
  return library === 'media' ? '/_media' : library === 'document' ? '/_documents' : '/_attachments'
}

/** Percent-encode a collection or record id for a core path segment. */
export function seg(value: string): string {
  return encodeURIComponent(value)
}

export function format(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v, null, 2)
  } catch {
    s = String(v)
  }
  if (s.length > MAX) s = `${s.slice(0, MAX)}\n… (result truncated at ${MAX} chars)`
  return s ?? ''
}

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

export function err(message: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: message instanceof Error ? message.message : String(message) }],
    isError: true,
  }
}

/** Wrap a read tool body: format the payload, or return the failure as text. */
export function run<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(format(await fn(args)))
    } catch (e) {
      return err(e)
    }
  }
}

/** Wrap a write tool body: refuse outright when `MCP_READONLY=true`. */
export function runWrite<A>(core: CoreClient, fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      core.assertWritable()
      return ok(format(await fn(args)))
    } catch (e) {
      return err(e)
    }
  }
}

/** Wrap a list response for a readable first line in the tool result. */
export function summarize(
  label: string,
  resp: { data?: unknown[]; meta?: { page?: number; pageSize?: number; total?: number; totalPages?: number } },
): string {
  const rows = resp.data?.length ?? 0
  const meta = resp.meta
  if (!meta) return label
  return `${label}: ${meta.total ?? rows} total, page ${meta.page ?? 1}/${meta.totalPages ?? 1}, showing ${rows}`
}
