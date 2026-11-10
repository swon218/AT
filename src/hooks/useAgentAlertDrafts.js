import { useRef, useState } from 'react'

const empty = { revision: null, focus: null, rows: {}, saved: {} }

export default function useAgentAlertDrafts(userId) {
  const current = useRef({ userId, rooms: {} })
  const [, render] = useState(0)
  if (current.current.userId !== userId) current.current = { userId, rooms: {} }
  const room = id => current.current.rooms[id] || empty
  const change = (id, next) => {
    if (!userId || current.current.userId !== userId) return false
    current.current.rooms[id] = next
    render(value => value + 1)
    return true
  }
  return {
    room,
    editor(id) {
      const { focus, revision, rows, saved } = room(id)
      const row = rows[focus] || saved[focus]
      return { revision, draft: row ? { id: row.id, code: row.code, kind: row.kind || '',
        threshold: String(row.threshold ?? ''), expires_on: row.expires_on || '',
        frequency: row.frequency || 'once',
        ...(row.rule_id ? { rule_id: row.rule_id, version: row.version } : {}) } : null }
    },
    move(from, to) {
      if (from === 'new' && current.current.rooms.new && change(to, room(from))) delete current.current.rooms.new
    },
    edit(id, code, patch) {
      const before = room(id)
      change(id, { ...before, revision: crypto.randomUUID(), focus: code,
        rows: { ...before.rows, [code]: { ...before.rows[code], ...patch, code, id: before.rows[code]?.id || crypto.randomUUID() } } })
    },
    apply(id, draft) {
      const before = room(id)
      if (draft.roomId !== id || before.revision !== draft.baseRevision) return false
      const group = draft.rule_id ? 'saved' : 'rows'
      const key = draft.rule_id || draft.code
      return change(id, { ...before, revision: draft.revision, focus: key,
        [group]: { ...before[group], [key]: { ...draft, selected: true, dirty: true } } })
    },
    clear(id, codes, revision) {
      const before = room(id)
      if (before.revision !== revision) return
      const rows = { ...before.rows }
      for (const code of codes) delete rows[code]
      change(id, { ...before, revision: crypto.randomUUID(), focus: rows[before.focus] || before.saved[before.focus] ? before.focus : null, rows })
    },
    clearSaved(id, draft) {
      const before = room(id)
      if (before.saved[draft.rule_id]?.revision !== draft.revision) return
      const saved = { ...before.saved }
      delete saved[draft.rule_id]
      change(id, { ...before, saved, revision: crypto.randomUUID(), focus: before.focus === draft.rule_id ? null : before.focus })
    },
  }
}
