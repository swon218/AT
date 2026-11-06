import { getAuthenticatedCredentials } from './accountSettings.js'
import { createBrokerHistory, HISTORY_BROKERS, historyNames } from './brokerOrderHistory.js'
import { createOrderCalendar, koreanDay } from './orderCalendar.js'
import { httpError } from './brokerHttp.js'

const required = {
  kiwoom: ['kiwoomAppKey', 'kiwoomSecretKey'], toss: ['tossApiKey', 'tossSecretKey'],
  nh: ['nhAppKey', 'nhSecretKey'], kb: ['kbAppKey', 'kbSecretKey'],
}
const configured = (account, broker) => Boolean(account.status?.[`${broker}Configured`] && required[broker].every(key => account.credentials?.[key]))

export function selectedOrderBrokers(query = {}) {
  if (query.brokers === undefined) return [...HISTORY_BROKERS]
  if (typeof query.brokers !== 'string') throw httpError('조회 증권사를 확인해 주세요.', 400)
  const selected = query.brokers ? query.brokers.split(',') : []
  if (selected.some(broker => !HISTORY_BROKERS.includes(broker))) throw httpError('조회 증권사를 확인해 주세요.', 400)
  return HISTORY_BROKERS.filter(broker => selected.includes(broker))
}

export function sortRecentOrders(items) {
  // No invented midnight for NH's absent order time. Report the ordering limitation.
  return [...items].sort((a, b) => b.date.localeCompare(a.date) ||
    (b.orderedAt ? Date.parse(b.orderedAt) : -Infinity) - (a.orderedAt ? Date.parse(a.orderedAt) : -Infinity) || a.id.localeCompare(b.id))
}

export function createRecentOrderHandlers({ authenticate = getAuthenticatedCredentials, calendar = createOrderCalendar(),
  readBroker = createBrokerHistory(), now = Date.now, timeoutMs = 25_000,
} = {}) {
  async function authorize(request) {
    if (!/^Bearer\s+\S+/i.test(request.headers.authorization || '')) throw httpError('로그인 후 최근 주문 내역을 확인할 수 있습니다.', 401)
    const account = await authenticate(request)
    if (!account?.user?.id) throw httpError('로그인 세션을 확인해 주세요.', 401)
    return account
  }
  async function read(broker, account, days, accountRef) {
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([
        readBroker(broker, account, days, accountRef, controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(httpError('조회 시간 초과', 504)) }, timeoutMs) }),
      ])
    } finally { clearTimeout(timer); controller.abort() }
  }
  function selection(request, broker) {
    const value = String(request.query?.[`${broker}Account`] || '')
    if (value && !/^[a-f0-9]{32}$/.test(value)) throw httpError('조회 계좌를 다시 선택해 주세요.', 400)
    return value
  }
  return {
    async list(request) {
      const account = await authorize(request)
      const selected = selectedOrderBrokers(request.query)
      const selections = Object.fromEntries(selected.map(broker => [broker, selection(request, broker)]))
      const range = selected.some(broker => configured(account, broker)) ? await calendar(koreanDay(now())) : null
      const results = await Promise.all(selected.map(async broker => {
        if (!configured(account, broker)) return { broker, status: 'unconfigured', items: [], accounts: [] }
        try { return { broker, ...await read(broker, account, range.days, selections[broker]) } }
        catch (error) { return { broker, status: 'error', error: error.statusCode === 504 ? 'timeout' : 'broker_unavailable', items: [], accounts: [] } }
      }))
      const items = sortRecentOrders(results.flatMap(result => result.items))
      return { fetchedAt: new Date(now()).toISOString(), range, orderingIncomplete: items.some(item => !item.orderedAt),
        brokers: results.map(({ items: _, ...result }) => result),
        items: items.slice(0, 5).reverse().map(({ executions: _, ...item }) => item) }
    },
    async detail(request) {
      const account = await authorize(request)
      const { broker, id } = request.params
      if (!HISTORY_BROKERS.includes(broker) || !/^[a-f0-9]{64}$/.test(id)) throw httpError('주문 식별자를 확인해 주세요.', 400)
      if (!configured(account, broker)) throw Object.assign(httpError('선택한 증권사의 API 정보를 등록해 주세요.', 403), { missing: [broker] })
      const accountRef = selection(request, broker)
      const range = await calendar(koreanDay(now()))
      const result = await read(broker, account, range.days, accountRef)
      const item = result.items.find(order => order.id === id)
      if (!item) throw httpError('현재 조회 계좌와 기간에서 주문을 찾을 수 없습니다.', 404)
      return { item, fetchedAt: new Date(now()).toISOString() }
    },
  }
}

export function registerRecentOrderRoutes(app, handlers = createRecentOrderHandlers()) {
  for (const [path, action] of [['/api/account/orders/recent', 'list'], ['/api/account/orders/recent/:broker/:id', 'detail']]) {
    app.get(path, { logLevel: 'silent' }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache')
      try { return await handlers[action](request) }
      catch (error) {
        const status = [400, 401, 403, 404, 503, 504].includes(error.statusCode) ? error.statusCode : 502
        return reply.code(status).send({ error: status === 403 ? '선택한 증권사의 API 정보를 등록해 주세요.' : status === 401 ? '로그인 세션을 확인해 주세요.' : status === 503 ? '거래일 달력을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.' : '주문 내역을 조회하지 못했습니다.',
          ...(error.missing ? { missingBrokers: error.missing.map(id => ({ id, name: historyNames[id] })) } : {}) })
      }
    })
  }
}
