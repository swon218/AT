import { isStockCatalog, STOCK_CATALOG_MAX_AGE, STOCK_CATALOG_TTL } from './stockSearch.js'

const storageKey = 'atlas:stock-catalog:v1'

export function createStockCatalogCache({ fetchCatalog, now = Date.now, storage = () => globalThis.sessionStorage, ttl = STOCK_CATALOG_TTL } = {}) {
  const catalogs = new Map()
  const pending = new Map()
  const usable = catalog => isStockCatalog(catalog) && catalog.updatedAt <= now() + 60_000 && now() - catalog.updatedAt <= STOCK_CATALOG_MAX_AGE

  function read(scope) {
    let catalog = catalogs.get(scope)
    if (!catalog) {
      try {
        const saved = JSON.parse(storage()?.getItem(storageKey) || 'null')
        if (saved?.scope === scope && usable(saved.catalog)) catalog = saved.catalog
      } catch { /* Storage can be disabled or full; memory search still works. */ }
    }
    if (!usable(catalog)) { catalogs.delete(scope); return null }
    catalogs.set(scope, catalog)
    return catalog
  }

  async function load(scope) {
    const cached = read(scope)
    if (cached && cached.checkedAt > now() - ttl && !cached.stale && now() - cached.updatedAt < ttl) return cached
    if (pending.has(scope)) return pending.get(scope)
    const request = (async () => {
      const data = await fetchCatalog()
      if (!usable(data)) throw new Error('검색용 종목 목록을 확인할 수 없습니다. 다시 시도해 주세요.')
      // Only these public fields are stored; no session tokens or credentials.
      const catalog = { items: data.items.map(({ code, name, market }) => ({ code, name, market })), updatedAt: data.updatedAt, stale: Boolean(data.stale), checkedAt: now() }
      if (catalogs.size >= 8 && !catalogs.has(scope)) catalogs.delete(catalogs.keys().next().value)
      catalogs.set(scope, catalog)
      try { storage()?.setItem(storageKey, JSON.stringify({ scope, catalog })) } catch { /* Optional cache. */ }
      return catalog
    })()
    pending.set(scope, request)
    try { return await request } finally { pending.delete(scope) }
  }

  return { read, load }
}
