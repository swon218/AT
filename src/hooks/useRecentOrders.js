import { useEffect, useRef, useState } from 'react'
import { getRecentOrders } from '../services/recentOrdersApi'
import { createOrderRequestGuard, missingOrderBrokers, recentOrderScope } from '../utils/recentOrders'

export default function useRecentOrders({ userId, integrationStatus, integrationVersion, accountRefs, revision }) {
  const scope = recentOrderScope(userId, integrationStatus, integrationVersion, accountRefs, revision)
  const enabled = Boolean(userId && !missingOrderBrokers(integrationStatus).length)
  const [state, setState] = useState(null)
  const guard = useRef(null)
  guard.current ??= createOrderRequestGuard()
  useEffect(() => {
    if (!enabled) return undefined
    const controller = new AbortController(), version = guard.current.next()
    setState({ scope, loading: true })
    getRecentOrders({ accountRefs, signal: controller.signal })
      .then(data => { if (guard.current.isCurrent(version)) setState({ scope, data, loading: false }) })
      .catch(error => { if (guard.current.isCurrent(version) && !controller.signal.aborted) setState({ scope, error, loading: false }) })
    return () => { guard.current.cancel(); controller.abort() }
  }, [enabled, scope]) // scope contains all account, credential and refresh inputs.
  return { ...(enabled && state?.scope === scope ? state : { loading: enabled }), scope }
}
