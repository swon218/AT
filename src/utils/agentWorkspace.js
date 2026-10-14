// Browser-only conversation storage. No model, brokerage or network calls.
export const MAX_CONVERSATIONS = 50
export const MAX_MESSAGES = 100
export const MAX_QUESTION_LENGTH = 6000
const VERSION = 1
const clamp = value => Math.min(1, Math.max(0, value))
const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const timestamp = () => new Date().toISOString()

export const agentStorageKey = userId => `atlas.agent.workspace.v1:${userId ? `user:${encodeURIComponent(userId)}` : 'guest'}`

function newConversation() {
  return { id: id(), title: '새 대화', createdAt: timestamp(), updatedAt: timestamp(), draft: '', messages: [] }
}

export function emptyAgentWorkspace() {
  const conversation = newConversation()
  return {
    version: VERSION, activeId: conversation.id, conversations: [conversation],
    ui: { robotVisible: true, miniOpen: false, position: { x: 1, y: 1 } },
  }
}

export function decodeAgentWorkspace(raw) {
  const value = JSON.parse(raw)
  const validDate = date => typeof date === 'string' && Number.isFinite(Date.parse(date))
  if (!value || value.version !== VERSION || !Array.isArray(value.conversations)
    || !value.conversations.length || value.conversations.length > MAX_CONVERSATIONS) throw new Error('Invalid workspace')
  const ids = new Set()
  const conversations = value.conversations.map(conversation => {
    if (!conversation || typeof conversation.id !== 'string' || !conversation.id || ids.has(conversation.id)
      || typeof conversation.title !== 'string' || conversation.title.length > 80
      || !validDate(conversation.createdAt) || !validDate(conversation.updatedAt)
      || typeof conversation.draft !== 'string' || conversation.draft.length > MAX_QUESTION_LENGTH
      || !Array.isArray(conversation.messages) || conversation.messages.length > MAX_MESSAGES) throw new Error('Invalid conversation')
    ids.add(conversation.id)
    const messageIds = new Set()
    const messages = conversation.messages.map(message => {
      if (!message || typeof message.id !== 'string' || !message.id || messageIds.has(message.id)
        || message.role !== 'user' || typeof message.content !== 'string' || !message.content.trim()
        || message.content.length > MAX_QUESTION_LENGTH || !validDate(message.createdAt)) throw new Error('Invalid message')
      messageIds.add(message.id)
      return { id: message.id, role: 'user', content: message.content, createdAt: message.createdAt }
    })
    return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt, draft: conversation.draft, messages }
  })
  const position = value.ui?.position
  return {
    version: VERSION, conversations, activeId: ids.has(value.activeId) ? value.activeId : conversations[0].id,
    ui: { robotVisible: value.ui?.robotVisible !== false, miniOpen: value.ui?.miniOpen === true,
      position: { x: Number.isFinite(position?.x) ? clamp(position.x) : 1, y: Number.isFinite(position?.y) ? clamp(position.y) : 1 } },
  }
}

export function readAgentWorkspace(storage, userId) {
  const raw = storage.getItem(agentStorageKey(userId))
  return raw ? decodeAgentWorkspace(raw) : emptyAgentWorkspace()
}

export function saveAgentWorkspace(storage, userId, data) {
  storage.setItem(agentStorageKey(userId), JSON.stringify(data))
}

export function changeAgentWorkspace(data, action) {
  const active = data.conversations.find(conversation => conversation.id === data.activeId)
  const updateActive = patch => ({ ...data, conversations: data.conversations.map(conversation => conversation.id === active.id ? { ...conversation, ...patch } : conversation) })
  switch (action.type) {
    case 'draft':
      return updateActive({ draft: action.value.slice(0, MAX_QUESTION_LENGTH) })
    case 'submit': {
      const content = active.draft.trim()
      if (!content) return data
      if (active.messages.length >= MAX_MESSAGES) throw new Error('이 대화에는 질문을 100개까지 보관할 수 있습니다. 새 대화를 시작해 주세요.')
      const now = timestamp()
      return updateActive({ draft: '', title: active.messages.length ? active.title : content.replace(/\s+/g, ' ').slice(0, 40),
        updatedAt: now, messages: [...active.messages, { id: id(), role: 'user', content, createdAt: now }] })
    }
    case 'new': {
      if (!active.messages.length && !active.draft) return data
      if (data.conversations.length >= MAX_CONVERSATIONS) throw new Error('대화는 50개까지 보관할 수 있습니다. 필요 없는 대화를 삭제한 뒤 시작해 주세요.')
      const conversation = newConversation()
      return { ...data, activeId: conversation.id, conversations: [conversation, ...data.conversations] }
    }
    case 'select':
      return data.conversations.some(conversation => conversation.id === action.id) ? { ...data, activeId: action.id } : data
    case 'delete': {
      const conversations = data.conversations.filter(conversation => conversation.id !== action.id)
      if (!conversations.length) conversations.push(newConversation())
      return { ...data, conversations, activeId: conversations.some(conversation => conversation.id === data.activeId) ? data.activeId : conversations[0].id }
    }
    case 'ui': {
      const ui = { ...data.ui, ...action.patch }
      if (action.patch.position) ui.position = { x: clamp(action.patch.position.x), y: clamp(action.patch.position.y) }
      return { ...data, ui }
    }
    default: return data
  }
}

export const ROBOT_SIZE = 88
export const ROBOT_MARGIN = 16
export function robotCoordinates(position, viewport) {
  const rangeX = Math.max(0, viewport.width - ROBOT_SIZE - ROBOT_MARGIN * 2)
  const rangeY = Math.max(0, viewport.height - ROBOT_SIZE - ROBOT_MARGIN * 2)
  return { x: ROBOT_MARGIN + clamp(position.x) * rangeX, y: ROBOT_MARGIN + clamp(position.y) * rangeY }
}
export function robotPosition(coordinates, viewport) {
  return { x: clamp((coordinates.x - ROBOT_MARGIN) / Math.max(1, viewport.width - ROBOT_SIZE - ROBOT_MARGIN * 2)),
    y: clamp((coordinates.y - ROBOT_MARGIN) / Math.max(1, viewport.height - ROBOT_SIZE - ROBOT_MARGIN * 2)) }
}
