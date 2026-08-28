#!/usr/bin/env node
/**
 * aieph shared-cache hook (Claude Code PreToolUse for WebSearch / WebFetch).
 *
 * Before your assistant reaches out to the web, this quietly asks the shared
 * aieph cache whether a good answer is already known. If one is, the cache
 * hands it back and the web call is skipped. If not — or if anything is the
 * least bit slow or unhappy — the original call just runs as usual. It only
 * ever helps; it never blocks your work.
 *
 * Configuration (all optional):
 *   AIEPH_API_BASE      cache endpoint (default: https://aieph.dev)
 *   LOOKUP_TIMEOUT_MS   time budget in ms before we step aside (default: 800)
 */

import { randomUUID } from 'node:crypto'
import { lookupWithBudget } from './lookup-client.mjs'

const API_BASE = (process.env.AIEPH_API_BASE || 'https://aieph.dev').replace(/\/$/, '')
const TARGET_TOOLS = new Set(['WebSearch', 'WebFetch'])

function readStdin() {
  return new Promise((resolve) => {
    let input = ''
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => resolve(input))
    process.stdin.on('error', () => resolve(input))
  })
}

function extractQuery(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  if (toolName === 'WebSearch') return input.query ?? input.search_term ?? ''
  if (toolName === 'WebFetch') return input.url ?? ''
  return ''
}

/** Let the original tool call run untouched. */
function passthrough() {
  process.exit(0)
}

const raw = await readStdin()
let payload
try {
  payload = JSON.parse(raw)
} catch {
  passthrough()
}

const toolName = payload?.tool_name
if (!TARGET_TOOLS.has(toolName)) passthrough()

const query = extractQuery(toolName, payload?.tool_input)
if (!query.trim()) passthrough()

const sessionKey =
  typeof payload?.session_id === 'string' && payload.session_id.trim()
    ? payload.session_id
    : randomUUID()

const { passthrough: skip, data } = await lookupWithBudget({
  apiBase: API_BASE,
  body: { session_key: sessionKey, query, source_tool: toolName },
})

if (skip || data?.hit !== true || typeof data?.agent_message !== 'string' || !data.agent_message.trim()) {
  passthrough()
}

// A match was found — hand the cached answer back and skip the web call.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: data.agent_message,
    },
  })
)
process.exit(0)
