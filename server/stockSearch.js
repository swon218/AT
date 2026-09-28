import { setTimeout as delay } from 'node:timers/promises'
import { marketRequestContext } from './marketContext.js'

const markets = [['0', 'KOSPI'], ['10', 'KOSDAQ']]
const normalize = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase()
const validCode = (code) => /^[0-9][0-9A-Z]{5}$/.test(code)
const numeric = (value) => {
  if (value === undefined || value === null || value === '') return null
  const result = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(result) ? result : null
}
const httpError = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode })

export function createStockSearch({ now = Date.now, pause = delay, ttl = 30 * 60_000, maxScopes = 50 } = {}) {
  const catalogs = new Map()
  const pending = new Map()

  async function loadCatalog({ requester, cacheScope }) {
    const cached = catalogs.get(cacheScope)
    if (cached && cached.expires > now()) return cached.items
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
      const items = [...stocks.values()]
      for (const [key, value] of catalogs) if (value.expires <= now()) catalogs.delete(key)
      if (catalogs.size >= maxScopes) catalogs.delete(catalogs.keys().next().value)
      catalogs.set(cacheScope, { items, expires: now() + ttl })
      return items
    })()
    pending.set(cacheScope, promise)
    try { return await promise } finally { pending.delete(cacheScope) }
  }

  return async (query, context) => {
    const term = normalize(query)
    if (!term) return { items: [], total: 0 }
    if (term.length > 40) throw httpError('검색어는 40자 이내로 입력해 주세요.', 400)
    const items = await loadCatalog(context)
    const score = (stock) => stock.code === term ? 0 : normalize(stock.name) === term ? 1 : normalize(stock.name).startsWith(term) ? 2 : stock.code.startsWith(term) ? 3 : 4
    const matches = items.filter(stock => normalize(stock.name).includes(term) || stock.code.includes(term))
      .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, 'ko') || a.code.localeCompare(b.code))
    return { items: matches.slice(0, 50), total: matches.length }
  }
}

export async function getStockQuote(symbol, { requester }) {
  if (!validCode(symbol)) throw httpError('올바른 6자리 종목코드가 필요합니다.', 400)
  const body = await requester({ apiId: 'ka10001', endpoint: '/api/dostk/stkinfo', body: { stk_cd: symbol } })
  const code = String(body.stk_cd || '').replace(/^A/, '').split('_')[0]
  if (code !== symbol || !body.stk_nm) throw httpError('종목 시세 응답을 확인할 수 없습니다.')
  const price = numeric(body.cur_prc)
  return { code, name: body.stk_nm, price: price === null ? null : Math.abs(price), change: numeric(body.flu_rt) }
}

const searchStocks = createStockSearch()
export function registerStockSearchRoutes(app, { context = marketRequestContext, search = searchStocks, quote = getStockQuote } = {}) {
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
