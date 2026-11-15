import { getAuthenticatedCredentials } from './accountSettings.js'
import { getTossBrokerageAccount, requestTossWithCredentials } from './tossClient.js'
import { httpError, numeric, validSymbol } from './brokerHttp.js'

const number = (value) => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}
const holdingNumber = value => typeof value === 'string' || typeof value === 'number' ? numeric(value) : null
const ownedQuantity = value => { const quantity = holdingNumber(value); return quantity !== null && quantity >= 0 ? quantity : null }

export function normalizeTossHoldings(payload, symbol = '', sellableQuantity = null) {
  if (!payload || payload.error != null || payload.success === false || !Array.isArray(payload.result?.items)) {
    throw httpError('토스 보유정보 응답을 확인할 수 없습니다.')
  }
  return payload.result.items
    .filter(item => {
      if (!item || typeof item !== 'object' || typeof item.marketCountry !== 'string' || typeof item.currency !== 'string') throw httpError('토스 보유정보 응답을 확인할 수 없습니다.')
      return item.marketCountry === 'KR' && item.currency === 'KRW'
    })
    .map(item => {
      if (!validSymbol(String(item.symbol || ''))) throw httpError('토스 보유정보 응답을 확인할 수 없습니다.')
      return {
        code: String(item.symbol), name: String(item.name || ''),
        quantity: ownedQuantity(item.quantity),
        tradableQuantity: item.symbol === symbol ? numeric(sellableQuantity) : numeric(item.quantity),
        averagePrice: holdingNumber(item.averagePurchasePrice),
        currentPrice: number(item.lastPrice),
        purchaseAmount: number(item.marketValue?.purchaseAmount),
        evaluationAmount: number(item.marketValue?.amount),
        evaluationProfit: number(item.profitLoss?.amount),
        profitRate: number(item.profitLoss?.rate) * 100,
      }
    })
}

export function createTossAccountSummary({ authenticate = getAuthenticatedCredentials, getAccount = getTossBrokerageAccount, requestAccount = requestTossWithCredentials, timeoutMs = 20_000 } = {}) {
 return async function getSummary(request) {
  const { credentials, status } = await authenticate(request)
  if (!status.tossConfigured || !credentials.tossApiKey || !credentials.tossSecretKey) {
    const error = new Error('개인 설정에서 토스 Client ID와 Client Secret을 먼저 저장해 주세요.')
    error.statusCode = 403
    throw error
  }

  const signal = AbortSignal.timeout(timeoutMs)
  const auth = { apiKey: credentials.tossApiKey, secretKey: credentials.tossSecretKey }
  const account = await getAccount(auth, { signal })
  const symbol = String(request.query?.symbol || '')
  if (symbol && !/^\d{6}$/.test(symbol)) {
    const error = new Error('국내주식 종목코드를 확인해 주세요.')
    error.statusCode = 400
    throw error
  }

  const call = ({ path, query }) => requestAccount({ ...auth, path, query, accountSeq: account.accountSeq, signal })
  const [holdingsPayload, buyingPowerPayload, sellablePayload] = await Promise.all([
    call({ path: '/api/v1/holdings' }),
    call({ path: '/api/v1/buying-power', query: { currency: 'KRW' } }),
    symbol ? call({ path: '/api/v1/sellable-quantity', query: { symbol } }).catch(() => ({ result: { sellableQuantity: '0' } })) : null,
  ])

  const overview = holdingsPayload.result || {}
  const sellableQuantity = numeric(sellablePayload?.result?.sellableQuantity)
  const holdings = normalizeTossHoldings(holdingsPayload, symbol, sellableQuantity)
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
}
export const getTossAccountSummary = createTossAccountSummary()
