import { useEffect, useMemo, useState } from 'react'
import { getKiwoomStockQuote } from '../services/kiwoomMarketApi'
import { createWatchlistQuoteLoader } from '../services/watchlistQuotes'

const noQuotes = {}

export default function useWatchlistQuotes(rows, credentialScope, enabled) {
  const load = useMemo(() => createWatchlistQuoteLoader(getKiwoomStockQuote), [credentialScope])
  const codeKey = rows.map(row => row.code).join(',')
  const [state, setState] = useState(null)

  useEffect(() => {
    if (!enabled || !codeKey) return
    let active = true
    let refreshing = false
    const codes = codeKey.split(',')
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden') return
      refreshing = true
      const worker = async offset => {
        for (let i = offset; active && i < codes.length; i += 2) {
          const code = codes[i]
          const quote = await load(code)
          if (active) setState(previous => {
            const quotes = previous?.load === load ? previous.quotes : noQuotes
            if (quotes[code] === quote) return previous
            return { load, quotes: { ...quotes, [code]: quote } }
          })
        }
      }
      await Promise.all([worker(0), worker(1)])
      refreshing = false
    }
    void refresh()
    const timer = window.setInterval(refresh, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [enabled, codeKey, load])

  return state?.load === load ? state.quotes : noQuotes
}
