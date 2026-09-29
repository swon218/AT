import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'
import { createStrategyRepository } from '../services/strategyRepository'

const defaultRepository = createStrategyRepository(supabase)

// One instance in App supplies both workspaces. Old account requests may finish,
// but their results can never populate the next account's list.
export default function useStrategies(userId, repository = defaultRepository) {
  const owner = userId || null
  const scope = useRef({ owner, epoch: 0, request: 0, busy: false })
  if (scope.current.owner !== owner) scope.current = { owner, epoch: scope.current.epoch + 1, request: 0, busy: false }
  const current = scope.current
  const [state, setState] = useState({ owner, rows: [], loading: false, busy: false, error: '' })
  const visible = state.owner === owner ? state : { rows: [], loading: !!owner, busy: false, error: '' }
  const publish = useCallback((token, update) => {
    if (scope.current === token) setState(previous => ({ ...(previous.owner === token.owner ? previous : { rows: [] }), owner: token.owner, ...update }))
  }, [])
  const refresh = useCallback(async () => {
    const token = scope.current
    if (token.owner !== owner || token.busy) return
    const request = ++token.request
    if (!owner) { publish(token, { rows: [], loading: false, busy: false, error: '' }); return }
    publish(token, { loading: true, error: '' })
    try {
      const rows = await repository.list(owner)
      if (request === token.request) publish(token, { rows, loading: false })
    } catch (error) {
      if (request === token.request) publish(token, { error: error.message, loading: false })
    }
  }, [owner, repository, publish])
  useEffect(() => {
    refresh()
    const onFocus = () => { if (document.visibilityState !== 'hidden') refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [refresh])

  const mutate = async (operation) => {
    const token = scope.current
    if (token !== current || !owner) throw new Error('로그인 후 이용해 주세요.')
    if (token.busy) throw new Error('이전 저장 요청이 처리 중입니다.')
    token.busy = true
    ++token.request // Invalidate a list that started before this write.
    publish(token, { busy: true, loading: false, error: '' })
    try {
      const result = await operation()
      if (scope.current !== token) throw new Error('로그인 정보가 변경되었습니다.')
      return result
    } finally {
      token.busy = false
      publish(token, { busy: false })
      // Recover a list invalidated by this write, and discover concurrent
      // changes without ever replacing either workspace's unsaved draft.
      if (scope.current === token) void refresh()
    }
  }
  return {
    ...visible, authenticated: !!owner, refresh,
    save: (input, selected) => mutate(async () => {
      const row = await repository.save(owner, input, selected)
      if (scope.current === current) setState(previous => ({ ...previous, owner, rows: [row, ...(previous.owner === owner ? previous.rows : []).filter(item => item.id !== row.id)] }))
      return row
    }),
    remove: selected => mutate(async () => {
      await repository.remove(owner, selected)
      if (scope.current === current) setState(previous => ({ ...previous, rows: previous.rows.filter(item => item.id !== selected.id) }))
    }),
  }
}
