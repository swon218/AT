export const STOCK_CATALOG_TTL = 30 * 60_000
export const STOCK_CATALOG_MAX_AGE = 7 * 24 * 60 * 60_000
export const normalizeStockQuery = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase()

export function isStockCatalog(value) {
  return Number.isFinite(value?.updatedAt) && Array.isArray(value.items) && value.items.length > 0 &&
    value.items.every(stock => /^[0-9][0-9A-Z]{5}$/.test(stock?.code) && typeof stock.name === 'string' &&
      stock.name.trim().length > 0 && ['KOSPI', 'KOSDAQ'].includes(stock.market))
}

// Sort and normalize once when the catalog changes, rather than for each keystroke.
export function indexStockCatalog(items) {
  return items.map(stock => ({ stock, name: normalizeStockQuery(stock.name) }))
    .sort((a, b) => a.stock.name.localeCompare(b.stock.name, 'ko') || a.stock.code.localeCompare(b.stock.code))
}

export function searchStockCatalog(index, query, limit = 50) {
  const term = normalizeStockQuery(query)
  if (!term) return { items: [], total: 0 }
  const buckets = [[], [], [], [], []]
  let total = 0
  for (const { stock, name } of index) {
    if (!name.includes(term) && !stock.code.includes(term)) continue
    const score = stock.code === term ? 0 : name === term ? 1 : name.startsWith(term) ? 2 : stock.code.startsWith(term) ? 3 : 4
    buckets[score].push(stock)
    total++
  }
  return { items: buckets.flat().slice(0, limit), total }
}
