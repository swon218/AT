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
    status: null, error: '', steps: [], busy: false, hasMore: false, confirmations: {} }
}

function updateConfirmation(message, confirmation, draft) {
  const old = message.answer?.watchlistConfirmation?.status
  if (!confirmation || (old !== 'pending' && confirmation.status === 'pending')
    || (old === 'ready' && confirmation.status === 'added')) return message
  return { ...message, answer: { ...message.answer, watchlistConfirmation: confirmation, ...(draft ? { alertDraft: draft } : {}) } }
}

export default function useServerAgentWorkspace(userId, authReady, apiClient = agentApi, alertFlow = {}) {
  const owner = authReady ? userId || 'guest' : null
  const [state, setState] = useState(() => initial(owner, userId))
  const sending = useRef(false), scope = useRef(owner), observed = useRef({})
  const activeRoom = useRef('new'), alertRequests = useRef(new Map()), alertHandlers = useRef(alertFlow)
  const confirmationScope = useRef({ owner, running: new Set() })
  if (confirmationScope.current.owner !== owner) confirmationScope.current = { owner, running: new Set() }
  alertHandlers.current = alertFlow
  let current = state
  if (current.owner !== owner) {
    scope.current = owner; sending.current = false; observed.current = {}; alertRequests.current.clear()
    current = initial(owner, userId); setState(current)
  }
  const update = patch => setState(previous => previous.owner === owner && scope.current === owner ? { ...previous, ...(typeof patch === 'function' ? patch(previous) : patch) } : previous)
  const api = (path, options = {}) => apiClient(path, { userId, ...options })
  const fail = exc => { if (exc.name !== 'AbortError') update({ error: exc.message }) }
  const room = current.rooms.find(r => r.id === current.activeId) || current.rooms[0]
  activeRoom.current = room.id
  const refresh = async (id, before) => {
    if (id === 'new') return
    const result = await api(`/rooms/${id}/messages${before ? `?before=${before}` : ''}`)
    const messages = result.messages.map(m => ({ ...m, id: String(m.id), createdAt: m.created_at }))
    if (!before && scope.current === owner) {
      for (const message of messages) {
        const draft = message.answer?.alertDraft
        if (message.role === 'assistant' && alertRequests.current.get(message.request_id) === id) {
          alertRequests.current.delete(message.request_id)
          if (activeRoom.current === id && draft?.requestId === message.request_id) alertHandlers.current.onDraft?.(id, draft)
        }
      }
      for (const request of result.requests) if (request.status === 'failed') alertRequests.current.delete(request.id)
    }
    update(previous => ({ error: previous.error.startsWith('AI 서버에 연결하지 못했습니다.') ? '' : previous.error, rooms: previous.rooms.map(r => {
      if (r.id !== id) return r
      const oldMessages = new Map(r.messages.map(message => [message.id, message]))
      const incoming = messages.map(message => {
        const old = oldMessages.get(message.id)
        if (!old?.answer?.watchlistConfirmation || !message.answer?.watchlistConfirmation) return message
        return updateConfirmation(old, message.answer.watchlistConfirmation, message.answer.alertDraft)
      })
      return { ...r, question_count: result.question_count, title: result.room?.title || r.title, updatedAt: result.room?.updated_at || r.updatedAt,
        messages: before ? [...incoming, ...r.messages.filter(m => !messages.some(n => n.id === m.id))]
          : [...r.messages.filter(m => messages.length && BigInt(m.id) < BigInt(messages[0].id)), ...incoming], requests: result.requests }
    }), ...(previous.activeId === id ? { hasMore: before ? messages.length === 50 : previous.hasMore || messages.length === 50,
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
    activeRoom.current = 'new'
    update(previous => ({ rooms: [freshRoom(), ...previous.rooms.filter(r => r.id !== 'new')], activeId: 'new', steps: [], error: '', busy: false }))
    return true
  }
  const submit = () => {
    const question = String(current.drafts[room.id] || '').trim()
    if (!question || sending.current || current.busy || !owner) return false
    sending.current = true
    const requestId = current.pending?.question === question && current.pending?.roomId === room.id ? current.pending.requestId : crypto.randomUUID()
    const editor = userId && current.status?.alert_tools ? alertHandlers.current.editor?.(room.id) : null
    update({ busy: true, error: '', steps: [] })
    void (async () => {
      let roomId = room.id
      try {
        if (roomId === 'new') {
          const created = await api('/rooms', { method: 'POST', body: {} })
          roomId = created.id
          if (scope.current === owner) {
            activeRoom.current = roomId
            alertHandlers.current.onRoomCreated?.('new', roomId)
          }
          update(previous => ({ rooms: [{ ...created, messages: [], requests: [], updatedAt: created.updated_at }, ...previous.rooms.filter(r => r.id !== 'new')], activeId: roomId,
            drafts: { ...previous.drafts, [roomId]: question, new: '' } }))
        }
        const pending = { requestId, roomId, question }
        if (scope.current !== owner) return
        // Persist before POST: an uncertain response can be retried with the same ID after refresh.
        try { localStorage.setItem(`atlas.agent.serverui.v1:${owner}`, JSON.stringify({ ui: current.ui, drafts: { ...current.drafts, [roomId]: question }, activeId: roomId, pending })) } catch { /* In-memory fallback. */ }
        update({ pending })
        if (editor) {
          if (alertRequests.current.size >= 32) alertRequests.current.delete(alertRequests.current.keys().next().value)
          alertRequests.current.set(requestId, roomId)
        }
        await api(`/rooms/${roomId}/requests`, { method: 'POST', body: { request_id: requestId, question,
          ...(editor ? { alert_editor: editor } : {}) } })
        update(previous => ({ pending: null, drafts: { ...previous.drafts, [roomId]: '' } }))
        await refresh(roomId)
      } catch (exc) { fail(exc); update({ busy: false }) }
      finally { if (scope.current === owner) sending.current = false }
    })()
    return true
  }

  async function respondToWatchlist(message, decision) {
    const id = room.id, requestId = message.request_id
    const job = confirmationScope.current
    if (!userId || id === 'new' || job.running.has(requestId)) return
    const feedback = changes => update(previous => ({ confirmations: { ...previous.confirmations, [requestId]: changes } }))
    const accept = ({ confirmation, draft }) => update(previous => ({ rooms: previous.rooms.map(r => r.id !== id ? r : {
      ...r, messages: r.messages.map(item => item.request_id === requestId && item.role === 'assistant'
        ? updateConfirmation(item, confirmation, draft) : item),
    }) }))
    const call = choice => api(`/rooms/${id}/requests/${requestId}/watchlist-confirmation`, { method: 'POST', body: {
      decision: choice, revision: alertHandlers.current.editor?.(id)?.revision ?? null,
    } })
    job.running.add(requestId)
    feedback({ busy: true })
    let phase = decision
    try {
      let result = await call(decision)
      if (confirmationScope.current !== job) return
      accept(result)
      if (result.confirmation.addition) await alertHandlers.current.onWatchlistAdded?.()
      if (confirmationScope.current !== job) return
      if (decision === 'yes' && ['added', 'ready'].includes(result.confirmation.status)) {
        phase = 'draft'
        result = await call('draft')
        if (confirmationScope.current !== job) return
        accept(result)
      }
      if (decision !== 'no' && result.draft && activeRoom.current === id
        && alertHandlers.current.onDraft?.(id, result.draft) === false) {
        feedback({ error: agentErrors.confirmation_outdated })
      } else feedback({})
    } catch (exc) {
      if (confirmationScope.current !== job) return
      const error = exc.code ? exc.message : phase === 'draft' ? '알림 초안을 불러오지 못했습니다. 다시 시도해 주세요.'
        : '선택 결과를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      feedback({ error })
    } finally { job.running.delete(requestId) }
  }

  return {
    ready: Boolean(owner), error: current.error, busy: current.busy, status: current.status,
    legacy: current.legacy, steps: current.steps, hasMore: current.hasMore,
    data: { ui: current.ui, activeId: room.id, conversations: current.rooms },
    active: { ...room, draft: String(current.drafts[room.id] || '') },
    setDraft: value => update(previous => ({ drafts: { ...previous.drafts, [room.id]: value.slice(0, 6000) } })),
    submit, newConversation, respondToWatchlist, confirmations: current.confirmations,
    confirmationRevision: userId ? alertFlow.editor?.(room.id)?.revision ?? null : null,
    select: id => { activeRoom.current = id; update({ activeId: id, steps: [], error: '', busy: false }) },
    loadMore: () => refresh(room.id, room.messages[0]?.id).catch(fail),
    rename: title => { void api(`/rooms/${room.id}`, { method: 'PUT', body: { title } }).then(result => update(previous => ({ rooms: previous.rooms.map(r => r.id === room.id ? { ...r, title: result.title } : r) }))).catch(fail) },
    remove: id => { if (id === 'new') { newConversation(); return } void api(`/rooms/${id}`, { method: 'DELETE' }).then(() => {
      update(previous => { const rooms = previous.rooms.filter(r => r.id !== id); return { rooms: rooms.length ? rooms : [freshRoom()], activeId: previous.activeId === id ? rooms[0]?.id || 'new' : previous.activeId, busy: false, steps: [] } })
    }).catch(fail) },
    setUI: patch => update(previous => ({ ui: { ...previous.ui, ...patch } })),
  }
}
