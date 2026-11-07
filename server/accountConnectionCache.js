// Only booleans and credential digests live here; never account payloads or keys.
export function createAccountConnectionCache({ now = Date.now, ttlMs = 60_000, timeoutMs = 12_000 } = {}) {
  const entries = new Map()
  const keyFor = (userId, broker) => JSON.stringify([userId, broker])
  function invalidate(userId, brokers) {
    for (const broker of brokers) {
      const key = keyFor(userId, broker)
      entries.get(key)?.controller.abort()
      entries.delete(key)
    }
  }
  async function check(userId, broker, version, verify) {
    const key = keyFor(userId, broker)
    let entry = entries.get(key)
    if (entry?.version !== version || (!entry?.promise && entry?.expiresAt <= now())) {
      invalidate(userId, [broker])
      entry = null
    }
    if (!entry) {
      // Bound process memory even if many different users visit only once.
      if (entries.size >= 2000) {
        const oldest = entries.keys().next().value
        entries.get(oldest).controller.abort()
        entries.delete(oldest)
      }
      entry = { version, controller: new AbortController() }
      entries.set(key, entry)
      const current = entry
      current.promise = (async () => {
        let timer
        try {
          current.connected = await Promise.race([
            Promise.resolve().then(() => {
              current.controller.signal.throwIfAborted()
              return verify(current.controller.signal)
            }).then(value => value === true),
            new Promise(resolve => {
              timer = setTimeout(() => { current.controller.abort(); resolve(false) }, timeoutMs)
              current.controller.signal.addEventListener('abort', () => resolve(false), { once: true })
            }),
          ])
        } catch { current.connected = false }
        finally { clearTimeout(timer) }
        current.expiresAt = now() + ttlMs
        current.promise = null
      })()
    }
    if (entry.promise) await entry.promise
    return {
      connected: entry.connected === true,
      expiresAt: entry.expiresAt,
      current: () => entries.get(key) === entry && entry.expiresAt > now(),
    }
  }
  return { check, invalidate }
}

export const accountConnectionCache = createAccountConnectionCache()
