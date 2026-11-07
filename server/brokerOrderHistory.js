import { createHash, createHmac } from 'node:crypto'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'
import { requestTossWithCredentials } from './tossClient.js'
import { addedBrokerData } from './addedBrokerData.js'
import { nhClient } from './nhClient.js'
import { kbClient } from './kbClient.js'
import { httpError, numeric, stockCode, validSymbol } from './brokerHttp.js'
import { koreanOrderDay } from '../src/utils/orderPeriod.js'

export const HISTORY_BROKERS = ['kiwoom', 'toss', 'nh', 'kb']
export const historyNames = { kiwoom: '키움증권', toss: '토스증권', nh: 'NH투자증권', kb: 'KB증권' }
const no = value => String(value ?? '').trim().replace(/^0+(?=\d)/, '')
const positive = value => { const n = numeric(value); return n !== null && n >= 0 ? n : null }
const price = value => { const n = positive(value); return n > 0 ? n : null }
const side = value => /매수|BUY/i.test(value || '') ? 'buy' : /매도|SELL/i.test(value || '') ? 'sell' : null
const dayString = value => String(value).replaceAll('-', '')
const timeAt = (day, value) => {
  const time = String(value || '').replaceAll(':', '')
  if (!/^([01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(time)) return null
  return `${day}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`
}
const list = (body, key, optional = false) => {
  if (optional && body[key] === undefined) return []
  if (!Array.isArray(body[key])) throw httpError('주문내역 응답 형식을 확인할 수 없습니다.')
  return body[key]
}
async function historyStage(stage, work) {
  try { return await work() }
  catch (error) {
    error.orderStage ||= error.tossStage === 'token' ? 'token' : stage
    // Retain only the classification, never the broker's message.
    if (/조회\s*(기간|일자).{0,30}(초과|제한|불가|이전|범위)|지원하지 않는.{0,15}(기간|일자)|(?:invalid|unsupported|out of range).{0,20}(?:date range|period)/i.test(error.message)) {
      error.orderPeriodUnsupported = true
    }
    throw error
  }
}

const limitError = () => Object.assign(httpError('주문내역 연속 조회를 완료하지 못했습니다.'), { orderReadLimit: true })

async function boundedRequest(work, signal) {
  signal.throwIfAborted()
  let abort
  try {
    return await Promise.race([work(signal), new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function orderState(item) {
  if (item.rejected) return 'rejected'
  const filled = item.filledQuantity, quantity = item.quantity
  if (quantity > 0 && filled !== null && filled >= quantity) return 'filled'
  const cancelled = item.cancelled || (quantity > 0 && item.cancelledQuantity > 0 && filled !== null && filled + item.cancelledQuantity >= quantity)
  if (cancelled) return filled > 0 ? 'residualCancelled' : filled === 0 ? 'cancelled' : 'unknown'
  if (item.replaced) return 'replaced'
  if (filled > 0) return 'partiallyFilled'
  return item.pending ? 'pending' : 'unknown'
}

export function normalizeHistoryOrder(broker, accountRef, day, rawId, values) {
  const orderNumber = no(rawId)
  if (!orderNumber || orderNumber === '0' || !validSymbol(values.symbol)) throw httpError('주문내역 식별 정보를 확인할 수 없습니다.')
  const item = { broker, accountRef, date: day, orderedAt: null, symbol: '', name: '', side: null,
    quantity: null, filledQuantity: null, averageFilledPrice: null, orderPrice: null, marketOrder: false,
    executions: [], lastFilledAt: null, ...values }
  item.id = createHash('sha256').update(JSON.stringify([broker, accountRef, day, orderNumber])).digest('hex')
  item.status = orderState(item)
  // Raw upstream objects, account numbers and rejection messages never leave adapters.
  for (const key of ['cancelled', 'cancelledQuantity', 'rejected', 'pending', 'replaced']) delete item[key]
  return item
}

export function deduplicateOrders(items) {
  const orders = new Map()
  for (const item of items) orders.set(item.id, item)
  return [...orders.values()]
}

export function createBrokerHistory({ kiwoom = requestKiwoomWithCredentials, toss = requestTossWithCredentials,
  tossAccount = async (auth, signal) => {
    const payload = await toss({ ...auth, path: '/api/v1/accounts', signal })
    return list(payload, 'result').filter(item => item.accountType === 'BROKERAGE' && item.accountSeq != null)
  }, nh = nhClient, kb = kbClient, nhAccounts = (auth, signal) => addedBrokerData.nhAccounts(auth, signal),
  pause = (signal, milliseconds = 500) => new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const done = () => { signal?.removeEventListener('abort', stop); resolve() }
    const timer = setTimeout(done, milliseconds)
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(httpError('조회 시간 초과', 504)) }
    signal?.addEventListener('abort', stop, { once: true })
  }),
} = {}) {
  return async function read(broker, account, days, requestedRef = '', signal, options) {
    const credentials = account.credentials
    const auth = broker === 'toss' ? { apiKey: credentials.tossApiKey, secretKey: credentials.tossSecretKey }
      : { appKey: credentials[`${broker}AppKey`], secretKey: credentials[`${broker}SecretKey`] }
    const ref = raw => createHmac('sha256', auth.secretKey).update(JSON.stringify([account.user.id, broker, auth.appKey || auth.apiKey, raw])).digest('hex').slice(0, 32)
    const deadline = options && AbortSignal.timeout(options.timeBudgetMs)
    const operation = deadline && signal ? AbortSignal.any([deadline, signal]) : deadline || signal
    const call = work => options
      ? boundedRequest(work, AbortSignal.any([operation, AbortSignal.timeout(8_000)]))
      : work(signal)
    let rawAccount = '', accounts, selectedAccountRef, accountLabel
    if (broker === 'nh') {
      const available = await historyStage('accounts', () => call(sig => nhAccounts(auth, sig)))
      signal?.throwIfAborted()
      accounts = available.map(option => ({ id: ref(option.id), label: option.label }))
      const chosen = requestedRef ? available.find(option => ref(option.id) === requestedRef) : available.length === 1 ? available[0] : null
      if (chosen) { rawAccount = chosen.id; selectedAccountRef = ref(chosen.id); accountLabel = chosen.label }
    } else if (broker === 'toss') {
      const result = await historyStage('accounts', () => call(sig => tossAccount(auth, sig)))
      signal?.throwIfAborted()
      const available = Array.isArray(result) ? result : [result]
      accounts = available.map((option, index) => ({ id: ref(option.accountSeq),
        label: available.length === 1 ? '종합매매 · API 연결 계좌' : `종합매매 계좌 ${index + 1}` }))
      const chosen = requestedRef ? accounts.findIndex(option => option.id === requestedRef) : available.length === 1 || (!options && available.length) ? 0 : -1
      if (chosen >= 0) { rawAccount = available[chosen].accountSeq; selectedAccountRef = accounts[chosen].id; accountLabel = accounts[chosen].label }
    } else {
      selectedAccountRef = ref('linked'); accountLabel = 'API 연결 계좌'
      accounts = [{ id: selectedAccountRef, label: accountLabel }]
    }
    if (!selectedAccountRef || (requestedRef && selectedAccountRef !== requestedRef)) {
      if (requestedRef && !options) throw httpError('본인 계좌를 선택해 주세요.', 400)
      return { status: 'accountRequired', accounts, selectedAccountRef: '', items: [] }
    }
    const output = [], completedDays = []
    const result = () => ({ accounts, selectedAccountRef, completedDays, items: deduplicateOrders(output).map(item => ({ ...item, accountLabel })) })
    async function daily(readDay) {
      let unsupported
      for (const day of days) {
        try {
          await readDay(day)
          completedDays.push(day)
        } catch (error) {
          if (!options || !error.orderPeriodUnsupported) throw error
          unsupported = error
        }
      }
      if (unsupported) throw unsupported
    }
    let budget = 40
    const paged = async (fetchPage, readPage) => {
      let cursor = ''; const seen = new Set()
      for (let page = 0; page < 50; page++) {
        operation?.throwIfAborted()
        if (options && budget-- <= 0) throw limitError()
        if (broker === 'kiwoom' || (options && broker === 'toss')) await pause(operation, broker === 'kiwoom' ? 500 : 250)
        const result = await call(sig => fetchPage(cursor, sig))
        operation?.throwIfAborted()
        const next = readPage(result)
        if (!next.more) return
        if (!next.key || seen.has(next.key) || page === 49) throw limitError()
        seen.add(next.key); cursor = next.key
      }
    }
    try {
      if (broker === 'kiwoom') {
        await daily(async day => {
          const snapshots = new Map(), fills = new Map()
          const fetchRows = async (apiId, key, body, collect) => historyStage(apiId, () => paged((nextKey, signal) => {
            return kiwoom({ ...auth, apiId, endpoint: '/api/dostk/acnt', body: { ord_dt: dayString(day), stk_bond_tp: '1', sell_tp: '0', stk_cd: '', fr_ord_no: '', dmst_stex_tp: '%', ...body }, returnPage: true, contYn: nextKey ? 'Y' : 'N', nextKey, timeoutMs: 12_000, signal })
          }, result => {
            if (String(result.body?.return_code) !== '0') throw httpError(result.body?.return_msg || '키움 주문내역 응답을 확인할 수 없습니다.')
            collect(list(result.body, key, true)); return { more: result.contYn === 'Y', key: result.nextKey }
          }))
          await fetchRows('kt00007', 'acnt_ord_cntr_prps_dtl', { qry_tp: '2' }, rows => {
            for (const row of rows) snapshots.set(no(row.ord_no), row)
          })
          // kt00009 identifies actual fills by cntr_no, with execution time/quantity/price.
          await fetchRows('kt00009', 'acnt_ord_cntr_prst_array', { qry_tp: '1', mrkt_tp: '0' }, rows => {
            for (const row of rows) {
              if (!no(row.cntr_no) || no(row.cntr_no) === '0' || !(price(row.cntr_uv) && positive(row.cntr_qty) > 0)) continue
              fills.set(JSON.stringify([no(row.ord_no), no(row.cntr_no), row.dmst_stex_tp]), row)
            }
          })
          const cancellations = new Map()
          const executionsByOrder = new Map()
          for (const fill of fills.values()) {
            const id = no(fill.ord_no)
            if (!executionsByOrder.has(id)) executionsByOrder.set(id, [])
            executionsByOrder.get(id).push({
              id: `${no(fill.cntr_no)}:${fill.dmst_stex_tp || ''}`, at: timeAt(day, fill.cntr_tm), quantity: positive(fill.cntr_qty), price: price(fill.cntr_uv),
            })
          }
          for (const row of snapshots.values()) if (/취소확인/.test(row.mdfy_cncl || '') && no(row.ori_ord) !== '0' && positive(row.cnfm_qty) > 0) {
            const original = no(row.ori_ord)
            cancellations.set(original, (cancellations.get(original) || 0) + positive(row.cnfm_qty))
          }
          for (const [id, row] of snapshots) {
            if (/^[JQ]/.test(String(row.stk_cd || ''))) continue // ELW/ETN prefixes in the official TR.
            if (/취소/.test(row.mdfy_cncl || '') && no(row.ori_ord) && no(row.ori_ord) !== '0' && snapshots.has(no(row.ori_ord))) continue
            const executions = executionsByOrder.get(id) || []
            const fillQty = executions.reduce((sum, fill) => sum + fill.quantity, 0)
            const quantity = positive(row.ord_qty), snapshotQty = positive(row.cntr_qty)
            const filledQuantity = executions.length ? Math.max(fillQty, snapshotQty || 0) : snapshotQty
            output.push(normalizeHistoryOrder(broker, selectedAccountRef, day, id, {
              symbol: stockCode(row.stk_cd), name: String(row.stk_nm || ''), side: side(row.io_tp_nm),
              orderedAt: timeAt(day, row.ord_tm), quantity, filledQuantity,
              averageFilledPrice: executions.length && fillQty === filledQuantity ? executions.reduce((sum, fill) => sum + fill.quantity * fill.price, 0) / fillQty : null,
              orderPrice: price(row.ord_uv), marketOrder: /시장가/.test(row.trde_tp || ''), executions,
              rejected: /거부|거절/.test(row.acpt_tp || ''), cancelledQuantity: cancellations.get(id) || 0, pending: /접수|확인/.test(row.acpt_tp || ''),
            }))
          }
        })
      } else if (broker === 'toss') {
        for (const group of ['OPEN', 'CLOSED']) await historyStage(group === 'OPEN' ? 'orders_open' : 'orders_closed', () => paged((cursor, signal) => toss({ ...auth, path: '/api/v1/orders', accountSeq: rawAccount,
          query: { status: group, from: days.at(-1), to: days[0], limit: 100, cursor }, signal }), payload => {
          const result = payload.result
          if (!result || typeof result.hasNext !== 'boolean') throw httpError('토스 주문내역 응답을 확인할 수 없습니다.')
          for (const row of list(result, 'orders')) {
            if (row.currency !== 'KRW' || !validSymbol(row.symbol)) continue
            const timestamp = Date.parse(row.orderedAt)
            if (!Number.isFinite(timestamp) || !/[Zz]|[+-]\d{2}:\d{2}$/.test(row.orderedAt)) throw httpError('토스 주문일자를 확인할 수 없습니다.')
            const day = koreanOrderDay(timestamp)
            if (!days.includes(day)) continue
            const execution = row.execution || {}, filledQuantity = positive(execution.filledQuantity), total = positive(execution.filledAmount)
            output.push(normalizeHistoryOrder(broker, selectedAccountRef, day, row.orderId, {
              symbol: row.symbol, name: row.symbol, side: side(row.side), orderedAt: new Date(timestamp).toISOString(),
              quantity: positive(row.quantity), filledQuantity,
              averageFilledPrice: price(execution.averageFilledPrice) ?? (filledQuantity > 0 && total !== null ? total / filledQuantity : null),
              orderPrice: price(row.price), marketOrder: row.orderType === 'MARKET', lastFilledAt: Number.isFinite(Date.parse(execution.filledAt)) ? execution.filledAt : null,
              cancelled: row.status === 'CANCELED', rejected: row.status === 'REJECTED', replaced: row.status === 'REPLACED',
              pending: ['PENDING', 'PENDING_CANCEL', 'PENDING_REPLACE', 'CANCEL_REJECTED', 'REPLACE_REJECTED'].includes(row.status),
            }))
          }
          return { more: result.hasNext, key: result.nextCursor }
        }))
        completedDays.push(...days)
      } else if (broker === 'nh') {
        await daily(async day => {
          const rows = new Map()
          await historyStage('dailyOrderExecution', () => paged((cts, signal) => nh.request(auth, '/krstock/inquiry/v1/dailyOrderExecution', {
            orr_dt: dayString(day), act_no: rawAccount, itg_orr_no: 0, orr_mkt_cd: '00', ost_cns_dit: '0',
          }, { cts, signal }), result => {
            if (!result.rsp_cd) throw httpError('NH 주문내역 응답을 확인할 수 없습니다.')
            for (const row of list(result, 'Output_0', true)) rows.set(no(row.itg_orr_no), row)
            return { more: result.hasMore || ['00165', '00218'].includes(result.rsp_cd), key: result.continuation }
          }))
          const childCancellations = new Map(), children = new Set()
          for (const [id, row] of rows) {
            const parent = no(row.org_itg_orr_no)
            if (parent && parent !== id && parent !== '0' && rows.has(parent) && positive(row.can_qty) > 0 && positive(row.tot_cns_qty) === 0) {
              children.add(id)
              childCancellations.set(parent, (childCancellations.get(parent) || 0) + positive(row.can_qty))
            }
          }
          for (const [id, row] of rows) {
            if (children.has(id)) continue
            const filledQuantity = positive(row.tot_cns_qty), total = positive(row.cns_amt)
            output.push(normalizeHistoryOrder(broker, selectedAccountRef, day, id, {
              symbol: stockCode(row.iem_cd), name: String(row.iem_nm || ''), side: side(row.sby_dit_cd_nm), quantity: positive(row.orr_qty), filledQuantity,
              averageFilledPrice: price(row.cns_avg_uit_pr) ?? (filledQuantity > 0 && total !== null ? total / filledQuantity : null),
              orderPrice: price(row.orr_pr), marketOrder: /시장가/.test(row.nmn_pr_tp_cd_nm || ''),
              cancelledQuantity: Math.max(positive(row.can_qty) || 0, childCancellations.get(id) || 0), rejected: Boolean(String(row.orr_rjt_rsn_cd_nm || '').trim()), pending: positive(row.ny_cns_qty) > 0,
            }))
          }
        })
      } else if (broker === 'kb') {
        await daily(async day => {
          const rows = new Map()
          await historyStage('ssqm2341', () => paged((nxtKey, signal) => kb.request(auth, 'ssqm2341', { ccls_clsf: '0', ordr_dt: dayString(day), nxt_key: nxtKey }, { signal }), result => {
            if ((options && result.grid_cnt1 === undefined && result.Record1 === undefined) ||
              positive(result.grid_cnt1) > (result.Record1?.length || 0)) throw httpError('KB 주문내역 목록을 모두 확인하지 못했습니다.')
            for (const row of list(result, 'Record1', true)) rows.set(no(row.ordr_no), row)
            return { more: Boolean(String(result.nxt_key || '').trim()), key: String(result.nxt_key || '').trim() }
          }))
          const childCancellations = new Map(), children = new Set()
          for (const [id, row] of rows) {
            const parent = no(row.orgn_ordr_no)
            const cancelled = positive(row.sor_cncl_q) || (/취소|CANCEL/i.test(row.crct_cncl_ccd || '') ? positive(row.ordr_q) : 0)
            if (parent && parent !== id && parent !== '0' && rows.has(parent) && cancelled > 0 && positive(row.tl_ccls_q) === 0) {
              children.add(id)
              childCancellations.set(parent, (childCancellations.get(parent) || 0) + cancelled)
            }
          }
          for (const [id, row] of rows) {
            if (children.has(id)) continue
            const isin = String(row.stnd_is_no || '')
            const symbol = /^KR7[0-9A-Z]{6}\d{3}$/.test(isin) ? isin.slice(3, 9) : stockCode(isin)
            output.push(normalizeHistoryOrder(broker, selectedAccountRef, day, id, {
              symbol, name: String(row.hngl_shrt_nm || ''), side: side(row.trd_dl_ccd_nm), orderedAt: timeAt(day, row.ordr_tm),
              quantity: positive(row.ordr_q), filledQuantity: positive(row.tl_ccls_q), orderPrice: price(row.ordr_uprc),
              // ccls_uprc is a fill price, not a documented order-average price.
              marketOrder: row.ordr_ccd === '03', cancelledQuantity: Math.max(positive(row.sor_cncl_q) || 0, childCancellations.get(id) || 0),
              cancelled: /취소|CANCEL/i.test(row.crct_cncl_ccd || '') && positive(row.nccls_q) === 0,
              rejected: Boolean(String(row.rfsl_rsn_nm || '').trim()), pending: positive(row.nccls_q) > 0,
            }))
          }
        })
      } else throw httpError('지원하지 않는 증권사입니다.', 400)
    } catch (error) {
      if (options && !signal?.aborted) error.orderProgress = result()
      throw error
    }
    return { status: 'ready', ...result() }
  }
}
