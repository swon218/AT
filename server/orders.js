import { getAuthenticatedCredentials } from './accountSettings.js'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'
import { config } from './config.js'

const recentOrders = new Map()
const ORDER_DEDUPE_MS = 5 * 60 * 1000

function httpError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function positiveInteger(value, label, maximum) {
  const normalized = String(value ?? '').trim()
  if (!/^\d+$/.test(normalized)) throw httpError(`${label}을(를) 올바르게 입력해 주세요.`)
  const number = Number(normalized)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw httpError(`${label} 범위를 확인해 주세요.`)
  }
  return String(number)
}

function normalizeOrder(input) {
  const side = input.side === 'sell' ? 'sell' : input.side === 'buy' ? 'buy' : ''
  if (!side) throw httpError('매수 또는 매도를 선택해 주세요.')

  const symbol = String(input.symbol || '').trim()
  if (!/^\d{6}$/.test(symbol)) throw httpError('국내주식 종목코드를 확인해 주세요.')

  const exchange = String(input.exchange || 'KRX').toUpperCase()
  if (!['KRX', 'NXT', 'SOR'].includes(exchange)) throw httpError('지원하지 않는 거래소입니다.')

  const session = ['regular', 'pre', 'post'].includes(input.session) ? input.session : 'regular'
  const priceType = input.priceType === 'market' ? 'market' : 'limit'
  const quantity = positiveInteger(input.quantity, '주문수량', 1_000_000)

  let tradeType = priceType === 'market' ? '3' : '0'
  let price = ''
  if (session === 'pre') tradeType = '61'
  else if (session === 'post') tradeType = '81'
  else if (priceType === 'limit') price = positiveInteger(input.price, '주문가격', 1_000_000_000)

  const clientRequestId = String(input.clientRequestId || '').trim()
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clientRequestId)) throw httpError('주문 요청 식별자가 올바르지 않습니다.')

  return { side, symbol, exchange, session, priceType, quantity, price, tradeType, clientRequestId }
}

function pruneRecentOrders() {
  const now = Date.now()
  for (const [key, value] of recentOrders) {
    if (value.expiresAt <= now) recentOrders.delete(key)
  }
}

export async function placeKiwoomOrder(request) {
  if (!config.kiwoomOrdersEnabled) {
    throw httpError('VPS에서 키움 주문 기능이 활성화되지 않았습니다.', 503)
  }
  const { user, credentials, status } = await getAuthenticatedCredentials(request)
  if (!status.kiwoomConfigured || !credentials.kiwoomAppKey || !credentials.kiwoomSecretKey) {
    throw httpError('개인 설정에서 키움 App Key와 Secret Key를 먼저 저장해 주세요.', 403)
  }

  const order = normalizeOrder(request.body && typeof request.body === 'object' ? request.body : {})
  pruneRecentOrders()
  const dedupeKey = `${user.id}:${order.clientRequestId}`
  const existing = recentOrders.get(dedupeKey)
  if (existing) return existing.promise

  const promise = requestKiwoomWithCredentials({
    appKey: credentials.kiwoomAppKey,
    secretKey: credentials.kiwoomSecretKey,
    apiId: order.side === 'buy' ? 'kt10000' : 'kt10001',
    endpoint: '/api/dostk/ordr',
    body: {
      dmst_stex_tp: order.exchange,
      stk_cd: order.symbol,
      ord_qty: order.quantity,
      ord_uv: order.price,
      trde_tp: order.tradeType,
      cond_uv: '',
    },
  }).then((result) => ({
    broker: 'kiwoom',
    side: order.side,
    symbol: order.symbol,
    quantity: order.quantity,
    price: order.price,
    orderNumber: result.ord_no || '',
    message: result.return_msg || '주문 요청이 처리되었습니다.',
  }))

  recentOrders.set(dedupeKey, { expiresAt: Date.now() + ORDER_DEDUPE_MS, promise })
  try {
    return await promise
  } catch (error) {
    recentOrders.delete(dedupeKey)
    throw error
  }
}
