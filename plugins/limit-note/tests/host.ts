// A fake machine beneath the plugin: a HOME, files in memory, mkdir and rmdir
// that lock as the real ones do, and a curl and gh that only record.
import { mock } from 'claude-code/testing'

export const HOME = '/Users/test'
export const DIR = `${HOME}/.config/limit-note`
export const CONFIG = `${DIR}/config.json`
export const SENT = `${DIR}/sent.json`
export const LOCK = `${DIR}/lock`
// Sunday Oct 11 2026, noon in Vancouver (PDT).
export const T0 = Date.parse('2026-10-11T19:00:00Z')
export const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }

export type Push = { argv: string[]; body: string | undefined; timeoutMs: number | undefined }

export type Host = {
  clock: ReturnType<typeof mock.clock>
  files: Map<string, string>
  /** Folders that exist, with when each was made. */
  dirs: Map<string, number>
  pushes: Push[]
  gh: string[][]
  shells: { argv: string[]; stdin: string | undefined }[]
  mkdirs: number
  toasts: string[]
  modelCalls: string[]
  usageArgs: unknown[]
  /** curl's exit code for the next pushes; 0 succeeds. */
  curlExit: number
}

export function config(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ topic: 'ln-test', ...extra })
}

export function fakeHost(on: any, files: Record<string, string> = {}): Host {
  mock.store(on)
  mock.env(on, { HOME })
  const host: Host = {
    clock: mock.clock(on, { now: T0 }),
    files: new Map(Object.entries(files)),
    dirs: new Map([[DIR, 0]]),
    pushes: [],
    gh: [],
    shells: [],
    mkdirs: 0,
    toasts: [],
    modelCalls: [],
    usageArgs: [],
    curlExit: 0,
  }
  const result = (exitCode = 0, stderr = '') => ({
    value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', async (_$: any, e: any) => ({ changed: e.changed }))
  on('command.register', async (_$: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', async (_$: any, e: any) => (host.toasts.push(e.text), { value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.usage', async (_$: any, e: any) => {
    host.usageArgs.push(e)
    return {
      value: {
        startedAt: T0,
        context: { window: 200_000 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-11T22:40:00Z' }],
      },
    }
  })
  on('model.complete', async () => {
    host.modelCalls.push('complete')
    throw new Error('the model was called')
  })
  on('model.fork', async () => {
    host.modelCalls.push('fork')
    throw new Error('the model was called')
  })

  on('fs.exists', async (_$: any, e: any) => ({ value: host.files.has(e.path) || host.dirs.has(e.path) }))
  on('fs.read', async (_$: any, e: any) => {
    const text = host.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$: any, e: any) => (host.files.set(e.path, e.text), { value: undefined }))
  on('fs.stat', async (_$: any, e: any) => {
    const made = host.dirs.get(e.path)
    if (made === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: made, isLink: false } }
  })

  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = [...e.argv]
    const path = argv[1] ?? ''
    if (argv[0] === '/bin/mkdir') {
      host.mkdirs++
      if (host.dirs.has(path)) return result(1, `mkdir: ${path}: File exists`)
      host.dirs.set(path, host.clock.now())
      return result()
    }
    if (argv[0] === '/bin/rmdir') return (host.dirs.delete(path), result())
    if (argv[0] === '/usr/bin/curl') {
      host.pushes.push({ argv, body: e.init?.stdin, timeoutMs: e.init?.timeoutMs })
      return host.curlExit === 0 ? result() : result(host.curlExit, 'curl: (6) Could not resolve host: ntfy.sh')
    }
    if (argv[0] === '/bin/sh') {
      host.shells.push({ argv, stdin: e.init?.stdin })
      const file = argv[argv.length - 1]!
      if (host.files.has(file)) return result(1, `sh: ${file}: cannot overwrite existing file`)
      host.files.set(file, e.init?.stdin ?? '')
      return result()
    }
    host.gh.push(argv)
    return result()
  })
  return host
}

/** The value of one `-H` header curl was given. */
export function header(push: Push, name: string): string | undefined {
  const i = push.argv.findIndex((a, j) => push.argv[j - 1] === '-H' && a.startsWith(`${name}: `))
  return i < 0 ? undefined : push.argv[i]!.slice(name.length + 2)
}
