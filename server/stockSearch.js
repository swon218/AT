import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketRequestContext } from './marketContext.js'
import { indexStockCatalog, isStockCatalog, normalizeStockQuery, searchStockCatalog, STOCK_CATALOG_MAX_AGE, STOCK_CATALOG_TTL } from '../src/utils/stockSearch.js'

const markets = [['0', 'KOSPI'], ['10', 'KOSDAQ']]
const validCode = (code) => /^[0-9][0-9A-Z]{5}$/.test(code)
const numeric = (value) => {
  if (value === undefined || value === null || value === '') return null
  const result = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(result) ? result : null
}
const httpError = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode })

export function createStockSearch({ now = Date.now, pause = delay, ttl = STOCK_CATALOG_TTL, maxScopes = 50, snapshotPath = null, onError = () => {} } = {}) {
  const catalogs = new Map()
  const pending = new Map()
  let restored

  function remember(cacheScope, catalog) {
    if (catalogs.size >= maxScopes && !catalogs.has(cacheScope)) catalogs.delete(catalogs.keys().next().value)
    const entry = { ...catalog, index: indexStockCatalog(catalog.items) }
    catalogs.set(cacheScope, entry)
    return entry
  }

  async function restoreSnapshot() {
    if (!snapshotPath) return
    try {
      const catalog = JSON.parse(await readFile(snapshotPath, 'utf8'))
      if (isStockCatalog(catalog) && now() - catalog.updatedAt <= STOCK_CATALOG_MAX_AGE && catalog.updatedAt <= now()) remember('operator', catalog)
    } catch (error) { if (error.code !== 'ENOENT') onError(error) }
  }

  async function saveSnapshot(catalog) {
    if (!snapshotPath) return
    const temporary = `${snapshotPath}.${process.pid}.tmp`
    try {
      await mkdir(dirname(snapshotPath), { recursive: true })
      await writeFile(temporary, JSON.stringify(catalog), { mode: 0o600 })
      await rename(temporary, snapshotPath)
    } catch (error) { onError(error) }
    finally { await rm(temporary, { force: true }).catch(() => {}) }
  }

  async function refreshCatalog({ requester, cacheScope }) {
    if (pending.has(cacheScope)) return pending.get(cacheScope)
    if (pending.size >= 4) throw httpError('종목 목록을 준비 중입니다. 잠시 후 다시 검색해 주세요.', 503)
    const promise = (async () => {
      const stocks = new Map()
      let requests = 0
      for (const [marketCode, market] of markets) {
        let nextKey = ''
        const seenKeys = new Set()
        for (let page = 0; page < 50; page += 1) {
          if (requests++) await pause(250)
          const result = await requester({ apiId: 'ka10099', endpoint: '/api/dostk/stkinfo', body: { mrkt_tp: marketCode }, contYn: nextKey ? 'Y' : 'N', nextKey, returnPage: true })
          if (!Array.isArray(result.body?.list) || result.body.list.length === 0) throw httpError('키움 종목 목록 응답이 비어 있습니다. 다시 검색해 주세요.')
          for (const row of result.body.list) {
            const code = String(row.code || '').trim().replace(/^A(?=\d{6}$)/, '').toUpperCase()
            const name = String(row.name || '').trim()
            if (validCode(code) && name) stocks.set(code, { code, name, market })
          }
          if (result.contYn !== 'Y') break
          if (!result.nextKey || seenKeys.has(result.nextKey) || page === 49) throw httpError('키움 전체 종목 목록의 연속 조회를 완료하지 못했습니다.')
          seenKeys.add(result.nextKey)
          nextKey = result.nextKey
        }
      }
      if (!stocks.size) throw httpError('검색 가능한 종목이 없습니다.')
      const catalog = { items: [...stocks.values()], updatedAt: now() }
      for (const [key, value] of catalogs) if (now() - value.updatedAt > STOCK_CATALOG_MAX_AGE) catalogs.delete(key)
      // Persist only the operator's public catalog, never personal scopes or keys.
      if (cacheScope === 'operator') await saveSnapshot(catalog)
      return remember(cacheScope, catalog)
    })()
    pending.set(cacheScope, promise)
    try { return await promise } finally { pending.delete(cacheScope) }
  }

  async function loadCatalog(context) {
    if (context.cacheScope === 'operator') await (restored ??= restoreSnapshot())
    const cached = catalogs.get(context.cacheScope)
    if (cached && now() - cached.updatedAt <= STOCK_CATALOG_MAX_AGE) {
      if (now() - cached.updatedAt >= ttl && now() >= (cached.retryAt || 0)) {
        // Keep the last complete list available during refresh and transient failures.
        void refreshCatalog(context).catch(error => { cached.retryAt = now() + 30_000; onError(error) })
      }
      return cached
    }
    return refreshCatalog(context)
  }

  const search = async (query, context) => {
    const term = normalizeStockQuery(query)
    if (!term) return { items: [], total: 0 }
    if (term.length > 40) throw httpError('검색어는 40자 이내로 입력해 주세요.', 400)
    const catalog = await loadCatalog(context)
    return searchStockCatalog(catalog.index, term)
  }
  search.catalog = async context => {
    const { items, updatedAt } = await loadCatalog(context)
    return { items, updatedAt, stale: now() - updatedAt >= ttl }
  }
  return search
}

export async function getStockQuote(symbol, { requester }) {
  if (!validCode(symbol)) throw httpError('올바른 6자리 종목코드가 필요합니다.', 400)
  const body = await requester({ apiId: 'ka10001', endpoint: '/api/dostk/stkinfo', body: { stk_cd: symbol } })
  const code = String(body.stk_cd || '').replace(/^A/, '').split('_')[0]
  if (code !== symbol || !body.stk_nm) throw httpError('종목 시세 응답을 확인할 수 없습니다.')
  const price = numeric(body.cur_prc)
  return { code, name: body.stk_nm, price: price === null ? null : Math.abs(price), change: numeric(body.flu_rt) }
}

const searchStocks = createStockSearch({
  snapshotPath: fileURLToPath(new URL('../data/stock-catalog.json', import.meta.url)),
  onError: error => console.warn('Stock catalog refresh/cache failed:', error.message),
})

export async function warmStockSearchCatalog() {
  return searchStocks.catalog(await marketRequestContext({ headers: {} }))
}

export function registerStockSearchRoutes(app, { context = marketRequestContext, search = searchStocks, catalog = search.catalog, quote = getStockQuote } = {}) {
  app.get('/api/public/market/kiwoom/catalog', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try { return await catalog(await context(request)) }
    catch (error) { return reply.code(error.statusCode >= 400 ? error.statusCode : 502).send({ error: error.message }) }
  })
  const options = { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 1, maxLength: 40 } }, additionalProperties: false } } }
  app.get('/api/public/market/kiwoom/search', options, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try { return await search(request.query.q, await context(request)) }
    catch (error) { return reply.code(error.statusCode >= 400 ? error.statusCode : 502).send({ error: error.message }) }
  })
  app.get('/api/public/market/kiwoom/quote', { schema: { querystring: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string', pattern: '^[0-9][0-9A-Z]{5}$' } }, additionalProperties: false } } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try { return await quote(request.query.symbol, await context(request)) }
    catch (error) { return reply.code(error.statusCode >= 400 ? error.statusCode : 502).send({ error: error.message }) }
  })
}
