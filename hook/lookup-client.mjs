/**
 * Shared-cache lookup client with a strict time budget.
 *
 * Everything here is fail-open by design: if the cache is slow, unreachable, or
 * returns anything unexpected, we simply report `passthrough: true` so the
 * original tool call runs untouched. The cache is only ever allowed to help —
 * never to get in the way.
 */

const DEFAULT_LOOKUP_TIMEOUT_MS = 800
const timeoutStats = { total: 0, timeouts: 0 }

export function getLookupTimeoutMs() {
  const raw = process.env.LOOKUP_TIMEOUT_MS
  const parsed = raw ? Number(raw) : DEFAULT_LOOKUP_TIMEOUT_MS
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOOKUP_TIMEOUT_MS
}

export function getTimeoutRate() {
  return timeoutStats.total === 0
    ? 0
    : Number((timeoutStats.timeouts / timeoutStats.total).toFixed(4))
}

/**
 * @returns {{ passthrough: boolean, timed_out?: boolean, data?: object, timeout_rate: number }}
 */
export async function lookupWithBudget({ apiBase, body, timeoutMs = getLookupTimeoutMs() }) {
  timeoutStats.total += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/hook/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = await response.json()
    return { passthrough: false, timed_out: false, data, timeout_rate: getTimeoutRate() }
  } catch (error) {
    if (error?.name === 'AbortError') {
      timeoutStats.timeouts += 1
      const timeout_rate = getTimeoutRate()
      process.stderr.write(
        JSON.stringify({ event: 'aieph_lookup_timeout', timeout_ms: timeoutMs, timeout_rate }) + '\n'
      )
      return { passthrough: true, timed_out: true, timeout_rate }
    }
    process.stderr.write(
      JSON.stringify({ event: 'aieph_lookup_error', message: error?.message ?? 'unknown' }) + '\n'
    )
    return { passthrough: true, timed_out: false, timeout_rate: getTimeoutRate() }
  } finally {
    clearTimeout(timer)
  }
}
