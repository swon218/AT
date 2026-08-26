import { getAuthenticatedCredentials } from './accountSettings.js'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'

const number = (value) => {
  const parsed = Number(String(value ?? '0').replace(/[,\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

const absoluteNumber = (value) => Math.abs(number(value))
const stockCode = (value) => String(value ?? '').replace(/^A/, '').split('_')[0]

export async function getKiwoomAccountSummary(request) {
  const { credentials, status } = await getAuthenticatedCredentials(request)
  if (!status.kiwoomConfigured || !credentials.kiwoomAppKey || !credentials.kiwoomSecretKey) {
    const error = new Error('개인 설정에서 키움 App Key와 Secret Key를 먼저 저장해 주세요.')
    error.statusCode = 403
    throw error
  }

  const call = ({ apiId, body }) => requestKiwoomWithCredentials({
    appKey: credentials.kiwoomAppKey,
    secretKey: credentials.kiwoomSecretKey,
    apiId,
    endpoint: '/api/dostk/acnt',
    body,
  })

  const [deposit, balance] = await Promise.all([
    call({ apiId: 'kt00001', body: { qry_tp: '2' } }),
    call({ apiId: 'kt00018', body: { qry_tp: '1', dmst_stex_tp: 'KRX' } }),
  ])

  const rows = Array.isArray(balance.acnt_evlt_remn_indv_tot) ? balance.acnt_evlt_remn_indv_tot : []
  const holdings = rows.map((row) => ({
    code: stockCode(row.stk_cd),
    name: String(row.stk_nm || ''),
    quantity: absoluteNumber(row.rmnd_qty),
    tradableQuantity: absoluteNumber(row.trde_able_qty),
    averagePrice: absoluteNumber(row.pur_pric),
    currentPrice: absoluteNumber(row.cur_prc),
    purchaseAmount: absoluteNumber(row.pur_amt),
    evaluationAmount: absoluteNumber(row.evlt_amt),
    evaluationProfit: number(row.evltv_prft),
    profitRate: number(row.prft_rt),
  })).filter((item) => item.code && item.quantity > 0)

  return {
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
