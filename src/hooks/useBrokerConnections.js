import { useCallback, useEffect, useRef, useState } from 'react'
import { getBrokerConnection } from '../services/accountSettingsApi'
import { createConnectionMonitor, emptyConnections } from '../utils/brokerConnections'

export default function useBrokerConnections(userId) {
  const monitor = useRef(null)
  const [state, setState] = useState({ owner: null, connections: emptyConnections() })
  useEffect(() => {
    const instance = createConnectionMonitor({ read: getBrokerConnection, onChange: setState })
    monitor.current = instance
    instance.setUser(userId)
    const refreshExpired = () => {
      // Timers suspended by the browser are serviced on focus; stale successes
      // are hidden by the monitor's timestamp check before any new response.
      setState(current => ({ ...current, connections: instance.snapshot() }))
    }
    window.addEventListener('focus', refreshExpired)
    return () => { instance.dispose(); monitor.current = null; window.removeEventListener('focus', refreshExpired) }
  }, [userId])
  const mutation = useCallback((brokers, pending) => monitor.current?.mutation(brokers, pending), [])
  return { connections: userId && state.owner === userId ? state.connections : emptyConnections(), mutation }
}
