import { test, expect } from 'claude-code/testing'
import { FALLBACK_HOLD_MS, NOTE_FALLBACK, noteFor, pickTrigger } from '../hooks/note'

// Sunday Oct 11 2026, noon in Vancouver (PDT, UTC-7).
const NOW = Date.parse('2026-10-11T19:00:00Z')
const at = (iso: string) => Date.parse(iso)

test('the status text names the time in Pacific time, minutes only when not on the hour', () => {
  expect(noteFor(at('2026-10-11T22:40:00Z'), NOW)).toBe('Out of Claude limits, ping me at 3:40 pm PT')
  expect(noteFor(at('2026-10-11T22:00:00Z'), NOW)).toBe('Out of Claude limits, ping me at 3 pm PT')
  expect(noteFor(at('2026-10-11T19:05:00Z'), NOW)).toBe('Out of Claude limits, ping me at 12:05 pm PT')
})

test('a reset on another day names the weekday, and a week or more out the date', () => {
  expect(noteFor(at('2026-10-13T16:00:00Z'), NOW)).toBe('Out of Claude limits, ping me Tue at 9 am PT')
  // 11:30 pm Sunday to 1 am Monday is tomorrow, though under two hours away.
  expect(noteFor(at('2026-10-12T08:00:00Z'), at('2026-10-12T06:30:00Z'))).toBe('Out of Claude limits, ping me Mon at 1 am PT')
  // Same weekday a week on: a bare "Sun" would read as today.
  expect(noteFor(at('2026-10-18T19:00:00Z'), NOW)).toBe('Out of Claude limits, ping me Oct 18 at 12 pm PT')
})

test('the time follows Vancouver, which keeps daylight time from Nov 2026 where Los Angeles does not', () => {
  // tzdata 2026b: B.C. stays on UTC-7 year-round, so 01:00 UTC is 6 pm, not 5.
  expect(noteFor(at('2026-11-02T01:00:00Z'), at('2026-11-01T19:00:00Z'))).toBe('Out of Claude limits, ping me at 6 pm PT')
  expect(noteFor(at('2027-01-15T20:00:00Z'), at('2027-01-15T18:00:00Z'))).toBe('Out of Claude limits, ping me at 1 pm PT')
})

test('every text fits an Instagram Note', () => {
  const longest = noteFor(at('2026-10-20T19:50:00Z'), NOW)
  expect(longest).toBe('Out of Claude limits, ping me Oct 20 at 12:50 pm PT')
  expect(longest.length).toBeLessThan(60)
  expect(NOTE_FALLBACK.length).toBeLessThan(60)
})

test('fires at 99 or above, never on an exact match, and only for the plan windows', () => {
  const resetsAt = '2026-10-11T22:40:00Z'
  expect(pickTrigger([], NOW)).toBeUndefined()
  expect(pickTrigger([{ kind: 'five_hour', percentUsed: 98.9, resetsAt }], NOW)).toBeUndefined()
  expect(pickTrigger([{ kind: 'five_hour', percentUsed: 99, resetsAt }], NOW)?.kind).toBe('five_hour')
  // A burst folded 98 straight into 100.
  expect(pickTrigger([{ kind: 'seven_day', percentUsed: 100, resetsAt }], NOW)?.kind).toBe('seven_day')
  expect(pickTrigger([{ kind: 'spend_limit', percentUsed: 150, resetsAt }], NOW)).toBeUndefined()
  expect(pickTrigger([{ kind: 'five_hour', percentUsed: 95, resetsAt }], NOW, 95)?.percentUsed).toBe(95)
})

test('a reading that resets within ten minutes or already has is stale and skipped', () => {
  expect(pickTrigger([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-11T19:09:00Z' }], NOW)).toBeUndefined()
  expect(pickTrigger([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-11T18:00:00Z' }], NOW)).toBeUndefined()
  expect(pickTrigger([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-11T19:11:00Z' }], NOW)?.note).toBe(
    'Out of Claude limits, ping me at 12:11 pm PT',
  )
})

test('the back time is the latest reset among the windows at the limit', () => {
  const t = pickTrigger(
    [
      { kind: 'five_hour', percentUsed: 99.5, resetsAt: '2026-10-11T22:40:00Z' },
      { kind: 'seven_day', percentUsed: 99, resetsAt: '2026-10-13T16:00:00Z' },
    ],
    NOW,
  )
  expect(t).toEqual({
    kind: 'seven_day',
    percentUsed: 99,
    backAt: at('2026-10-13T16:00:00Z'),
    until: at('2026-10-13T16:00:00Z'),
    note: 'Out of Claude limits, ping me Tue at 9 am PT',
  })
  // A window under the limit does not set the time, however late it resets.
  const five = pickTrigger(
    [
      { kind: 'five_hour', percentUsed: 99.5, resetsAt: '2026-10-11T22:40:00Z' },
      { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-13T16:00:00Z' },
    ],
    NOW,
  )
  expect(five?.kind).toBe('five_hour')
})

test('a window at the limit with no reset time gives the text without a time', () => {
  expect(pickTrigger([{ kind: 'five_hour', percentUsed: 99 }], NOW)).toEqual({
    kind: 'five_hour',
    percentUsed: 99,
    until: NOW + FALLBACK_HOLD_MS,
    note: NOTE_FALLBACK,
  })
  const mixed = pickTrigger(
    [
      { kind: 'five_hour', percentUsed: 99, resetsAt: '2026-10-11T22:40:00Z' },
      { kind: 'seven_day', percentUsed: 99.1, resetsAt: 'not a time' },
    ],
    NOW,
  )
  expect(mixed?.kind).toBe('seven_day')
  expect(mixed?.note).toBe(NOTE_FALLBACK)
})
