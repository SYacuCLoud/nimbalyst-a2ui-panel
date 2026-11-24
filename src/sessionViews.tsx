import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExtensionContext, PanelHostProps } from '@nimbalyst/extension-sdk'
import { MessageProcessor } from '@a2ui/web_core'
import type { ActionPayload } from '@a2ui/web_core'
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1'

type Call = (toolName: string, args?: Record<string, unknown>) => Promise<unknown>
type Entry = { seq: number; sessionId: string; messages: unknown[] }

const POLL_MS = 400
export const RIGHT_PANEL_ID = 'com.syacucloud.a2ui-panel.right'

// Surfaces from a2ui-panel.show, one processor per calling session. Module scope so every view shares them.
const processors = new Map<string, MessageProcessor>()
const listeners = new Set<() => void>()
let call: Call | null = null
let cursor = 0
let activeSessionId: string | null = null
let viewers = 0
let timer: ReturnType<typeof setInterval> | null = null
let lastError: string | null = null
let diagOpen = false
let restoreInfo = '아직 안 함'
let unloading = false
let suspending = false // closing the bottom panel because we left Agent mode: keep the saved "open"
let modeLabel = '?'
// Set by installSideView: open the view when the active session gets a screen, close it after a button sends.
let onShown = () => {}
let onSent = () => {}
// Agent mode = a visible session transcript that is not the Files-mode chat sidebar.
export function isAgentMode() {
  for (const el of document.querySelectorAll<HTMLElement>('.agent-session-panel[data-session-id]')) {
    if (el.getBoundingClientRect().width > 0 && !el.closest('.chat-sidebar')) return true
  }
  return false
}
window.addEventListener('beforeunload', () => { unloading = true })
// Diagnostics shown under the view: the only way to see what happens without devtools.
const diag = { at: '', ws: '', instance: '', got: 0, queuedFor: [] as string[] }

type Ipc = { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
const ipc = () => (window as unknown as { electronAPI: Ipc }).electronAPI
const workspaces = new Map<string, string>()
// Backend calls from the renderer must name the project; use the active session's workspace.
export async function sessionWorkspace(sessionId: string | null) {
  if (!sessionId) return undefined
  if (!workspaces.has(sessionId)) {
    const got = (await ipc().invoke('sessions:get', sessionId)) as { session?: { workspacePath?: string } }
    if (got.session?.workspacePath) workspaces.set(sessionId, got.session.workspacePath)
  }
  return workspaces.get(sessionId)
}
export const currentWorkspace = () => sessionWorkspace(readActiveSessionId())

// Active session = the visible agent transcript (renderer DOM). Files mode keeps the last one seen.
function readActiveSessionId() {
  for (const el of document.querySelectorAll<HTMLElement>('.agent-session-panel[data-session-id]')) {
    if (el.getBoundingClientRect().width > 0) return el.dataset.sessionId ?? null
  }
  return activeSessionId
}

function processorFor(sessionId: string) {
  let p = processors.get(sessionId)
  if (!p) {
    const created: MessageProcessor = new MessageProcessor([basicCatalog], (action) => sendAction(sessionId, created, action), { version: 'v1.0' })
    p = created
    processors.set(sessionId, p)
  }
  return p
}

// Internal IPC (ai:createQueuedPrompt / ai:triggerQueueProcessing), same path as the chat composer.
const LOCK_MAX_MS = 120000 // safety: unlock even if the agent never answers
const locks = new Map<string, number>() // sessionId:surfaceId -> locked at
const lockKey = (sessionId: string, surfaceId: string) => sessionId + ':' + surfaceId
export const isLocked = (sessionId: string | null, surfaceId: string) => {
  if (!sessionId) return false
  const at = locks.get(lockKey(sessionId, surfaceId))
  return at !== undefined && Date.now() - at < LOCK_MAX_MS
}
function surfaceIdsOf(messages: unknown[]) {
  const ids = new Set<string>()
  for (const m of messages) for (const v of Object.values((m ?? {}) as Record<string, unknown>)) {
    const id = (v as { surfaceId?: unknown } | null)?.surfaceId
    if (typeof id === 'string') ids.add(id)
  }
  return ids
}

async function sendAction(sessionId: string, p: MessageProcessor, action: ActionPayload) {
  if (isLocked(sessionId, action.surfaceId)) return
  locks.set(lockKey(sessionId, action.surfaceId), Date.now())
  listeners.forEach((l) => l())
  const dataModel = p.model.getSurface(action.surfaceId)?.dataModel.get('/')
  const prompt = JSON.stringify({
    version: '1.0',
    action,
    metadata: { a2uiRendererDataModel: { version: '1.0', surfaces: { [action.surfaceId]: dataModel } } }
  })
  try {
    await ipc().invoke('ai:createQueuedPrompt', sessionId, prompt, [], undefined)
    await ipc().invoke('ai:triggerQueueProcessing', sessionId, await sessionWorkspace(sessionId), 'a2ui-action')
    onSent()
  } catch (e) {
    locks.delete(lockKey(sessionId, action.surfaceId)) // not sent: let the user retry
    listeners.forEach((l) => l())
    throw e
  }
}

async function tick() {
  const id = readActiveSessionId()
  if (id !== activeSessionId) {
    activeSessionId = id
    listeners.forEach((l) => l())
  }
  if (!call) return
  const res = (await call('a2ui-panel.spull', { after: cursor })) as { entries: Entry[]; instance?: { id: string; workspacePath?: string } }
  const { entries } = res
  Object.assign(diag, {
    at: new Date().toLocaleTimeString(),
    ws: String(await currentWorkspace()),
    instance: res.instance ? res.instance.id + ' ' + res.instance.workspacePath : '(no instance info)',
    got: entries.length,
    queuedFor: entries.map((e) => e.sessionId),
  })
  listeners.forEach((l) => l())
  let mine = false
  for (const entry of entries) {
    if (entry.sessionId === activeSessionId) mine = true
    const p = processorFor(entry.sessionId)
    const errors = p.processMessagesWithErrors(entry.messages)
    for (const sid of surfaceIdsOf(entry.messages)) locks.delete(lockKey(entry.sessionId, sid))
    cursor = entry.seq
    await call('a2ui-panel.sack', { seq: entry.seq, errors })
    listeners.forEach((l) => l())
  }
  if (mine) onShown()
}

function startViewer(c: Call) {
  call ??= c
  if (viewers++ === 0) {
    let busy = false
    timer = setInterval(() => {
      if (busy) return
      busy = true
      tick()
        .then(() => { if (lastError) { lastError = null; listeners.forEach((l) => l()) } })
        .catch((e) => { const m = String(e); if (m !== lastError) { lastError = m; listeners.forEach((l) => l()) } })
        .finally(() => { busy = false })
    }, POLL_MS)
  }
  return () => {
    if (--viewers === 0 && timer) { clearInterval(timer); timer = null }
  }
}

function useActive() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return activeSessionId ? processorFor(activeSessionId) : null
}

export function ActiveSessionView({ call: c, Surfaces }: { call: Call; Surfaces: (p: { processor: MessageProcessor; empty: string; locked?: (surfaceId: string) => boolean }) => JSX.Element }) {
  useEffect(() => startViewer(c), [c])
  const processor = useActive()
  return (
    <ErrorBoundary>
      {lastError && <pre className="a2ui-panel__error">{lastError}</pre>}
      {processor
        ? <Surfaces key={activeSessionId} processor={processor} locked={(sid) => isLocked(activeSessionId, sid)} empty="이 세션은 아직 A2UI 화면을 보내지 않았어요." />
        : <div className="a2ui-panel__empty">에이전트 세션을 열면 그 세션의 A2UI 화면이 보여요.</div>}
      {(diagOpen || lastError) && <pre className="a2ui-panel__diag">{[
        'poll ' + (diag.at || '아직 없음') + ' · 받은 ' + diag.got + '건' + (diag.queuedFor.length ? ' (세션 ' + diag.queuedFor.join(', ') + ')' : ''),
        '활성 세션 ' + (activeSessionId ?? '없음') + ' · 화면 있는 세션 ' + ([...processors.keys()].join(', ') || '없음'),
        '보낸 workspace ' + (diag.ws || '?') + ' · 백엔드 ' + (diag.instance || '?'),
        '모드: ' + modeLabel + ' · 복원: ' + restoreInfo,
        '#root 폭 ' + Math.round(document.getElementById('root')?.getBoundingClientRect().width ?? -1) + ' / 창 ' + window.innerWidth,
      ].join('\n')}</pre>}
    </ErrorBoundary>
  )
}

// Render errors show inside the view; there is no devtools console to read them from.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message + '\n' + (e.stack ?? '') : String(e) } }
  render() { return this.state.error ? <pre className="a2ui-panel__error">{this.state.error}</pre> : this.props.children }
}

// --- One A2UI view, placed left / right (extension overlay) or bottom (host bottom panel). ---
type Place = 'left' | 'right' | 'bottom'
type SurfacesFn = Parameters<typeof ActiveSessionView>[0]['Surfaces']
export const BOTTOM_PANEL_ID = 'com.syacucloud.a2ui-panel.bottom'
const store = {
  get place(): Place { return (localStorage.getItem('a2ui-panel.place') as Place) || 'right' },
  set place(p: Place) { localStorage.setItem('a2ui-panel.place', p) },
  get open() { return localStorage.getItem('a2ui-panel.open') === '1' },
  set open(v: boolean) { localStorage.setItem('a2ui-panel.open', v ? '1' : '0') },
  get width() { return Number(localStorage.getItem('a2ui-panel.width')) || 420 },
  set width(w: number) { localStorage.setItem('a2ui-panel.width', String(w)) },
}
// The host toggles bottom panels on this event; ids other than ours fall through to it.
const toggleBottom = () => window.dispatchEvent(new CustomEvent('nimbalyst:toggle-panel', { detail: { panelId: BOTTOM_PANEL_ID } }))
let moveTo: (p: Place) => void = () => {}
let closeSide: () => void = () => {}
// Gutter button with place left/right: toggle the side view instead of showing the bottom panel.
let toggleSide: () => void = () => {}
let bottomOpen = false

function Header({ place, onClose }: { place: Place; onClose: () => void }) {
  const [, force] = useState(0)
  const btn = (p: Place, label: string, text: string) => (
    <button type="button" className="a2ui-right__close" aria-label={label} aria-pressed={place === p} disabled={place === p} onClick={() => moveTo(p)}>{text}</button>
  )
  return (
    <div className="a2ui-right__header">
      <span>A2UI</span>
      <span>
        {btn('left', '왼쪽으로 옮기기', '◧')}{btn('bottom', '아래로 옮기기', '⬓')}{btn('right', '오른쪽으로 옮기기', '◨')}
        <button type="button" className="a2ui-right__close" aria-label="진단 정보 펼치기" aria-pressed={diagOpen}
          onClick={() => { diagOpen = !diagOpen; force((n) => n + 1); listeners.forEach((l) => l()) }}>ⓘ</button>
        <button type="button" className="a2ui-right__close" aria-label="A2UI 칸 닫기" onClick={onClose}>✕</button>
      </span>
    </div>
  )
}

export function makeBottomPanel(Surfaces: SurfacesFn) {
  return function BottomPanel({ host }: PanelHostProps) {
    // The host opens this panel from its gutter button (or our toggleBottom). Only ◧ ⬓ ◨ change the place.
    const [offMode] = useState(() => !isAgentMode())
    const [redirect] = useState(() => store.place !== 'bottom')
    useEffect(() => {
      if (offMode) { toggleBottom(); return }
      if (redirect) {
        toggleSide()
        toggleBottom() // close this bottom panel again
        return
      }
      bottomOpen = true
      store.open = true
      closeSide()
      return () => {
        bottomOpen = false
        if (store.place === 'bottom' && !unloading && !suspending) store.open = false
        suspending = false
      }
    }, [redirect, offMode])
    if (redirect || offMode) return null
    return (
      <div className="a2ui-panel" style={{ flexDirection: 'column' }}>
        <Header place="bottom" onClose={toggleBottom} />
        <div className="a2ui-panel__surfaces">
          <ActiveSessionView call={host.callBackendTool.bind(host)} Surfaces={Surfaces} />
        </div>
      </div>
    )
  }
}

// Left/right: the host has no renderer for placement "floating", so the extension mounts its own overlay.
// Ctrl+Alt+Shift+A fires the "right" panel's auto-registered toggle; it opens the last chosen place.
export function installSideView(context: ExtensionContext, Surfaces: SurfacesFn) {
  const ai = context.services.ai
  if (!ai) return () => {}
  const c: Call = async (name, args) => ai.callBackendTool(name, args, await currentWorkspace())
  let root: Root | null = null
  let host: HTMLDivElement | null = null
  const close = () => { root?.unmount(); host?.remove(); root = null; host = null }
  closeSide = close
  const userClose = () => { store.open = false; close() }
  const open = (place: 'left' | 'right') => {
    store.open = true
    close()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<ErrorBoundary><SideView key={place} place={place} onClose={userClose} call={c} Surfaces={Surfaces} /></ErrorBoundary>)
  }
  toggleSide = () => { if (root) userClose(); else if (store.place !== 'bottom') open(store.place) }
  moveTo = (p) => {
    store.place = p
    if (p === 'bottom') { close(); if (!bottomOpen) toggleBottom() }
    else { if (bottomOpen) toggleBottom(); open(p) }
  }
  const onToggle = (e: Event) => {
    const id = (e as CustomEvent).detail?.panelId
    if (id !== RIGHT_PANEL_ID) return
    // Capture phase runs before the host's handler, which would treat the id as a bottom panel.
    e.stopImmediatePropagation()
    if (!isAgentMode()) return // the view only exists in Agent mode
    const place = store.place
    if (place === 'bottom' || bottomOpen) toggleBottom()
    else if (root) userClose()
    else open(place)
  }
  window.addEventListener('nimbalyst:toggle-panel', onToggle, true)
  onShown = () => {
    if (!isAgentMode()) return
    if (store.place === 'bottom') { if (!bottomOpen) toggleBottom() }
    else if (!root) open(store.place)
  }
  onSent = () => { if (bottomOpen) toggleBottom(); else if (root) userClose() }
  const stopPoll = startViewer(c) // keep polling while closed, so new screens can open the view
  // Show the saved view in Agent mode only. Restart restore is the first Agent-mode check.
  const saved = 'open=' + localStorage.getItem('a2ui-panel.open') + ', place=' + localStorage.getItem('a2ui-panel.place')
  restoreInfo = '저장값 ' + saved + ', 결과 화면 준비 기다리는 중'
  let last: boolean | null = null
  const apply = () => {
    const agent = isAgentMode()
    modeLabel = agent ? 'agent' : '기타'
    if (agent === last) return
    const first = last === null
    last = agent
    let result: string
    if (!agent) {
      if (root) close()
      if (bottomOpen) { suspending = true; toggleBottom() }
      result = 'Agent 모드가 아니라 숨김'
    } else if (!store.open) result = '닫혀 있던 상태라 열지 않음'
    else if (store.place === 'bottom') { if (!bottomOpen) toggleBottom(); result = '아래 칸 열기 요청(nimbalyst:toggle-panel)' }
    else { if (!root) open(store.place); result = store.place + ' 칸 열기' }
    if (first || agent) restoreInfo = '저장값 ' + saved + ', 결과 ' + result
    listeners.forEach((l) => l())
  }
  let scheduled = false
  const mo = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => { scheduled = false; apply() })
  })
  // Wait until the host app has rendered its gutter (its toggle listener and layout exist by then).
  const ready = setInterval(() => {
    if (!document.getElementById('root')?.firstElementChild || !document.querySelector('[data-gutter-item]')) return
    clearInterval(ready)
    apply()
    mo.observe(document.getElementById('root')!, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  }, 200)
  return () => { stopPoll(); onShown = onSent = () => {}; clearInterval(ready); mo.disconnect(); window.removeEventListener('nimbalyst:toggle-panel', onToggle, true); close() }
}

// The narrow left column that holds the gutter buttons.
function findGutter() {
  let el = document.querySelector<HTMLElement>('[data-gutter-item]')
  while (el?.parentElement && el.parentElement.getBoundingClientRect().width < 120) el = el.parentElement
  return el
}

// Agent mode's session list (.session-history). Climb to the outermost ancestor with the same left edge and width,
// so the header above the list is covered too.
function findSidebar() {
  let el = document.querySelector<HTMLElement>('.session-history')
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 50 || r.height < 50) return null
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const q = p.getBoundingClientRect()
    if (Math.abs(q.left - r.left) > 2 || Math.abs(q.width - r.width) > 2) break
    el = p
  }
  return el
}

type Box = { left: number; top: number; width: number; height: number }
function measureSidebar(): Box | null {
  const el = findSidebar()
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function useSidebarBox(enabled: boolean, frame: { current: HTMLElement | null }) {
  const [box, setBox] = useState<Box | null>(() => (enabled ? measureSidebar() : null))
  useEffect(() => {
    if (!enabled) return
    let el: HTMLElement | null = null
    const measure = () => {
      if (!el) return setBox(null)
      const r = el.getBoundingClientRect()
      setBox((b) => b && b.left === r.left && b.top === r.top && b.width === r.width && b.height === r.height ? b : { left: r.left, top: r.top, width: r.width, height: r.height })
    }
    const ro = new ResizeObserver(measure)
    const setHidden = (h: boolean) => { if (frame.current) frame.current.style.visibility = h ? 'hidden' : '' }
    const find = () => {
      const next = findSidebar()
      if (next === el) return measure()
      setHidden(true) // the sidebar was swapped (mode switch): hide until the new box is applied
      ro.disconnect(); el = next; if (el) ro.observe(el)
      measure()
      requestAnimationFrame(() => requestAnimationFrame(() => setHidden(false)))
    }
    find()
    let scheduled = false
    const mo = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => { scheduled = false; find() })
    })
    mo.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', measure)
    return () => { mo.disconnect(); ro.disconnect(); setHidden(false); window.removeEventListener('resize', measure) }
  }, [enabled])
  return box
}

function SideView({ place, onClose, call: c, Surfaces }: { place: 'left' | 'right'; onClose: () => void; call: Call; Surfaces: SurfacesFn }) {
  const [width, setWidth] = useState(store.width)
  const [left, setLeft] = useState(0)
  const drag = useRef(false)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const sidebar = useSidebarBox(place === 'left', frameRef)
  const cover = place === 'left' && sidebar !== null
  useEffect(() => {
    store.width = width
    if (cover) return // covering the existing split takes no extra space
    if (place === 'left') {
      // Push the content right of the gutter; the gutter column stays put.
      const gutter = findGutter()
      if (!gutter) return
      setLeft(gutter.getBoundingClientRect().right)
      const prev = gutter.style.marginRight
      gutter.style.marginRight = width + 'px'
      return () => { gutter.style.marginRight = prev }
    }
    const app = document.getElementById('root')
    if (!app) return
    // transform makes #root the containing block of its position: fixed children, so they shrink too.
    const prev = [app.style.width, app.style.transform]
    app.style.width = 'calc(100% - ' + width + 'px)'
    app.style.transform = 'translateZ(0)'
    return () => { [app.style.width, app.style.transform] = prev }
  }, [width, place, cover])
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return
      const w = place === 'right' ? window.innerWidth - e.clientX : e.clientX - left
      setWidth(Math.min(Math.max(w, 240), window.innerWidth - 300))
    }
    const up = () => { drag.current = false; document.body.style.userSelect = '' }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [place, left])
  const handle = (
    <div className="a2ui-right__handle" role="separator" aria-orientation="vertical" aria-label="A2UI 칸 폭 조절"
      onMouseDown={() => { drag.current = true; document.body.style.userSelect = 'none' }} />
  )
  return (
    <div ref={frameRef} className={'a2ui-right__frame a2ui-panel a2ui-side--' + place}
      style={cover ? { ...sidebar, right: 'auto', bottom: 'auto', boxShadow: 'none' } : place === 'left' ? { width, left, right: 'auto' } : { width }}>
      {place === 'right' && handle}
      <div className="a2ui-right__body">
        <Header place={place} onClose={onClose} />
        <div className="a2ui-panel__surfaces">
          <ActiveSessionView call={c} Surfaces={Surfaces} />
        </div>
      </div>
      {place === 'left' && !cover && handle}
    </div>
  )
}
