/**
 * Business order / inventory event dates (IST calendar day).
 * createdAt / InventoryLog.createdAt remain wall-clock audit timestamps.
 */

const MAX_PAST_DAYS = 90

/** Format a Date as YYYY-MM-DD in Asia/Kolkata. */
function toIstDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * Parse YYYY-MM-DD into a Date at 12:00 IST (06:30 UTC).
 * Midday avoids edge midnight filter issues.
 */
function parseBusinessDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null

  const utc = new Date(Date.UTC(year, month - 1, day, 6, 30, 0, 0))
  if (Number.isNaN(utc.getTime())) return null
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null
  }
  return utc
}

/** Inclusive IST day start and exclusive next-day start. */
function istDayBounds(dateOrStr) {
  const dateStr = typeof dateOrStr === 'string' ? dateOrStr.slice(0, 10) : toIstDateString(dateOrStr)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const start = new Date(`${dateStr}T00:00:00+05:30`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start, end, dateStr }
}

/**
 * Resolve orderDate from request body.
 * Empty/missing → today IST.
 * Returns { ok, orderDate, dateStr, bounds, error }.
 */
function resolveOrderDateInput(raw, { maxPastDays = MAX_PAST_DAYS, allowFuture = false } = {}) {
  const todayStr = toIstDateString()
  const dateStr = raw && String(raw).trim() ? String(raw).trim().slice(0, 10) : todayStr
  const orderDate = parseBusinessDate(dateStr)
  if (!orderDate) {
    return { ok: false, error: 'orderDate must be YYYY-MM-DD' }
  }

  if (!allowFuture && dateStr > todayStr) {
    return { ok: false, error: 'orderDate cannot be in the future' }
  }

  const todayBounds = istDayBounds(todayStr)
  const oldest = new Date(todayBounds.start)
  oldest.setUTCDate(oldest.getUTCDate() - maxPastDays)
  const oldestStr = toIstDateString(oldest)
  if (dateStr < oldestStr) {
    return { ok: false, error: `orderDate cannot be older than ${maxPastDays} days` }
  }

  const bounds = istDayBounds(dateStr)
  return { ok: true, orderDate, dateStr, bounds }
}

module.exports = {
  MAX_PAST_DAYS,
  toIstDateString,
  parseBusinessDate,
  istDayBounds,
  resolveOrderDateInput,
}
