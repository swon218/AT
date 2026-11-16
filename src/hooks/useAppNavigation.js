import { useCallback, useEffect, useRef, useState } from 'react'
import { appRouteUrl, nextAppRoute, readAppRoute } from '../utils/appNavigation'

export default function useAppNavigation() {
  const [route, setRoute] = useState(() => readAppRoute(window.location.href))
  const current = useRef(route)
  const commit = useCallback((next, replace = false) => {
    const url = appRouteUrl(window.location.href, next)
    const existing = `${window.location.pathname}${window.location.search}${window.location.hash}`
    const state = { ...window.history.state, atlasNavigation: { agentMode: next.agentMode } }
    if (replace || url === existing) window.history.replaceState(state, '', url)
    else window.history.pushState(state, '', url)
    current.current = next
    setRoute(next)
  }, [])
  useEffect(() => {
    // Canonicalize legacy alerts links without adding an extra Back entry.
    commit(current.current, true)
    const restore = () => {
      const next = readAppRoute(window.location.href, window.history.state?.atlasNavigation?.agentMode || current.current.agentMode)
      current.current = next
      setRoute(next)
      if (new URLSearchParams(window.location.search).get('agent') === 'alerts') commit(next, true)
    }
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore) }
  }, [commit])
  const navigate = useCallback((page, agentMode) => commit(nextAppRoute(current.current, page, agentMode)), [commit])
  const chooseAgentMode = useCallback(agentMode => commit(nextAppRoute(current.current, 'agent', agentMode)), [commit])
  return { activePage: route.page, agentMode: route.agentMode, pageHash: route.hash, navigate, chooseAgentMode }
}
