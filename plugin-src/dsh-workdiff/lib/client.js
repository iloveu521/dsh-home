/**
 * dsh-workdiff — client half (hand-built browser bundle, ModuleLoader wire
 * format, plain CJS + React.createElement — no bundler, no JSX).
 *
 * Features (all inside dsh-better-sidebar's RIGHT sidebar):
 *  1. A "改动" tab (`workdiff`) registered through `ctx.betterSidebar`:
 *     agent-session changes are shown by default, with an explicit switch to
 *     all uncommitted Git changes. Files expand to an inline unified diff.
 *  2. Auto-expand: when agent-session changes appear during a session, the
 *     sidebar opens to the changes tab (setting `autoExpandOnChange`, default
 *     on; throttled, including the first non-empty snapshot so fast file
 *     writes are not missed).
 *  3. Optional bottom-bar auto-open: on a NEW session, expand better-sidebar's
 *     bottom panel once (its first-expansion flow opens a terminal tab).
 *     Setting `openBottomOnNewSession`, default on.
 *
 * The status feed polls the host `/workdiff/*` routes (loopback + workspace
 * fenced); the tab, badge and auto-expand all read the same store.
 */
window.__ModuleLoader__.load({ id: 'dsh-workdiff', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  const React = require('react')
  const { createElement: h, useEffect, useState, useSyncExternalStore } = React

  // ── tiny external store (stable reference between changes) ───────────────
  function createStore(initial) {
    let state = initial
    const listeners = new Set()
    return {
      get: () => state,
      set: (updater) => {
        const next = typeof updater === 'function' ? updater(state) : updater
        if (next !== state) {
          state = next
          for (const fn of [...listeners]) {
            try { fn() } catch { /* one bad listener must not break the rest */ }
          }
        }
      },
      subscribe: (fn) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    }
  }

  const statusStore = createStore({ data: null, error: null, loading: false, ts: 0, sessionId: null, focusAgent: 0 })

  /** The plugin context (set in apply; read by helpers). */
  let ctxRef = null
  /** The bound settings scope for namespace `dsh-workdiff`. */
  let settingsScopeRef = null
  /** Live session scope the host feed is bound to. */
  let sessionRef = null
  /** Whether the workdiff tab descriptor has been registered. */
  let tabRegistered = false
  /** Auto-expand bookkeeping. */
  let lastSig = ''
  let lastExpandAt = 0

  const UNAVAILABLE_SNAPSHOT = Object.freeze({ status: 'unavailable', value: undefined, revision: undefined })

  // ── helpers ──────────────────────────────────────────────────────────────
  function query(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
  }

  function getJSON(path, params) {
    const url = params ? `${path}?${query(params)}` : path
    return fetch(url, { headers: { accept: 'application/json' } }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
  }

  function sessionsList() {
    return ctxRef?.get('sessions')?.list?.getSnapshot?.()
  }

  /** The active session id + cwd (better-sidebar snapshot first, sessions list fallback). */
  function currentScope() {
    const bs = ctxRef?.get('betterSidebar')
    let id
    let cwd
    if (bs && typeof bs.getSnapshot === 'function') {
      const snap = bs.getSnapshot()
      id = snap.sessionId
      if (id) cwd = sessionsList()?.byId?.[id]?.cwd
    }
    if (!id) {
      const list = sessionsList()
      id = list?.current
      if (id && !cwd) cwd = list?.byId?.[id]?.cwd
    }
    return id ? { id, cwd } : null
  }

  function settingsValue(key, fallback) {
    if (!settingsScopeRef) return fallback
    try {
      const snap = settingsScopeRef.getSnapshot()
      if (snap.status === 'ready') {
        const v = snap.value?.[key]
        return v === undefined ? fallback : v
      }
      return fallback
    } catch {
      return fallback
    }
  }

  /** Signature of the agent-session change set (path:status:adds:dels). */
  function changeSignature(data) {
    if (!data || data.ok !== true || data.git !== true || !Array.isArray(data.agentFiles)) return ''
    return data.agentFiles.map((f) => `${f.path}:${f.status}:${f.adds}:${f.dels}`).join('|')
  }

  /** One status fetch against the current session; writes the status store. */
  function pollOnce() {
    const s = sessionRef
    if (!s || !s.id) return
    const params = { session: s.id }
    if (s.cwd) params.cwd = s.cwd
    statusStore.set({ ...statusStore.get(), loading: true })
    getJSON('/workdiff/status', params)
      .then((data) => {
        statusStore.set((state) => ({ ...state, data, error: null, loading: false, ts: Date.now(), sessionId: s.id }))
        const sig = changeSignature(data)
        if (sig !== '' && sig !== lastSig) maybeAutoExpand()
        lastSig = sig
      })
      .catch((error) => {
        statusStore.set((state) => ({ ...state, data: null, error: String(error), loading: false, ts: Date.now(), sessionId: s.id }))
      })
  }

  /** Track the active session; resolve cwd when unknown; fire the bottom auto-open. */
  const bottomAttempted = new Set()
  let lastSessionKey = ''
  function refreshSession() {
    const s = currentScope()
    const key = s ? `${s.id}|${s.cwd ?? ''}` : ''
    if (key !== lastSessionKey) {
      lastSessionKey = key
      lastSig = ''
      statusStore.set({ data: null, error: null, loading: false, ts: 0, sessionId: s?.id ?? null, focusAgent: 0 })
    }
    sessionRef = s
    if (s && !s.cwd) {
      getJSON('/workdiff/cwd', { session: s.id })
        .then((r) => {
          if (r.ok && typeof r.cwd === 'string') sessionRef = { id: s.id, cwd: r.cwd }
        })
        .catch(() => { /* keep cwd undefined; next tick retries */ })
    }
    maybeAutoOpenBottom()
  }

  // ── bottom panel auto-open (new sessions only) ───────────────────────────
  function maybeAutoOpenBottom() {
    const bs = ctxRef?.get('betterSidebar')
    if (!bs || typeof bs.getSnapshot !== 'function') return
    if (!settingsValue('openBottomOnNewSession', true)) return
    const snap = bs.getSnapshot()
    const state = snap.state
    const id = snap.sessionId
    if (!id || !state) return
    if (state.bottomOpen || state.bottomOpenedOnce) return
    if (bottomAttempted.has(id)) return
    bottomAttempted.add(id)
    clickBottomToggle(0)
  }

  function clickBottomToggle(attempt) {
    if (attempt > 10) return
    const labels = ['\u5c55\u5f00\u5e95\u90e8\u9762\u677f', 'Expand bottom panel']
    let btn = null
    for (const label of labels) {
      try {
        btn = document.querySelector(`button[aria-label="${label}"]`)
      } catch { /* selector escaping */ }
      if (btn) break
    }
    if (btn) {
      try { btn.click() } catch { /* ignore */ }
      return
    }
    window.setTimeout(() => clickBottomToggle(attempt + 1), 500)
  }

  // ── right-sidebar auto-expand on changes ─────────────────────────────────
  function maybeAutoExpand() {
    if (!settingsValue('autoExpandOnChange', true)) return
    const now = Date.now()
    if (now - lastExpandAt < 8000) return
    const bs = ctxRef?.get('betterSidebar')
    if (!bs || typeof bs.openTab !== 'function') return
    const s = currentScope()
    if (!s?.id) return
    lastExpandAt = now
    try {
      statusStore.set((state) => ({ ...state, focusAgent: (state.focusAgent ?? 0) + 1 }))
      bs.openTab(
        { type: 'workdiff', path: 'workdiff://changes', title: fallbackT('entryLabel') },
        { sessionId: s.id, cwd: s.cwd },
      )
    } catch { /* ignore */ }
  }

  // ── tab registration (retried until better-sidebar is up) ────────────────
  function registerWorkdiffTab() {
    const bs = ctxRef?.get('betterSidebar')
    if (!bs || typeof bs.registerTab !== 'function') return false
    if (tabRegistered) return true
    try {
      bs.registerTab({
        id: 'workdiff',
        title: fallbackT('entryLabel'),
        icon: (size) => IconDiff(size),
        order: 30,
        single: true,
        badge: () => {
          try {
            const d = statusStore.get().data
            return d && d.ok === true && d.git === true && Array.isArray(d.agentFiles) ? d.agentFiles.length : null
          } catch {
            return null
          }
        },
        component: WorkdiffTab,
      })
      tabRegistered = true
    } catch (error) {
      console.error('[dsh-workdiff] registerTab failed:', error)
    }
    return tabRegistered
  }

  // ── locale dictionaries ───────────────────────────────────────────────────
  const zh = {
    title: '\u4ee3\u7801\u6539\u52a8\u4e0e\u5e95\u680f',
    desc: '\u9ed8\u8ba4\u5c55\u793a agent \u672c\u4f1a\u8bdd\u7684\u4ee3\u7801\u6539\u52a8\uff0c\u53ef\u5207\u6362\u67e5\u770b Git \u5168\u90e8\u672a\u63d0\u4ea4\u6539\u52a8\uff1b\u65b0\u4f1a\u8bdd\u81ea\u52a8\u6253\u5f00\u5e95\u680f\u3002',
    openBottomLabel: '\u65b0\u4f1a\u8bdd\u81ea\u52a8\u6253\u5f00\u5e95\u680f',
    openBottomDesc: '\u65b0\u4f1a\u8bdd\u5f00\u59cb\u65f6\u81ea\u52a8\u5c55\u5f00\u5e95\u90e8\u9762\u677f\u5e76\u6253\u5f00\u7ec8\u7aef\u6807\u7b7e\uff08\u53ef\u5728\u4fa7\u8fb9\u5361\u7247\u8bbe\u7f6e\u4e2d\u5173\u95ed\uff09\u3002',
    autoExpandLabel: '\u4ee3\u7801\u6539\u52a8\u65f6\u81ea\u52a8\u5c55\u5f00\u4fa7\u680f',
    autoExpandDesc: 'Agent \u672c\u4f1a\u8bdd\u4ea7\u751f\u65b0\u6539\u52a8\u65f6\uff0c\u81ea\u52a8\u6253\u5f00\u53f3\u4fa7\u680f\u5e76\u5c55\u793a agent \u6539\u52a8\u3002',
    entryLabel: '\u6539\u52a8',
    entryTitle: '\u4ee3\u7801\u6539\u52a8\uff08\u5de5\u4f5c\u533a\u6539\u52a8\u5b9e\u65f6\u540c\u6b65\uff09',
    drawerTitle: '\u4ee3\u7801\u6539\u52a8',
    agentChanges: 'Agent \u6539\u52a8',
    gitChanges: 'Git \u672a\u63d0\u4ea4',
    refresh: '\u5237\u65b0',
    close: '\u5173\u95ed',
    noChanges: '\u6ca1\u6709\u6539\u52a8',
    noChangesHint: '\u672c\u4f1a\u8bdd\u4e2d agent \u5c1a\u672a\u4fee\u6539\u4ee3\u7801',
    noGitChangesHint: '\u5f53\u524d\u5206\u652f\u6ca1\u6709\u672a\u63d0\u4ea4\u6539\u52a8',
    notGit: '\u5f53\u524d\u5de5\u4f5c\u533a\u4e0d\u662f Git \u4ed3\u5e93',
    loading: '\u52a0\u8f7d\u4e2d\u2026',
    error: '\u52a0\u8f7d\u5931\u8d25',
  }
  const en = {
    title: 'Code Changes & Bottom Bar',
    desc: 'Shows this agent session\'s changes by default, with a switch for all uncommitted Git changes; new sessions auto-open the bottom panel.',
    openBottomLabel: 'Auto-open bottom bar on new sessions',
    openBottomDesc: 'Expands the bottom panel and opens a terminal tab when a new session starts (disable in Side card settings).',
    autoExpandLabel: 'Auto-expand sidebar on code changes',
    autoExpandDesc: 'When this agent session produces new changes, open the right sidebar on the agent changes view.',
    entryLabel: 'Changes',
    entryTitle: 'Code changes (live sync of working-tree edits)',
    drawerTitle: 'Code Changes',
    agentChanges: 'Agent changes',
    gitChanges: 'Git uncommitted',
    refresh: 'Refresh',
    close: 'Close',
    noChanges: 'No changes',
    noChangesHint: 'The agent has not changed code in this session',
    noGitChangesHint: 'The current branch has no uncommitted changes',
    notGit: 'Current workspace is not a Git repository',
    loading: 'Loading\u2026',
    error: 'Load failed',
  }
  const fallbackT = (key) => zh[key] ?? key

  // ── CSS (injected once; theme tokens with dark fallbacks) ────────────────
  const CSS_TEXT = [
    '.wd-tab{display:flex;flex-direction:column;height:100%;min-height:0}',
    '.wd-tab-header{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px}',
    '.wd-tab-title{flex:1;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wd-tab-branch{flex:none;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa3b2);border:1px solid var(--dsw-alias-border-l1,#26282e);border-radius:999px;padding:1px 8px}',
    '.wd-icon-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa3b2);cursor:pointer}',
    '.wd-icon-btn:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e8eaed)}',
    '.wd-view-switch{flex:none;display:grid;grid-template-columns:1fr 1fr;gap:2px;margin:0 8px 7px;padding:2px;border:1px solid var(--dsw-alias-border-l1,#26282e);border-radius:8px;background:var(--dsw-alias-bg-base,#17181c)}',
    '.wd-view-btn{min-width:0;border:0;border-radius:6px;padding:5px 8px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wd-view-btn:hover{color:var(--dsw-alias-label-primary,#e8eaed)}',
    '.wd-view-btn.wd-active{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600}',
    '.wd-view-count{margin-left:4px;opacity:.72}',
    '.wd-tab-body{flex:1;min-height:0;overflow:auto;padding:2px 6px 8px}',
    '.wd-state{padding:28px 16px;text-align:center;color:var(--dsw-alias-label-secondary,#9aa3b2)}',
    '.wd-state-hint{margin-top:6px;font-size:12px;opacity:.7}',
    '.wd-file{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer}',
    '.wd-file:hover{background:var(--dsw-specific-sidebar-nav-item-hover,rgba(255,255,255,.06))}',
    '.wd-badge{flex:none;width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px;font-size:11px;font-weight:700}',
    '.wd-badge-M{background:rgba(230,162,60,.2);color:#e6a23c}',
    '.wd-badge-A{background:rgba(46,160,67,.2);color:#7ee2a8}',
    '.wd-badge-D{background:rgba(248,81,73,.2);color:#ff9b94}',
    '.wd-badge-U{background:rgba(139,148,158,.25);color:#c9d1d9}',
    '.wd-badge-R{background:rgba(121,192,255,.2);color:#79b8ff}',
    '.wd-file-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wd-file-stat{flex:none;font-size:11px;font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}',
    '.wd-file-add{color:#7ee2a8}',
    '.wd-file-del{color:#ff9b94}',
    '.wd-diff-wrap{border:1px solid var(--dsw-alias-border-l1,#26282e);border-radius:8px;margin:2px 0 8px;overflow:hidden}',
    '.wd-diff{display:block;margin:0;padding:6px 0;max-height:52vh;overflow:auto;background:var(--dsw-alias-bg-base,#17181c);font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;line-height:1.55}',
    '.wd-diff-line{display:block;white-space:pre;padding:0 10px}',
    '.wd-add{background:rgba(46,160,67,.16);color:#7ee2a8}',
    '.wd-del{background:rgba(248,81,73,.16);color:#ff9b94}',
    '.wd-hunk{background:rgba(56,139,253,.1);color:#79b8ff}',
    '.wd-meta{background:rgba(139,148,158,.08);color:#8b949e}',
    '.wd-ctx{color:var(--dsw-alias-label-secondary,#9aa3b2)}',
    '.wd-diff-err{padding:8px 12px;color:#ff9b94;font-size:12px}',
    '.wd-settings{padding:0 2px}',
    '.wd-setting-row{display:flex;align-items:flex-start;gap:12px;padding:10px 0}',
    '.wd-switch{flex:none;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);background:var(--dsw-alias-bg-raised,#23252b);position:relative;cursor:pointer;transition:background .15s}',
    '.wd-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary,#9aa3b2);transition:left .15s,background .15s}',
    '.wd-switch.wd-on{background:var(--dsw-alias-accent,#4d6bfe);border-color:var(--dsw-alias-accent,#4d6bfe)}',
    '.wd-switch.wd-on::after{left:16px;background:#fff}',
    '.wd-setting-copy{display:flex;flex-direction:column;gap:2px}',
    '.wd-setting-copy span{color:var(--dsw-alias-label-primary,#e8eaed);font-size:13px}',
    '.wd-setting-copy small{color:var(--dsw-alias-label-secondary,#9aa3b2);font-size:12px;line-height:1.5}',
  ].join('\n')

  function injectCss() {
    if (typeof document === 'undefined') return
    if (document.getElementById('wd-styles')) return
    const style = document.createElement('style')
    style.id = 'wd-styles'
    style.textContent = CSS_TEXT
    document.head.appendChild(style)
  }

  // ── icons ─────────────────────────────────────────────────────────────────
  function IconDiff(size) {
    return h('svg', { width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': 'true', style: { display: 'block' } },
      h('path', { d: 'M2 7h4M4 5v4', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }),
      h('path', { d: 'M9 4v6M6 7h6', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round', opacity: 0.5 }))
  }

  // ── inline unified diff ───────────────────────────────────────────────────
  function DiffText({ text }) {
    const lines = text.split('\n')
    const rows = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let cls = 'wd-ctx'
      if (line.startsWith('+')) cls = 'wd-add'
      else if (line.startsWith('-')) cls = 'wd-del'
      else if (line.startsWith('@@')) cls = 'wd-hunk'
      else if (line.startsWith('---') || line.startsWith('+++')) cls = 'wd-meta'
      rows.push(h('span', { key: i, className: 'wd-diff-line ' + cls }, line === '' ? '\u00a0' : line))
    }
    return h('pre', { className: 'wd-diff' }, rows)
  }

  // ── the "改动" tab inside the right sidebar ───────────────────────────────
  function WorkdiffTab(props) {
    const scope = props.scope
    const visible = props.visible
    const status = useSyncExternalStore(statusStore.subscribe, statusStore.get)
    const [expanded, setExpanded] = useState(null)
    const [diffCache, setDiffCache] = useState({})
    const [view, setView] = useState('agent')

    // Refresh when the tab becomes visible or the session changes.
    useEffect(() => {
      if (visible) pollOnce()
    }, [visible, scope?.sessionId])

    // Every session opens on the focused agent delta, never the repository-wide view.
    useEffect(() => {
      setView('agent')
      setExpanded(null)
      setDiffCache({})
    }, [scope?.sessionId])

    // Auto-expansion always focuses the agent subset, even if the user had
    // previously switched this mounted tab to the repository-wide Git view.
    useEffect(() => {
      if ((status.focusAgent ?? 0) > 0) {
        setView('agent')
        setExpanded(null)
      }
    }, [status.focusAgent])

    const data = status.data
    const agentFiles = data?.ok === true && data.git === true && Array.isArray(data.agentFiles) ? data.agentFiles : []
    const gitFiles = data?.ok === true && data.git === true
      ? (Array.isArray(data.gitFiles) ? data.gitFiles : (Array.isArray(data.files) ? data.files : []))
      : []
    const files = view === 'git' ? gitFiles : agentFiles
    const openFile = expanded && files.find((f) => f.path === expanded)
    const diff = openFile ? diffCache[`${view}:${openFile.path}`] : null

    const toggleFile = (file) => {
      if (expanded === file.path) {
        setExpanded(null)
        return
      }
      setExpanded(file.path)
      const cacheKey = `${view}:${file.path}`
      if (diffCache[cacheKey]) return
      if (!scope) return
      getJSON('/workdiff/diff', {
        session: scope.sessionId,
        cwd: scope.cwd ?? data?.root ?? '',
        file: file.path,
        untracked: file.xy === '??' ? '1' : '0',
        mode: view,
      })
        .then((r) => {
          setDiffCache((c) => ({ ...c, [cacheKey]: r }))
        })
        .catch((error) => {
          setDiffCache((c) => ({ ...c, [cacheKey]: { ok: false, error: String(error) } }))
        })
    }

    const t = fallbackT
    let body
    if (data?.ok === true && data.git === false) {
      body = h('div', { className: 'wd-state' }, t('notGit'))
    } else if (files.length === 0) {
      body = h('div', { className: 'wd-state' },
        h('div', null, status.data?.ok === true ? t('noChanges') : (status.error ? t('error') : t('loading'))),
        status.data?.ok === true ? h('div', { className: 'wd-state-hint' }, t(view === 'git' ? 'noGitChangesHint' : 'noChangesHint')) : null)
    } else {
      const rows = []
      for (const file of files) {
        const badgeClass = 'wd-badge wd-badge-' + (file.status || 'M')
        const isOpen = file.path === expanded
        rows.push(
          h('div', { key: file.path, className: 'wd-file', onClick: () => toggleFile(file), title: file.path },
            h('span', { className: badgeClass }, file.status || 'M'),
            h('span', { className: 'wd-file-path' }, file.path),
            h('span', { className: 'wd-file-stat' },
              file.adds > 0 ? h('span', { className: 'wd-file-add' }, `+${file.adds}`) : null,
              file.adds > 0 && file.dels > 0 ? ' ' : null,
              file.dels > 0 ? h('span', { className: 'wd-file-del' }, `-${file.dels}`) : null)),
          isOpen
            ? h('div', { key: file.path + ':diff', className: 'wd-diff-wrap' },
                diff === null || diff === undefined
                  ? h('div', { className: 'wd-diff-err' }, t('loading'))
                  : diff.ok
                    ? h(DiffText, { text: diff.text })
                    : h('div', { className: 'wd-diff-err' }, diff.error ?? t('error')))
            : null)
      }
      body = rows
    }

    return h('div', { className: 'wd-tab', 'data-workdiff-tab': '' },
      h('div', { className: 'wd-tab-header' },
        h('span', { className: 'wd-tab-title' }, t('drawerTitle')),
        data?.ok === true && data.git === true && data.branch ? h('span', { className: 'wd-tab-branch' }, data.branch) : null,
        h('button', { type: 'button', className: 'wd-icon-btn', title: t('refresh'), 'aria-label': t('refresh'), onClick: () => pollOnce() }, IconDiff(13))),
      h('div', { className: 'wd-view-switch', role: 'tablist', 'aria-label': t('drawerTitle') },
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'agent' ? 'true' : 'false',
          className: 'wd-view-btn' + (view === 'agent' ? ' wd-active' : ''),
          onClick: () => { setView('agent'); setExpanded(null) },
        }, t('agentChanges'), h('span', { className: 'wd-view-count' }, agentFiles.length)),
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'git' ? 'true' : 'false',
          className: 'wd-view-btn' + (view === 'git' ? ' wd-active' : ''),
          onClick: () => { setView('git'); setExpanded(null) },
        }, t('gitChanges'), h('span', { className: 'wd-view-count' }, gitFiles.length))),
      h('div', { className: 'wd-tab-body' }, body))
  }

  // ── settings section card ─────────────────────────────────────────────────
  function WorkdiffSettingsSection(props) {
    const t = props?.t ?? fallbackT
    const scope = settingsScopeRef
    const subscribe = scope ? scope.subscribe.bind(scope) : () => () => {}
    const getSnap = scope ? scope.getSnapshot.bind(scope) : () => UNAVAILABLE_SNAPSHOT
    const snap = useSyncExternalStore(subscribe, getSnap)
    const value = snap.status === 'ready' ? (snap.value ?? {}) : {}
    const openBottom = value.openBottomOnNewSession ?? true
    const autoExpand = value.autoExpandOnChange ?? true

    const row = (label, desc, on, toggle) => h('div', { className: 'wd-setting-row' },
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        className: 'wd-switch' + (on ? ' wd-on' : ''),
        onClick: toggle,
      }),
      h('div', { className: 'wd-setting-copy' },
        h('span', null, label),
        h('small', null, desc)))

    return h('div', { className: 'wd-settings' },
      h('h2', { style: { margin: '0 0 4px', fontSize: 15 } }, t('title')),
      h('p', { style: { margin: '0 0 10px', color: 'var(--dsw-alias-label-secondary,#9aa3b2)', fontSize: 13, lineHeight: 1.6 } }, t('desc')),
      row(t('openBottomLabel'), t('openBottomDesc'), openBottom, () => {
        if (scope) void scope.set('openBottomOnNewSession', !openBottom)
      }),
      row(t('autoExpandLabel'), t('autoExpandDesc'), autoExpand, () => {
        if (scope) void scope.set('autoExpandOnChange', !autoExpand)
      }))
  }

  // ── client plugin body ────────────────────────────────────────────────────
  const inject = ['slots', 'locale', 'settingsScope', 'sessions']

  function apply(ctx) {
    ctxRef = ctx
    settingsScopeRef = (ctx.get('webUiSettings') ?? ctx.settingsScope).bind({ namespace: 'dsh-workdiff' })
    injectCss()

    ctx.effect(() => ctx.locale.register('workdiff', { zh, en }), 'workdiff: dictionaries')

    // Session tracking: subscribe to both the better-sidebar snapshot (when
    // present) and the sessions list; re-derive scope on every poll tick so a
    // late-mounting better-sidebar is eventually picked up.
    ctx.effect(() => {
      const disposers = []
      const bs = ctx.get('betterSidebar')
      if (bs && typeof bs.subscribeState === 'function') disposers.push(bs.subscribeState(refreshSession))
      const sessions = ctx.get('sessions')
      if (sessions?.list?.subscribe) disposers.push(sessions.list.subscribe(refreshSession))
      refreshSession()
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* ignore */ }
        }
      }
    }, 'workdiff: session tracking')

    // Poll loop: status feed while a session exists. Self-rescheduling,
    // disposed with the fiber; also retries the tab registration.
    ctx.effect(() => {
      let timer = null
      let stopped = false
      const intervalNow = () => (settingsValue('refreshMs', 2500))
      const loop = async () => {
        registerWorkdiffTab()
        refreshSession()
        pollOnce()
        if (stopped) return
        timer = window.setTimeout(loop, intervalNow())
      }
      void loop()
      return () => {
        stopped = true
        if (timer) window.clearTimeout(timer)
      }
    }, 'workdiff: poll loop')

    // Settings section card.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'workdiff',
      order: 120,
      label: () => {
        try { return ctx.locale.bind('workdiff')('title') } catch { return '代码改动与底栏' }
      },
      locale: 'workdiff',
    }, WorkdiffSettingsSection))
  }

  exports.inject = inject
  exports.apply = apply
  return module.exports
} })
