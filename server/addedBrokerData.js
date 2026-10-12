import { nhClient } from './nhClient.js'
import { kbClient } from './kbClient.js'
import { fingerprint, httpError, numeric, stockCode, validSymbol } from './brokerHttp.js'

const intervals = new Set(['1분', '5분', '10분', '15분', '30분', '60분', '일', '주', '월'])
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '')
function time(date, clock, minute) {
  const d = String(date || '').trim(), t = String(clock || '').trim().padStart(6, '0')
  if (!/^\d{8}$/.test(d) || (minute && !/^\d{6}$/.test(t))) return ''
  const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  return minute ? `${day}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+09:00` : day
}
const object = value => value && !Array.isArray(value) && typeof value === 'object' ? value : null
const cashHolding = label => !/신용|융자|대주|대출/.test(String(label || ''))

export function createAddedBrokerData({ nh = nhClient, kb = kbClient } = {}) {
  const cache = new Map()
  async function candles(broker, symbol, interval, limit, auth) {
    if (!validSymbol(symbol) || !intervals.has(interval)) throw httpError('종목코드 또는 차트 주기를 확인해 주세요.', 400)
    const key = `${broker}:${fingerprint(auth)}:${symbol}:${interval}:${limit}`
    const cached = cache.get(key)
    if (cached?.until > Date.now()) return cached.items
    const minute = interval.endsWith('분')
    let items
    if (broker === 'nh') {
      const quote = await nh.request(auth, '/krstock/quote/v1/currentPrice', { market_cd: 'KRX', iem_cd: symbol })
      const market = String(quote.Output_0?.mrkt_div_isnm || '')
      if (!/코스피|코스닥|KOSPI|KOSDAQ/i.test(market)) throw httpError('NH 종목 시장을 확인할 수 없습니다.')
      const result = await nh.request(auth, '/krstock/quote/v1/period', {
        market_cd: 'KRX', iem_cd: symbol, mrkt_div_cls_code: /코스닥|KOSDAQ/i.test(market) ? '4' : '1',
        edate: today(), array_cnt: String(limit), maxavg: '0', gubun: minute ? '5' : ({ 일: '1', 주: '2', 월: '3' })[interval],
        xtick: minute ? interval.replace('분', '') : '1', today_cls_code: '0', fake_tick: '0', sur_flag: '0',
        out1_scale_change: '0', out2_scale_change: '0', view_main_yn: 'Y',
      })
      if (!Array.isArray(result.Output_1)) throw httpError('NH 차트 데이터가 없습니다.')
      items = result.Output_1.map(row => ({ time: time(row.bsop_date, row.bsop_time, minute), open: numeric(row.stck_oprc), high: numeric(row.stck_hgpr), low: numeric(row.stck_lwpr), close: numeric(row.stck_prpr), volume: numeric(row.vol) }))
    } else {
      const quote = await kb.request(auth, 'ivu10140', { excg_clsf: '0', shrt_cd: symbol })
      const market = String(quote.mkt_clsf_nm || '')
      if (!/코스피|거래소|유가증권|코스닥|KOSPI|KOSDAQ/i.test(market)) throw httpError('KB 종목 시장을 확인할 수 없습니다.')
      const result = await kb.request(auth, 'ivs11560', {
        info_ccd: '2', mkt_clsf: /코스닥|KOSDAQ/i.test(market) ? '1' : '0', chrt_clsf: minute ? 'B' : ({ 일: 'D', 주: 'W', 월: 'M' })[interval],
        minute_tck_indx: minute ? interval.replace('분', '') : '1', is_cd: symbol, inq_clsf: '2', strt_dy: today(), inq_cnt: String(limit),
      })
      if (!Array.isArray(result.out2)) throw httpError('KB 차트 데이터가 없습니다.')
      items = result.out2.map(row => ({ time: time(row.dt, row.tm, minute), open: numeric(row.opn_prc_p2), high: numeric(row.hgh_prc_p2), low: numeric(row.lw_prc_p2), close: numeric(row.cls_prc_p2), volume: numeric(row.vlm) }))
    }
    items = [...new Map(items.filter(row => row.time && [row.open, row.high, row.low, row.close].every(value => value > 0) && row.volume !== null).map(row => [row.time, row])).values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-limit)
    if (!items.length) throw httpError('표시할 차트 데이터가 없습니다.')
    if (cache.size >= 300) cache.delete(cache.keys().next().value)
    cache.set(key, { items, until: Date.now() + 30_000 })
    return items
  }

  async function nhAccounts(auth) {
    const result = await nh.request(auth, '/n2/acctinfo', {})
    const accounts = (Array.isArray(result.Output_0) ? result.Output_0 : [])
      .filter(row => (nh.simulated ? ['03'] : ['01', '02']).includes(row.acct_type) && /^\d{11}$/.test(row.acct_no))
      .map(row => ({ id: row.acct_no, label: `${row.acct_no.slice(0, 3)}-****-${row.acct_no.slice(-4)}${row.acct_type === '03' ? ' (모의)' : ''}` }))
    if (!accounts.length) throw httpError('NH API에 연결된 사용 가능한 계좌가 없습니다.', 403)
    return accounts
  }

  function selectAccount(accounts, accountId) {
    if (accountId) {
      if (!accounts.some(account => account.id === accountId)) throw httpError('본인 API에 연결된 NH 계좌를 선택해 주세요.', 403)
      return accountId
    }
    return accounts.length === 1 ? accounts[0].id : ''
  }

  async function summary(broker, auth, symbol, accountId = '') {
    if (symbol && !validSymbol(symbol)) throw httpError('국내주식 종목코드를 확인해 주세요.', 400)
    if (broker === 'nh') {
      const accounts = await nhAccounts(auth), selectedAccountId = selectAccount(accounts, accountId)
      if (!selectedAccountId) return { broker, accounts, selectedAccountId: '', accountRequired: true, holdings: [] }
      let cts = '', total = null, rows = []
      const seen = new Set()
      for (let page = 0; page < 50; page++) {
        const result = await nh.request(auth, '/krstock/inquiry/v1/balance', { act_no: selectedAccountId, bnc_bse_cd: '1', ltg_aot_dit_cd: '9', aet_bse: '1', qut_dit_cd: 'KRX', aly_qut_cd: '1' }, { cts })
        rows.push(...(Array.isArray(result.Output_1) ? result.Output_1 : []))
        total = object(result.Output_0) || total
        // NH sends the totals only on the final balance page.
        if (!result.hasMore && !['00165', '00218'].includes(result.rsp_cd)) break
        if (!result.continuation || seen.has(result.continuation) || page === 49) throw httpError('NH 잔고 연속 조회를 완료하지 못했습니다.')
        cts = result.continuation
        seen.add(cts)
      }
      if (!total) throw httpError('NH 잔고 합계를 확인할 수 없습니다.')
      const power = symbol ? await nh.request(auth, '/krstock/inquiry/v1/buyableQuantity', { ost_dit_cd: '1', act_no: selectedAccountId, iem_cd: symbol, nmn_pr_tp_cd: '05', orr_pr: 0, cfd_lon_cd: '', lon_dt: '' }) : null
      const sellable = symbol ? await nh.request(auth, '/krstock/inquiry/v1/sellableQuantity', { act_no: selectedAccountId, iem_cd: symbol, lon_dt: '', cfd_lon_cd: '00' }) : null
      const holdings = rows.filter(row => cashHolding(row.tp_cd_nm)).map(row => {
        const quantity = numeric(row.itg_bnc_qty), averagePrice = numeric(row.phs_pr), code = stockCode(row.iem_cd)
        return { code, name: String(row.iem_nm || '').trim(), quantity, averagePrice, currentPrice: numeric(row.now_pr), purchaseAmount: quantity !== null && averagePrice !== null ? quantity * averagePrice : null, evaluationAmount: numeric(row.eal_amt), evaluationProfit: numeric(row.eal_pls_amt), profitRate: numeric(row.pft_rt), tradableQuantity: code === symbol ? numeric(sellable?.Output_0?.sll_pbl_qty) : null }
      })
      return { broker, accounts, selectedAccountId, accountRequired: false, holdings, cash: numeric(total.dca), orderableAmount: numeric(power?.Output_0?.csh_orr_pbl_amt), withdrawableAmount: numeric(total.drn_pbl_amt), totalPurchaseAmount: numeric(total.tot_byn_amt), totalEvaluationAmount: numeric(total.tot_eal_amt), totalEvaluationProfit: numeric(total.tot_eal_pls), totalProfitRate: numeric(total.pft_rt), estimatedAssets: numeric(total.nas_amt), updatedAt: new Date().toISOString() }
    }
    const total = await kb.request(auth, 'ssqm2952', { excg_mktpr_ccd: 'K' })
    const power = await kb.request(auth, 'ssqm1802', { is_no: symbol })
    const rows = Array.isArray(total.Record1) ? total.Record1 : []
    if (numeric(total.tl_data_cnt) > rows.length) throw httpError('KB 잔고 전체를 확인하지 못했습니다. 증권사에서 잔고를 확인해 주세요.')
    let sellable = [], nextKey = ''
    const seen = new Set()
    for (let page = 0; symbol && page < 50; page++) {
      const result = await kb.request(auth, 'ssqm1801', { inq_clsf: '0', is_no: symbol, mkt_tm_ccd: '1', nxt_key: nextKey })
      sellable.push(...(Array.isArray(result.Record1) ? result.Record1 : []))
      const next = String(result.nxt_key || '').trim()
      if (!next) break
      if (seen.has(next) || page === 49) throw httpError('KB 매도 가능 수량의 연속 조회를 완료하지 못했습니다.')
      seen.add(next)
      nextKey = next
    }
    const holdings = rows.filter(row => cashHolding(row.clsf)).map(row => {
      const code = stockCode(row.is_cd), sell = sellable.find(item => stockCode(item.is_no) === code)
      return { code, name: String(row.is_nm || '').trim(), quantity: numeric(row.ec_q), averagePrice: numeric(row.byng_avr_prc), currentPrice: numeric(row.now_prc), purchaseAmount: numeric(row.byng_amt), evaluationAmount: numeric(row.val_amt), evaluationProfit: numeric(row.val_pl), profitRate: numeric(row.val_yld), tradableQuantity: numeric(sell?.ordr_psbl_q ?? row.ordr_psbl_q) }
    })
    return { broker, holdings, accountRequired: false, orderableAmount: numeric(power.pcnt100_ordr_psbl_amt), cash: numeric(total.dy_tfnd), withdrawableAmount: numeric(power.do_psbl_csh), totalPurchaseAmount: numeric(total.byng_amt_sum), totalEvaluationAmount: numeric(total.val_amt_sum), totalEvaluationProfit: numeric(total.val_pl_sum), totalProfitRate: numeric(total.val_yld_sum), estimatedAssets: numeric(total.nt_asts_val_amt), updatedAt: new Date().toISOString() }
  }
  return { candles, summary, nhAccounts, selectAccount }
}
export const addedBrokerData = createAddedBrokerData()
