/**
 * dsh-workdiff — host half.
 *
 * Serves the working-tree change feed for the browser side:
 *   GET /workdiff/status?session=<id>&cwd=<path>
 *       -> { ok, git, root, branch, files: [{ path, xy, status, adds, dels }] }
 *   GET /workdiff/diff?session=<id>&cwd=<path>&file=<rel>
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

export const inject = ['webServer', 'settings']

const MAX_BUF = 64 * 1024 * 1024

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

// ── untracked-directory expansion ──────────────────────────────────────────
/** Tool/noise directories skipped when walking an untracked directory. */
const NOISE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'dist',
  'build', '.next', '.nuxt', '.output', 'target', 'out', 'coverage', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.idea', '.vscode', '.claude', '.agents', '.dsh-reef',
  '.cache', '.gitlab', '.github',
])
/** Max expanded untracked files per status call. */
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

/**
 * Expand an untracked directory (relative to cwd) into its files, skipping
 * noise dirs and bounding the walk. Returns [{ path, adds }].
 */
function expandUntrackedDir(cwd, dir, budget) {
  const out = []
  const stack = [dir]
  while (stack.length > 0 && out.length < budget) {
    const rel = stack.pop()
    let abs
    try {
      abs = resolve(cwd, rel)
      if (!existsSync(abs)) continue
      const st = statSync(abs)
      if (st.isDirectory()) {
        const children = []
        try {
          for (const name of readdirSync(abs)) children.push(name)
        } catch { /* permission */ }
        for (const name of children) {
          if (out.length >= budget) break
          if (NOISE_DIRS.has(name)) continue
          stack.push(join(rel, name))
        }
      } else if (st.isFile()) {
        const relPath = rel.split(sep).join('/')
        out.push({ path: relPath, adds: countLines(abs) })
      }
    } catch { /* unreadable node */ }
  }
  return out
}

/** Per-cwd cache of the expanded untracked file list (invalidated by TTL). */
const untrackedWalkCache = new Map()

/** Expand all untracked entries; directory entries become their files. */
function expandUntracked(cwd, entries) {
  const now = Date.now()
  const cacheKey = cwd
  let cached = untrackedWalkCache.get(cacheKey)
  if (cached === undefined || now - cached.ts > 15000) {
    cached = { ts: now, dirs: new Map() }
    untrackedWalkCache.set(cacheKey, cached)
  }
  const out = []
  for (const entry of entries) {
    if (entry.xy !== '??') continue
    let abs
    try {
      abs = resolve(cwd, entry.path)
      if (!existsSync(abs)) continue
    } catch { continue }
    let isDir = false
    try { isDir = statSync(abs).isDirectory() } catch { /* gone */ }
    if (isDir) {
      let files = cached.dirs.get(entry.path)
      if (files === undefined) {
        files = expandUntrackedDir(cwd, entry.path, UNTRACKED_FILE_CAP - out.length)
        cached.dirs.set(entry.path, files)
      }
      for (const f of files) {
        if (out.length >= UNTRACKED_FILE_CAP) break
        out.push({ path: f.path, xy: '??', status: 'U', adds: f.adds, dels: 0 })
      }
    } else {
      out.push({ path: entry.path, xy: '??', status: 'U', adds: countLines(abs), dels: 0 })
    }
    if (out.length >= UNTRACKED_FILE_CAP) break
  }
  return out
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
    const liveCwd = live?.meta?.cwd ?? live?.cwd
    if (typeof liveCwd === 'string' && liveCwd !== '') return liveCwd
  } catch { /* fall through */ }
  try {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      const snap = await query.readSession(sessionId)
      const cwd = snap?.meta?.cwd ?? snap?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    }
  } catch { /* fall through */ }
  return undefined
}

export function apply(ctx) {
  // Register the settings namespace so the client's settingsScope writes validate.
  ctx.settings.register('dsh-workdiff', Config)

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

      const statusRes = git(cwd, ['status', '--porcelain=v1', '-z'])
      if (!statusRes.ok) {
        return send(res, 200, {
          ok: true,
          git: false,
          root: cwd,
          branch: '',
          files: [],
          error: statusRes.stderr.trim() || 'not a git repository',
        })
      }
      const branch = git(cwd, ['branch', '--show-current']).stdout.trim()
      const unstaged = parseNumstat(git(cwd, ['diff', '--numstat']).stdout)
      const staged = parseNumstat(git(cwd, ['diff', '--cached', '--numstat']).stdout)

      const files = []
      const untrackedExpanded = []
      const plain = []
      for (const entry of parseStatus(statusRes.stdout)) {
        if (entry.xy === '??') plain.push(entry)
        else files.push(entry)
      }
      // Expand untracked directories into real files (capped, noise dirs skipped).
      for (const u of expandUntracked(cwd, plain)) untrackedExpanded.push(u)
      const result = files.map((entry) => {
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
      result.push(...untrackedExpanded)
      result.sort((a, b) => a.path.localeCompare(b.path))

      send(res, 200, {
        ok: true,
        git: true,
        root: cwd,
        branch,
        files: result,
        truncated: untrackedExpanded.length >= UNTRACKED_FILE_CAP,
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
      let text = ''
      let method = ''
      if (isUntracked) {
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
