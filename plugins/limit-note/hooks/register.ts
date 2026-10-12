// limit-note: when a Claude subscription limit reaches 99%, put up the status
// text "Out of Claude limits, ping me at 3:40 pm PT", once per window across
// every open session. Turned on, it posts that text as the person's Instagram
// Note itself (scripts/instagram-note.mjs, a headless Chrome in a profile of
// its own) and sets their GitHub status; either way an ntfy push tells their
// phone what happened. It reads the limits the engine already measures and
// never calls the model.
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
  instagram: boolean
  node: string
  chrome: string
}

const DEFAULTS: Omit<Config, 'topic'> = {
  server: 'https://ntfy.sh',
  click: 'instagram://direct-inbox',
  threshold: 99,
  github: false,
  gh: '/opt/homebrew/bin/gh',
  instagram: false,
  node: '/opt/homebrew/bin/node',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}

// The engine's PATH has no /opt/homebrew, so every command goes by full path.
const CURL = '/usr/bin/curl'
const SEND_TIMEOUT_MS = 10_000
// The script gives up at 90 s; this leaves it room to close Chrome.
const INSTAGRAM_TIMEOUT_MS = 120_000
// A lock older than this belongs to a session that died mid-send.
const STALE_LOCK_MS = 5 * 60_000
const STORE_KEY = 'sent'
const STATUS_MUTATION =
  'mutation($message: String!, $expiresAt: DateTime) { changeUserStatus(input: { message: $message, emoji: ":hourglass_flowing_sand:", expiresAt: $expiresAt }) { status { message } } }'

const HELP = [
  '/limit-note status shows the setup, the live limit readings and what was sent.',
  '/limit-note setup writes ~/.config/limit-note/config.json with a private ntfy topic.',
  '/limit-note test sends a test push from a made-up 99% reading; add github to also try the GitHub status.',
  '/limit-note instagram-login opens the Chrome profile the Instagram auto-post uses, for you to sign in once.',
  '/limit-note test instagram goes as far as the Note composer and stops before Share; add live to post for real.',
].join('\n')

type Paths = { dir: string; config: string; sent: string; lock: string; profile: string }
/** Until when each window's alert counts as sent, by window kind. */
type Sent = Record<string, number>
/** What the Instagram script reported: whether the Note is up, and each step. */
type Posted = { ok: boolean; reason?: string; steps: string[] }
type Outcome = 'quiet' | 'no-config' | 'already' | 'busy' | 'sent' | 'posted' | `failed: ${string}`

export const register: Register = on => {
  // Said once per load: a reading at the limit with no config set up.
  let hasToldSetup = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'limit-note',
      description: 'Your Instagram Note and a phone alert when your Claude limits reach 99%',
      argumentHint: '[status | setup | test | instagram-login]',
      immediate: true,
    })
    return started
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    try {
      const outcome = await onReading($, e.rateLimits)
      if (outcome === 'posted') $.ui.toast('Claude limits at 99%: your Instagram Note is up.')
      else if (outcome === 'sent') $.ui.toast('Claude limits at 99%: sent your status text to your phone.')
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
      if (verb === 'instagram-login') return { text: await instagramLogin($) }
      if (verb === 'test' && rest.includes('instagram')) return { text: await testInstagram($, rest.includes('live')) }
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
    const posted = cfg.instagram ? await postNote($, cfg, p, trigger.note, false) : undefined
    const pushed = await push($, cfg, trigger, false, posted)
    // A Note that is up is the alert delivered, even with the push lost.
    if (pushed !== 'ok' && posted?.ok !== true) return `failed: ${pushed}`
    sent[trigger.kind] = trigger.until
    await $.fs.write(p.sent, JSON.stringify(sent))
    await $.store.set(STORE_KEY, sent)
    if (cfg.github) {
      const set = await setGithubStatus($, cfg, trigger.note, trigger.until)
      if (set !== 'ok') $.ui.log(`limit-note: GitHub status not set: ${set}`, { to: 'debug' })
    }
    if (posted !== undefined && !posted.ok) $.ui.log(`limit-note: Instagram auto-post failed: ${posted.reason}`, { to: 'debug' })
    return posted?.ok ? 'posted' : 'sent'
  } finally {
    await run($, ['/bin/rmdir', p.lock])
  }
}

/** `/limit-note test`: the same push from a made-up 99% reading. */
async function sendTest($: EngineInterface, withGithub: boolean): Promise<string> {
  const now = await $.clock.now()
  const cfg = await readConfig($, (await paths($)).config)
  if (!cfg) return 'Not set up yet. Run /limit-note setup first.'
  const trigger = testTrigger(now, cfg)
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

/** `/limit-note test instagram [live]`: the auto-post from a made-up reading; without live it stops before Share. */
async function testInstagram($: EngineInterface, isLive: boolean): Promise<string> {
  const now = await $.clock.now()
  const p = await paths($)
  const cfg = await readConfig($, p.config)
  if (!cfg) return 'Not set up yet. Run /limit-note setup first.'
  const trigger = testTrigger(now, cfg)
  const posted = await postNote($, cfg, p, trigger.note, !isLive)
  const lines = [...posted.steps]
  if (!posted.ok) lines.push(`It failed: ${posted.reason}.`)
  if (isLive) {
    const pushed = await push($, cfg, trigger, true, posted)
    lines.push(pushed === 'ok' ? 'Sent the push that goes with it.' : `The push failed: ${pushed}`)
  }
  return lines.join('\n')
}

/** `/limit-note instagram-login`: open the auto-post's own Chrome profile to sign in. */
async function instagramLogin($: EngineInterface): Promise<string> {
  const p = await paths($)
  const cfg = await readConfig($, p.config)
  if (!cfg) return 'Not set up yet. Run /limit-note setup first.'
  const opened = await script($, cfg, ['login', '--chrome', cfg.chrome, '--profile', p.profile], SEND_TIMEOUT_MS)
  if (!opened.ok) return `Could not open the Chrome profile: ${opened.reason}`
  return [
    'A Chrome window opened at Instagram, in a profile only limit-note uses.',
    'Sign in there yourself, then close that window.',
    `Then set "instagram": true in ${p.config} and run /limit-note test instagram.`,
  ].join('\n')
}

// A reset three hours out, on a ten-minute mark, as a real reading has.
function testTrigger(now: number, cfg: Config): Trigger {
  const resetsAt = new Date(Math.ceil((now + 3 * 3_600_000) / 600_000) * 600_000).toISOString()
  const reading = { kind: 'five_hour', percentUsed: Math.max(99, cfg.threshold), resetsAt }
  return pickTrigger([reading], now, cfg.threshold)!
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
      ? `Topic ${cfg.topic} on ${cfg.server}, alert at ${cfg.threshold}%, Instagram auto-post ${cfg.instagram ? 'on' : 'off'}, GitHub status ${cfg.github ? 'on' : 'off'}.`
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
  return [
    `In the ntfy phone app, subscribe to the topic ${cfg.topic} on ${cfg.server}, then run /limit-note test.`,
    'To have it post your Instagram Note itself, run /limit-note instagram-login.',
  ].join('\n')
}

async function paths($: EngineInterface): Promise<Paths> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  const dir = `${home}/.config/limit-note`
  return { dir, config: `${dir}/config.json`, sent: `${dir}/sent.json`, lock: `${dir}/lock`, profile: `${dir}/chrome-profile` }
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
    instagram: pick('instagram'),
    node: pick('node'),
    chrome: pick('chrome'),
  }
}

async function postNote($: EngineInterface, cfg: Config, p: Paths, text: string, isDryRun: boolean): Promise<Posted> {
  const args = ['post', '--chrome', cfg.chrome, '--profile', p.profile, '--text', text, ...(isDryRun ? ['--dry-run'] : [])]
  return script($, cfg, args, INSTAGRAM_TIMEOUT_MS)
}

// The script's last line of output is { ok, reason, steps }; its exit code
// says whether the Note is up.
async function script($: EngineInterface, cfg: Config, args: readonly string[], timeoutMs: number): Promise<Posted> {
  const r = await run($, [cfg.node, `${$.plugin.root}/scripts/instagram-note.mjs`, ...args], { timeoutMs })
  try {
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Partial<Posted>
    const steps = Array.isArray(out.steps) ? out.steps.map(String) : []
    return { ok: r.exitCode === 0 && out.ok === true, reason: out.reason ?? (r.exitCode === 0 ? undefined : `exit ${r.exitCode}`), steps }
  } catch {
    return { ok: false, reason: r.stderr.trim().split('\n').pop() || `the script exited ${r.exitCode}`, steps: [] }
  }
}

async function push($: EngineInterface, cfg: Config, t: Trigger, isTest: boolean, posted?: Posted): Promise<string> {
  const lead = `${isTest ? 'Test: ' : ''}Claude ${kindLabel(t.kind)} limit at ${t.percentUsed}%`
  const title = posted?.ok ? `${lead}: Instagram Note is up` : lead
  const body = posted && !posted.ok ? `${t.note}\nThe Instagram auto-post failed: ${posted.reason}.` : t.note
  const url = `${cfg.server.replace(/\/+$/, '')}/${cfg.topic}`
  const argv = [CURL, '-fsS', '--max-time', '8', '-H', `Title: ${title}`, '-H', 'Tags: hourglass_flowing_sand', '-H', `Click: ${cfg.click}`, '--data-binary', '@-', url]
  const r = await run($, argv, { stdin: body, timeoutMs: SEND_TIMEOUT_MS })
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
