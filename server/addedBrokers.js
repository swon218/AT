import { createHash } from 'node:crypto'
import { config } from './config.js'
import { getAuthenticatedCredentials } from './accountSettings.js'
import { getCandles } from './charts.js'
import { requestKiwoom } from './kiwoomClient.js'
import { addedBrokerData } from './addedBrokerData.js'
import { nhClient } from './nhClient.js'
import { kbClient } from './kbClient.js'
import { httpError, validSymbol } from './brokerHttp.js'
import { storeBrokerOrder } from './brokerOrderStore.js'

const names = { nh: 'NH투자증권', kb: 'KB증권' }
function authFrom(account, broker) {
  const appKey = account?.credentials?.[`${broker}AppKey`], secretKey = account?.credentials?.[`${broker}SecretKey`]
  return account?.status?.[`${broker}Configured`] && appKey && secretKey ? { appKey, secretKey } : null
}

export function normalizeAddedOrder(input) {
  const side = input.side, symbol = String(input.symbol || '').trim(), session = input.session || 'regular', priceType = input.priceType
  if (!['buy', 'sell'].includes(side) || !validSymbol(symbol) || !['regular', 'pre', 'post'].includes(session) || !['limit', 'market'].includes(priceType)) throw httpError('주문 구분과 종목을 확인해 주세요.', 400)
  const integer = (value, maximum) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= maximum
  if (!integer(input.quantity, 1_000_000)) throw httpError('주문수량을 확인해 주세요.', 400)
  if (session === 'regular' && priceType === 'limit' && !integer(input.price, 999_999_999)) throw httpError('주문가격을 확인해 주세요.', 400)
  const exchange = input.exchange || 'KRX'
  if (!['KRX', 'NXT', 'SOR'].includes(exchange) || (session !== 'regular' && exchange !== 'KRX')) throw httpError('해당 거래소의 주문 유형을 지원하지 않습니다.', 400)
  const clientRequestId = String(input.clientRequestId || '')
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clientRequestId)) throw httpError('주문 요청 식별자를 확인해 주세요.', 400)
  return { side, symbol, session, priceType, exchange, quantity: Number(input.quantity), price: session === 'regular' && priceType === 'limit' ? Number(input.price) : 0, accountId: String(input.accountId || ''), clientRequestId }
}

export function nhOrderInput(order, accountId) {
  return { act_no: accountId, iem_cd: order.symbol, orr_qty: order.quantity, orr_pr: order.price, orr_amt: 0,
    nmn_pr_tp_cd: order.session === 'pre' ? '61' : order.session === 'post' ? '71' : order.priceType === 'market' ? '05' : '01',
    orr_cnd_dit_cd: '00', ssl_nmn_pr_dit_cd: '00', sop_cnd_pr: 0, rmt_mkt_cd: order.exchange, sor_mkt_sli_yn: 'N' }
}
export function kbOrderInput(order) {
  return { mkt_tm_clsf: ({ regular: '1', pre: '2', post: '3' })[order.session], is_cd: order.symbol, ordr_q: String(order.quantity), ordr_uprc: String(order.price),
    ordr_ccd: order.session !== 'regular' ? '99' : order.priceType === 'market' ? '03' : '00', sor_ordr_ccd: ({ KRX: 'K', NXT: 'N', SOR: 'S' })[order.exchange] }
}

export function createAddedBrokerHandlers({ settings = config, authenticate = getAuthenticatedCredentials, data = addedBrokerData, kiwoomCandles = getCandles, nh = nhClient, kb = kbClient, storeOrder = storeBrokerOrder } = {}) {
  const accountFor = async request => request.headers.authorization ? authenticate(request) : null
  async function personal(request, broker) {
    const account = await authenticate(request), auth = authFrom(account, broker)
    if (!auth) throw httpError(`개인 설정에서 본인의 ${names[broker]} 앱키와 시크릿키를 저장해 주세요.`, 403)
    return { account, auth }
  }
  return {
    async candles(request, broker) {
      const { symbol = '', interval = '일' } = request.query || {}, limit = Math.min(500, Math.max(1, Number(request.query?.limit) || 200))
      const account = await accountFor(request), auth = authFrom(account, broker)
      if (auth) return { items: await data.candles(broker, symbol, interval, limit, auth), sourceBroker: broker, credentialScope: 'personal' }
      if (broker === 'kb' && !(settings.kbAppKey && settings.kbSecretKey)) {
        // Explicit operator context: never use another personal broker key here.
        return { items: await kiwoomCandles(symbol, interval, limit, { requester: requestKiwoom, cacheScope: 'operator' }), sourceBroker: 'kiwoom', credentialScope: 'operator', fallback: true }
      }
      return { items: await data.candles(broker, symbol, interval, limit, { appKey: settings[`${broker}AppKey`], secretKey: settings[`${broker}SecretKey`] }), sourceBroker: broker, credentialScope: 'operator' }
    },
    async summary(request, broker) {
      const { auth } = await personal(request, broker)
      return data.summary(broker, auth, String(request.query?.symbol || ''), String(request.query?.accountId || ''))
    },
    async order(request, broker) {
      const { account, auth } = await personal(request, broker)
      if (!settings[`${broker}OrdersEnabled`]) throw httpError(`VPS에서 ${names[broker]} 주문 기능이 활성화되지 않았습니다.`, 503)
      const order = normalizeAddedOrder(request.body || {})
      if (broker === 'nh') {
        order.accountId = data.selectAccount(await data.nhAccounts(auth), order.accountId)
        if (!order.accountId) throw httpError('주문할 NH 계좌를 선택해 주세요.', 400)
      }
      const digest = createHash('sha256').update(JSON.stringify(order)).digest('hex')
      return storeOrder({ userId: account.user.id, broker, requestId: order.clientRequestId, digest }, async () => {
        let orderNumber
        if (broker === 'nh') {
          const result = await nh.request(auth, `/krstock/order/v1/${order.side === 'buy' ? 'cashBuy' : 'cashSell'}`, nhOrderInput(order, order.accountId), { write: true })
          orderNumber = result.Output_0?.mkt_orr_no
        } else {
          const result = await kb.request(auth, order.side === 'buy' ? 'ssam1802' : 'ssam1801', kbOrderInput(order), { write: true })
          orderNumber = result.ordr_no
        }
        if (!/^\d+$/.test(String(orderNumber || '').trim()) || Number(orderNumber) <= 0) throw httpError('증권사의 주문번호를 확인할 수 없습니다. 주문 내역을 확인해 주세요.')
        return { broker, side: order.side, symbol: order.symbol, quantity: order.quantity, price: order.price, orderNumber: String(orderNumber).trim(), message: `${names[broker]} 주문이 접수되었습니다.` }
      })
    },
  }
}

export function registerAddedBrokerRoutes(app, handlers = createAddedBrokerHandlers()) {
  for (const broker of ['nh', 'kb']) {
    for (const [method, path, action] of [
      ['get', `/api/public/market/${broker}/candles`, 'candles'],
      ['get', `/api/account/${broker}/summary`, 'summary'],
      ['post', `/api/orders/${broker}`, 'order'],
    ]) app[method](path, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      try { return await handlers[action](request, broker) }
      catch (error) { return reply.code(error.statusCode || 502).send({ error: error.message }) }
    })
  }
}
