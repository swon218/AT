import { useEffect, useState } from 'react'
import { changeAgentWorkspace, emptyAgentWorkspace, readAgentWorkspace, saveAgentWorkspace } from '../utils/agentWorkspace'

function load(owner, userId) {
  if (!owner) return { owner, data: emptyAgentWorkspace(), dirty: false, error: '' }
  try { return { owner, data: readAgentWorkspace(window.localStorage, userId), dirty: false, error: '' } }
  catch { return { owner, data: emptyAgentWorkspace(), dirty: false, error: '이 브라우저의 대화를 불러오지 못했습니다. 새 대화로 시작합니다.' } }
}

export default function useAgentWorkspace(userId, authReady) {
  const owner = authReady ? userId || 'guest' : null
  const [record, setRecord] = useState(() => load(owner, userId))
  // Change scope before painting, so a login/logout never displays another scope's messages.
  let current = record
  if (record.owner !== owner) { current = load(owner, userId); setRecord(current) }

  useEffect(() => {
    if (!owner || !record.dirty || record.owner !== owner) return
    try {
      saveAgentWorkspace(window.localStorage, userId, record.data)
      setRecord(previous => previous.owner === owner ? { ...previous, error: '' } : previous)
    } catch {
      setRecord(previous => previous.owner === owner ? { ...previous, error: '브라우저에 저장하지 못했습니다. 현재 화면에서는 사용할 수 있지만 새로고침하면 변경 내용이 사라질 수 있습니다.' } : previous)
    }
  }, [owner, userId, record.data, record.dirty])

  const [notice, setNotice] = useState('')
  useEffect(() => setNotice(''), [owner])
  const dispatch = action => {
    if (!owner) return false
    try {
      // Validate synchronously so the composer clears only after a successful submission.
      const next = changeAgentWorkspace(current.data, action)
      setRecord(previous => previous.owner === owner ? { ...previous, data: next, dirty: true } : previous)
      setNotice('')
      return true
    } catch (error) { setNotice(error.message); return false }
  }
  return {
    data: current.data, ready: Boolean(owner), error: current.error || notice,
    active: current.data.conversations.find(conversation => conversation.id === current.data.activeId),
    setDraft: value => dispatch({ type: 'draft', value }), submit: () => dispatch({ type: 'submit' }),
    newConversation: () => dispatch({ type: 'new' }), select: id => dispatch({ type: 'select', id }),
    remove: id => dispatch({ type: 'delete', id }), setUI: patch => dispatch({ type: 'ui', patch }),
  }
}
