import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * dsh-think-slice — 常驻版
 *
 * 两条链路：
 *  1) llm/stream 包装：捕获纯思考阶段被中断的 reasoning 切片；同指纹重试请求命中切片时
 *     克隆请求追加「续思前缀」消息，嵌套 llm.stream 无缝续跑。
 *  2) agent/request-error（prepend 最外层）：provider error/429/423/server/transport/空响应
 *     全类别自动分级退避重试（尊重 providerRetryAfterMs），溢出类与手动停止放行。
 *
 * 相比动态验证版新增：
 *  - 结构化 JSONL 日志（按天滚动，保留 N 天），控制台同步镜像 [think-slice] 行；
 *  - 切片库落盘 slices.json（原子写），dsh web 重启后仍可续思。
 */

const name = 'think-slice'
const inject = ['timer']

const MIN_SLICE_CHARS = 120
const MAX_SLICE_CHARS = 12000
const SLICE_TTL_MS = 48 * 3600 * 1000
const MAX_RETRIES_PER_FP = 10
const WAIT_BUDGET_MS = 15 * 60 * 1000
const LOG_RETENTION_DAYS = 14
const SLICE_STORE_MAX_ENTRIES = 50

const PASS_THROUGH = /(overflow|context length|too many tokens|context_window|prompt too long|max.?tokens)/i
const RX_RATE = /(rate limit|too many requests|\b429\b)/i
const RX_LOCK = /(\b423\b|\blocked\b|quota)/i
const RX_SRV = /(\b5\d\d\b|server error|bad gateway|service unavailable|overloaded|internal error)/i
const RX_NET = /(econn|etimedout|econnreset|socket|network|fetch failed|timeout|timed out|transport)/i
const RX_PROV = /(provider returned error|provider error|upstream error)/i
const RX_EMPTY = /(empty_response|empty response|no content)/i

function resolveHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function dayStamp(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// ===== 日志系统：JSONL 按天滚动 + 控制台镜像 =====
function createLogger(dir) {
  let currentStamp = ''
  let currentPath = ''
  function roll(now) {
    currentStamp = dayStamp(now)
    currentPath = join(dir, 'think-slice-' + currentStamp + '.jsonl')
  }
  function write(lvl, ev, data) {
    const now = Date.now()
    if (!currentStamp || dayStamp(now) !== currentStamp) roll(now)
    const line = JSON.stringify(Object.assign({ t: new Date(now).toISOString(), lvl, ev }, data || {}))
    try {
      appendFileSync(currentPath, line + '\n')
    } catch (e) {
      console.error('[think-slice] log append failed:', e && e.message)
    }
    console.error('[think-slice] ' + ev + (data ? ' ' + JSON.stringify(data) : ''))
  }
  function sweep(now) {
    try {
      const cutoff = now - LOG_RETENTION_DAYS * 24 * 3600 * 1000
      for (const f of readdirSync(dir)) {
        const m = /^think-slice-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
        if (!m) continue
        const t = new Date(m[1] + 'T00:00:00').getTime()
        if (Number.isFinite(t) && t < cutoff) {
          try { unlinkSync(join(dir, f)) } catch (e) {}
        }
      }
    } catch (e) {}
  }
  return { write, sweep }
}

// ===== 切片库持久化 =====
function loadSlices(file) {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : []
    const now = Date.now()
    const map = new Map()
    for (const e of entries) {
      if (e && typeof e.fp === 'string' && typeof e.text === 'string' && Number.isFinite(e.ts)) {
        if (now - e.ts <= SLICE_TTL_MS) map.set(e.fp, { text: e.text, ts: e.ts })
      }
    }
    return map
  } catch (e) {
    return new Map()
  }
}

function saveSlices(file, map) {
  try {
    const entries = [...map.entries()]
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, SLICE_STORE_MAX_ENTRIES)
      .map(([fp, v]) => ({ fp, text: v.text, ts: v.ts }))
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries }))
    renameSync(tmp, file)
    return entries.length
  } catch (e) {
    return -1
  }
}

// ===== 插件主体 =====
async function apply(ctx) {
  const timer = ctx.timer
  const llm = ctx.get('llm')
  if (llm === undefined) {
    console.error('[think-slice] llm service missing; plugin idle')
    return
  }

  // 日志目录与切片存储初始化（fail-safe：失败则退化为仅控制台/仅内存）
  let logger = { write: (_lvl, ev, data) => console.error('[think-slice] ' + ev + (data ? ' ' + JSON.stringify(data) : '')), sweep() {} }
  let logDirOk = false
  let home = ''
  let logDir = ''
  let storeFile = ''
  try {
    home = resolveHome()
    logDir = join(home, 'think-slice', 'logs')
    mkdirSync(logDir, { recursive: true })
    logger = createLogger(logDir)
    logDirOk = true
  } catch (e) {
    console.error('[think-slice] log dir init failed; console-only:', e && e.message)
  }
  const storeDir = join(home, 'think-slice')
  storeFile = join(storeDir, 'slices.json')

  const owned = new WeakSet()
  let slices = new Map()
  try { slices = loadSlices(storeFile) } catch (e) {}
  const retr = new Map()
  const recent = []
  const stats = { captured: 0, resumed: 0, retried: 0, delegated: 0 }

  function b64key(s) {
    return Buffer.from(s, 'utf8').toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)
  }
  function fingerprintOf(options) {
    const msgs = Array.isArray(options.messages) ? options.messages : []
    const last = msgs.length ? msgs[msgs.length - 1] : null
    let tail = ''
    try { tail = last ? JSON.stringify(last) : '' } catch (e) { tail = String(msgs.length) }
    return b64key(String(options.sessionId || '') + '|' + String(options.model || '') + '|' + msgs.length + '|' + tail.slice(-600))
  }

  function persistSlices(reason) {
    const n = saveSlices(storeFile, slices)
    if (n < 0) logger.write('error', 'slice-store-save-failed', { reason })
    else logger.write('info', 'slice-store-saved', { reason, entries: n })
  }

  function prune() {
    const now = Date.now()
    let dropped = 0
    for (const [k, v] of slices) if (now - v.ts > SLICE_TTL_MS) { slices.delete(k); dropped++ }
    while (recent.length > 32) recent.shift()
    if (dropped > 0) persistSlices('ttl-prune')
  }

  logger.write('info', 'armed', {
    version: 'v3-resident',
    home,
    logDirReady: logDirOk,
    slicesLoaded: slices.size,
    maxRetriesPerFp: MAX_RETRIES_PER_FP,
    waitBudgetMs: WAIT_BUDGET_MS
  })

  // 周期任务：TTL 清理 + 日志滚动清理（每小时）
  ctx.effect(() => timer.interval(() => { prune(); logger.sweep(Date.now()) }, 60 * 60 * 1000))

  function classify(f) {
    const blob = String(f.code || '') + ' ' + String(f.message || '') + ' ' + String(f.status || '')
    if (PASS_THROUGH.test(blob)) return null
    if (f.status === 429 || RX_RATE.test(blob)) return 'rateLimit'
    if (f.status === 423 || RX_LOCK.test(blob)) return 'locked'
    if ((typeof f.status === 'number' && f.status >= 500) || RX_SRV.test(blob)) return 'server'
    if (RX_NET.test(blob)) return 'transport'
    if (RX_PROV.test(blob)) return 'provider'
    if (RX_EMPTY.test(blob)) return 'empty'
    if (typeof f.status === 'number' && f.status >= 400) return 'server'
    return null
  }

  function delayFor(cls, n, f) {
    let d
    if (f.providerRetryAfterMs) d = Number(f.providerRetryAfterMs)
    else if (cls === 'rateLimit') d = 5000 * Math.pow(2, n)
    else if (cls === 'locked') d = 8000 * Math.pow(2, n)
    else if (cls === 'server') d = 2000 * Math.pow(2, n)
    else d = 1500 * Math.pow(2, n)
    const cap = cls === 'rateLimit' ? 90000 : cls === 'locked' ? 120000 : cls === 'server' ? 45000 : 20000
    d = Math.min(d, cap)
    return Math.round(d * (0.75 + Math.random() * 0.5))
  }

  ctx.on('agent/request-error', async (payload, next) => {
    try {
      const signal = payload.signal
      if (signal && signal.aborted) return next()
      const f = payload.failure || {}
      const cls = classify(f)
      if (!cls) { stats.delegated++; return next() }
      let fp = null
      for (let i = recent.length - 1; i >= 0; i--) {
        const e = recent[i]
        if (e.provider === payload.provider && Date.now() - e.ts < 180000) { fp = e.fp; break }
      }
      if (!fp) {
        for (let i = recent.length - 1; i >= 0; i--) {
          if (Date.now() - recent[i].ts < 90000) { fp = recent[i].fp; break }
        }
      }
      if (!fp) return next()
      const st = retr.get(fp) || { n: 0, waitedMs: 0 }
      if (st.n >= MAX_RETRIES_PER_FP) {
        logger.write('warn', 'retry-cap-reached', { fp: fp.slice(0, 8), cap: MAX_RETRIES_PER_FP })
        return next()
      }
      const delay = delayFor(cls, st.n, f)
      if (st.waitedMs + delay > WAIT_BUDGET_MS) {
        logger.write('warn', 'wait-budget-exhausted', { fp: fp.slice(0, 8), waitedMs: st.waitedMs })
        return next()
      }
      st.n++
      st.waitedMs += delay
      retr.set(fp, st)
      logger.write('warn', 'retry', {
        cls,
        attempt: st.n,
        max: MAX_RETRIES_PER_FP,
        delayMs: delay,
        code: f.code || null,
        status: f.status || null,
        msg: String(f.message || '').slice(0, 140),
        hasSlice: slices.has(fp),
        provider: payload.provider
      })
      if (delay > 0) {
        let abortedFlag = false
        const onAbort = () => { abortedFlag = true }
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        try { await timer.timeout(delay) } finally { if (signal) signal.removeEventListener('abort', onAbort) }
        if (abortedFlag) {
          logger.write('info', 'aborted-during-backoff', { fp: fp.slice(0, 8) })
          return next()
        }
      }
      stats.retried++
      return { kind: 'retry' }
    } catch (e) {
      logger.write('error', 'request-error-handler-failed', { detail: String((e && e.message) || e) })
      return next()
    }
  }, { prepend: true })

  async function* pump(stream, rootFp, sessionId) {
    const partsByIndex = new Map()
    let sawBody = false
    try {
      for await (const chunk of stream) {
        if (chunk.type === 'reasoning-delta') {
          partsByIndex.set(chunk.index, (partsByIndex.get(chunk.index) || '') + chunk.text)
        } else if (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') {
          sawBody = true
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason
          if ((reason.kind === 'error' || reason.kind === 'aborted') && !sawBody) {
            let text = ''
            for (const t of partsByIndex.values()) text += t
            if (text.trim().length >= MIN_SLICE_CHARS) saveSlice(rootFp, text, sessionId)
          }
        }
        yield chunk
      }
    } catch (e) {
      logger.write('error', 'upstream-threw', { fp: rootFp.slice(0, 8), detail: String((e && e.message) || e) })
      if (!sawBody) {
        let text = ''
        for (const t of partsByIndex.values()) text += t
        if (text.trim().length >= MIN_SLICE_CHARS) saveSlice(rootFp, text, sessionId)
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'think-slice: upstream stream threw: ' + String((e && e.message) || e), code: 'THINK_SLICE_UPSTREAM_THROW' } } }
    }
  }

  function saveSlice(rootFp, text, sessionId) {
    const prev = slices.get(rootFp)
    const merged = prev ? (prev.text.slice(-MAX_SLICE_CHARS / 2) + '\n…[中断后续写]…\n' + text) : text
    slices.set(rootFp, { text: merged.slice(-MAX_SLICE_CHARS), ts: Date.now() })
    stats.captured++
    logger.write('info', 'captured', { fp: rootFp.slice(0, 8), chars: merged.length, session: sessionId || '' })
    persistSlices('captured')
  }

  ctx.on('llm/stream', (options, next) => {
    if (options.purpose) return next()
    if (owned.has(options)) return next()
    const fp = fingerprintOf(options)
    recent.push({ fp, provider: options.provider, ts: Date.now() })
    prune()

    const hit = slices.get(fp)
    if (hit && hit.text && hit.text.length >= MIN_SLICE_CHARS) {
      const preamble = '[系统恢复提示] 上一次尝试在深度思考中途因提供方错误中断且未产生记录。下面是你此前已完成且仍然有效的思考片段，请从中断处无缝续接：不要重复已推导的内容，不要提及本提示，直接继续推理。\n<<<THINK_SLICE\n' + hit.text.slice(-MAX_SLICE_CHARS) + '\nTHINK_SLICE>>>'
      const newOptions = Object.assign({}, options, { messages: (options.messages || []).concat([{ role: 'user', content: preamble }]) })
      owned.add(newOptions)
      stats.resumed++
      logger.write('info', 'resumed', { fp: fp.slice(0, 8), chars: hit.text.length, session: options.sessionId || '' })
      const upstream = llm.stream(newOptions)
      return (async function* () { yield* pump(upstream, fp, options.sessionId) })()
    }
    return (async function* () { yield* pump(next(), fp, options.sessionId) })()
  })
}

export {
  name,
  inject,
  apply,
  apply as default
}
