import { marketRequestContext } from './marketContext.js'

const markets = [{ symbol: 'kospi', name: '코스피', code: '001', market: '0' }, { symbol: 'kosdaq', name: '코스닥', code: '101', market: '1' }]
const seoulDate = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))
const number = value => {
  if (value == null || String(value).trim() === '') return null
  const parsed = Number(String(value).replaceAll(',', '').trim())
  return Number.isFinite(parsed) ? parsed : null
}
const count = value => { const n = number(value); return n !== null && n >= 0 && Number.isInteger(n) ? n : null }
const amount = (value, unit) => { const n = number(value); return n === null ? null : n * unit }

export function normalizeMarketQuote(quote) {
  const turnover = number(quote.trde_prica)
  return {
    // ka20001: million KRW. Rising/falling already include upper/lower limits.
    turnoverWon: turnover !== null && turnover >= 0 ? turnover * 1_000_000 : null,
    breadth: { rising: count(quote.rising), unchanged: count(quote.stdns), falling: count(quote.fall), upperLimit: count(quote.upl), lowerLimit: count(quote.lst) },
  }
}

async function readFlow(index, date, request) {
  let nextKey = ''
  const seen = new Set()
  for (let page = 0; page < 10; page++) {
    const result = await request({ apiId: 'ka10051', endpoint: '/api/dostk/sect', body: { mrkt_tp: index.market, amt_qty_tp: '0', stex_tp: '1', base_dt: date }, returnPage: true, contYn: nextKey ? 'Y' : 'N', nextKey })
    // Select the market aggregate; summing sectors double-counts overlapping groups.
    const row = result.body?.inds_netprps?.find(item => String(item.inds_cd).trim() === index.code)
    if (row) return { foreignNetBuyWon: amount(row.frgnr_netprps, 100_000_000), institutionNetBuyWon: amount(row.orgn_netprps, 100_000_000) }
    if (result.contYn !== 'Y' || !result.nextKey || seen.has(result.nextKey)) break
    nextKey = result.nextKey
    seen.add(nextKey)
  }
  throw new Error('시장 전체 수급 응답이 없습니다.')
}

export function createMarketSummary({ now = Date.now, ttl = 30_000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map(), pending = new Map()
  return async ({ requester, cacheScope }) => {
    if (cache.get(cacheScope)?.expires > now()) return cache.get(cacheScope).data
    if (pending.has(cacheScope)) return pending.get(cacheScope)
    const job = (async () => {
      const today = seoulDate(now()).replaceAll('-', '')
      const request = async definition => { await pause(500); return requester({ ...definition, timeoutMs: 15_000 }) }
      const result = []
      for (const index of markets) {
        const market = { symbol: index.symbol, name: index.name, asOf: null, turnoverWon: null, breadth: null, foreignNetBuyWon: null, institutionNetBuyWon: null, quoteError: null, flowError: null }
        let date
        try {
          const daily = await request({ apiId: 'ka20006', endpoint: '/api/dostk/chart', body: { inds_cd: index.code, base_dt: today } })
          date = daily.inds_dt_pole_qry?.map(row => String(row.dt)).filter(value => /^\d{8}$/.test(value) && value <= today).sort().at(-1)
          if (!date) throw new Error('기준 거래일 없음')
          market.asOf = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
        } catch {
          market.quoteError = market.flowError = '기준 거래일을 확인하지 못했습니다.'
          result.push(market)
          continue
        }
        try {
          const quote = await request({ apiId: 'ka20001', endpoint: '/api/dostk/sect', body: { mrkt_tp: index.market, inds_cd: index.code } })
          Object.assign(market, normalizeMarketQuote(quote))
          if (market.turnoverWon === null || Object.values(market.breadth).some(value => value === null)) market.quoteError = '일부 시장 데이터가 비어 있습니다.'
        } catch { market.quoteError = '시장 현황을 불러오지 못했습니다.' }
        try {
          Object.assign(market, await readFlow(index, date, request))
          if (market.foreignNetBuyWon === null || market.institutionNetBuyWon === null) market.flowError = '일부 수급 데이터가 비어 있습니다.'
        } catch { market.flowError = '투자자 수급을 불러오지 못했습니다.' }
        result.push(market)
      }
      const data = { exchange: 'KRX', fetchedAt: new Date(now()).toISOString(), markets: result }
      for (const [key, value] of cache) if (value.expires <= now()) cache.delete(key)
      if (cache.size >= 200) cache.delete(cache.keys().next().value)
      cache.set(cacheScope, { expires: now() + ttl, data })
      return data
    })()
    pending.set(cacheScope, job)
    try { return await job } finally { pending.delete(cacheScope) }
  }
}

export function registerMarketSummaryRoutes(app, { context = marketRequestContext, getSummary = createMarketSummary(), sessions } = {}) {
  const route = (path, read) => app.get(path, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    try { return await read(await context(request)) }
    catch (error) { return reply.code(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 502).send({ error: error.statusCode === 401 ? '로그인 세션을 확인해 주세요.' : '시장 데이터에 연결하지 못했습니다.' }) }
  })
  route('/api/public/market/kiwoom/summary', getSummary)
  route('/api/public/market/kiwoom/session', auth => sessions.get(auth))
  app.addHook('onClose', async () => sessions.close())
}
