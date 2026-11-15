import { getAuthenticatedCredentials } from './accountSettings.js'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'
import { httpError, numeric, validSymbol } from './brokerHttp.js'

const number = (value) => {
  const parsed = Number(String(value ?? '0').replace(/[,\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

const absoluteNumber = (value) => Math.abs(number(value))
const stockCode = (value) => String(value ?? '').replace(/^A/, '').split('_')[0]
const holdingNumber = value => typeof value === 'string' || typeof value === 'number' ? numeric(value) : null
const ownedQuantity = value => { const quantity = holdingNumber(value); return quantity !== null && quantity >= 0 ? quantity : null }

export function normalizeKiwoomHoldings(balance) {
  const noHoldings = balance?.acnt_evlt_remn_indv_tot === undefined && numeric(balance?.tot_pur_amt) === 0 && numeric(balance?.tot_evlt_amt) === 0
  if (!balance || ![0, '0'].includes(balance.return_code) || (!Array.isArray(balance.acnt_evlt_remn_indv_tot) && !noHoldings)) {
    throw httpError('키움 보유정보 응답을 확인할 수 없습니다.')
  }
  return (balance.acnt_evlt_remn_indv_tot || []).map(row => {
    if (!row || typeof row !== 'object' || (!validSymbol(stockCode(row.stk_cd)) && !/^[JQ][0-9][0-9A-Z]{5}$/.test(String(row.stk_cd || '')))) throw httpError('키움 보유정보 응답을 확인할 수 없습니다.')
    return {
      code: stockCode(row.stk_cd),
      name: String(row.stk_nm || ''),
      // These are current owned quantity and the broker's position purchase price,
      // never sellable quantity, last trade, or a recomputed market-value ratio.
      quantity: ownedQuantity(row.rmnd_qty),
      tradableQuantity: numeric(row.trde_able_qty),
      averagePrice: holdingNumber(row.pur_pric),
      currentPrice: absoluteNumber(row.cur_prc),
      purchaseAmount: absoluteNumber(row.pur_amt),
      evaluationAmount: absoluteNumber(row.evlt_amt),
      evaluationProfit: number(row.evltv_prft),
      profitRate: number(row.prft_rt),
    }
  }).filter(item => item.quantity === null || item.quantity > 0)
}

export function createKiwoomAccountSummary({ authenticate = getAuthenticatedCredentials, requestAccount = requestKiwoomWithCredentials } = {}) {
 return async function getSummary(request) {
  const { credentials, status } = await authenticate(request)
  if (!status.kiwoomConfigured || !credentials.kiwoomAppKey || !credentials.kiwoomSecretKey) {
    const error = new Error('개인 설정에서 키움 App Key와 Secret Key를 먼저 저장해 주세요.')
    error.statusCode = 403
    throw error
  }

  const signal = AbortSignal.timeout(20_000)
  const call = ({ apiId, body, ...options }) => requestAccount({
    appKey: credentials.kiwoomAppKey,
    secretKey: credentials.kiwoomSecretKey,
    apiId,
    endpoint: '/api/dostk/acnt',
    body,
    signal,
    ...options,
  })

  const readBalance = async () => {
    let nextKey = '', balance = {}, rows = []
    const seen = new Set()
    for (let page = 0; page < 50; page++) {
      const result = await call({ apiId: 'kt00018', body: { qry_tp: '1', dmst_stex_tp: 'KRX' }, returnPage: true, contYn: page ? 'Y' : 'N', nextKey })
      // Validate every page before calling an incomplete/empty list authoritative.
      normalizeKiwoomHoldings(result.body)
      if (result.contYn === 'Y' && !Array.isArray(result.body.acnt_evlt_remn_indv_tot)) throw httpError('키움 보유정보 연속 조회를 완료하지 못했습니다.')
      rows.push(...(result.body.acnt_evlt_remn_indv_tot || []))
      balance = { ...balance, ...result.body }
      if (result.contYn !== 'Y') return { ...balance, acnt_evlt_remn_indv_tot: rows }
      if (!result.nextKey || seen.has(result.nextKey) || page === 49) throw httpError('키움 보유정보 연속 조회를 완료하지 못했습니다.')
      nextKey = result.nextKey
      seen.add(nextKey)
    }
  }

  const [deposit, balance] = await Promise.all([
    call({ apiId: 'kt00001', body: { qry_tp: '2' } }),
    readBalance(),
  ])

  const holdings = normalizeKiwoomHoldings(balance)

  return {
    broker: 'kiwoom',
    cash: number(deposit.entr),
    orderableAmount: number(deposit.ord_alow_amt),
    withdrawableAmount: number(deposit.pymn_alow_amt),
    totalPurchaseAmount: number(balance.tot_pur_amt),
    totalEvaluationAmount: number(balance.tot_evlt_amt),
    totalEvaluationProfit: number(balance.tot_evlt_pl),
    totalProfitRate: number(balance.tot_prft_rt),
    estimatedAssets: number(balance.prsm_dpst_aset_amt),
    holdings,
    updatedAt: new Date().toISOString(),
  }
 }
}
export const getKiwoomAccountSummary = createKiwoomAccountSummary()
