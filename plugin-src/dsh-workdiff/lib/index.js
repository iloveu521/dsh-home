/**
 * dsh-workdiff — host half.
 *
 * Serves the working-tree change feed for the browser side:
 *   GET /workdiff/status?session=<id>&cwd=<path>
 *       -> { ok, git, root, branch, agentFiles, gitFiles, files }
 *   GET /workdiff/diff?session=<id>&cwd=<path>&file=<rel>&mode=agent|git
 *       -> { ok, method, text, truncated, error? }
 *   GET /workdiff/cwd?session=<id>
 *       -> { ok, cwd? }  (fallback: resolve a session's cwd host-side)
 *
 * Fences:
 *   - requests only from loopback peers (LAN exposure of dsh web gets 403);
 *   - `cwd` must be an existing directory;
 *   - `file` must resolve strictly inside `cwd`.
 * The feed only ever reports the caller's own session workspace, same trust
 * level as the built-in sidebar fs/git routes.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-workdiff'

/** Plugin configuration (user-facing settings namespace `dsh-workdiff`). */
export const Config = z.object({
  /** Whether a brand-new session auto-opens the bottom panel (terminal by default). */
  openBottomOnNewSession: z.boolean().default(true),
  /** Whether the right sidebar auto-expands to the changes tab when working-tree changes appear. */
  autoExpandOnChange: z.boolean().default(true),
  /** Client status poll interval (ms). */
  refreshMs: z.number().min(500).max(60000).default(2500),
})

export const inject = ['webServer', 'settings', 'sessions']

const MAX_BUF = 64 * 1024 * 1024
const MAX_BASELINE_BYTES = 64 * 1024 * 1024

/** Session-start working-tree snapshots, used to isolate the agent's delta. */
const sessionBaselines = new Map()

/** Run one git command synchronously inside `cwd`. */
function git(cwd, args) {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUF,
      windowsHide: true,
    })
    if (r.error) return { ok: false, code: -1, stdout: '', stderr: String(r.error.message ?? r.error) }
    return { ok: r.status === 0, code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } catch (error) {
    return { ok: false, code: -1, stdout: '', stderr: String(error) }
  }
}

/** Unquote a git C-quoted path (`"a\tb"` -> `a\tb`). */
function unquote(path) {
  if (path.length < 2 || path[0] !== '"') return path
  let out = ''
  for (let i = 1; i < path.length - 1; i++) {
    const ch = path[i]
    if (ch === '\\' && i + 1 < path.length - 1) {
      const next = path[i + 1]
      if (next === '"' || next === '\\') { out += next; i += 1; continue }
      if (next === 't') { out += '\t'; i += 1; continue }
      if (next === 'n') { out += '\n'; i += 1; continue }
    }
    out += ch
  }
  return out
}

/** Parse `git status --porcelain=v1 -z` output into [{ xy, path }]. */
function parseStatus(zero) {
  const files = []
  const parts = zero.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]
    if (raw === '') continue
    const xy = raw.slice(0, 2)
    let path = raw.slice(2)
    if (path.startsWith(' ')) path = path.slice(1)
    if ((xy[0] === 'R' || xy[0] === 'C') && i + 1 < parts.length) {
      // Rename/copy: the destination path is the NEXT NUL field.
      path = parts[i + 1]
      i += 1
    }
    if (path !== '') files.push({ xy, path: unquote(path) })
  }
  return files
}

/** Parse `git diff --numstat` (per line: `adds\tdeletes\tpath`). */
function parseNumstat(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const t1 = line.indexOf('\t')
    if (t1 === -1) continue
    const t2 = line.indexOf('\t', t1 + 1)
    if (t2 === -1) continue
    const adds = parseInt(line.slice(0, t1), 10)
    const dels = parseInt(line.slice(t1 + 1, t2), 10)
    map.set(unquote(line.slice(t2 + 1)), {
      adds: Number.isNaN(adds) ? 0 : adds,
      dels: Number.isNaN(dels) ? 0 : dels,
    })
  }
  return map
}

/** The display status letter of one porcelain XY pair. */
function badgeOf(xy) {
  if (xy === '??') return 'U'
  const x = xy[0]
  const y = xy[1]
  if (x !== undefined && x !== ' ' && x !== '?') return x
  if (y !== undefined && y !== ' ' && y !== '?') return y
  return 'M'
}

/** Read one file state for a session baseline/current comparison. */
function fileState(cwd, file, budget = { left: MAX_BASELINE_BYTES }) {
  try {
    const abs = resolve(cwd, file)
    const st = statSync(abs)
    if (!st.isFile()) return { exists: false, content: null, size: 0, mtimeMs: 0 }
    let content = null
    if (st.size <= budget.left) {
      content = readFileSync(abs)
      budget.left -= content.length
    }
    return { exists: true, content, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, content: null, size: 0, mtimeMs: 0 }
  }
}

function sameFileState(a, b) {
  if (a.exists !== b.exists) return false
  if (!a.exists) return true
  if (a.content !== null && b.content !== null) return a.content.equals(b.content)
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** Run a no-index diff between a saved baseline state and the current file. */
function diffFromBaseline(cwd, file, before) {
  const after = fileState(cwd, file)
  if (before.content === null && before.exists) {
    return { ok: false, text: '', adds: 0, dels: 0, error: 'session baseline is too large to diff' }
  }
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-workdiff-'))
    const oldPath = join(dir, 'before')
    if (before.exists) writeFileSync(oldPath, before.content ?? Buffer.alloc(0))
    const newPath = resolve(cwd, file)
    const args = ['diff', '--no-index', '--unified=3', '--', before.exists ? oldPath : '/dev/null', after.exists ? newPath : '/dev/null']
    const result = git(cwd, args)
    if (result.code !== 0 && result.code !== 1) {
      return { ok: false, text: '', adds: 0, dels: 0, error: result.stderr.trim() || 'diff failed' }
    }
    const lines = result.stdout.split('\n')
    let adds = 0
    let dels = 0
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) adds += 1
      else if (line.startsWith('-') && !line.startsWith('---')) dels += 1
    }
    if (lines[0]?.startsWith('diff --git ')) lines[0] = `diff --git a/${file} b/${file}`
    const oldHeader = lines.findIndex((line) => line.startsWith('--- '))
    const newHeader = lines.findIndex((line) => line.startsWith('+++ '))
    if (oldHeader !== -1) lines[oldHeader] = before.exists ? `--- a/${file}` : '--- /dev/null'
    if (newHeader !== -1) lines[newHeader] = after.exists ? `+++ b/${file}` : '+++ /dev/null'
    return { ok: true, text: lines.join('\n'), adds, dels, error: null }
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

/** A unified diff for an untracked file (everything added). */
function fakeAddedDiff(cwd, file) {
  let content = ''
  try {
    content = readFileSync(resolve(cwd, file), 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return { text: '', error: `read failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const head = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`
  return { text: head + lines.map((l) => `+${l}`).join('\n') + (lines.length > 0 ? '\n' : ''), error: null }
}

// ── untracked files ────────────────────────────────────────────────────────
/** Max untracked files returned per status call. */
const UNTRACKED_FILE_CAP = 600
/** Max bytes read for an untracked file's line count. */
const COUNT_SIZE_CAP = 2 * 1024 * 1024

/** Count non-empty lines of a UTF-8 text file (bounded; binary returns 0). */
function countLines(abs) {
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > COUNT_SIZE_CAP) return 0
    const buf = readFileSync(abs)
    if (buf.includes(0)) return 0 // binary
    let count = 0
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) count += 1
    }
    return count
  } catch {
    return 0
  }
}

/** Send a JSON response. */
function send(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Whether the peer is loopback and cwd is an existing directory. */
function allowRequest(req, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return false
  try {
    if (!existsSync(cwd)) return false
  } catch {
    return false
  }
  const addr = (req.socket?.remoteAddress ?? '').toLowerCase()
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  return true
}

/** Resolve a session's cwd (live store first, then the query service). */
async function resolveSessionCwd(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const live = ctx.get('sessions')?.get?.(sessionId)
    const liveCwd = live?.header?.cwd ?? live?.meta?.cwd ?? live?.cwd
    if (typeof liveCwd === 'string' && liveCwd !== '') return liveCwd
  } catch { /* fall through */ }
  try {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      const snap = await query.readSession(sessionId)
      const cwd = snap?.session?.cwd ?? snap?.meta?.cwd ?? snap?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    }
  } catch { /* fall through */ }
  return undefined
}

/** Collect the repository-wide uncommitted file list. */
function workingStatus(cwd) {
  // Let Git enumerate every untracked file itself. Unlike a manual directory
  // walk, this honors repository, info/exclude and global ignore rules all the
  // way down an otherwise-untracked directory tree.
  const statusRes = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!statusRes.ok) return { git: false, branch: '', files: [], error: statusRes.stderr.trim() || 'not a git repository' }
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim()
  const unstaged = parseNumstat(git(cwd, ['diff', '--numstat']).stdout)
  const staged = parseNumstat(git(cwd, ['diff', '--cached', '--numstat']).stdout)
  const tracked = []
  const untracked = []
  for (const entry of parseStatus(statusRes.stdout)) {
    if (entry.xy === '??') untracked.push(entry)
    else tracked.push(entry)
  }
  const files = tracked.map((entry) => {
    const us = unstaged.get(entry.path)
    const st = staged.get(entry.path)
    return {
      path: entry.path,
      xy: entry.xy,
      status: badgeOf(entry.xy),
      adds: (us?.adds ?? 0) + (st?.adds ?? 0),
      dels: (us?.dels ?? 0) + (st?.dels ?? 0),
    }
  })
  const shownUntracked = untracked.slice(0, UNTRACKED_FILE_CAP)
  files.push(...shownUntracked.map((entry) => ({
    path: entry.path,
    xy: '??',
    status: 'U',
    adds: countLines(resolve(cwd, entry.path)),
    dels: 0,
  })))
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { git: true, branch, files, truncated: untracked.length > UNTRACKED_FILE_CAP, error: null }
}

/** Capture the dirty files exactly as they were when this session started. */
function captureBaseline(sessionId, cwd) {
  if (sessionBaselines.has(sessionId) || typeof cwd !== 'string' || cwd === '') return
  const status = workingStatus(cwd)
  const known = new Map()
  const budget = { left: MAX_BASELINE_BYTES }
  if (status.git) {
    for (const file of status.files) known.set(file.path, fileState(cwd, file.path, budget))
  }
  sessionBaselines.set(sessionId, { cwd, known, createdAt: Date.now() })
}

/** Split current changes into the session's agent delta and the full Git delta. */
function splitChanges(cwd, status, baseline) {
  const gitFiles = status.files
  if (baseline === undefined || baseline.cwd !== cwd) return { agentFiles: [], gitFiles, baselineReady: false }
  const currentByPath = new Map(gitFiles.map((file) => [file.path, file]))
  const paths = new Set([...baseline.known.keys(), ...currentByPath.keys()])
  const agentFiles = []
  for (const path of paths) {
    const gitFile = currentByPath.get(path)
    const before = baseline.known.get(path)
    if (before === undefined) {
      // It was clean (or absent) at session start, so the ordinary HEAD diff is
      // also the agent-session diff.
      if (gitFile !== undefined) agentFiles.push({ ...gitFile, source: 'head' })
      continue
    }
    const after = fileState(cwd, path)
    if (sameFileState(before, after)) continue
    const delta = diffFromBaseline(cwd, path, before)
    agentFiles.push({
      path,
      xy: gitFile?.xy ?? (before.exists && !after.exists ? ' D' : (!before.exists && after.exists ? '??' : ' M')),
      status: before.exists && !after.exists ? 'D' : (!before.exists && after.exists ? 'A' : 'M'),
      adds: delta.adds,
      dels: delta.dels,
      source: 'baseline',
      diffError: delta.ok ? null : delta.error,
    })
  }
  agentFiles.sort((a, b) => a.path.localeCompare(b.path))
  return { agentFiles, gitFiles, baselineReady: true }
}

export function apply(ctx) {
  // Register the settings namespace so the client's settingsScope writes validate.
  ctx.settings.register('dsh-workdiff', Config)

  // The baseline must be captured at publication time, before the first agent
  // turn can mutate the workspace. The route keeps a lazy fallback for sessions
  // that were already live when this plugin was hot-reloaded.
  ctx.on('session/created', (session) => {
    captureBaseline(session.id, session.header?.cwd)
  }, { global: true })
  ctx.on('session/disposed', (session) => {
    sessionBaselines.delete(session.id)
  }, { global: true })

  ctx.webServer.register({
    kind: 'exact',
    path: '/workdiff/cwd',
    handler: async (req, res) => {
      const params = new URL(req.url, 'http://local').searchParams
      if (!allowRequest(req, process.cwd())) {
        return send(res, 403, { ok: false, error: 'forbidden' })
      }
      const cwd = await resolveSessionCwd(ctx, params.get('session') ?? '')
      if (cwd === undefined) return send(res, 404, { ok: false, error: 'session not found' })
      send(res, 200, { ok: true, cwd })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/workdiff/status',
    handler: async (req, res) => {
      const params = new URL(req.url, 'http://local').searchParams
      const cwd = params.get('cwd') ?? ''
      if (!allowRequest(req, cwd)) return send(res, 403, { ok: false, error: 'forbidden' })

      const status = workingStatus(cwd)
      if (!status.git) {
        return send(res, 200, {
          ok: true,
          git: false,
          root: cwd,
          branch: status.branch,
          files: [],
          agentFiles: [],
          gitFiles: [],
          error: status.error,
        })
      }
      const sessionId = params.get('session') ?? ''
      if (!sessionBaselines.has(sessionId)) captureBaseline(sessionId, cwd)
      const groups = splitChanges(cwd, status, sessionBaselines.get(sessionId))

      send(res, 200, {
        ok: true,
        git: true,
        root: cwd,
        branch: status.branch,
        // `files` remains as a compatibility alias for older clients.
        files: groups.gitFiles,
        agentFiles: groups.agentFiles,
        gitFiles: groups.gitFiles,
        baselineReady: groups.baselineReady,
        truncated: status.truncated,
        error: null,
      })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/workdiff/diff',
    handler: async (req, res) => {
      const params = new URL(req.url, 'http://local').searchParams
      const cwd = params.get('cwd') ?? ''
      const file = params.get('file') ?? ''
      if (!allowRequest(req, cwd)) return send(res, 403, { ok: false, error: 'forbidden' })
      if (file === '') return send(res, 400, { ok: false, error: 'missing file' })

      const root = resolve(cwd)
      const abs = resolve(cwd, file)
      if (abs !== root && !abs.startsWith(root + sep)) {
        return send(res, 403, { ok: false, error: 'path outside workspace' })
      }

      const isUntracked = params.get('untracked') === '1'
      const mode = params.get('mode') ?? 'git'
      let text = ''
      let method = ''
      if (mode === 'agent') {
        const sessionId = params.get('session') ?? ''
        const baseline = sessionBaselines.get(sessionId)
        const before = baseline?.cwd === cwd ? baseline.known.get(file) : undefined
        if (before !== undefined) {
          const delta = diffFromBaseline(cwd, file, before)
          if (!delta.ok) return send(res, 200, { ok: false, error: delta.error })
          text = delta.text
          method = 'session-baseline'
        } else if (isUntracked) {
          const fake = fakeAddedDiff(cwd, file)
          if (fake.error !== null) return send(res, 200, { ok: false, error: fake.error })
          text = fake.text
          method = 'untracked'
        } else {
          const head = git(cwd, ['diff', 'HEAD', '--unified=3', '--', file])
          text = head.stdout
          method = 'HEAD'
        }
      } else if (isUntracked) {
        const fake = fakeAddedDiff(cwd, file)
        if (fake.error !== null) return send(res, 200, { ok: false, error: fake.error })
        text = fake.text
        method = 'untracked'
      } else {
        const head = git(cwd, ['diff', 'HEAD', '--unified=3', '--', file])
        if (head.ok && head.stdout.trim() !== '') {
          text = head.stdout
          method = 'HEAD'
        } else {
          const us = git(cwd, ['diff', '--unified=3', '--', file])
          const st = git(cwd, ['diff', '--cached', '--unified=3', '--', file])
          text = (us.ok ? us.stdout : '') + (st.ok ? st.stdout : '')
          method = 'mixed'
        }
      }
      const truncated = text.length > 2 * 1024 * 1024
      if (truncated) text = text.slice(0, 2 * 1024 * 1024) + '\n... (truncated)'
      send(res, 200, { ok: true, method, text, truncated, error: null })
    },
  })
}
