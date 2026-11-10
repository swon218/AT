import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { config } from './config.js'
import { requestKiwoom } from './kiwoomClient.js'
import { getStockQuote, searchResearchStock } from './stockSearch.js'
import { chartDefinition, normalizeTime } from './charts.js'

const codePattern = /^[0-9][0-9A-Z]{5}$/
const minutes = new Set([1, 5, 10, 15, 30, 60])
const ticks = new Set([1, 3, 5, 10, 30])
const problem = code => Object.assign(new Error(code), { safeCode: code })
const number = value => {
  const text = String(value ?? '').replace(/,/g, '').trim()
  return text && /^[+-]?\d+(?:\.\d+)?$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null
}
const kstDay = at => new Date(at + 9 * 3600000).toISOString().slice(0, 10)

function day(value, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value || value > today || value < '2001-01-01') throw problem('invalid_period')
  return value
}

function business(payload) {
  if (String(payload?.return_code) !== '0') throw problem('market_invalid_response')
}

export function createAgentMarketData({ request = requestKiwoom, search = searchResearchStock, now = Date.now,
  scope = () => createHash('sha256').update(config.kiwoomHost + '\0' + config.kiwoomAppKey + '\0' + config.kiwoomSecretKey).digest('hex'),
  configured = () => Boolean(config.kiwoomAppKey && config.kiwoomSecretKey), sleep = pause } = {}) {
  const cache = new Map(), pending = new Map()
  let nextRequest = 0
  let lastSuccess = null
  async function load(tool, args, permit) {
    if (!configured()) throw problem('market_not_configured')
    const requester = async definition => {
      permit()
      const wait = Math.max(0, nextRequest - now())
      nextRequest = Math.max(now(), nextRequest) + 250
      if (wait) await sleep(wait)
      return request({ ...definition, timeoutMs: 7000 })
    }
    const today = kstDay(now())
    if (tool === 'resolve_market_symbol') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 40) throw problem('invalid_arguments')
      const result = await search(args.query, requester)
      return { status: result.total > 1 ? 'partial' : result.items.length ? 'success' : 'empty',
        items: result.items.slice(0, 10).map(({ code, name, market }) => ({ code, name, market })), total: result.total,
        source: 'Kiwoom stock catalog', queried_at: new Date(now()).toISOString(), warnings: ['운영자 공개 종목 목록 기준입니다.'] }
    }
    if (args.market !== 'KRX') throw problem('unsupported_market')
    if (!codePattern.test(args.code)) throw problem('invalid_symbol')
    if (tool === 'get_market_quote') {
      const checked = async definition => {
        const body = await requester(definition)
        business(body)
        if (String(body.stk_cd || '').replace(/^A/, '') !== args.code) throw problem('market_symbol_mismatch')
        return body
      }
      const quote = await getStockQuote(args.code, { requester: checked, includeMetadata: true })
      if (!Number.isFinite(quote.price) || quote.price <= 0) throw problem('market_no_data')
      return { status: 'success', ...quote, market: 'KRX', currency: 'KRW', volume_unit: 'shares',
        provider_at: null, queried_at: new Date(now()).toISOString(), realtime: 'unknown', delay: 'unknown',
        observation: 'latest_available', adjusted: 'not_applicable', source: 'Kiwoom REST ka10001',
        warnings: ['공급자 시세 시각·지연 여부 미제공. 서버 수신 시각을 실시간 시세의 증거로 사용하지 않습니다.'] }
    }
    if (tool !== 'get_intraday_bars') throw problem('forbidden_data_tool')
    if (!['minute','tick'].includes(args.kind)) throw problem('unsupported_interval')
    if (!(args.kind === 'minute' ? minutes : ticks).has(args.interval)) throw problem('unsupported_interval')
    const end = day(args.end_date || today, today), start = day(args.start_date || end, today)
    if (start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 6) throw problem('unsupported_period')
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 120) throw problem('invalid_limit')
    const definition = args.kind === 'minute' ? chartDefinition(args.code, args.interval + '분') : {
      apiId: 'ka10079', endpoint: '/api/dostk/chart', listKeys: ['stk_tic_chart_qry'],
      body: { stk_cd: args.code, tic_scope: String(args.interval), upd_stkpc_tp: '1' },
    }
    const { listKeys, ...operation } = definition
    if (args.kind === 'minute') operation.body.base_dt = end.replaceAll('-', '')
    const items = [], seenCursors = new Set()
    let previousPage = []
    let nextKey = '', more = false, invalid = 0, reachedStart = false, receivedRows = 0
    for (let page = 0; page < 2; page++) {
      const result = await requester({ ...operation, returnPage: true, contYn: nextKey ? 'Y' : 'N', nextKey })
      business(result.body)
      if (result.body.stk_cd !== args.code) throw problem('market_symbol_mismatch')
      const rows = listKeys.map(key => result.body[key]).find(Array.isArray)
      if (!rows || rows.length > 2000) throw problem('market_invalid_response')
      receivedRows += rows.length
      const serialized = rows.map(row => JSON.stringify(row))
      let overlap = Math.min(previousPage.length, serialized.length)
      while (overlap && !previousPage.slice(-overlap).every((row, index) => row === serialized[index])) overlap--
      previousPage = serialized
      for (const row of rows.slice(overlap)) {
        const time = normalizeTime(row.cntr_tm)
        const at = Date.parse(time)
        const prices = [row.open_pric, row.high_pric, row.low_pric, row.cur_prc].map(number).map(value => value === null ? null : Math.abs(value))
        const volume = number(row.trde_qty)
        if (!/^\d{14}$/.test(String(row.cntr_tm)) || !Number.isFinite(at) || at > now() + 5000
            || new Date(at + 9 * 3600000).toISOString().slice(0, 19).replace(/\D/g, '') !== row.cntr_tm
            || prices.some(value => value === null || value <= 0) || prices[1] < Math.max(prices[0], prices[3])
            || prices[2] > Math.min(prices[0], prices[3]) || volume === null || volume < 0) { invalid++; continue }
        const date = time.slice(0, 10)
        if (date < start) reachedStart = true
        if (date < start || date > end) continue
        items.push({ time, open: prices[0], high: prices[1], low: prices[2], close: prices[3], volume,
          completed: 'unknown' })
      }
      more = result.contYn === 'Y'
      if (!more || reachedStart || items.length >= args.limit) break
      if (!result.nextKey || seenCursors.has(result.nextKey)) throw problem('market_invalid_cursor')
      seenCursors.add(result.nextKey); nextKey = result.nextKey
    }
    // Equal-time/equal-price ticks within a page can be distinct trades.
    items.sort((a,b) => a.time.localeCompare(b.time))
    const selected = items.slice(-args.limit)
    const partial = invalid > 0 || more && !reachedStart || items.length > args.limit || receivedRows > 0 && selected.length === 0
    return { status: selected.length ? partial ? 'partial' : 'success' : invalid ? 'error' : partial ? 'partial' : 'empty',
      ...(invalid && !selected.length ? { code: 'market_invalid_response' } : {}),
      code_symbol: args.code, market: 'KRX', kind: args.kind, interval: args.interval, items: selected,
      currency: 'KRW', volume_unit: 'shares', adjusted: true, realtime: 'unknown', delay: 'unknown',
      provider_at: selected.at(-1)?.time || null, queried_at: new Date(now()).toISOString(),
      requested_period: { start, end }, returned_period: { start: selected[0]?.time || null, end: selected.at(-1)?.time || null },
      more_available: more, invalid_rows: invalid, truncated: items.length > args.limit,
      source: 'Kiwoom REST ' + operation.apiId,
      warnings: ['최대 2페이지·120봉의 제한된 수신 범위입니다. 봉 확정 여부는 공급자가 제공하지 않습니다.',
        ...(receivedRows && !selected.length ? ['요청 기간에 해당하는 봉을 수신하지 못했습니다.'] : []),
        ...(partial ? ['요청 기간 전체 수신을 보장하지 못하는 부분 조회입니다.'] : [])] }
  }
  return {
    ready: configured,
    status: () => ({ market: { configured: configured(), last_success_at: lastSuccess } }),
    async read(tool, args, permit) {
      const fields = { resolve_market_symbol: ['query'], get_market_quote: ['code','market'],
        get_intraday_bars: ['code','market','kind','interval','start_date','end_date','limit'] }[tool]
      if (!fields || !args || Object.keys(args).some(key => !fields.includes(key))) return { status: 'error', code: 'invalid_arguments', items: [] }
      const key = JSON.stringify([scope(), tool, args])
      const at = now(), existing = cache.get(key)
      if (existing && at - existing.at < 5000) return { ...existing.value, cache_hit: true, cache_age_ms: at - existing.at }
      if (pending.has(key)) return { ...await pending.get(key), cache_hit: true, cache_age_ms: 0 }
      if (pending.size >= 8) return { status: 'error', code: 'market_busy', items: [] }
      const operation = load(tool, args, permit).then(value => {
        if (value.status === 'success' && tool !== 'resolve_market_symbol') lastSuccess = new Date(now()).toISOString()
        if (['success','partial','empty'].includes(value.status)) {
          if (cache.size >= 128) cache.delete(cache.keys().next().value)
          cache.set(key, { at: now(), value })
        }
        return value
      }).catch(error => ({ status: 'error', code: error.safeCode || (error.statusCode === 401 || error.statusCode === 403 ? 'market_auth_error'
        : error.statusCode === 429 ? 'market_rate_limit' : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'market_timeout' : 'market_provider_error'), items: [] }))
      pending.set(key, operation)
      try { return { ...await operation, cache_hit: false, cache_age_ms: 0 } } finally { pending.delete(key) }
    },
  }
}

export const agentMarketData = createAgentMarketData()
