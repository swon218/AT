const QUOTE_TTL = 60_000
const RETRY_TTL = 30_000

export function createWatchlistQuoteLoader(fetchQuote, now = Date.now) {
  const entries = new Map()
  const lanes = [Promise.resolve(), Promise.resolve()]
  let nextLane = 0
  let nextStart = 0

  return code => {
    const existing = entries.get(code)
    if (existing?.pending) return existing.pending
    if (existing && existing.expiresAt > now()) return Promise.resolve(existing.quote)
    for (const [key, entry] of entries) {
      if (!entry.pending && entry.expiresAt <= now()) entries.delete(key)
    }

    const lane = nextLane
    nextLane = (nextLane + 1) % lanes.length
    const pending = lanes[lane].then(async () => {
      const time = Date.now()
      const wait = Math.max(0, nextStart - time)
      nextStart = time + wait + 250
      if (wait) await new Promise(resolve => setTimeout(resolve, wait))
      let quote = null
      try {
        const result = await fetchQuote(code, AbortSignal.timeout(8_000))
        if (result?.code === code) {
          const value = key => Number.isFinite(result[key]) ? result[key] : null
          quote = { price: value('price'), change: value('change'), volume: value('volume') }
        }
      } catch {
        // The watchlist item stays visible regardless of the market response.
      }
      entries.set(code, { quote, expiresAt: now() + (quote ? QUOTE_TTL : RETRY_TTL) })
      return quote
    })
    lanes[lane] = pending
    entries.set(code, { pending })
    return pending
  }
}
