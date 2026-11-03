import { useEffect, useRef, useState } from 'react'
import { getNewsFeed } from '../services/newsApi'
import { mergeNewsItems, NEWS_REFRESH_MS } from '../utils/news'

export default function useNewsFeed(category) {
  const [state, setState] = useState({})
  const actions = useRef({})
  useEffect(() => {
    const controller = new AbortController()
    let inFlight = false, nextStart = 1, firstSignature, pendingPage, loaded = false, lastCheck = 0, failedMode = 'replace'
    const signature = page => JSON.stringify(page.items)
    setState({ category, items: [], loading: true })
    const replace = page => {
      nextStart = page.nextStart
      firstSignature = signature(page)
      pendingPage = null
      loaded = true
      failedMode = null
      setState({ ...page, category, items: mergeNewsItems([], page.items), loading: false })
    }
    const load = async (mode = 'replace') => {
      if (inFlight || controller.signal.aborted || (mode === 'append' && nextStart === null)) return
      inFlight = true
      const start = mode === 'append' ? nextStart : 1
      if (mode !== 'poll') setState(previous => ({ ...previous, loading: true, loadingMore: mode === 'append', error: null, refreshError: null }))
      if (mode !== 'append') lastCheck = Date.now()
      try {
        const page = await getNewsFeed(category, start, controller.signal)
        if (controller.signal.aborted) return
        if (mode === 'poll') {
          pendingPage = signature(page) !== firstSignature ? page : null
          // Never replace articles or the paging cursor while the reader is browsing.
          setState(previous => ({ ...previous, hasUpdate: !!pendingPage, refreshError: null }))
        } else if (mode === 'append') {
          nextStart = page.nextStart
          failedMode = null
          setState(previous => ({ ...previous, ...page, items: mergeNewsItems(previous.items, page.items), loading: false, loadingMore: false, error: null }))
        } else replace(page)
      } catch (error) {
        if (controller.signal.aborted) return
        if (mode !== 'poll') failedMode = mode
        setState(previous => mode === 'poll'
          ? { ...previous, refreshError: '새 뉴스 확인에 실패했습니다. 현재 목록은 유지됩니다.' }
          : { ...previous, loading: false, loadingMore: false, error: error.message })
      } finally { inFlight = false }
    }
    actions.current = {
      more: () => load('append'),
      retry: () => load(failedMode || 'poll'),
      refresh: () => { if (!inFlight) { if (pendingPage) replace(pendingPage); else load() } },
    }
    const check = () => { if (loaded && !document.hidden && Date.now() - lastCheck >= NEWS_REFRESH_MS) load('poll') }
    const timer = setInterval(check, NEWS_REFRESH_MS)
    document.addEventListener('visibilitychange', check)
    load()
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', check) }
  }, [category])
  return { ...(state.category === category ? state : { items: [], loading: true }),
    loadMore: () => actions.current.more?.(), retry: () => actions.current.retry?.(), refresh: () => actions.current.refresh?.() }
}
