/**
 * dsh-task-resilience — browser half (hand-built ModuleLoader bundle).
 *
 * DSH already reconnects the browser transport indefinitely and records LLM
 * retry events durably. This plugin makes those states impossible to miss:
 *   - host stream disconnect/reconnect;
 *   - provider retry number, backoff and transport error;
 *   - terminal stop reason, including hidden turn-error nodes left behind by
 *     a retry chain.
 *
 * It intentionally never re-submits a completed/partially-executed turn. The
 * native request retry resumes the failed provider request without replaying
 * earlier tool calls, avoiding duplicate file writes and commands.
 */
window.__ModuleLoader__.load({ id: 'dsh-task-resilience', factory(require) {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const h = React.createElement
  const { useSyncExternalStore } = React

  const EMPTY = Object.freeze({
    kind: 'idle', title: '', detail: '', code: '', sticky: false,
    deadline: 0, updatedAt: 0,
  })
  let state = EMPTY
  const listeners = new Set()
  let dismissedStatusKey = ''

  function statusKey(value) {
    return [value.kind, value.title, value.detail, value.code].join('\u0000')
  }

  function emit(next) {
    if (sameStatus(state, next)) return
    state = Object.freeze(next)
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { console.error('[task-resilience] listener failed:', error) }
    }
  }

  function sameStatus(a, b) {
    return a.kind === b.kind && a.title === b.title && a.detail === b.detail &&
      a.code === b.code && a.sticky === b.sticky && a.deadline === b.deadline
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function nodeValues(store) {
    if (!store) return []
    if (typeof store.values === 'function') return [...store.values()]
    if (Array.isArray(store)) return store
    return Object.values(store)
  }

  function latestTurn(snapshot) {
    const order = snapshot?.chat?.timeline?.turnOrder
    return Array.isArray(order) && order.length > 0 ? order[order.length - 1] : 0
  }

  function latestNodes(snapshot, turn) {
    let retry = null
    let turnError = null
    for (const node of nodeValues(snapshot?.chat?.nodes)) {
      const data = node?.data
      if (node?.kind === 'model-retry' && data?.current?.turn === turn) {
        if (!retry || (data.current.seq ?? 0) >= (retry.current?.seq ?? 0)) retry = data
      }
      if (node?.kind === 'turn-error' && data?.turn === turn) {
        if (!turnError || (data.seq ?? 0) >= (turnError.seq ?? 0)) turnError = data
      }
    }
    return { retry, turnError }
  }

  function failureText(failure) {
    if (!failure) return '未知错误'
    if (typeof failure === 'string') return failure
    return String(failure.message ?? failure.error?.message ?? failure.code ?? '未知错误')
  }

  function statusFromSession(snapshot) {
    if (!snapshot) return EMPTY
    const turn = latestTurn(snapshot)
    if (!turn) return EMPTY
    const location = snapshot.chat?.timeline?.turns?.get?.(turn)
    const { retry, turnError } = latestNodes(snapshot, turn)
    const current = retry?.current

    if (snapshot.running && current) {
      const max = Number.isFinite(current.maxRetries) ? current.maxRetries : 10000
      const deadline = current.retryState === 'scheduled'
        ? Number(current.time ?? Date.now()) + Number(current.delayMs ?? 0)
        : 0
      const phase = current.retryState === 'scheduled' ? '等待后重试' : '正在重新连接模型服务'
      return {
        kind: 'retrying',
        title: `连接中断，${phase}（${current.retry}/${max}）`,
        detail: failureText(current.failure),
        code: String(current.failure?.code ?? ''),
        sticky: true,
        deadline,
        updatedAt: Date.now(),
      }
    }

    if (!snapshot.running && location?.status === 'closed' && turnError) {
      return {
        kind: 'stopped',
        title: '任务已停止',
        detail: failureText(turnError),
        code: String(turnError.code ?? ''),
        sticky: true,
        deadline: 0,
        updatedAt: Date.now(),
      }
    }

    if (snapshot.running) {
      return {
        kind: 'running',
        title: '任务正在执行',
        detail: '已连接；等待新的模型输出或工具结果。',
        code: '',
        sticky: false,
        deadline: 0,
        updatedAt: Date.now(),
      }
    }
    return EMPTY
  }

  function StatusBar() {
    const current = useSyncExternalStore(subscribe, () => state)
    if (current.kind === 'idle' || statusKey(current) === dismissedStatusKey) return null
    const remaining = current.deadline > Date.now()
      ? `，约 ${Math.max(1, Math.ceil((current.deadline - Date.now()) / 1000))} 秒后重试`
      : ''
    return h('section', {
      className: `dtr-bar dtr-${current.kind}`,
      role: current.kind === 'stopped' ? 'alert' : 'status',
      'aria-live': current.kind === 'stopped' ? 'assertive' : 'polite',
      'data-dsh-task-resilience': current.kind,
    },
    h('span', { className: 'dtr-dot', 'aria-hidden': 'true' }),
    h('div', { className: 'dtr-copy' },
      h('strong', null, current.title + remaining),
      current.detail ? h('span', null, current.detail) : null,
      current.code ? h('code', null, current.code) : null),
    h('button', {
      type: 'button', className: 'dtr-close', title: '隐藏此状态', 'aria-label': '隐藏此状态',
      onClick: () => {
        dismissedStatusKey = statusKey(current)
        // useSyncExternalStore only re-renders when the snapshot identity
        // changes; dismissal lives outside the status payload, so publish a
        // fresh immutable snapshot before notifying subscribers.
        state = Object.freeze({ ...state, updatedAt: Date.now() })
        for (const listener of [...listeners]) listener()
      },
    }, '×'))
  }

  const CSS = [
    '.dtr-bar{position:relative;display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;margin:0 auto 8px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:12px;background:color-mix(in srgb,var(--dsw-specific-input-major,#17202f) 88%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);backdrop-filter:blur(10px);color:var(--dsw-alias-label-primary,#e8eaed);font-family:inherit}',
    '.dtr-dot{flex:none;width:9px;height:9px;margin-top:5px;border-radius:50%;background:#79b8ff;box-shadow:0 0 0 4px rgba(121,184,255,.14)}',
    '.dtr-copy{flex:1;min-width:0;display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:baseline}',
    '.dtr-copy strong{font-size:13px;line-height:1.45}',
    '.dtr-copy span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#aab2c0);font-size:12px}',
    '.dtr-copy code{padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08);font-size:11px;color:inherit}',
    '.dtr-close{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#aab2c0);cursor:pointer;font-size:18px;line-height:18px;padding:0 2px}',
    '.dtr-retrying{border-color:rgba(230,162,60,.55)}.dtr-retrying .dtr-dot{background:#e6a23c;box-shadow:0 0 0 4px rgba(230,162,60,.14);animation:dtr-pulse 1.3s ease-in-out infinite}',
    '.dtr-stopped{border-color:rgba(248,81,73,.65)}.dtr-stopped .dtr-dot{background:#f85149;box-shadow:0 0 0 4px rgba(248,81,73,.15)}',
    '.dtr-host-reconnecting{border-color:rgba(230,162,60,.55)}.dtr-host-reconnecting .dtr-dot{background:#e6a23c;animation:dtr-pulse 1.3s ease-in-out infinite}',
    '.dtr-recovered{border-color:rgba(46,160,67,.55)}.dtr-recovered .dtr-dot{background:#3fb950;box-shadow:0 0 0 4px rgba(63,185,80,.14)}',
    '@keyframes dtr-pulse{50%{opacity:.4;transform:scale(.75)}}',
    '@media(max-width:720px){.dtr-copy{grid-template-columns:1fr auto}.dtr-copy span{grid-column:1/-1}}',
    '@media(prefers-reduced-motion:reduce){.dtr-dot{animation:none!important}}',
  ].join('\n')

  function mount(ctx) {
    const oldStyle = document.getElementById('dsh-task-resilience-style')
    if (oldStyle) oldStyle.remove()
    const style = document.createElement('style')
    style.id = 'dsh-task-resilience-style'
    style.dataset.plugin = 'dsh-task-resilience'
    style.textContent = CSS
    document.head.appendChild(style)

    const sessions = ctx.get('sessions') ?? ctx.sessions
    const connection = ctx.get('connection') ?? ctx.connection
    let sessionDispose = null
    let boundSessionId = ''
    let currentSession = null
    let everConnected = false
    let hostWasDisconnected = false
    let recoveredTimer = null

    function refreshConversation() {
      if (!currentSession?.getSnapshot) return
      const next = statusFromSession(currentSession.getSnapshot())
      if (next.kind === 'idle' && (state.kind === 'host-reconnecting' || state.kind === 'stopped')) return
      emit(next)
    }

    function refreshSession() {
      if (!sessions?.list?.getSnapshot) return
      const id = sessions.list.getSnapshot()?.current ?? ''
      if (id !== boundSessionId) {
        if (sessionDispose) sessionDispose()
        sessionDispose = null
        currentSession = null
        boundSessionId = id
        dismissedStatusKey = ''
        emit(EMPTY)
      }
      // A session binding can be minted slightly after the list selects it.
      // Keep trying on later list notifications instead of staying detached.
      if (id && !currentSession && typeof sessions.binding === 'function') {
        currentSession = sessions.binding(id)?.session ?? null
        if (currentSession?.subscribe) sessionDispose = currentSession.subscribe(refreshConversation)
      }
      refreshConversation()
    }

    const disposers = []
    if (sessions?.list?.subscribe) disposers.push(sessions.list.subscribe(refreshSession))
    refreshSession()

    const hostFace = connection?.hostDescription
    if (hostFace?.subscribe) {
      const refreshConnection = () => {
        const connected = hostFace.getSnapshot() !== undefined
        if (connected) {
          everConnected = true
          if (hostWasDisconnected) {
            hostWasDisconnected = false
            emit({ kind: 'recovered', title: '与 DSH 服务的连接已恢复',
              detail: '正在重新同步当前任务状态。', code: '', sticky: false,
              deadline: 0, updatedAt: Date.now() })
            if (recoveredTimer) clearTimeout(recoveredTimer)
            recoveredTimer = setTimeout(refreshConversation, 3500)
          }
        } else if (everConnected) {
          hostWasDisconnected = true
          emit({ kind: 'host-reconnecting', title: '与 DSH 服务的连接已中断，正在自动恢复',
            detail: '页面会在连接恢复后重新同步当前任务，不需要重复发送消息。',
            code: 'HOST_DISCONNECTED', sticky: true, deadline: 0, updatedAt: Date.now() })
        }
      }
      disposers.push(hostFace.subscribe(refreshConnection))
      refreshConnection()
    }

    const clockTimer = setInterval(() => {
      if (state.kind === 'retrying' && state.deadline > Date.now()) {
        state = Object.freeze({ ...state, updatedAt: Date.now() })
        for (const listener of [...listeners]) listener()
      }
    }, 1000)

    // Resume/mount failures happen before an Agent exists, so they are not
    // written into the session projection that refreshConversation reads.
    // Preserve the transient toast as a durable status bar instead of letting
    // the user see an apparently idle composer again.
    let lastResumeError = ''
    const resumeErrorObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          const element = added?.nodeType === 1 ? added : added?.parentElement
          if (element?.closest?.('[data-dsh-task-resilience]')) continue
          const message = String(added?.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (!/resume failed for session|preset .* failed to mount/i.test(message)) continue
          if (message === lastResumeError) continue
          lastResumeError = message
          emit({
            kind: 'stopped',
            title: '任务恢复失败',
            detail: message.slice(0, 1200),
            code: 'RESUME_FAILED',
            sticky: true,
            deadline: 0,
            updatedAt: Date.now(),
          })
          return
        }
      }
    })
    resumeErrorObserver.observe(document.body, { childList: true, subtree: true })

    window.dshTaskResilience = { status: () => state, refresh: refreshSession }
    console.info('[task-resilience] recovery visibility enabled; provider retry execution remains native')

    return () => {
      if (sessionDispose) sessionDispose()
      for (const dispose of disposers) {
        try { dispose() } catch { /* ignore */ }
      }
      if (recoveredTimer) clearTimeout(recoveredTimer)
      clearInterval(clockTimer)
      resumeErrorObserver.disconnect()
      style.remove()
      try { delete window.dshTaskResilience } catch { window.dshTaskResilience = undefined }
    }
  }

  const inject = ['connection', 'sessions', 'slots']
  function apply(ctx) {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'task-resilience',
      priority: -50,
    }, StatusBar))
    ctx.effect(() => mount(ctx), 'task-resilience: visible recovery status')
  }
  exports.inject = inject
  exports.apply = apply
  return module.exports
} })
