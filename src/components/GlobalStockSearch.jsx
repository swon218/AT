import { useEffect, useState } from 'react'
import StockSearch from './StockSearch'
import { stockCatalog } from '../services/stockCatalog'

export default function GlobalStockSearch({ onSelect, credentialScope }) {
  const [catalogState, setCatalogState] = useState(() => ({ scope: credentialScope, catalog: stockCatalog.read(credentialScope) }))
  const [retryVersion, setRetryVersion] = useState(0)
  const current = catalogState.scope === credentialScope ? catalogState : null

  useEffect(() => {
    let disposed = false
    setCatalogState({ scope: credentialScope, catalog: stockCatalog.read(credentialScope) })
    const refresh = () => stockCatalog.load(credentialScope)
      .then(catalog => { if (!disposed) setCatalogState({ scope: credentialScope, catalog }) })
      .catch(error => { if (!disposed) setCatalogState({ scope: credentialScope, catalog: stockCatalog.read(credentialScope), error: error.message }) })
    refresh()
    const timer = setInterval(refresh, 60_000)
    return () => { disposed = true; clearInterval(timer) }
  }, [credentialScope, retryVersion])

  return <StockSearch key={credentialScope} catalogItems={current?.catalog?.items} ready={Boolean(current?.catalog)}
    error={current?.error} stale={current?.catalog?.stale} onRetry={() => setRetryVersion(value => value + 1)}
    onSelect={stock => onSelect({ ...stock, price: null, change: null })}/>
}
