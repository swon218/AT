import { useRef, useState } from 'react'

const empty = { revision: null, focus: null, rows: {} }

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
      const { focus, revision, rows } = room(id)
      const row = rows[focus]
      return { revision, draft: row ? { id: row.id, code: focus, kind: row.kind || '',
        threshold: String(row.threshold ?? ''), expires_on: row.expires_on || '' } : null }
    },
    move(from, to) {
      if (from === 'new' && current.current.rooms.new && change(to, room(from))) delete current.current.rooms.new
    },
    edit(id, code, patch) {
      const before = room(id)
      change(id, { revision: crypto.randomUUID(), focus: code,
        rows: { ...before.rows, [code]: { ...before.rows[code], ...patch, id: before.rows[code]?.id || crypto.randomUUID() } } })
    },
    apply(id, draft) {
      const before = room(id)
      if (draft.roomId !== id || before.revision !== draft.baseRevision) return false
      return change(id, { revision: draft.revision, focus: draft.code,
        rows: { ...before.rows, [draft.code]: { ...draft, selected: true, dirty: true } } })
    },
    clear(id, codes, revision) {
      const before = room(id)
      if (before.revision !== revision) return
      const rows = { ...before.rows }
      for (const code of codes) delete rows[code]
      change(id, { revision: crypto.randomUUID(), focus: rows[before.focus] ? before.focus : null, rows })
    },
  }
}
