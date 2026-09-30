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
 * MCP prompts: task-shaped starting points a client can offer as a slash command.
 *
 * A prompt here is *not* a tool. It returns a message the client hands to the
 * model, so it costs nothing until the user picks it, and it can carry
 * instructions the tool surface deliberately does not — how to sequence calls,
 * what to check before a destructive write, when to stop and ask.
 *
 * Two rules keep them honest:
 *
 * - **A prompt never guesses data.** It names the tools to call and the order;
 *   the model fetches the actual schema and rows itself.
 * - **A prompt states the refusals.** Read-only mode, the admin group being off,
 *   and the destructive tools are all things the model should discover from the
 *   prompt text rather than by hitting an error mid-task.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { nameSchema } from './tools/shared'

/**
 * A prompt body: one user turn, and nothing else.
 *
 * The SDK's callback contract is a `GetPromptResult` (a `messages` array), not a
 * bare message. A prompt that returns only the user turn leaves the model to
 * decide what a draft looks like, which is exactly the guessing this file exists
 * to prevent.
 */
function ask(text: string): { messages: { role: 'user'; content: { type: 'text'; text: string } }[] } {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] }
}

const SCOPE_HINT =
  'Every tool accepts optional land and colony arguments that override the server default. Pass them only when the ' +
  'user named a scope; otherwise leave them out so the server default applies. Tools that write refuse outright when ' +
  'the server is read-only — if one refuses, tell the user instead of retrying.'

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'explore_content',
    {
      title: 'Explore the content model',
      description: 'Map what this core holds: collections, fields, row counts, and which collections actually have content.',
      argsSchema: z.object({
        focus: z.string().max(200).optional().describe('What the user wants to find, e.g. "the blog" or "anything unpublished".'),
      }),
    },
    ({ focus }: { focus?: string }) =>
      ask(
        [
          `Map the content of this Hamolus core${focus ? `, looking specifically for: ${focus}` : ''}.`,
          '',
          '1. Call get_stats for the overview (collections, total records, per-collection counts).',
          '2. Call get_collection on any collection worth opening, and summarise its fields — required flags, enums,',
          '   relation targets, localized fields.',
          '3. For the two or three collections that matter, call list_records with pageSize 5 to see real rows and',
          '   judge whether the content is populated, duplicated or empty.',
          '4. Report a short map: collection, purpose, field shape, row count, and what looks wrong or unfinished.',
          '',
          `Read-only work only. ${SCOPE_HINT}`,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'draft_record',
    {
      title: 'Draft a record',
      description: 'Create one record from a description, reading the collection schema first so the draft validates.',
      argsSchema: z.object({
        collection: nameSchema.describe('Collection to write into.'),
        brief: z.string().min(1).describe('What the record should say, in the user\'s own words.'),
      }),
    },
    ({ collection, brief }: { collection: string; brief: string }) =>
      ask(
        [
          `Create one ${collection} record from this brief:`,
          '',
          brief,
          '',
          '1. Call get_collection to read the real field definition. Do not guess field names or types.',
          '2. Map the brief onto the fields. For anything the brief does not cover and the definition marks required,',
          '   either derive a sensible value or stop and list what you need from the user.',
          '3. For a relation field, list the target collection first so the id you pass is a real one.',
          '4. Call create_record once. If the core answers VALIDATION, fix the offending field and try again — do not',
          '   start a second record.',
          '5. Report the created record id and the values you chose on the user\'s behalf.',
          '',
          `Confirm with the user before creating if the brief is ambiguous about something destructive or irreversible. ${SCOPE_HINT}`,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'bulk_import',
    {
      title: 'Bulk create records',
      description: 'Load many records into a collection from a structured list, validating the schema up front.',
      argsSchema: z.object({
        collection: nameSchema.describe('Collection to write into.'),
        source: z.string().min(1).describe('Where the rows come from, or the rows themselves when pasted inline.'),
        dryRun: z.enum(['true', 'false']).optional().describe('"true" (default) plans the import and writes nothing.'),
      }),
    },
    ({ collection, source, dryRun }: { collection: string; source: string; dryRun?: 'true' | 'false' }) =>
      ask(
        [
          `Bulk-create ${collection} records from: ${source}`,
          '',
          `Mode: ${dryRun === 'false' ? 'WRITE' : 'DRY RUN — plan only, create nothing'}.`,
          '',
          '1. Call get_collection and state the exact field list, which fields are required, and which are relation',
          '   fields (each needs a real id from its target collection).',
          '2. Parse the source into rows. Reject any row you cannot map without guessing; list those rows back to the',
          '   user rather than inventing values.',
          '3. Report the plan: how many rows, which fields each row sets, and anything you will drop.',
          dryRun === 'false'
            ? '4. Ask the user to confirm the plan, then create the rows one at a time with create_record. On the first'
              + ' VALIDATION error, stop and report — do not skip the row and carry on.'
            : '4. Stop here. Do not call create_record. Wait for the user to confirm the plan.',
          '',
          SCOPE_HINT,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'review_collection',
    {
      title: 'Review a collection',
      description: 'Audit records for duplicates, empty required fields, broken relations and taxonomy drift.',
      argsSchema: z.object({
        collection: nameSchema.describe('Collection to audit.'),
        limit: z.string().max(20).optional().describe('Rough row budget, e.g. "200". Read in pages until you hit it.'),
      }),
    },
    ({ collection, limit }: { collection: string; limit?: string }) =>
      ask(
        [
          `Audit the ${collection} collection for content problems.`,
          '',
          '1. Call get_collection for the field definition, noting required fields, unique flags and relation targets.',
          `2. Page through list_records (pageSize 100) up to roughly ${limit ?? '200'} rows.`,
          '3. Look for, and report as a list:',
          '   - empty values in required fields',
          '   - near-duplicate rows (same title, same slug, same email)',
          '   - relation ids that no longer resolve — check a sample against the target collection',
          '   - inconsistent enum values, locales or date formats',
          '4. Propose a fix per finding and say whether it needs update_record, a put_collection change, or a human.',
          '',
          `This pass is read-only. Do not fix anything yet. ${SCOPE_HINT}`,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'migrate_records',
    {
      title: 'Migrate records between collections',
      description: 'Copy records from one collection to another, mapping fields and reporting what does not fit.',
      argsSchema: z.object({
        from: nameSchema.describe('Source collection.'),
        to: nameSchema.describe('Target collection.'),
      }),
    },
    ({ from, to }: { from: string; to: string }) =>
      ask(
        [
          `Migrate records from ${from} into ${to}.`,
          '',
          '1. Call get_collection on BOTH collections and print the two field lists side by side.',
          '2. Propose an explicit field mapping. Names that match are a safe default; anything else needs a stated',
          '   reason, and a source field with no target must be called out rather than dropped silently.',
          '3. Report how many ${from} records exist, then list any that cannot be mapped without guessing and stop.',
          '4. Present the plan and wait for explicit confirmation. Only then create the target records.',
          '5. Afterwards, list the new record ids next to their source ids so the migration can be reversed.',
          '',
          'Leave the source records in place — this tool has no restore, and deletion is the user\'s call, not yours.',
          SCOPE_HINT,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'manage_media',
    {
      title: 'Organise media',
      description: 'Tidy a media library: find untagged or unnamed assets, and normalise the taxonomy.',
      argsSchema: z.object({
        group: z.string().max(100).optional().describe('Restrict to one group, category or tag.'),
      }),
    },
    ({ group }: { group?: string }) =>
      ask(
        [
          `Tidy the media library${group ? `, restricted to "${group}"` : ''}.`,
          '',
          '1. Call get_media_taxonomy for the vocabulary already in use. Match it; do not invent new labels.',
          '2. Page through list_media and report assets with no title, no alt text, or no taxonomy at all.',
          '3. Propose a batch of update_asset calls: one per asset, each carrying only the keys it needs.',
          '4. Present the batch and wait for confirmation before applying. Report the count applied and the count skipped.',
          '',
          'Never call delete_asset as part of tidying — an unused asset is a decision for the user.',
          `To upload new files, bytes travel as base64 through upload_media; ask the user for a path or a URL rather than guessing. ${SCOPE_HINT}`,
        ].join('\n'),
      ),
  )

  server.registerPrompt(
    'provision_user',
    {
      title: 'Provision a user',
      description: 'Create an account with the right role, after checking which roles exist.',
      argsSchema: z.object({
        username: z.string().min(2).max(40).describe('Login name: lowercase, digits and underscores.'),
        role: z.string().max(60).optional().describe('Role name, e.g. editor. Look it up with list_privileges.'),
      }),
    },
    ({ username, role }: { username: string; role?: string }) =>
      ask(
        [
          `Provision a console user.`,
          '',
          `Username: ${username}${role ? `  Role: ${role}` : ''}`,
          '',
          '1. Call list_privileges and show the roles with what each grants. If the requested role is missing or',
          '   ambiguous, stop and ask — do not create a role as a side effect of creating a user.',
          `2. Call create_user with username, a display name, a password of at least 8 characters, and the chosen privilegeId.`,
          '3. Never invent a password. Ask the user for one, or create the account with a placeholder and say plainly',
          '   that the password must be reset before first use.',
          '4. Report the account, its role, and the permissions that role carries.',
          '',
          'These tools live in the `admin` group. If get_current_user or list_privileges reports the tool is missing,',
          'the admin tool group is not enabled for this server — tell the user rather than working around it.',
          SCOPE_HINT,
        ].join('\n'),
      ),
  )
}
