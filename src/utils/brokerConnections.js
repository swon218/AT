export const CONNECTION_BROKERS = ['kiwoom', 'toss', 'nh', 'kb']
export const emptyConnections = () => Object.fromEntries(CONNECTION_BROKERS.map(broker => [broker, false]))
export const accountAvailability = connections => {
  const count = CONNECTION_BROKERS.filter(broker => connections?.[broker] === true).length
  return count === 4 ? '사용가능' : count ? '일부 사용' : '사용불가'
}

// One monitor owned by App, independent of page selection. No persistent personal cache.
export function createConnectionMonitor({ read, onChange, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let owner = null, generation = 0
  const slots = new Map()
  const snapshot = () => Object.fromEntries(CONNECTION_BROKERS.map(broker => {
    const slot = slots.get(broker)
    return [broker, Boolean(slot?.connected && slot.expiresAt > now())]
  }))
  const publish = () => onChange({ owner, connections: snapshot() })
  function cancel(broker) {
    const slot = slots.get(broker)
    if (slot) { slot.controller?.abort(); clearTimer(slot.timer) }
    slots.delete(broker)
  }
  function start(broker, paused = false) {
    cancel(broker)
    const slot = { connected: false, controller: new AbortController() }
    slots.set(broker, slot)
    publish()
    if (!owner || paused) return
    const userId = owner, epoch = generation
    const current = () => owner === userId && generation === epoch && slots.get(broker) === slot
    // Bound browser transport separately, including a stalled settings/auth service.
    let settled = false
    const apply = result => {
      if (!current() || settled) return
      settled = true
      clearTimer(slot.timer)
      slot.expiresAt = Math.min(Number(result?.expiresAt) || now(), now() + 60_000)
      slot.connected = result?.connected === true && slot.expiresAt > now() && !slot.controller.signal.aborted
      publish()
      slot.timer = setTimer(() => start(broker), Math.max(1000, slot.expiresAt - now()))
    }
    slot.timer = setTimer(() => {
      slot.controller.abort()
      apply({ connected: false, expiresAt: now() + 60_000 })
    }, 18_000)
    Promise.resolve().then(() => {
      if (!current()) throw new Error('Obsolete connection check')
      return read(broker, userId, slot.controller.signal)
    })
      .then(apply, () => apply({ connected: false, expiresAt: now() + 60_000 }))
  }
  return {
    setUser(userId) {
      generation++
      for (const broker of CONNECTION_BROKERS) cancel(broker)
      owner = userId || null
      publish()
      if (owner) for (const broker of CONNECTION_BROKERS) start(broker)
    },
    mutation(brokers, pending) { if (owner) for (const broker of brokers) if (CONNECTION_BROKERS.includes(broker)) start(broker, pending) },
    snapshot,
    dispose() { generation++; owner = null; for (const broker of CONNECTION_BROKERS) cancel(broker) },
  }
}
