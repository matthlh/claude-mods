// Sets the Instagram Note through instagram.com, in a Chrome profile kept for
// this alone, with no AI and no packages: Chrome is driven over the DevTools
// protocol on a pipe (--remote-debugging-pipe), so no port is ever opened.
//
//   node instagram-note.mjs login --chrome <path> --profile <dir>
//   node instagram-note.mjs post --chrome <path> --profile <dir> --text <note> [--dry-run]
//
// `login` opens the profile in a normal window for the person to sign in by
// hand; nothing here ever types a password or answers a security check.
// `post` prints one JSON line, { ok, reason?, steps }, and exits 0 when the
// Note is up (or, with --dry-run, when the composer is ready and Share was not
// pressed); 2 signed out or a security check, 3 the page is not as expected,
// 4 out of time, 5 the login window is still open, 1 anything else.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readlinkSync } from 'node:fs'

const DEADLINE_MS = 90_000
const INBOX = 'https://www.instagram.com/direct/inbox/'
const BLOCKED = /\/accounts\/login|\/challenge|\/checkpoint|two_factor|\/accounts\/suspended|\/accounts\/disabled/

const [mode, ...rest] = process.argv.slice(2)
const opt = flags(rest)
const steps = []

class Stop extends Error {
  constructor(code, reason) {
    super(reason)
    this.code = code
  }
}

process.on('uncaughtException', fail)
if (mode === 'login') login()
else if (mode === 'post') post().catch(fail)
else finish(1, `unknown mode ${mode}`)

function flags(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const key = list[i].replace(/^--/, '')
    if (key === 'dry-run') out.dryRun = true
    else out[key] = list[++i]
  }
  return out
}

function finish(code, reason) {
  process.stdout.write(`${JSON.stringify({ ok: code === 0, reason, steps })}\n`)
  process.exit(code)
}

function fail(err) {
  finish(err instanceof Stop ? err.code : 1, err instanceof Stop ? err.message : String(err?.message ?? err))
}

function profileDir() {
  if (!opt.profile || !opt.chrome) finish(1, '--profile and --chrome are required')
  mkdirSync(opt.profile, { recursive: true, mode: 0o700 })
  return opt.profile
}

// A normal window, started through `open` so it outlives this script.
function login() {
  const profile = profileDir()
  const app = opt.chrome.replace(/\/Contents\/MacOS\/[^/]+$/, '')
  if (owner(profile)) finish(5, 'the limit-note Chrome profile is already open; sign in in that window')
  execFileSync('/usr/bin/open', ['-na', app, '--args', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'https://www.instagram.com/accounts/login/'])
  steps.push('Opened Instagram in the limit-note Chrome profile.')
  finish(0)
}

// The pid of the Chrome holding the profile, if one is running.
function owner(profile) {
  try {
    const pid = Number(readlinkSync(`${profile}/SingletonLock`).split('-').pop())
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

async function post() {
  const profile = profileDir()
  if (!opt.text) throw new Stop(1, '--text is required')
  const held = owner(profile)
  if (held) {
    // A headless run of ours that was cut off is cleared; the login window is
    // the person's and is left alone.
    const command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(held)], { encoding: 'utf8' })
    if (!command.includes('--headless')) throw new Stop(5, 'the Instagram login window is still open; close it and try again')
    process.kill(held, 'SIGKILL')
    await sleep(1000)
  }
  const chrome = spawn(
    opt.chrome,
    ['--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  )
  const timer = setTimeout(() => {
    chrome.kill('SIGKILL')
    finish(4, `ran out of time after ${DEADLINE_MS / 1000} s`)
  }, DEADLINE_MS)
  const cdp = connect(chrome)
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const page = (method, params) => cdp.send(method, params, sessionId)
    await page('Page.enable')
    await page('Accessibility.enable')
    await page('Page.navigate', { url: INBOX })
    await setNote(page)
  } finally {
    clearTimeout(timer)
    await cdp.send('Browser.close').catch(() => {})
    setTimeout(() => chrome.kill('SIGKILL'), 3000).unref()
  }
  finish(0)
}

async function setNote(page) {
  const evaluate = async expression => (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

  // The inbox, signed in, with the Notes row showing.
  const yourNote = await until(30_000, 'the inbox never showed "Your note"', async () => {
    const href = await evaluate('location.href')
    if (BLOCKED.test(href)) {
      const where = new URL(href).pathname
      throw new Stop(2, where.startsWith('/accounts/login') ? 'signed out of Instagram' : `Instagram asked for a security check (${where})`)
    }
    const buttons = await axButtons(page)
    const notNow = buttons.find(b => /^not now$/i.test(b.name))
    if (notNow) {
      // The "Turn on notifications" prompt: decline it.
      await click(page, notNow.id)
      steps.push('Declined a notifications prompt.')
      return undefined
    }
    return buttons.find(b => b.name === 'Your note')
  })
  steps.push('Opened the inbox, signed in.')
  await click(page, yourNote.id)
  steps.push('Pressed "Your note".')

  let composer = await until(10_000, 'pressing "Your note" opened no composer', async () => {
    const d = await dialog(evaluate)
    if (!d) return undefined
    if (d.textboxes.length > 0) return d
    // A Note already up: start a new one.
    const fresh = d.buttons.find(b => /new note/i.test(b.name))
    if (fresh) {
      await clickAt(page, fresh)
      steps.push(`Pressed "${fresh.name}" over the Note already up.`)
    }
    return undefined
  })
  const box = composer.textboxes[0]
  steps.push(`The composer opened; its text box reads "${box.placeholder}".`)
  await clickAt(page, box)
  await page('Input.insertText', { text: opt.text })
  steps.push(`Typed "${opt.text}" (${[...opt.text].length} characters).`)

  composer = await until(5_000, 'no Share button turned on after typing', async () => {
    const d = await dialog(evaluate)
    return d?.buttons.some(b => b.name === 'Share' && !b.disabled) ? d : undefined
  })
  steps.push(`The composer says: ${composer.text.replace(/\s+/g, ' ').trim()}`)
  const share = composer.buttons.find(b => b.name === 'Share' && !b.disabled)
  if (opt.dryRun) {
    steps.push('Dry run: stopped before pressing Share; nothing was posted.')
    return
  }
  await clickAt(page, share)
  steps.push('Pressed Share.')
  await until(15_000, 'the composer stayed open after Share', async () => {
    const d = await dialog(evaluate)
    if (d && /couldn.t|try again|something went wrong/i.test(d.text)) throw new Stop(3, `Instagram said: ${d.text.slice(0, 120)}`)
    return d && d.textboxes.length > 0 ? undefined : true
  })
  steps.push('The composer closed: the Note is up.')
}

// The newest dialog's text, text boxes and buttons, with where each sits.
function dialog(evaluate) {
  return evaluate(`(() => {
    const d = [...document.querySelectorAll('[role=dialog]')].pop()
    if (!d) return null
    const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const at = el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
    const label = el => (el.getAttribute('aria-label') || el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
    return {
      text: d.innerText.slice(0, 600),
      textboxes: [...d.querySelectorAll('textarea, input[type=text], [contenteditable=true], [role=textbox]')].filter(shown)
        .map(el => ({ placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('aria-label') || '', ...at(el) })),
      buttons: [...d.querySelectorAll('button, [role=button]')].filter(shown)
        .map(el => ({ name: label(el), disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true', ...at(el) })),
    }
  })()`)
}

// Buttons by accessible name, as a screen reader hears them.
async function axButtons(page) {
  const { root } = await page('DOM.getDocument', { depth: 0 })
  const { nodes } = await page('Accessibility.queryAXTree', { nodeId: root.nodeId, role: 'button' })
  return nodes.filter(n => !n.ignored && n.backendDOMNodeId).map(n => ({ name: String(n.name?.value ?? '').trim(), id: n.backendDOMNodeId }))
}

async function click(page, backendNodeId) {
  await page('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const { model } = await page('DOM.getBoxModel', { backendNodeId })
  const q = model.content
  await clickAt(page, { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 })
}

async function clickAt(page, { x, y }) {
  await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function until(ms, failure, probe) {
  const end = Date.now() + ms
  for (;;) {
    let found
    try {
      found = await probe()
    } catch (err) {
      if (err instanceof Stop) throw err
      // The page is mid-navigation; look again.
    }
    if (found) return found
    if (Date.now() > end) throw new Stop(3, failure)
    await sleep(500)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// The DevTools protocol over Chrome's pipe: JSON messages ended by a NUL,
// commands written to its fd 3 and answers read from its fd 4.
function connect(child) {
  const pending = new Map()
  let next = 0
  let buffer = ''
  const reader = child.stdio[4]
  reader.setEncoding('utf8')
  reader.on('data', chunk => {
    buffer += chunk
    for (let end; (end = buffer.indexOf('\0')) >= 0; ) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      const waiting = pending.get(message.id)
      if (!waiting) continue
      pending.delete(message.id)
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`))
      else waiting.resolve(message.result)
    }
  })
  child.on('exit', () => {
    for (const waiting of pending.values()) waiting.reject(new Error('Chrome exited'))
    pending.clear()
  })
  return {
    send(method, params = {}, sessionId) {
      const id = ++next
      child.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }))
    },
  }
}
