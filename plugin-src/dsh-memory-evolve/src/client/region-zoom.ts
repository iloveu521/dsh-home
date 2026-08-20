/**
 * DSH desktop region zoom.
 *
 * Browser Ctrl+wheel zoom normally scales the entire page.  DSH is a three
 * surface workbench, so that behaviour is especially disruptive: enlarging a
 * diff also enlarges the conversation and the session list.  This controller
 * intercepts Ctrl+wheel before the browser default and keeps an independent
 * zoom value for the left sidebar, conversation, and code workbench.
 *
 * The selectors below deliberately use DSH's public data anchors rather than
 * build-generated class names:
 * - [data-pane="sidebar"] / [data-pane="conversation"] are shell panes;
 * - [data-dsh-panel-host] is better-sidebar's fixed right/bottom workbench;
 * - [data-pane="details"] is the built-in detail/code surface.
 */

export type RegionZoomName = 'sidebar' | 'chat' | 'code'

export interface RegionZoomValues {
  sidebar: number
  chat: number
  code: number
}

const STORAGE_KEY = 'dsh-memory-evolve:region-zoom:v1'
const TARGET_ATTR = 'data-dsh-region-zoom-target'
const ZOOM_VAR = '--dsh-region-zoom'
const STYLE_ATTR = 'data-dsh-region-zoom-css'
const CHANGE_EVENT = 'dsh-memory-evolve:region-zoom-change'

const MIN_ZOOM = 0.6
const MAX_ZOOM = 2
const ZOOM_STEP = 0.1
const DEFAULT_ZOOM: RegionZoomValues = { sidebar: 1, chat: 1, code: 1 }

const REGION_ZOOM_CSS = `
[${TARGET_ATTR}] {
  zoom: var(${ZOOM_VAR}, 1) !important;
  width: 100% !important;
  height: 100% !important;
}
`

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10))
}

function readZoomValues(): RegionZoomValues {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Record<RegionZoomName, unknown>>
      return {
        sidebar: typeof parsed.sidebar === 'number' ? clampZoom(parsed.sidebar) : 1,
        chat: typeof parsed.chat === 'number' ? clampZoom(parsed.chat) : 1,
        code: typeof parsed.code === 'number' ? clampZoom(parsed.code) : 1,
      }
    }
  } catch { /* storage is best-effort */ }
  return { ...DEFAULT_ZOOM }
}

function writeZoomValues(values: RegionZoomValues): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values))
  } catch { /* keep the current-page values when storage is unavailable */ }
}

/** Resolve an event target to one of the three independent visual regions. */
export function regionFromTarget(target: EventTarget | null): RegionZoomName | null {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null
  if (element === null) return null

  // The fixed code workbench overlays the conversation, so it must win before
  // the underlying shell-pane checks.
  if (element.closest('[data-dsh-panel-host]') !== null) return 'code'
  if (element.closest('[data-pane="details"]') !== null) return 'code'
  if (element.closest('[data-pane="sidebar"]') !== null) return 'sidebar'
  if (element.closest('[data-pane="conversation"]') !== null) return 'chat'
  return null
}

/** Direct rendered children under a display:contents slot. */
function slotChildren(paneSelector: string, slotName: string): HTMLElement[] {
  const pane = document.querySelector(paneSelector)
  const slot = pane?.querySelector(`:scope > [data-slot="${slotName}"]`)
  if (slot === null || slot === undefined) return []
  return Array.from(slot.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
}

/**
 * Find the content roots of better-sidebar's fixed right and bottom panels.
 * Its class names are content-hashed, but the structural contract is stable:
 * panel host -> large direct panel -> flex-growing body -> workbench root.
 */
function codeWorkbenchRoots(): HTMLElement[] {
  const roots: HTMLElement[] = []
  for (const host of document.querySelectorAll('[data-dsh-panel-host]')) {
    for (const child of Array.from(host.children)) {
      if (!(child instanceof HTMLElement)) continue
      const rect = child.getBoundingClientRect()
      // Excludes the small top-right toggle cluster. Hidden panels still have
      // their configured size and are prepared before their slide-in animation.
      if (rect.width < 180 || rect.height < 100) continue

      const bodies = Array.from(child.children).filter((candidate): candidate is HTMLElement => {
        if (!(candidate instanceof HTMLElement)) return false
        const candidateRect = candidate.getBoundingClientRect()
        // The resize handle can inherit a flex-grow value from host styles in
        // some better-sidebar builds; its 1px/8px geometry must never become a
        // zoom target.
        return candidateRect.width >= 100
          && candidateRect.height >= 80
          && Number.parseFloat(getComputedStyle(candidate).flexGrow || '0') > 0
      })
      const body = bodies.at(-1)
      if (body === undefined) continue
      const content = body.firstElementChild
      roots.push(content instanceof HTMLElement ? content : body)
    }
  }
  return roots
}

function targetsByRegion(): Record<RegionZoomName, Set<HTMLElement>> {
  return {
    sidebar: new Set(slotChildren('[data-pane="sidebar"]', 'sidebar')),
    chat: new Set(slotChildren('[data-pane="conversation"]', 'conversation')),
    code: new Set([
      ...codeWorkbenchRoots(),
      ...slotChildren('[data-pane="details"]', 'details'),
    ]),
  }
}

function installStyle(): { dispose: () => void } {
  const existing = document.querySelector(`style[${STYLE_ATTR}]`)
  if (existing !== null) return { dispose: () => {} }
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTR, '1')
  style.textContent = REGION_ZOOM_CSS
  document.head.appendChild(style)
  return { dispose: () => style.remove() }
}

/** Create the global Ctrl+wheel region-zoom controller. */
export function createRegionZoom(): { dispose: () => void } {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { dispose: () => {} }
  }

  const style = installStyle()
  const values = readZoomValues()
  const tagged = new Set<HTMLElement>()
  let disposed = false
  let syncFrame = 0

  const syncTargets = (): void => {
    syncFrame = 0
    if (disposed) return
    const current = targetsByRegion()
    const desired = new Map<HTMLElement, RegionZoomName>()
    for (const region of ['sidebar', 'chat', 'code'] as const) {
      if (values[region] === 1) continue
      for (const target of current[region]) desired.set(target, region)
    }

    for (const target of tagged) {
      if (desired.has(target)) continue
      target.removeAttribute(TARGET_ATTR)
      target.style.removeProperty(ZOOM_VAR)
      tagged.delete(target)
    }
    for (const [target, region] of desired) {
      target.setAttribute(TARGET_ATTR, region)
      target.style.setProperty(ZOOM_VAR, String(values[region]))
      tagged.add(target)
    }
  }

  const scheduleSync = (): void => {
    if (disposed || syncFrame !== 0) return
    syncFrame = window.requestAnimationFrame(syncTargets)
  }

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || event.deltaY === 0) return
    const region = regionFromTarget(event.target)
    if (region === null) return

    // A non-passive capture listener is required to suppress Chromium's whole
    // page zoom before any nested editor/canvas sees the modified wheel event.
    event.preventDefault()
    event.stopPropagation()

    const direction = event.deltaY < 0 ? 1 : -1
    const next = clampZoom(values[region] + direction * ZOOM_STEP)
    if (next === values[region]) return
    values[region] = next
    writeZoomValues(values)
    syncTargets()
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { region, zoom: next, values: { ...values } },
    }))
  }

  document.addEventListener('wheel', onWheel, { capture: true, passive: false })
  const observer = new MutationObserver(scheduleSync)
  observer.observe(document.body, { childList: true, subtree: true })
  syncTargets()

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      document.removeEventListener('wheel', onWheel, { capture: true })
      observer.disconnect()
      if (syncFrame !== 0) window.cancelAnimationFrame(syncFrame)
      for (const target of tagged) {
        target.removeAttribute(TARGET_ATTR)
        target.style.removeProperty(ZOOM_VAR)
      }
      tagged.clear()
      style.dispose()
    },
  }
}
