import { test, expect } from 'claude-code/testing'
import { CONFIG, DIR, RUN, SENT, config, fakeHost, header } from './host'

const FIVE = '2026-10-11T22:40:00Z' // 3:40 pm PT today
const NOTE = 'Out of Claude limits, ping me at 3:40 pm PT'
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
  expect(host.scripts[0]).toContain('Out of Claude limits, ping me at 3 pm PT')
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
