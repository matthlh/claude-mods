// Which reading sets off the alert, and the status text it carries. Pure:
// everything here takes the time as an argument, so the tests pin it.
import type { SessionRateLimit } from 'claude-code'

// The subscription's windows. A gateway's `spend_limit` runs past 100 and is
// not the person's plan, so it never counts.
const WINDOWS: readonly string[] = ['five_hour', 'seven_day']
// A window that resets sooner than this is a stale reading (the usage may have
// happened in claude.ai chat while this session sat idle) or nearly over.
export const MIN_LEAD_MS = 10 * 60_000
// How long an alert stays sent when the reading gave no reset time.
export const FALLBACK_HOLD_MS = 5 * 60 * 60_000
export const ZONE = 'America/Vancouver'
export const NOTE_FALLBACK = 'Out of Claude Tokens; Ping me later pls'

export type Trigger = {
  /** The window that sets the back time; alerts are deduped on it. */
  kind: string
  percentUsed: number
  /** When that window resets; absent when the reading gave no time. */
  backAt?: number
  /** Until when this alert counts as sent. */
  until: number
  note: string
}

type Hot = { kind: string; percentUsed: number; at?: number }

/**
 * The alert a set of readings calls for, or undefined. Fires at `threshold`
 * or above, never on equality: a burst of readings folds into one, so the
 * exact value can be skipped.
 */
export function pickTrigger(limits: readonly SessionRateLimit[], now: number, threshold = 99): Trigger | undefined {
  const hot: Hot[] = []
  for (const r of limits) {
    if (!WINDOWS.includes(r.kind) || !(r.percentUsed >= threshold)) continue
    const parsed = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
    const at = Number.isFinite(parsed) ? parsed : undefined
    if (at !== undefined && at - now < MIN_LEAD_MS) continue
    hot.push({ kind: r.kind, percentUsed: r.percentUsed, at })
  }
  if (hot.length === 0) return undefined
  // A hot window with no reset time could be the one that ends last, so the
  // text names no time rather than one that may be too early.
  const blind = hot.filter(w => w.at === undefined)
  if (blind.length > 0) {
    const w = blind.find(b => b.kind === 'seven_day') ?? blind[0]!
    return { kind: w.kind, percentUsed: w.percentUsed, until: now + FALLBACK_HOLD_MS, note: NOTE_FALLBACK }
  }
  const last = hot.reduce((a, b) => (b.at! > a.at! ? b : a))
  return { kind: last.kind, percentUsed: last.percentUsed, backAt: last.at!, until: last.at!, note: noteFor(last.at!, now) }
}

/** "Out of Claude Tokens; Ping me 3:40 pm PT pls", with the day when not today. */
export function noteFor(at: number, now: number): string {
  return `Out of Claude Tokens; Ping me ${backText(at, now)} pls`
}

/**
 * "3:40 pm PT" today, "Tue 3 pm PT" within the week, "Oct 18 3 pm PT"
 * past it (a weekday alone would read as today a week out).
 */
export function backText(at: number, now: number): string {
  const p = parts(at)
  const time = `${p.hour}${p.minute === '00' ? '' : `:${p.minute}`} ${(p.dayPeriod ?? '').toLowerCase()}`
  const days = dayNumber(parts(at)) - dayNumber(parts(now))
  const day = days <= 0 ? '' : days < 7 ? `${p.weekday} ` : `${p.month} ${p.day} `
  return `${day}${time} PT`
}

export function kindLabel(kind: string): string {
  return kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? 'weekly' : kind
}

const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour12: true,
  hour: 'numeric',
  minute: '2-digit',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(t: number): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  return Object.fromEntries(FORMAT.formatToParts(t).map(x => [x.type, x.value]))
}

// The local calendar day as a day count, so a difference is whole days.
function dayNumber(p: Partial<Record<Intl.DateTimeFormatPartTypes, string>>): number {
  return Date.UTC(Number(p.year), MONTHS.indexOf(p.month ?? ''), Number(p.day)) / 86_400_000
}
