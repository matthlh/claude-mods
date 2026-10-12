import { test, expect } from 'claude-code/testing'
import { CONFIG, DIR, RUN, SENT, config, fakeHost, header } from './host'

const FIVE = '2026-10-11T22:40:00Z' // 3:40 pm PT today
const NOTE = 'Out of Claude Tokens; Ping me 3:40 pm PT pls'
const PROFILE = `${DIR}/chrome-profile`

async function start($: any) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  return {
    measure: (rateLimits: unknown[]) => $.session.measure({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] }),
    command: async (args: string) => (await $.command.run({ command: 'limit-note', args, ...RUN })).text as string,
  }
}

test('turned on, the limit posts the Note itself and the push says it is up', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ instagram: true }) })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])

  expect(host.scripts).toEqual([
    ['post', '--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--profile', PROFILE, '--text', NOTE],
  ])
  expect(host.pushes.length).toBe(1)
  expect(header(host.pushes[0]!, 'Title')).toBe('Claude 5-hour limit at 99%: Instagram Note is up')
  expect(host.pushes[0]!.body).toBe(NOTE)
  expect(host.toasts).toEqual(['Claude limits at 99%: your Instagram Note is up.'])
  expect(JSON.parse(host.files.get(SENT)!)).toEqual({ five_hour: Date.parse(FIVE) })

  // The same window again: no second post.
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  expect(host.scripts.length).toBe(1)
})

test('when the post fails the push carries the text and says why', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ instagram: true }) })
  host.script = { exitCode: 2, ok: false, reason: 'signed out of Instagram', steps: [] }
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(header(host.pushes[0]!, 'Title')).toBe('Claude 5-hour limit at 99%')
  expect(host.pushes[0]!.body).toBe(`${NOTE}\nThe Instagram auto-post failed: signed out of Instagram.`)
  expect(host.files.has(SENT)).toBe(true)
})

test('a Note that went up counts as delivered even when the push is lost', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ instagram: true }) })
  host.curlExit = 6
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.files.has(SENT)).toBe(true)
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  expect(host.scripts.length).toBe(1)
})

test('a script that prints nothing readable counts as a failed post', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ instagram: true, node: '/nowhere/node' }) })
  host.script = { exitCode: 1, ok: false, steps: [] }
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.pushes[0]!.body).toContain('The Instagram auto-post failed')
})

test('off by default: no browser runs', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.scripts).toEqual([])
  expect(host.pushes.length).toBe(1)
})

test('/limit-note test instagram stops before Share and sends no push; live posts and pushes', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  host.script = { exitCode: 0, ok: true, steps: ['Dry run: stopped before pressing Share; nothing was posted.'] }
  const { command } = await start($)

  expect(await command('test instagram')).toContain('stopped before pressing Share')
  expect(host.scripts[0]).toContain('--dry-run')
  expect(host.scripts[0]).toContain('Out of Claude Tokens; Ping me 3 pm PT pls')
  expect(host.pushes).toEqual([])

  await command('test instagram live')
  expect(host.scripts[1]).not.toContain('--dry-run')
  expect(header(host.pushes[0]!, 'Title')).toBe('Test: Claude 5-hour limit at 99%: Instagram Note is up')
  expect(host.files.has(SENT)).toBe(false)
})

test('/limit-note instagram-login opens the profile and says what to do next', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { command } = await start($)
  const text = await command('instagram-login')
  expect(host.scripts).toEqual([['login', '--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--profile', PROFILE]])
  expect(text).toContain('Sign in there yourself')
  expect(text).toContain('"instagram": true')
})

const NOTE_FILE = `${DIR}/note.json`
const clears = (host: { scripts: string[][] }) => host.scripts.filter(a => a[0] === 'clear')

test('once the limit resets the Note comes down, even in a session sitting idle', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ instagram: true }) })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(JSON.parse(host.files.get(NOTE_FILE)!)).toEqual({ until: Date.parse(FIVE) })

  // Nothing comes down before the reset; the timer finds it soon after.
  await host.clock.set(Date.parse(FIVE) - 60_000)
  expect(clears(host)).toEqual([])
  await host.clock.advance(6 * 60_000)
  expect(clears(host)).toEqual([['clear', '--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--profile', PROFILE]])
  expect(JSON.parse(host.files.get(NOTE_FILE)!)).toEqual({})
  expect(host.toasts).toContain('Your Claude limit reset: took your Instagram Note down.')

  // Done once: later ticks and readings leave it.
  await host.clock.advance(30 * 60_000)
  await measure([{ kind: 'five_hour', percentUsed: 3, resetsAt: '2026-10-12T03:40:00Z' }])
  expect(clears(host).length).toBe(1)
})

test('a failed take-down is tried three times, ten minutes apart, then left', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ instagram: true }) })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  host.script = { exitCode: 2, ok: false, reason: 'signed out of Instagram', steps: [] }
  await host.clock.set(Date.parse(FIVE) + 60_000)
  expect(clears(host).length).toBe(1)
  await host.clock.advance(60 * 60_000)
  expect(clears(host).length).toBe(3)
  expect(JSON.parse(host.files.get(NOTE_FILE)!)).toEqual({})
})

test('a post that failed leaves nothing to take down', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ instagram: true }) })
  host.script = { exitCode: 3, ok: false, reason: 'the inbox never showed your Note bubble', steps: [] }
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  await host.clock.set(Date.parse(FIVE) + 30 * 60_000)
  expect(clears(host)).toEqual([])
})

test('/limit-note test instagram clear stops before deleting; live deletes', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  host.script = { exitCode: 0, ok: true, steps: ['Found "Delete note".', 'Dry run: stopped before deleting; your Note is still up.'] }
  const { command } = await start($)
  expect(await command('test instagram clear')).toContain('stopped before deleting')
  expect(clears(host)[0]).toContain('--dry-run')
  await command('test instagram clear live')
  expect(clears(host)[1]).not.toContain('--dry-run')
  expect(host.pushes).toEqual([])
})
