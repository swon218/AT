import { requestKiwoom } from './kiwoomClient.js'

const cache = new Map()
const allowedIntervals = new Set(['1분', '5분', '10분', '15분', '30분', '60분', '일', '주', '월'])
const absNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0
}

function todayInSeoul() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '')
}

function normalizeTime(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.length >= 14) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}+09:00`
  if (digits.length >= 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  return ''
}

function chartDefinition(symbol, interval) {
  if (interval.endsWith('분')) return {
    apiId: 'ka10080', endpoint: '/api/dostk/chart', listKeys: ['stk_min_pole_chart_qry'],
    body: { stk_cd: symbol, tic_scope: interval.replace('분', ''), upd_stkpc_tp: '1' },
  }
  const map = {
    일: ['ka10081', ['stk_dt_pole_chart_qry']],
    주: ['ka10082', ['stk_stk_pole_chart_qry', 'stk_wk_pole_chart_qry']],
    월: ['ka10083', ['stk_mth_pole_chart_qry']],
  }
  const [apiId, listKeys] = map[interval]
  return { apiId, endpoint: '/api/dostk/chart', listKeys, body: { stk_cd: symbol, base_dt: todayInSeoul(), upd_stkpc_tp: '1' } }
}

export async function getCandles(symbol, interval, limit = 200, { requester = requestKiwoom, cacheScope = 'operator' } = {}) {
  if (!/^\d{6}$/.test(symbol)) throw new Error('올바른 6자리 종목코드가 필요합니다.')
  if (!allowedIntervals.has(interval)) throw new Error('지원하지 않는 차트 주기입니다.')
  const key = `${cacheScope}:${symbol}:${interval}:${limit}`
  const existing = cache.get(key)
  if (existing && Date.now() - existing.at < 30_000) return existing.items

  const definition = chartDefinition(symbol, interval)
  const payload = await requester(definition)
  const rows = definition.listKeys.map((listKey) => payload[listKey]).find(Array.isArray) || []
  const items = rows.map((row) => ({
    time: normalizeTime(row.dt || row.cntr_tm),
    open: absNumber(row.open_pric), high: absNumber(row.high_pric),
    low: absNumber(row.low_pric), close: absNumber(row.cur_prc), volume: absNumber(row.trde_qty),
  })).filter((row) => row.time && row.open && row.high && row.low && row.close).reverse().slice(-limit)
  cache.set(key, { at: Date.now(), items })
  return items
}
