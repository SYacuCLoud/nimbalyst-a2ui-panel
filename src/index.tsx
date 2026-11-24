import { useEffect, useState } from 'react'
import type { EditorContextItem, EditorHostProps } from '@nimbalyst/extension-sdk'
import { MessageProcessor } from '@a2ui/web_core'
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1'
import { A2uiSurface, MarkdownContext } from '@a2ui/react'
import { renderMarkdown } from '@a2ui/markdown-it'
import './styles.css'
import type { ExtensionContext } from '@nimbalyst/extension-sdk'
import { installSideView, makeBottomPanel } from './sessionViews'

export function Surfaces({ processor, empty, locked }: { processor: MessageProcessor; empty: string; locked?: (surfaceId: string) => boolean }) {
  const list = () => Array.from(processor.model.surfacesMap.values())
  const [surfaces, setSurfaces] = useState(list)
  useEffect(() => {
    const sync = () => setSurfaces(list())
    sync()
    const subs = [processor.onSurfaceCreated(sync), processor.onSurfaceDeleted(sync)]
    return () => subs.forEach((s) => s.unsubscribe())
  }, [processor])
  return (
    <MarkdownContext.Provider value={renderMarkdown}>
      {surfaces.length === 0 && <div className="a2ui-panel__empty">{empty}</div>}
      {surfaces.map((surface) => {
        const busy = locked?.(surface.id) ?? false
        return (
          <div key={surface.id} className={busy ? 'a2ui-locked' : undefined} aria-busy={busy}>
            {busy && <div className="a2ui-locked__label" role="status">보내는 중이에요. 에이전트가 답하면 다시 누를 수 있어요.</div>}
            <fieldset disabled={busy} className="a2ui-surface-fieldset"><A2uiSurface surface={surface as never} /></fieldset>
          </div>
        )
      })}
    </MarkdownContext.Provider>
  )
}

// Accepts a JSON array of messages or JSONL (one message per line).
function parseMessages(text: string): unknown[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) return JSON.parse(trimmed)
  return trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
}

function A2uiFileEditor({ host }: EditorHostProps) {
  const [state, setState] = useState<{ processor: MessageProcessor; errors: unknown[] } | null>(null)

  useEffect(() => {
    const actions: EditorContextItem[] = []
    let current: MessageProcessor | null = null
    const render = (text: string) => {
      current?.dispose()
      actions.length = 0
      host.setEditorContextItems?.(null)
      const p: MessageProcessor = new MessageProcessor([basicCatalog], (action) => {
        const dataModel = p.model.getSurface(action.surfaceId)?.dataModel.get('/')
        actions.push({
          id: `${action.surfaceId}:${action.sourceComponentId}:${action.timestamp}`,
          label: `A2UI: ${action.name}`,
          icon: 'touch_app',
          description: `A2UI action from ${host.filePath}\naction: ${JSON.stringify(action)}\ndataModel: ${JSON.stringify(dataModel)}`,
        })
        host.setEditorContextItems?.([...actions])
      }, { version: 'v1.0' })
      current = p
      let errors: unknown[]
      try {
        errors = p.processMessagesWithErrors(parseMessages(text))
      } catch (e) {
        errors = [{ version: '1.0', error: { code: 'VALIDATION_FAILED', path: '/', message: `Invalid JSON: ${String(e)}` } }]
      }
      setState({ processor: p, errors })
    }
    host.loadContent().then(render)
    const unsub = host.onFileChanged(render)
    return () => { unsub(); current?.dispose(); host.setEditorContextItems?.(null) }
  }, [host])

  if (!state) return null
  return (
    <div className="a2ui-panel a2ui-panel__surfaces">
      {state.errors.map((e, i) => <pre key={i} className="a2ui-panel__error">{JSON.stringify(e)}</pre>)}
      <Surfaces processor={state.processor} empty="A2UI v1.0 메시지가 없어요." />
    </div>
  )
}

let uninstallRight: (() => void) | null = null
export function activate(context: ExtensionContext) { uninstallRight = installSideView(context, Surfaces) }
export function deactivate() { uninstallRight?.(); uninstallRight = null }

export const panels = {
  bottom: { component: makeBottomPanel(Surfaces) },
  right: { component: () => null }, // rendered by installSideView
}
export const components = { A2uiFileEditor }
