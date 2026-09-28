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
 * The `media` tool group: the three R2-backed libraries — `media` (images),
 * `document` and `attachment` — plus media taxonomy maintenance.
 *
 * Reads and metadata edits go through three library-parameterised tools
 * (`get_asset`, `update_asset`, `delete_asset`) instead of nine, because the
 * three libraries differ only in their path prefix; the *listing* tools stay
 * split because clients already depend on those names and because each one
 * carries its own description of what the library holds.
 *
 * Uploads take base64 because an MCP tool argument is JSON and the core's
 * upload routes are `multipart/form-data`. The client builds a `FormData` here
 * and the core receives exactly the shape a browser would have sent.
 */

import { z } from 'zod'
import type { CoreClient } from '../core'
import { fileListArgs, format, libraryArg, libraryPath, run, runWrite, scopeArgs, seg, summarize, type Library, type ToolSurface } from './shared'

/**
 * Decoded byte ceiling for a single upload. The core has no explicit limit, but
 * base64 inflates the payload by a third and the whole thing crosses a Worker
 * request boundary, so the tool refuses early with an actionable message rather
 * than letting the fetch fail opaquely.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Metadata every library accepts on upload. Media adds alt/caption/focus below. */
const uploadMetaFields = {
  name: z.string().min(1).max(255).optional().describe('Display filename; defaults to the uploaded name.'),
  title: z.string().max(255).optional(),
  alt: z.string().max(1024).optional().describe('SEO alt text (media library only).'),
  description: z.string().max(4096).optional(),
  caption: z.string().max(4096).optional().describe('Caption/attribution (media library only).'),
  group: z.string().max(60).optional().describe('Freeform organization group.'),
  category: z.string().max(60).optional().describe('Freeform category label.'),
  tags: z.array(z.string().min(1).max(60)).max(30).optional().describe('Freeform tags.'),
  focusX: z.number().min(0).max(100).optional().describe('Focus point X percent, 0-100 (media library only).'),
  focusY: z.number().min(0).max(100).optional().describe('Focus point Y percent, 0-100 (media library only).'),
}

const fileArg = z.object({
  filename: z.string().min(1).max(255).describe('Filename with extension; the core derives the R2 key and the stored ext from it.'),
  data: z
    .string()
    .describe('The file bytes as base64 (no data: prefix). Decode a local file with e.g. `base64 < file.png | tr -d "\\n"`.'),
  mimeType: z.string().max(120).optional().describe('Content type; inferred from the extension when omitted.'),
})

/** Decode base64 into bytes, refusing anything past {@link MAX_UPLOAD_BYTES}. */
function toBytes(b64: string, field: string): Uint8Array {
  const clean = b64.replace(/\s/g, '')
  if (clean.length === 0) throw new Error(`${field} is empty`)
  // 4 base64 chars -> 3 bytes; check before decoding so an oversized payload
  // never materialises in memory.
  if (Math.floor((clean.length * 3) / 4) > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${field} decodes to more than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Upload a smaller file, or put it behind your own object store and reference it by URL.`,
    )
  }
  let binary: string
  try {
    binary = atob(clean)
  } catch {
    throw new Error(`${field} is not valid base64`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
}

function guessMime(filename: string, override: string | undefined): string {
  if (override) return override
  const ext = (filename.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Append a metadata field only when the caller supplied it. */
function putField(form: FormData, key: string, value: string | number | string[] | undefined): void {
  if (value === undefined) return
  form.append(key, Array.isArray(value) ? JSON.stringify(value) : String(value))
}

export function registerMediaTools(s: ToolSurface, core: CoreClient): void {
  /* ------------------------------------------------------------------ */
  /* listings                                                            */
  /* ------------------------------------------------------------------ */

  const listArgsSchema = z.object({ ...fileListArgs })

  s.tool(
    'list_media',
    {
      description: 'Paginated media library listing (images with their SEO metadata and taxonomy). Supports ?search and group/category/tag exact filters.',
      inputSchema: listArgsSchema,
    },
    run((args: z.infer<typeof listArgsSchema>) =>
      core
        .get(
          '/_media',
          { search: args.search, group: args.group, category: args.category, tag: args.tag, page: args.page, pageSize: args.pageSize },
          { land: args.land, colony: args.colony },
        )
        .then((resp) => `${summarize('media', resp as { data?: unknown[] })}\n\n${format(resp)}`),
    ),
  )

  s.tool(
    'list_documents',
    {
      description: 'Paginated documents library listing (office/pdf/text files, each with a downloadUrl). Supports ?search and group/category/tag exact filters.',
      inputSchema: listArgsSchema,
    },
    run((args: z.infer<typeof listArgsSchema>) =>
      core
        .get(
          '/_documents',
          { search: args.search, group: args.group, category: args.category, tag: args.tag, page: args.page, pageSize: args.pageSize },
          { land: args.land, colony: args.colony },
        )
        .then((resp) => `${summarize('documents', resp as { data?: unknown[] })}\n\n${format(resp)}`),
    ),
  )

  s.tool(
    'list_attachments',
    {
      description: 'Paginated attachments library listing (any file type, no downloadUrl). Supports ?search and group/category/tag exact filters.',
      inputSchema: listArgsSchema,
    },
    run((args: z.infer<typeof listArgsSchema>) =>
      core
        .get(
          '/_attachments',
          { search: args.search, group: args.group, category: args.category, tag: args.tag, page: args.page, pageSize: args.pageSize },
          { land: args.land, colony: args.colony },
        )
        .then((resp) => `${summarize('attachments', resp as { data?: unknown[] })}\n\n${format(resp)}`),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* one asset, any library                                              */
  /* ------------------------------------------------------------------ */

  s.tool(
    'get_asset',
    {
      description: 'Read one asset by id from the media, document or attachment library, including its absolute url.',
      inputSchema: z.object({ library: libraryArg, id: z.string().max(200), ...scopeArgs }),
    },
    run(({ library, id, land, colony }: { library: Library; id: string; land?: string; colony?: string }) =>
      core.get(`${libraryPath(library)}/${seg(id)}`, undefined, { land, colony }),
    ),
  )

  s.tool(
    'update_asset',
    {
      description:
        'Patch asset metadata (write tool; disabled in read-only mode). Only the keys you send change. The core rejects keys the ' +
        'library does not hold: alt, caption, focusX and focusY are media-only, while name, title, description, group, category and ' +
        'tags work everywhere. The stored bytes and R2 key never change here — to swap the file itself, re-upload.',
      inputSchema: z.object({
        library: libraryArg,
        id: z.string().max(200),
        ...uploadMetaFields,
        ...scopeArgs,
      }),
    },
    runWrite(
      core,
      (args: {
        library: Library
        id: string
        name?: string
        title?: string
        alt?: string
        description?: string
        caption?: string
        group?: string
        category?: string
        tags?: string[]
        focusX?: number
        focusY?: number
        land?: string
        colony?: string
      }) => {
        const patch: Record<string, unknown> = {}
        for (const key of ['name', 'title', 'alt', 'description', 'caption', 'group', 'category', 'tags', 'focusX', 'focusY'] as const) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('Nothing to update: send at least one metadata field.')
        }
        return core.patch(`${libraryPath(args.library)}/${seg(args.id)}`, patch, { land: args.land, colony: args.colony })
      },
    ),
  )

  s.tool(
    'delete_asset',
    {
      description:
        'Delete an asset from a library (write tool; disabled in read-only mode). Hard delete: the R2 object goes with it, and for ' +
        'media the thumbnail and every crop variant too. Records that reference the id keep a dangling reference.',
      inputSchema: z.object({ library: libraryArg, id: z.string().max(200), ...scopeArgs }),
    },
    runWrite(core, ({ library, id, land, colony }: { library: Library; id: string; land?: string; colony?: string }) =>
      core.delete(`${libraryPath(library)}/${seg(id)}`, { land, colony }),
    ),
  )

  /* ------------------------------------------------------------------ */
  /* uploads                                                             */
  /* ------------------------------------------------------------------ */

  s.tool(
    'upload_media',
    {
      description:
        'Upload an image into the media library (write tool; disabled in read-only mode). Bytes travel as base64, up to 10 MB. ' +
        'Only image/* is accepted — the core stores the R2 object, reads the pixel dimensions, and returns the public url and any ' +
        'thumbnail. A thumb (small WebP for lazy loading) and labelled crop variants may be supplied alongside.',
      inputSchema: z.object({
        ...fileArg.shape,
        thumb: z
          .object({
            filename: z.string().min(1).max(255).optional(),
            data: z.string().describe('Thumbnail bytes as base64.'),
            mimeType: z.string().max(120).optional(),
          })
          .optional()
          .describe('Optional small WebP thumbnail used for lazy loading.'),
        variants: z
          .array(
            z.object({
              label: z.string().min(1).max(40).describe('Variant label; becomes part of the R2 key.'),
              filename: z.string().min(1).max(255).optional(),
              data: z.string().describe('Variant bytes as base64.'),
              mimeType: z.string().max(120).optional(),
              focusX: z.number().min(0).max(100).default(50),
              focusY: z.number().min(0).max(100).default(50),
            }),
          )
          .max(8)
          .optional()
          .describe('Optional aspect-ratio crop variants; labels must be unique.'),
        ...uploadMetaFields,
        ...scopeArgs,
      }),
    },
    runWrite(
      core,
      (args: {
        filename: string
        data: string
        mimeType?: string
        thumb?: { filename?: string; data: string; mimeType?: string }
        variants?: Array<{ label: string; filename?: string; data: string; mimeType?: string; focusX: number; focusY: number }>
        name?: string
        title?: string
        alt?: string
        description?: string
        caption?: string
        group?: string
        category?: string
        tags?: string[]
        focusX?: number
        focusY?: number
        land?: string
        colony?: string
      }) => {
        const form = new FormData()
        form.append(
          'file',
          new File([toBytes(args.data, 'data')], args.filename, { type: guessMime(args.filename, args.mimeType) }),
        )
        if (args.thumb) {
          const name = args.thumb.filename ?? `${args.filename}.thumb.webp`
          form.append('thumb', new File([toBytes(args.thumb.data, 'thumb.data')], name, { type: guessMime(name, args.thumb.mimeType) }))
        }
        if (args.variants?.length) {
          const meta: Array<{ label: string; focusX: number; focusY: number }> = []
          for (const v of args.variants) {
            const name = v.filename ?? `${args.filename}.${v.label}`
            form.append('variant', new File([toBytes(v.data, `variants[${v.label}].data`)], name, { type: guessMime(name, v.mimeType) }))
            meta.push({ label: v.label, focusX: v.focusX, focusY: v.focusY })
          }
          form.append('variantMeta', JSON.stringify(meta))
        }
        putField(form, 'name', args.name)
        putField(form, 'title', args.title)
        putField(form, 'alt', args.alt)
        putField(form, 'description', args.description)
        putField(form, 'caption', args.caption)
        putField(form, 'group', args.group)
        putField(form, 'category', args.category)
        putField(form, 'tags', args.tags)
        putField(form, 'focusX', args.focusX)
        putField(form, 'focusY', args.focusY)
        return core.postForm('/_media', form, { land: args.land, colony: args.colony })
      },
    ),
  )

  s.tool(
    'upload_file',
    {
      description:
        'Upload a file into the document or attachment library (write tool; disabled in read-only mode). Bytes travel as base64, up to ' +
        '10 MB. The document library only accepts office, PDF, text, csv, epub and zip files; the attachment library accepts any type. ' +
        'Documents get a downloadUrl, attachments do not. Returns the absolute url.',
      inputSchema: z.object({
        library: z.enum(['document', 'attachment']).describe('Target library; attachments accept any file type.'),
        ...fileArg.shape,
        name: uploadMetaFields.name,
        title: uploadMetaFields.title,
        description: uploadMetaFields.description,
        group: uploadMetaFields.group,
        category: uploadMetaFields.category,
        tags: uploadMetaFields.tags,
        ...scopeArgs,
      }),
    },
    runWrite(
      core,
      (args: {
        library: 'document' | 'attachment'
        filename: string
        data: string
        mimeType?: string
        name?: string
        title?: string
        description?: string
        group?: string
        category?: string
        tags?: string[]
        land?: string
        colony?: string
      }) => {
        const form = new FormData()
        form.append(
          'file',
          new File([toBytes(args.data, 'data')], args.filename, { type: guessMime(args.filename, args.mimeType) }),
        )
        putField(form, 'name', args.name)
        putField(form, 'title', args.title)
        putField(form, 'description', args.description)
        putField(form, 'group', args.group)
        putField(form, 'category', args.category)
        putField(form, 'tags', args.tags)
        return core.postForm(libraryPath(args.library), form, { land: args.land, colony: args.colony })
      },
    ),
  )

  /* ------------------------------------------------------------------ */
  /* media taxonomy                                                      */
  /* ------------------------------------------------------------------ */

  s.tool(
    'get_media_taxonomy',
    {
      description: 'Read the media taxonomy: every group, category and tag in use, with usage counts.',
      inputSchema: z.object({ ...scopeArgs }),
    },
    run(({ land, colony }: { land?: string; colony?: string }) =>
      core.get('/_media/taxonomy/detail', undefined, { land, colony }),
    ),
  )

  s.tool(
    'update_media_taxonomy',
    {
      description:
        'Rename or delete one taxonomy value across every media asset that uses it (write tool; disabled in read-only mode). ' +
        'Omit `to` to remove the value everywhere. Does not touch documents or attachments.',
      inputSchema: z.object({
        type: z.enum(['group', 'category', 'tag']),
        from: z.string().min(1).max(60),
        to: z.string().min(1).max(60).optional().describe('New value; omit to delete the old one.'),
        ...scopeArgs,
      }),
    },
    runWrite(core, (args: { type: 'group' | 'category' | 'tag'; from: string; to?: string; land?: string; colony?: string }) =>
      core.post('/_media/taxonomy', { type: args.type, from: args.from, to: args.to }, { land: args.land, colony: args.colony }),
    ),
  )
}
