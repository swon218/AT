
import { requestKiwoom } from './kiwoomClient.js'
const definitions = {
  realtime: {
    apiId: 'ka00198', endpoint: '/api/dostk/stkinfo', listKey: 'item_inq_rank', body: { qry_tp: '5' },
  },
  rising: {
    apiId: 'ka10027', endpoint: '/api/dostk/rkinfo', listKey: 'pred_pre_flu_rt_upper',
    body: { mrkt_tp: '000', sort_tp: '1', trde_qty_cnd: '0000', stk_cnd: '0', crd_cnd: '0', updown_incls: '1', pric_cnd: '0', trde_prica_cnd: '0', stex_tp: '3' },
  },
  falling: {
    apiId: 'ka10027', endpoint: '/api/dostk/rkinfo', listKey: 'pred_pre_flu_rt_upper',
    body: { mrkt_tp: '000', sort_tp: '3', trde_qty_cnd: '0000', stk_cnd: '0', crd_cnd: '0', updown_incls: '1', pric_cnd: '0', trde_prica_cnd: '0', stex_tp: '3' },
  },
  volume: {
    apiId: 'ka10030', endpoint: '/api/dostk/rkinfo', listKey: 'tdy_trde_qty_upper',
    body: { mrkt_tp: '000', sort_tp: '1', mang_stk_incls: '0', crd_tp: '0', trde_qty_tp: '0', pric_tp: '0', trde_prica_tp: '0', mrkt_open_tp: '0', stex_tp: '3' },
  },
  surge: {
    apiId: 'ka10023', endpoint: '/api/dostk/rkinfo', listKey: 'trde_qty_sdnin',
    body: { mrkt_tp: '000', sort_tp: '1', tm_tp: '2', trde_qty_tp: '5', tm: '', stk_cnd: '0', pric_tp: '0', stex_tp: '3' },
  },
}

const cache = new Map()
const number = (value) => {
  const parsed = Number(String(value ?? 0).replace(/[,+%]/g, '').trim())
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0
}
const signedNumber = (value) => {
  const parsed = Number(String(value ?? 0).replace(/[,%]/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}
const compact = (value) => new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(number(value))
const code = (row) => String(row.stk_cd || row.stk_code || row.stock_code || row.code || row.isu_cd || '').replace(/^A/, '').split('_')[0]

function normalize(row) {
  return {
    code: code(row),
    name: row.stk_nm || row.stk_name || row.stock_name || row.name || row.isu_nm || '',
    price: number(row.past_curr_prc ?? row.cur_prc),
    change: signedNumber(row.base_comp_chgr ?? row.prev_base_chgr ?? row.flu_rt ?? row.tdy_close_pric_flu_rt),
    volume: compact(row.trde_qty ?? row.now_trde_qty ?? row.acc_trde_qty ?? row.prid_trde_qty),
    surge: number(row.sdnin_rt ?? row.sdnin_qty),
    market: row.stex_tp || row.mrkt_nm || 'KRX',
  }
}

export async function getRankings(type, limit = 20) {
  if (type === 'favorites') return []
  const definition = definitions[type]
  if (!definition) throw new Error('지원하지 않는 순위 유형입니다.')
  const cacheKey = `${type}:${limit}`
  const existing = cache.get(cacheKey)
  if (existing && Date.now() - existing.at < 8_000) return existing.items

  const payload = await requestKiwoom(definition)
  const rows = Array.isArray(payload[definition.listKey]) ? payload[definition.listKey] : []
  const items = rows.map(normalize).filter((item) => item.code && item.name).slice(0, limit)
  cache.set(cacheKey, { at: Date.now(), items })
  return items
}
