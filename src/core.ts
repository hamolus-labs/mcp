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
 * The core transport, and the console-managed configuration that drives it.
 *
 * Two paths live here and they are not interchangeable:
 *
 * - **Managed** (`MCP_INSTANCE_ID` set). The instance id fetches the
 *   configuration from the core, and the caller's per-user token is exchanged
 *   for a short-lived session JWT. The permission list on that JWT is what
 *   enforces the console's read-only toggle and tool groups — this worker never
 *   gets to widen it.
 * - **Legacy** (no instance id). The worker mints a token from `ADMIN_KEY`,
 *   which is platform-wide, and reads its settings from env. Deprecated; kept
 *   working so an existing deployment is not broken by the upgrade.
 *
 * The instance config and the session JWT are cached per isolate, like the
 * collection definitions in `collections.ts`. Config changes about as often as a
 * collection's shape does, and a session is valid for the fifteen minutes the
 * core chose.
 */

import type { McpInstanceConfig } from '@hamolus/types'
import { parseMcpToolGroups } from '@hamolus/types'
import type { Env } from './env'

const globalStore = globalThis as {
  __mcpConfigCache?: Map<string, { at: number; config: McpInstanceConfig }>
  __mcpSessionCache?: Map<string, { at: number; expiresAt: number; token: string }>
  __mcpTokenCache?: Map<string, { at: number; token: string }>
} & typeof globalThis

/** How long a fetched instance config stays valid. A console toggle is not a hot path. */
const CONFIG_TTL_MS = 60 * 1000

export class CoreError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
    this.name = 'CoreError'
  }
}

export interface ScopeOpt {
  land?: string
  colony?: string
}

/** Query string values a core route accepts. `undefined`/`null`/`''` are dropped. */
export type Query = Record<string, string | number | boolean | undefined | null>

/** Thin JSON client for the core API (`/api/*`, Bearer JWT + optional x-land/x-colony). */
export class CoreClient {
  private readonly base: string
  private config: McpInstanceConfig | null = null

  /**
   * @param presentedToken the bearer the AI client presented. On the managed
   * path it is a per-user token, exchanged for a session JWT; on the legacy path
   * it is a static shared secret compared by `index.ts` and unused here.
   */
  constructor(
    private readonly env: Env,
    private readonly presentedToken: string = '',
  ) {
    this.base = (env.CORE_API_URL ?? 'http://localhost:8787/api').replace(/\/+$/, '')
  }

  /** True when this deployment is configured from the console. */
  get managed(): boolean {
    return Boolean(this.env.MCP_INSTANCE_ID)
  }

  /** Resolved core base URL including the `/api` prefix. */
  get baseUrl(): string {
    return this.base
  }

  /**
   * The land/colony this server defaults to when a tool omits them.
   *
   * On the managed path this is the instance's own scope, which is how a worker
   * that knows nothing but its id ends up pinned to exactly one colony.
   */
  get defaultScope(): ScopeOpt {
    if (this.config) return { land: this.config.land, colony: this.config.colony }
    return { land: this.env.CORE_LAND, colony: this.env.CORE_COLONY }
  }

  get readonly(): boolean {
    if (this.config) return this.config.readonly
    return this.env.MCP_READONLY === 'true'
  }

  /** Which groups this server registers. Only meaningful after `ready()`. */
  toolGroups(): Set<string> {
    if (this.config) return new Set(this.config.toolGroups)
    return new Set(parseMcpToolGroups(this.env.MCP_TOOL_GROUPS))
  }

  get dynamicTools(): string | undefined {
    if (this.config) return this.config.dynamicTools || undefined
    return this.env.MCP_DYNAMIC_TOOLS || undefined
  }

  get dynamicMax(): number {
    if (this.config) return this.config.dynamicMax
    const raw = Number(this.env.MCP_DYNAMIC_MAX)
    return Number.isFinite(raw) && raw > 0 ? raw : 10
  }

  assertWritable(): void {
    if (this.readonly) {
      throw new CoreError(
        'This MCP server is read-only (set Read only = off in the console). Write tools are disabled.',
      )
    }
  }

  /**
   * Load the instance configuration, once per request.
   *
   * Called by `createServer()` before anything registers a tool, which is what
   * lets the rest of the surface read `readonly` and `defaultScope` as plain
   * getters instead of threading a config object through every call site.
   */
  async ready(): Promise<void> {
    if (!this.managed || this.config) return
    const key = `${this.base}|${this.env.MCP_INSTANCE_ID}`
    const cache = (globalStore.__mcpConfigCache ??= new Map())
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) {
      this.config = hit.config
      return
    }
    const config = await this.fetchConfig()
    cache.set(key, { at: Date.now(), config })
    this.config = config
  }

  /** `GET /_mcp/config` — the instance id alone, never a session JWT. */
  private async fetchConfig(): Promise<McpInstanceConfig> {
    const res = await fetch(`${this.base}/_mcp/config`, {
      headers: { authorization: `Bearer ${this.env.MCP_INSTANCE_ID}` },
    })
    const body = await readBody<{ data?: { instance?: McpInstanceConfig }; error?: { message?: string } }>(res)
    if (!res.ok || !body?.data?.instance) {
      throw new CoreError(
        `Failed to read MCP config (${res.status}): ${body?.error?.message ?? 'unknown error'}`,
        res.status,
      )
    }
    return body.data.instance
  }

  /**
   * Exchange the caller's per-user token for a session JWT.
   *
   * Cached until the core's stated expiry, which is also the real revocation
   * window: a token revoked in the console stays usable until this entry dies.
   */
  private async sessionToken(): Promise<string> {
    if (!this.presentedToken) {
      throw new CoreError(
        'This MCP server needs a token issued from the console. Send `Authorization: Bearer <token>`.',
        401,
      )
    }
    const key = `${this.base}|${this.env.MCP_INSTANCE_ID}|${this.presentedToken}`
    const cache = (globalStore.__mcpSessionCache ??= new Map())
    const hit = cache.get(key)
    if (hit && Date.now() < hit.expiresAt) return hit.token

    const res = await fetch(`${this.base}/_mcp/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.env.MCP_INSTANCE_ID}`,
      },
      body: JSON.stringify({ token: this.presentedToken }),
    })
    const body = await readBody<{
      data?: { token?: string; expiresAt?: string }
      error?: { code?: string; message?: string }
    }>(res)
    if (!res.ok || !body?.data?.token) {
      const code = body?.error?.code ? ` [${body.error.code}]` : ''
      throw new CoreError(
        `MCP token rejected (${res.status})${code}: ${body?.error?.message ?? 'unknown error'}`,
        res.status,
      )
    }
    const expiresAt = body.data.expiresAt ? Date.parse(body.data.expiresAt) : Date.now() + 10 * 60 * 1000
    cache.set(key, { at: Date.now(), expiresAt, token: body.data.token })
    return body.data.token
  }

  /** Legacy path: a static JWT, or one minted from the admin key. */
  private async legacyToken(): Promise<string> {
    const { CORE_API_TOKEN, CORE_ADMIN_KEY } = this.env
    if (CORE_API_TOKEN && CORE_ADMIN_KEY) {
      console.warn(
        '[hamolus/mcp] Both CORE_API_TOKEN and CORE_ADMIN_KEY are set; using CORE_API_TOKEN. ' +
          'Unset one — a stale token silently outranks a rotated key.',
      )
    }
    if (CORE_API_TOKEN) return CORE_API_TOKEN
    if (!CORE_ADMIN_KEY) {
      throw new CoreError('No CORE_API_TOKEN or CORE_ADMIN_KEY configured for the MCP server.')
    }
    const cacheKey = `${this.base}|${CORE_ADMIN_KEY}`
    const cache = (globalStore.__mcpTokenCache ??= new Map())
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.token
    const res = await fetch(`${this.base}/_auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: CORE_ADMIN_KEY }),
    })
    const body = await readBody<{
      data?: { token?: string; error?: { message?: string } }
      error?: { message?: string }
    }>(res)
    if (!res.ok || !body?.data?.token) {
      const why = body?.error?.message ?? body?.data?.error?.message ?? 'unknown error'
      throw new CoreError(`Failed to mint core token from ${this.base}/_auth/token (${res.status}): ${why}`, res.status)
    }
    cache.set(cacheKey, { at: Date.now(), token: body.data.token })
    return body.data.token
  }

  private async token(): Promise<string> {
    return this.managed ? this.sessionToken() : this.legacyToken()
  }

  private async request<T>(path: string, init: RequestInit, scope: ScopeOpt = {}): Promise<T> {
    const token = await this.token()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    const fallback = this.defaultScope
    const land = scope.land !== undefined ? scope.land : (fallback.land ?? '')
    const colony = scope.colony !== undefined ? scope.colony : (fallback.colony ?? '')
    if (land) headers.set('x-land', land)
    if (colony) headers.set('x-colony', colony)
    // FormData bodies must keep the boundary the runtime generates, so only a
    // JSON body gets an explicit content-type.
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    const url = this.base + path
    const res = await fetch(url, { ...init, headers })
    const raw = await res.text()
    if (!res.ok) {
      // The full URL goes in the message. A 404 from `/_meta/collections` and a
      // 404 from `/collections` are the same string otherwise, and guessing which
      // one you are looking at wastes more time than the characters cost.
      let msg = `Core ${init.method ?? 'GET'} ${url} -> ${res.status}`
      try {
        const j = JSON.parse(raw) as { error?: { code?: string; message?: string } }
        if (j?.error?.message) msg += `: [${j.error.code ?? 'ERROR'}] ${j.error.message}`
      } catch {
        /* keep status line */
      }
      throw new CoreError(msg, res.status)
    }
    if (!raw) return null as unknown as T
    return JSON.parse(raw) as T
  }

  get<T>(path: string, q?: Query, scope?: ScopeOpt): Promise<T> {
    return this.request<T>(path + toQuery(q), { method: 'GET' }, scope)
  }

  post<T>(path: string, body: unknown, scope?: ScopeOpt, q?: Query): Promise<T> {
    return this.request<T>(path + toQuery(q), { method: 'POST', body: JSON.stringify(body) }, scope)
  }

  put<T>(path: string, body: unknown, scope?: ScopeOpt, q?: Query): Promise<T> {
    return this.request<T>(path + toQuery(q), { method: 'PUT', body: JSON.stringify(body) }, scope)
  }

  patch<T>(path: string, body: unknown, scope?: ScopeOpt, q?: Query): Promise<T> {
    return this.request<T>(path + toQuery(q), { method: 'PATCH', body: JSON.stringify(body) }, scope)
  }

  delete<T>(path: string, scope?: ScopeOpt, q?: Query): Promise<T> {
    return this.request<T>(path + toQuery(q), { method: 'DELETE' }, scope)
  }

  /**
   * POST a multipart body. The core's media and file upload routes read
   * `multipart/form-data`, which JSON bodies cannot express.
   */
  postForm<T>(path: string, form: FormData, scope?: ScopeOpt): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: form }, scope)
  }
}

async function readBody<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null
}

function toQuery(q?: Query): string {
  if (!q) return ''
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}
