import { test, expect } from 'claude-code/testing'
import { CONFIG, LOCK, RUN, SENT, T0, config, fakeHost, header } from './host'

const FIVE = '2026-10-11T22:40:00Z' // 3:40 pm PT today
const SEVEN = '2026-10-13T16:00:00Z' // Tue 9 am PT

async function start($: any) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  return {
    measure: (rateLimits: unknown[]) => $.session.measure({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] }),
    command: async (args: string) => (await $.command.run({ command: 'limit-note', args, ...RUN })).text as string,
  }
}

test('a 99% reading pushes the status text once, and later readings stay quiet', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure } = await start($)

  await measure([{ kind: 'five_hour', percentUsed: 98, resetsAt: FIVE }])
  expect(host.pushes).toEqual([])

  await measure([{ kind: 'five_hour', percentUsed: 99.4, resetsAt: FIVE }, { kind: 'seven_day', percentUsed: 40, resetsAt: SEVEN }])
  expect(host.pushes.length).toBe(1)
  const push = host.pushes[0]!
  expect(push.argv[0]).toBe('/usr/bin/curl')
  expect(push.argv[push.argv.length - 1]).toBe('https://ntfy.sh/ln-test')
  expect(push.body).toBe('Out of Claude limits, ping me at 3:40 pm PT')
  expect(header(push, 'Title')).toBe('Claude 5-hour limit at 99.4%')
  expect(header(push, 'Click')).toBe('instagram://direct-inbox')
  expect(push.timeoutMs).toBeGreaterThan(0)
  expect(JSON.parse(host.files.get(SENT)!)).toEqual({ five_hour: Date.parse(FIVE) })
  expect(host.dirs.has(LOCK)).toBe(false)
  expect(host.toasts.length).toBe(1)

  // 100 is the same window: no push, and no lock taken to find that out.
  const mkdirs = host.mkdirs
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  expect(host.pushes.length).toBe(1)
  expect(host.mkdirs).toBe(mkdirs)
  expect(host.modelCalls).toEqual([])
})

test('an alert another session sent holds this one back', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config(), [SENT]: JSON.stringify({ five_hour: Date.parse(FIVE) }) })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99.8, resetsAt: '2026-10-11T22:40:00.512Z' }])
  expect(host.pushes).toEqual([])
  expect(host.dirs.has(LOCK)).toBe(false)
})

test('a lock another session holds holds back; one left by a dead session is taken over', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  host.dirs.set(LOCK, T0 - 5_000)
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.pushes).toEqual([])
  expect(host.dirs.has(LOCK)).toBe(true)

  await host.clock.advance(3 * 60_000)
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  expect(host.pushes.length).toBe(1)
  expect(host.dirs.has(LOCK)).toBe(false)
})

test('the weekly limit joining later pushes again with the later time', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }, { kind: 'seven_day', percentUsed: 99, resetsAt: SEVEN }])
  expect(host.pushes.map(p => p.body)).toEqual([
    'Out of Claude limits, ping me at 3:40 pm PT',
    'Out of Claude limits, ping me Tue at 9 am PT',
  ])
  expect(header(host.pushes[1]!, 'Title')).toBe('Claude weekly limit at 99%')
})

test('the next window pushes again once the last one has reset', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  await host.clock.set(Date.parse('2026-10-12T02:00:00Z')) // 7 pm PT
  await measure([{ kind: 'five_hour', percentUsed: 99.2, resetsAt: '2026-10-12T05:00:00Z' }])
  expect(host.pushes.map(p => p.body)).toEqual([
    'Out of Claude limits, ping me at 3:40 pm PT',
    'Out of Claude limits, ping me at 10 pm PT',
  ])
})

test('a stale reading from before a reset pushes nothing', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-11T18:30:00Z' }])
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-11T19:05:00Z' }])
  await measure([])
  expect(host.pushes).toEqual([])
})

test('a failed push is not marked sent, so the next reading tries again', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure } = await start($)
  host.curlExit = 6
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.files.has(SENT)).toBe(false)
  expect(host.dirs.has(LOCK)).toBe(false)
  host.curlExit = 0
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  expect(host.pushes.length).toBe(2)
  expect(host.files.has(SENT)).toBe(true)
})

test('with no config a reading at the limit pushes nothing and says how to set up, once', async ($: any, on: any) => {
  const host = fakeHost(on)
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  await measure([{ kind: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  expect(host.pushes).toEqual([])
  expect(host.toasts.length).toBe(1)
  expect(host.toasts[0]).toContain('/limit-note setup')
})

test('the GitHub status, when on, expires when the window resets', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config({ github: true, gh: '/usr/local/bin/gh' }) })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.gh.length).toBe(1)
  const gh = host.gh[0]!
  expect(gh.slice(0, 3)).toEqual(['/usr/local/bin/gh', 'api', 'graphql'])
  expect(gh).toContain('message=Out of Claude limits, ping me at 3:40 pm PT')
  expect(gh).toContain('expiresAt=2026-10-11T22:40:00.000Z')
  expect(gh.find(a => a.startsWith('query='))).toContain('changeUserStatus')
})

test('the GitHub status stays off by default', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure } = await start($)
  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.pushes.length).toBe(1)
  expect(host.gh).toEqual([])
})

test('/limit-note test pushes a made-up reading and holds back no real alert', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { measure, command } = await start($)
  const text = await command('test')
  expect(text).toContain('Sent a test push')
  expect(host.pushes.length).toBe(1)
  expect(header(host.pushes[0]!, 'Title')).toBe('Test: Claude 5-hour limit at 99%')
  expect(host.pushes[0]!.body).toBe('Out of Claude limits, ping me at 3 pm PT')
  expect(host.files.has(SENT)).toBe(false)
  expect(host.gh).toEqual([])

  await measure([{ kind: 'five_hour', percentUsed: 99, resetsAt: FIVE }])
  expect(host.pushes.length).toBe(2)

  expect(await command('test github')).toContain('clears in 2 minutes')
  expect(host.gh[0]).toContain('expiresAt=2026-10-11T19:02:00.000Z')
})

test('/limit-note test says when the push failed', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config() })
  const { command } = await start($)
  host.curlExit = 6
  expect(await command('test')).toContain('Could not resolve host')
})

test('/limit-note setup writes a private config with a random topic, once', async ($: any, on: any) => {
  const host = fakeHost(on)
  const { command } = await start($)
  expect(await command('test')).toContain('/limit-note setup')

  const text = await command('setup')
  const shell = host.shells[0]!
  expect(shell.argv[2]).toContain('umask 077')
  expect(shell.argv[2]).toContain('set -C')
  const written = JSON.parse(host.files.get(CONFIG)!)
  expect(written.topic).toMatch(/^ln-[0-9a-f]{32}$/)
  expect(written.github).toBe(false)
  expect(text).toContain(written.topic)

  expect(await command('setup')).toContain('Already set up')
  expect(host.shells.length).toBe(1)
})

test('/limit-note status reads the free usage call, never the counted breakdown', async ($: any, on: any) => {
  const host = fakeHost(on, { [CONFIG]: config(), [SENT]: JSON.stringify({ seven_day: Date.parse(SEVEN), five_hour: T0 - 1 }) })
  const { command } = await start($)
  const text = await command('')
  expect(text).toContain('Topic ln-test')
  expect(text).toContain('5-hour limit: 42%, resets at 3:40 pm PT.')
  expect(text).toContain('weekly limit already sent, holds until Tue at 9 am PT')
  expect(text).not.toContain('5-hour limit already sent')
  expect(host.usageArgs.every(a => (a as { breakdown?: unknown }).breakdown === undefined)).toBe(true)
  expect(await command('help')).toContain('/limit-note test')
  expect(host.modelCalls).toEqual([])
})
