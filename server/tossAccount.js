import { getAuthenticatedCredentials } from './accountSettings.js'
import { getTossBrokerageAccount, requestTossWithCredentials } from './tossClient.js'

const number = (value) => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function getTossAccountSummary(request) {
  const { credentials, status } = await getAuthenticatedCredentials(request)
  if (!status.tossConfigured || !credentials.tossApiKey || !credentials.tossSecretKey) {
    const error = new Error('개인 설정에서 토스 Client ID와 Client Secret을 먼저 저장해 주세요.')
    error.statusCode = 403
    throw error
  }

  const auth = { apiKey: credentials.tossApiKey, secretKey: credentials.tossSecretKey }
  const account = await getTossBrokerageAccount(auth)
  const symbol = String(request.query?.symbol || '')
  if (symbol && !/^\d{6}$/.test(symbol)) {
    const error = new Error('국내주식 종목코드를 확인해 주세요.')
    error.statusCode = 400
    throw error
  }

  const call = ({ path, query }) => requestTossWithCredentials({ ...auth, path, query, accountSeq: account.accountSeq })
  const [holdingsPayload, buyingPowerPayload, sellablePayload] = await Promise.all([
    call({ path: '/api/v1/holdings' }),
    call({ path: '/api/v1/buying-power', query: { currency: 'KRW' } }),
    symbol ? call({ path: '/api/v1/sellable-quantity', query: { symbol } }).catch(() => ({ result: { sellableQuantity: '0' } })) : null,
  ])

  const overview = holdingsPayload.result || {}
  const sellableQuantity = number(sellablePayload?.result?.sellableQuantity)
  const holdings = (Array.isArray(overview.items) ? overview.items : [])
    .filter((item) => item.marketCountry === 'KR' && item.currency === 'KRW')
    .map((item) => ({
      code: String(item.symbol || ''),
      name: String(item.name || ''),
      quantity: number(item.quantity),
      tradableQuantity: item.symbol === symbol ? sellableQuantity : number(item.quantity),
      averagePrice: number(item.averagePurchasePrice),
      currentPrice: number(item.lastPrice),
      purchaseAmount: number(item.marketValue?.purchaseAmount),
      evaluationAmount: number(item.marketValue?.amount),
      evaluationProfit: number(item.profitLoss?.amount),
      profitRate: number(item.profitLoss?.rate) * 100,
    }))
  const orderableAmount = number(buyingPowerPayload.result?.cashBuyingPower)
  const totalEvaluationAmount = number(overview.marketValue?.amount?.krw)

  return {
    broker: 'toss',
    cash: orderableAmount,
    orderableAmount,
    withdrawableAmount: 0,
    totalPurchaseAmount: number(overview.totalPurchaseAmount?.krw),
    totalEvaluationAmount,
    totalEvaluationProfit: number(overview.profitLoss?.amount?.krw),
    totalProfitRate: number(overview.profitLoss?.rate) * 100,
    estimatedAssets: orderableAmount + totalEvaluationAmount,
    holdings,
    updatedAt: new Date().toISOString(),
  }
}
