import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../services/supabaseClient'
import { createWatchlistRepository, watchlistCode, WATCHLIST_LIMIT, WATCHLIST_LIMIT_MESSAGE } from '../services/watchlistRepository'

const defaultRepository = createWatchlistRepository(supabase)
const emptyRows = []

export default function useWatchlist(owner, { authReady, onLogin, repository = defaultRepository }) {
  const scope = useMemo(() => ({ owner, read: null, writing: false }), [owner, repository])
  const mounted = useRef(null)
  const [state, setState] = useState(null)
  const visible = state?.scope === scope ? state : null
  const rows = visible?.rows ?? emptyRows
  const ready = Boolean(visible?.rows)
  const loading = Boolean(owner && (visible?.loading ?? true))

  const publish = useCallback(changes => {
    if (mounted.current !== scope) return
    setState(previous => ({ ...(previous?.scope === scope ? previous : null), ...changes, scope }))
  }, [scope])

  useLayoutEffect(() => {
    mounted.current = scope
    return () => {
      mounted.current = null
      scope.read?.abort()
      scope.read = null
    }
  }, [scope])

  const refresh = useCallback(async () => {
    if (!owner || mounted.current !== scope || scope.read || scope.writing) return
    const controller = new AbortController()
    scope.read = controller
    publish({ loading: true, readError: '' })
    try {
      const rows = await repository.list(owner, controller.signal)
      if (!controller.signal.aborted) publish({ rows, loading: false })
    } catch (error) {
      if (!controller.signal.aborted) publish({ readError: error.message, loading: false })
    } finally {
      if (scope.read === controller) scope.read = null
    }
  }, [owner, repository, scope, publish])

  useEffect(() => {
    if (!owner) return
    void refresh()
    const onFocus = () => { if (document.visibilityState !== 'hidden') void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [owner, refresh])

  const toggle = async stock => {
    if (!authReady || mounted.current !== scope) return
    if (!owner) { onLogin(); return }
    if (!ready || visible?.readError || scope.read || scope.writing) return
    const code = watchlistCode(stock.code)
    if (!code) { publish({ mutationError: '종목 정보를 확인해 주세요.' }); return }
    const saved = !rows.some(row => row.code === code)
    if (saved && rows.length >= WATCHLIST_LIMIT) {
      publish({ mutationError: WATCHLIST_LIMIT_MESSAGE })
      return
    }

    scope.writing = true
    const next = saved ? [{ code, name: stock.name }, ...rows] : rows.filter(row => row.code !== code)
    publish({ rows: next, pendingCode: code, mutationError: '' })
    try {
      publish({ rows: await repository.setSaved(owner, stock, saved) })
    } catch (error) {
      if (mounted.current !== scope) return
      publish({ rows, mutationError: error.message })
      // A lost response can follow a committed write. Read back before unlocking.
      const controller = new AbortController()
      scope.read = controller
      try {
        const confirmed = await repository.list(owner, controller.signal)
        if (!controller.signal.aborted) publish({ rows: confirmed })
      } catch (readError) {
        if (!controller.signal.aborted) publish({ readError: readError.message })
      } finally {
        if (scope.read === controller) scope.read = null
      }
    } finally {
      scope.writing = false
      publish({ pendingCode: '' })
    }
  }

  return {
    rows, ready, loading: !authReady || loading, authenticated: Boolean(owner),
    readError: visible?.readError, mutationError: visible?.mutationError,
    pendingCode: visible?.pendingCode, refresh, toggle,
    canToggle: authReady && (!owner || (ready && !loading && !visible?.readError && !visible?.pendingCode)),
  }
}
