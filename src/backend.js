const ACK_TIMEOUT_MS = 5000
const CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json'
const MESSAGES_SCHEMA = {
  type: 'object',
  properties: { messages: { type: 'array', items: { type: 'object' }, description: 'A2UI v1.0 messages' } },
  required: ['messages']
}

// A queue the renderer drains with spull/sack. The tool call waits briefly for the renderer's validation result.
function makeQueue() {
  let seq = 0
  const entries = []
  const waiters = new Map()
  return {
    async push(fields) {
      const entry = { seq: ++seq, ...fields }
      entries.push(entry)
      const errors = await new Promise((resolve) => {
        waiters.set(entry.seq, resolve)
        setTimeout(() => resolve(null), ACK_TIMEOUT_MS)
      })
      waiters.delete(entry.seq)
      if (errors === null) return { ok: true, note: 'Queued. No A2UI view is open; it renders when the user opens one.', instance: fields.instance }
      return errors.length ? { ok: false, errors } : { ok: true }
    },
    pull: (after = 0) => ({ entries: entries.filter((e) => e.seq > after) }),
    ack(done, errors = []) {
      const i = entries.findIndex((e) => e.seq === done)
      if (i >= 0) entries.splice(i, 1)
      waiters.get(done)?.(errors)
      return { ok: true }
    }
  }
}

function checkMessages(messages) {
  if (Array.isArray(messages) && messages.length > 0) return null
  return { ok: false, errors: [{ version: '1.0', error: { code: 'VALIDATION_FAILED', path: '/messages', message: 'messages must be a non-empty array of A2UI v1.0 messages' } }] }
}

export async function activate(ctx) {
  const { registerMcpTools } = ctx.services
  const instance = { id: Math.random().toString(36).slice(2, 8), workspacePath: ctx.services.workspacePath }
  const shown = makeQueue() // a2ui-panel.show from any session, keyed by calling session

  await registerMcpTools([
    {
      name: 'show',
      description: `Show UI to the user in the A2UI view (left / right / bottom) for this session. messages is an array of A2UI v1.0 messages: createSurface (catalogId "${CATALOG_ID}"), updateComponents, updateDataModel, deleteSurface. Keep the surface and update it with the same surfaceId. Example: [{"version":"1.0","createSurface":{"surfaceId":"s1","catalogId":"${CATALOG_ID}"}},{"version":"1.0","updateComponents":{"surfaceId":"s1","components":[{"id":"root","component":"Column","children":["t","b"]},{"id":"t","component":"Text","text":{"@path":"/msg"}},{"id":"bt","component":"Text","text":"OK"},{"id":"b","component":"Button","child":"bt","action":{"event":{"name":"ok"}}}]}},{"version":"1.0","updateDataModel":{"surfaceId":"s1","path":"/","value":{"msg":"Hi"}}}]. Returns at once. A button press arrives later as a new chat message {"version":"1.0","action":{...},"metadata":{"a2uiRendererDataModel":...}}. Invalid messages come back as A2UI error messages; fix and resend. Text variant is only "caption" or "body" (no h1-h6). Sending createSurface again for an existing surfaceId fails with INTEGRITY_ERROR; change an existing surface with updateComponents / updateDataModel instead.`,
      inputSchema: MESSAGES_SCHEMA,
      scope: 'global',
      audience: 'all'
    },
    ...['spull', 'sack'].map((name) => ({ name, inputSchema: { type: 'object' }, scope: 'global', panelOnly: true }))
  ])

  const panelOnly = (fn) => async (params, methodCtx) => {
    if (methodCtx?.call?.caller === 'agent') throw new Error('panel only')
    return fn(params ?? {})
  }

  return {
    methods: {
      async show(params, methodCtx) {
        const sessionId = methodCtx?.call?.sessionId
        if (!sessionId) return { ok: false, errors: [{ version: '1.0', error: { code: 'VALIDATION_FAILED', path: '/', message: 'a2ui-panel.show must be called from an agent session' } }] }
        return checkMessages(params?.messages) ?? shown.push({ sessionId, messages: params.messages, instance })
      },
      spull: panelOnly(({ after }) => ({ ...shown.pull(after), instance })),
      sack: panelOnly(({ seq, errors }) => shown.ack(seq, errors))
    }
  }
}
