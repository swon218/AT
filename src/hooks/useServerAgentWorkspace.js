import { useEffect, useRef, useState } from 'react'
import { emptyAgentWorkspace, readAgentWorkspace } from '../utils/agentWorkspace'
import { agentApi, agentErrors } from '../services/agentApi'

const freshRoom = () => ({ id: 'new', title: '새 대화', messages: [], requests: [], draft: '', updatedAt: new Date().toISOString() })
function initial(owner, userId) {
  let settings = {}, legacy = []
  try { settings = JSON.parse(localStorage.getItem(`atlas.agent.serverui.v1:${owner}`) || '{}') } catch { /* Display settings only. */ }
  try { legacy = readAgentWorkspace(localStorage, userId).conversations.filter(c => c.messages.length) } catch { /* Old records remain untouched. */ }
  return { owner, rooms: [freshRoom()], activeId: 'new', drafts: settings.drafts || {}, pending: settings.pending || null,
    preferredId: settings.activeId, ui: { ...emptyAgentWorkspace().ui, ...settings.ui }, legacy,
    status: null, error: '', steps: [], busy: false, hasMore: false }
}
export default function useServerAgentWorkspace(userId, authReady, apiClient = agentApi) {
  const owner = authReady ? userId || 'guest' : null
  const [state, setState] = useState(() => initial(owner, userId))
  const sending = useRef(false), scope = useRef(owner), observed = useRef({})
  let current = state
  if (current.owner !== owner) {
    scope.current = owner; sending.current = false; observed.current = {}
    current = initial(owner, userId); setState(current)
  }
  const update = patch => setState(previous => previous.owner === owner && scope.current === owner ? { ...previous, ...(typeof patch === 'function' ? patch(previous) : patch) } : previous)
  const api = (path, options = {}) => apiClient(path, { userId, ...options })
  const fail = exc => { if (exc.name !== 'AbortError') update({ error: exc.message }) }
  const room = current.rooms.find(r => r.id === current.activeId) || current.rooms[0]
  const refresh = async (id, before) => {
    if (id === 'new') return
    const result = await api(`/rooms/${id}/messages${before ? `?before=${before}` : ''}`)
    const messages = result.messages.map(m => ({ ...m, id: String(m.id), createdAt: m.created_at }))
    update(previous => ({ error: previous.error.startsWith('AI 서버에 연결하지 못했습니다.') ? '' : previous.error, rooms: previous.rooms.map(r => r.id === id ? { ...r, question_count: result.question_count, title: result.room?.title || r.title, updatedAt: result.room?.updated_at || r.updatedAt,
      messages: before ? [...messages, ...r.messages.filter(m => !messages.some(n => n.id === m.id))] : [...r.messages.filter(m => messages.length && BigInt(m.id) < BigInt(messages[0].id)), ...messages],
      requests: result.requests } : r), ...(previous.activeId === id ? { hasMore: before ? messages.length === 50 : previous.hasMore || messages.length === 50,
      busy: sending.current || result.requests.some(r => r.status === 'running') } : {}) }))
    return result
  }
  useEffect(() => {
    if (!owner) return
    let disposed = false
    void (async () => {
      try {
        const status = await api('/status')
        if (disposed) return
        update({ status })
        const result = await api('/rooms')
        if (disposed) return
        const rooms = result.rooms.map(r => ({ ...r, messages: [], requests: [], updatedAt: r.updated_at }))
        const activeId = rooms.some(r => r.id === current.preferredId) ? current.preferredId : rooms[0]?.id || 'new'
        update({ rooms: rooms.length ? rooms : [freshRoom()], activeId, error: '' })
        await refresh(activeId)
      } catch (exc) { if (!disposed) fail(exc) }
    })()
    return () => { disposed = true }
  }, [owner])
  useEffect(() => {
    if (!owner || current.owner !== owner) return
    try { localStorage.setItem(`atlas.agent.serverui.v1:${owner}`, JSON.stringify({ ui: current.ui, drafts: current.drafts, activeId: current.activeId, pending: current.pending })) } catch { /* Server history is independent. */ }
  }, [owner, current.ui, current.drafts, current.activeId, current.pending])
  useEffect(() => {
    if (!owner || room.id === 'new') return
    let disposed = false, timer
    const poll = async () => {
      try {
        const result = await refresh(room.id)
        const request = result?.requests.at(-1)
        if (request && !disposed && (request.status === 'running' || observed.current[request.id] !== request.status)) {
          const progress = await api(`/requests/${request.id}`)
          if (!disposed) update({ steps: progress.steps || [] })
          if (request.status !== 'running' && !disposed) {
            const status = await api('/status')
            if (!disposed) { observed.current[request.id] = request.status; update({ status }) }
          }
        }
        if (!disposed && request?.status === 'failed') {
          update({ error: agentErrors[request.error_code] || `처리 실패: ${request.error_code}` })
        }
      } catch (exc) { if (!disposed) fail(exc) }
      if (!disposed) timer = setTimeout(poll, 1500)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [owner, room.id])
  const newConversation = () => {
    if (sending.current) return false
    update(previous => ({ rooms: [freshRoom(), ...previous.rooms.filter(r => r.id !== 'new')], activeId: 'new', steps: [], error: '', busy: false }))
    return true
  }
  const submit = () => {
    const question = String(current.drafts[room.id] || '').trim()
    if (!question || sending.current || current.busy || !owner) return false
    sending.current = true
    const requestId = current.pending?.question === question && current.pending?.roomId === room.id ? current.pending.requestId : crypto.randomUUID()
    update({ busy: true, error: '', steps: [] })
    void (async () => {
      let roomId = room.id
      try {
        if (roomId === 'new') {
          const created = await api('/rooms', { method: 'POST', body: {} })
          roomId = created.id
          update(previous => ({ rooms: [{ ...created, messages: [], requests: [], updatedAt: created.updated_at }, ...previous.rooms.filter(r => r.id !== 'new')], activeId: roomId,
            drafts: { ...previous.drafts, [roomId]: question, new: '' } }))
        }
        const pending = { requestId, roomId, question }
        if (scope.current !== owner) return
        // Persist before POST: an uncertain response can be retried with the same ID after refresh.
        try { localStorage.setItem(`atlas.agent.serverui.v1:${owner}`, JSON.stringify({ ui: current.ui, drafts: { ...current.drafts, [roomId]: question }, activeId: roomId, pending })) } catch { /* In-memory fallback. */ }
        update({ pending })
        await api(`/rooms/${roomId}/requests`, { method: 'POST', body: { request_id: requestId, question } })
        update(previous => ({ pending: null, drafts: { ...previous.drafts, [roomId]: '' } }))
        await refresh(roomId)
      } catch (exc) { fail(exc); update({ busy: false }) }
      finally { if (scope.current === owner) sending.current = false }
    })()
    return true
  }
  return {
    ready: Boolean(owner), error: current.error, busy: current.busy, status: current.status,
    legacy: current.legacy, steps: current.steps, hasMore: current.hasMore,
    data: { ui: current.ui, activeId: room.id, conversations: current.rooms },
    active: { ...room, draft: String(current.drafts[room.id] || '') },
    setDraft: value => update(previous => ({ drafts: { ...previous.drafts, [room.id]: value.slice(0, 6000) } })),
    submit, newConversation,
    select: id => update({ activeId: id, steps: [], error: '', busy: false }),
    loadMore: () => refresh(room.id, room.messages[0]?.id).catch(fail),
    rename: title => { void api(`/rooms/${room.id}`, { method: 'PUT', body: { title } }).then(result => update(previous => ({ rooms: previous.rooms.map(r => r.id === room.id ? { ...r, title: result.title } : r) }))).catch(fail) },
    remove: id => { if (id === 'new') { newConversation(); return } void api(`/rooms/${id}`, { method: 'DELETE' }).then(() => {
      update(previous => { const rooms = previous.rooms.filter(r => r.id !== id); return { rooms: rooms.length ? rooms : [freshRoom()], activeId: previous.activeId === id ? rooms[0]?.id || 'new' : previous.activeId, busy: false, steps: [] } })
    }).catch(fail) },
    setUI: patch => update(previous => ({ ui: { ...previous.ui, ...patch } })),
  }
}
