// limit-note: when a Claude subscription limit reaches 99%, push the status
// text "Out of Claude limits, ping me at 3:40 pm PT" to the person's phone
// through ntfy (and, when turned on, set it as their GitHub status), once per
// window across every open session. It reads the limits the engine already
// measures and never calls the model.
import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register, SessionRateLimit } from 'claude-code'
import { backText, kindLabel, pickTrigger } from './note'
import type { Trigger } from './note'

export type Config = {
  topic: string
  server: string
  click: string
  threshold: number
  github: boolean
  gh: string
}

const DEFAULTS: Omit<Config, 'topic'> = {
  server: 'https://ntfy.sh',
  click: 'instagram://direct-inbox',
  threshold: 99,
  github: false,
  gh: '/opt/homebrew/bin/gh',
}

// The engine's PATH has no /opt/homebrew, so every command goes by full path.
const CURL = '/usr/bin/curl'
const SEND_TIMEOUT_MS = 10_000
// A lock older than this belongs to a session that died mid-send.
const STALE_LOCK_MS = 2 * 60_000
const STORE_KEY = 'sent'
const STATUS_MUTATION =
  'mutation($message: String!, $expiresAt: DateTime) { changeUserStatus(input: { message: $message, emoji: ":hourglass_flowing_sand:", expiresAt: $expiresAt }) { status { message } } }'

const HELP = [
  '/limit-note status shows the setup, the live limit readings and what was sent.',
  '/limit-note setup writes ~/.config/limit-note/config.json with a private ntfy topic.',
  '/limit-note test sends a test push from a made-up 99% reading; add github to also try the GitHub status.',
].join('\n')

type Paths = { dir: string; config: string; sent: string; lock: string }
/** Until when each window's alert counts as sent, by window kind. */
type Sent = Record<string, number>
type Outcome = 'quiet' | 'no-config' | 'already' | 'busy' | 'sent' | `failed: ${string}`

export const register: Register = on => {
  // Said once per load: a reading at the limit with no config set up.
  let hasToldSetup = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'limit-note',
      description: 'Phone alert when your Claude limits reach 99%: status, setup or test',
      argumentHint: '[status | setup | test]',
      immediate: true,
    })
    return started
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    try {
      const outcome = await onReading($, e.rateLimits)
      if (outcome === 'sent') $.ui.toast('Claude limits at 99%: sent your status text to your phone.')
      else if (outcome === 'no-config' && !hasToldSetup) {
        hasToldSetup = true
        $.ui.toast('Claude limits at 99%. Run /limit-note setup to get this on your phone.')
      } else if (outcome.startsWith('failed')) $.ui.log(`limit-note: push ${outcome}`, { to: 'debug' })
    } catch (err) {
      $.ui.log(`limit-note: ${String(err)}`, { to: 'debug' })
    }
    return measured
  })

  on('command.run', { command: 'limit-note' }, async ($, e) => {
    const [verb = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    try {
      if (verb === 'status') return { text: await status($) }
      if (verb === 'setup') return { text: await setup($) }
      if (verb === 'test') return { text: await sendTest($, rest.includes('github')) }
      return { text: HELP }
    } catch (err) {
      return { text: `limit-note: ${String(err)}` }
    }
  })
}

/** A reading arrived: send the alert if it calls for one nobody has sent. */
async function onReading($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<Outcome> {
  const now = await $.clock.now()
  const p = await paths($)
  const cfg = await readConfig($, p.config)
  if (!cfg) return pickTrigger(limits, now) ? 'no-config' : 'quiet'
  const trigger = pickTrigger(limits, now, cfg.threshold)
  if (!trigger) return 'quiet'
  // This session's own record answers most readings without touching a file.
  if ((asSent(await $.store.get(STORE_KEY))[trigger.kind] ?? 0) > now) return 'already'
  if (!(await takeLock($, p.lock, now))) return 'busy'
  try {
    // The file is what every open session shares; the store only mirrors it.
    // An alert counts as sent while its window lasts, whatever exact time
    // string each session's reading carries.
    const sent = await readSent($, p.sent, now)
    if ((sent[trigger.kind] ?? 0) > now) {
      await $.store.set(STORE_KEY, sent)
      return 'already'
    }
    const pushed = await push($, cfg, trigger, false)
    if (pushed !== 'ok') return `failed: ${pushed}`
    sent[trigger.kind] = trigger.until
    await $.fs.write(p.sent, JSON.stringify(sent))
    await $.store.set(STORE_KEY, sent)
    if (cfg.github) {
      const set = await setGithubStatus($, cfg, trigger.note, trigger.until)
      if (set !== 'ok') $.ui.log(`limit-note: GitHub status not set: ${set}`, { to: 'debug' })
    }
    return 'sent'
  } finally {
    await run($, ['/bin/rmdir', p.lock])
  }
}

/** `/limit-note test`: the same push from a made-up 99% reading. */
async function sendTest($: EngineInterface, withGithub: boolean): Promise<string> {
  const now = await $.clock.now()
  const cfg = await readConfig($, (await paths($)).config)
  if (!cfg) return 'Not set up yet. Run /limit-note setup first.'
  // A reset three hours out, on a ten-minute mark, as a real reading has.
  const resetsAt = new Date(Math.ceil((now + 3 * 3_600_000) / 600_000) * 600_000).toISOString()
  const reading = { kind: 'five_hour', percentUsed: Math.max(99, cfg.threshold), resetsAt }
  const trigger = pickTrigger([reading], now, cfg.threshold)
  if (!trigger) return 'The test reading did not trigger an alert.'
  // No lock and no sent record: a test never holds back a real alert.
  const pushed = await push($, cfg, trigger, true)
  const lines = [
    pushed === 'ok' ? `Sent a test push to ntfy topic ${cfg.topic}: "${trigger.note}".` : `The test push failed: ${pushed}`,
  ]
  if (withGithub) {
    const set = await setGithubStatus($, cfg, `Test: ${trigger.note}`, now + 2 * 60_000)
    lines.push(set === 'ok' ? 'Set a test GitHub status that clears in 2 minutes.' : `The GitHub status failed: ${set}`)
  }
  return lines.join('\n')
}

/** `/limit-note setup`: write a config with a fresh random topic. */
async function setup($: EngineInterface): Promise<string> {
  const p = await paths($)
  const existing = await readConfig($, p.config)
  if (existing) return `Already set up. ${subscribeText(existing)}`
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const topic = `ln-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`
  const text = `${JSON.stringify({ topic, ...DEFAULTS }, null, 2)}\n`
  // umask 077 makes the folder 700 and the file 600 from the start, and
  // set -C refuses to overwrite a config another session wrote meanwhile.
  const argv = ['/bin/sh', '-c', 'umask 077 && /bin/mkdir -p "$1" && set -C && /bin/cat > "$2"', 'sh', p.dir, p.config]
  const made = await run($, argv, { stdin: text })
  if (made.exitCode !== 0) return `Could not write ${p.config}: ${made.stderr.trim()}`
  return `Wrote ${p.config}. ${subscribeText({ ...DEFAULTS, topic })}`
}

/** `/limit-note status`: the config, the live readings and what was sent. */
async function status($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const p = await paths($)
  const cfg = await readConfig($, p.config)
  const lines = [
    cfg
      ? `Topic ${cfg.topic} on ${cfg.server}, alert at ${cfg.threshold}%, GitHub status ${cfg.github ? 'on' : 'off'}.`
      : 'Not set up yet. Run /limit-note setup.',
  ]
  // The plain usage call is free; only a breakdown would count tokens.
  const { rateLimits } = await $.session.usage()
  for (const r of rateLimits) {
    const at = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
    const resets = Number.isFinite(at) && at > now ? `, resets ${backText(at, now)}` : ''
    lines.push(`${kindLabel(r.kind)} limit: ${r.percentUsed}%${resets}.`)
  }
  if (rateLimits.length === 0) lines.push('No limit readings yet in this session.')
  const sent = await readSent($, p.sent, now)
  for (const [kind, until] of Object.entries(sent)) {
    lines.push(`Alert for the ${kindLabel(kind)} limit already sent, holds until ${backText(until, now).replace(/^at /, '')}.`)
  }
  return lines.join('\n')
}

function subscribeText(cfg: Config): string {
  return `In the ntfy phone app, subscribe to the topic ${cfg.topic} on ${cfg.server}, then run /limit-note test.`
}

async function paths($: EngineInterface): Promise<Paths> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  const dir = `${home}/.config/limit-note`
  return { dir, config: `${dir}/config.json`, sent: `${dir}/sent.json`, lock: `${dir}/lock` }
}

async function readConfig($: EngineInterface, file: string): Promise<Config | undefined> {
  if (!(await $.fs.exists(file))) return undefined
  const raw: unknown = JSON.parse(await $.fs.read(file))
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof o.topic !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.topic)) {
    throw new Error(`${file} has no valid "topic"`)
  }
  const pick = <K extends keyof typeof DEFAULTS>(key: K): (typeof DEFAULTS)[K] =>
    typeof o[key] === typeof DEFAULTS[key] ? (o[key] as (typeof DEFAULTS)[K]) : DEFAULTS[key]
  return {
    topic: o.topic,
    server: pick('server'),
    click: pick('click'),
    threshold: pick('threshold'),
    github: pick('github'),
    gh: pick('gh'),
  }
}

async function push($: EngineInterface, cfg: Config, t: Trigger, isTest: boolean): Promise<string> {
  const title = `${isTest ? 'Test: ' : ''}Claude ${kindLabel(t.kind)} limit at ${t.percentUsed}%`
  const url = `${cfg.server.replace(/\/+$/, '')}/${cfg.topic}`
  const argv = [CURL, '-fsS', '--max-time', '8', '-H', `Title: ${title}`, '-H', 'Tags: hourglass_flowing_sand', '-H', `Click: ${cfg.click}`, '--data-binary', '@-', url]
  const r = await run($, argv, { stdin: t.note, timeoutMs: SEND_TIMEOUT_MS })
  return r.exitCode === 0 ? 'ok' : r.stderr.trim() || `curl exited ${r.exitCode}`
}

// `expiresAt` clears the status by itself when the window resets.
async function setGithubStatus($: EngineInterface, cfg: Config, message: string, until: number): Promise<string> {
  const argv = [cfg.gh, 'api', 'graphql', '-f', `query=${STATUS_MUTATION}`, '-f', `message=${message}`, '-f', `expiresAt=${new Date(until).toISOString()}`]
  const r = await run($, argv, { timeoutMs: SEND_TIMEOUT_MS })
  return r.exitCode === 0 ? 'ok' : r.stderr.trim() || `gh exited ${r.exitCode}`
}

// mkdir either creates the folder or fails, atomically, so one session of the
// many open holds the lock at a time.
async function takeLock($: EngineInterface, lock: string, now: number): Promise<boolean> {
  if ((await run($, ['/bin/mkdir', lock])).exitCode === 0) return true
  const held = await $.fs.stat(lock).catch(() => undefined)
  if (held === undefined || now - held.mtimeMs < STALE_LOCK_MS) return false
  await run($, ['/bin/rmdir', lock])
  return (await run($, ['/bin/mkdir', lock])).exitCode === 0
}

async function readSent($: EngineInterface, file: string, now: number): Promise<Sent> {
  if (!(await $.fs.exists(file))) return {}
  try {
    // Records past their window are dropped as they are read.
    const all = asSent(JSON.parse(await $.fs.read(file)))
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now))
  } catch {
    return {}
  }
}

function asSent(value: unknown): Sent {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter((x): x is [string, number] => typeof x[1] === 'number'))
}

async function run($: EngineInterface, argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> {
  try {
    return await $.process.run(argv, init)
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err), isStdoutTruncated: false, isStderrTruncated: false }
  }
}
