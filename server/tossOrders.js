import { config } from './config.js'
import { getAuthenticatedCredentials } from './accountSettings.js'
import { getTossBrokerageAccount, requestTossWithCredentials } from './tossClient.js'

const recentOrders = new Map()
const ORDER_DEDUPE_MS = 10 * 60 * 1000

function httpError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function positiveInteger(value, label, maximum) {
  const normalized = String(value ?? '').trim()
  if (!/^\d+$/.test(normalized)) throw httpError(`${label}을(를) 올바르게 입력해 주세요.`)
  const number = Number(normalized)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw httpError(`${label} 범위를 확인해 주세요.`)
  return String(number)
}

function normalizeOrder(input) {
  const side = input.side === 'sell' ? 'SELL' : input.side === 'buy' ? 'BUY' : ''
  if (!side) throw httpError('매수 또는 매도를 선택해 주세요.')
  const symbol = String(input.symbol || '').trim()
  if (!/^\d{6}$/.test(symbol)) throw httpError('국내주식 종목코드를 확인해 주세요.')
  if (input.session && input.session !== 'regular') throw httpError('토스 주문은 현재 정규장 주문만 지원합니다.')
  const orderType = input.priceType === 'market' ? 'MARKET' : 'LIMIT'
  const quantity = positiveInteger(input.quantity, '주문수량', 1_000_000)
  const price = orderType === 'LIMIT' ? positiveInteger(input.price, '주문가격', 1_000_000_000) : ''
  const clientOrderId = String(input.clientRequestId || '').trim().slice(0, 36)
  if (!/^[a-zA-Z0-9_-]{12,36}$/.test(clientOrderId)) throw httpError('주문 요청 식별자가 올바르지 않습니다.')
  return { side, symbol, orderType, quantity, price, clientOrderId }
}

function pruneRecentOrders() {
  const now = Date.now()
  for (const [key, value] of recentOrders) if (value.expiresAt <= now) recentOrders.delete(key)
}

export async function placeTossOrder(request) {
  if (!config.tossOrdersEnabled) throw httpError('VPS에서 토스 주문 기능이 활성화되지 않았습니다.', 503)
  const { user, credentials, status } = await getAuthenticatedCredentials(request)
  if (!status.tossConfigured || !credentials.tossApiKey || !credentials.tossSecretKey) {
    throw httpError('개인 설정에서 토스 Client ID와 Client Secret을 먼저 저장해 주세요.', 403)
  }

  const order = normalizeOrder(request.body && typeof request.body === 'object' ? request.body : {})
  pruneRecentOrders()
  const dedupeKey = `${user.id}:toss:${order.clientOrderId}`
  const existing = recentOrders.get(dedupeKey)
  if (existing) return existing.promise

  const auth = { apiKey: credentials.tossApiKey, secretKey: credentials.tossSecretKey }
  const promise = getTossBrokerageAccount(auth).then((account) => requestTossWithCredentials({
    ...auth,
    path: '/api/v1/orders',
    method: 'POST',
    accountSeq: account.accountSeq,
    body: {
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      ...(order.orderType === 'LIMIT' ? { price: order.price } : {}),
      confirmHighValueOrder: order.orderType === 'LIMIT' && Number(order.price) * Number(order.quantity) >= 100_000_000,
    },
  })).then((payload) => ({
    broker: 'toss',
    side: order.side.toLowerCase(),
    symbol: order.symbol,
    quantity: order.quantity,
    price: order.price,
    orderNumber: payload.result?.orderId || '',
    message: '토스증권 주문 요청이 처리되었습니다.',
  }))

  recentOrders.set(dedupeKey, { expiresAt: Date.now() + ORDER_DEDUPE_MS, promise })
  try { return await promise } catch (error) { recentOrders.delete(dedupeKey); throw error }
}
