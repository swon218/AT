import { getAuthenticatedCredentials } from './accountSettings.js'
import { createBrokerHistory, HISTORY_BROKERS, historyNames } from './brokerOrderHistory.js'
import { createOrderCalendar, koreanDay } from './orderCalendar.js'
import { httpError } from './brokerHttp.js'
import { createOrderReadCoordinator, safeOrderFailure } from './orderReadCoordinator.js'
import { ORDER_TIME_ZONE, orderPeriodError, orderPeriodWindow, validOrderDay } from '../src/utils/orderPeriod.js'
import { compareOrderHistory } from '../src/utils/recentOrders.js'

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
  return [...items].sort((a, b) => compareOrderHistory(b, a))
}

function requestedPeriod(query = {}, now) {
  const range = { start: query.from, end: query.to }
  const error = orderPeriodError(range, now)
  if (error) throw Object.assign(httpError(error, 400), { periodError: error })
  return range
}

export function createRecentOrderHandlers({ authenticate = getAuthenticatedCredentials, calendar = createOrderCalendar(),
  readBroker = createBrokerHistory(), now = Date.now, timeoutMs = 25_000, cancelGraceMs = 750, onBrokerError,
} = {}) {
  const read = createOrderReadCoordinator({ readBroker, now, timeoutMs, cancelGraceMs, onBrokerError })
  async function authorize(request) {
    if (!/^Bearer\s+\S+/i.test(request.headers.authorization || '')) throw httpError('로그인 후 최근 주문 내역을 확인할 수 있습니다.', 401)
    const account = await authenticate(request)
    if (!account?.user?.id) throw httpError('로그인 세션을 확인해 주세요.', 401)
    return account
  }
  function selection(request, broker) {
    const value = request.query?.[`${broker}Account`] ?? ''
    if (typeof value !== 'string' || (value && !/^[a-f0-9]{32}$/.test(value))) throw httpError('조회 계좌를 다시 선택해 주세요.', 400)
    return value
  }
  async function list(request, { signal } = {}, history = false) {
    const account = await authorize(request)
    signal?.throwIfAborted()
    const selected = selectedOrderBrokers(request.query)
    const selections = Object.fromEntries(selected.map(broker => [broker, selection(request, broker)]))
    let range, window
    if (history) {
      range = requestedPeriod(request.query, now())
      const before = request.query?.before
      if (before !== undefined && (!validOrderDay(before) || before <= range.start || before > range.end)) {
        throw httpError('이전 조회 구간을 확인해 주세요.', 400)
      }
      window = orderPeriodWindow(range, before)
    } else {
      range = selected.some(broker => configured(account, broker)) ? await calendar(koreanDay(now())) : null
      window = range
    }
    signal?.throwIfAborted()
    const results = await Promise.all(selected.map(async broker => {
      if (!configured(account, broker)) return { broker, status: 'unconfigured', items: [], accounts: [] }
      try { return { broker, ...await read(broker, account, window.days, selections[broker], signal, history ? range : null) } }
      catch (error) {
        if (signal?.aborted) throw error
        const progress = history && error.orderProgress
        const partial = progress && (progress.completedDays.length || progress.items.length)
        return { broker, status: partial ? 'partial' : 'error', error: safeOrderFailure(broker, error).category,
          items: [], accounts: [], ...progress,
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
      }
    }))
    const seen = new Set()
    const items = sortRecentOrders(results.flatMap(result => result.items).filter(item => {
      if (!window?.days.includes(item.date) || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    }))
    return { fetchedAt: new Date(now()).toISOString(), range, ...(history ? { window, timeZone: ORDER_TIME_ZONE } : {}),
      orderingIncomplete: items.some(item => !item.orderedAt),
      brokers: results.map(({ items: _, ...result }) => result),
      items: (history ? items : items.slice(0, 5)).reverse().map(({ executions: _, ...item }) => item) }
  }
  async function detail(request, { signal } = {}, history = false) {
    const account = await authorize(request)
    signal?.throwIfAborted()
    const { broker, id } = request.params
    if (!HISTORY_BROKERS.includes(broker) || !/^[a-f0-9]{64}$/.test(id)) throw httpError('주문 식별자를 확인해 주세요.', 400)
    if (!configured(account, broker)) throw Object.assign(httpError('선택한 증권사의 API 정보를 등록해 주세요.', 403), { missing: [broker] })
    const accountRef = selection(request, broker)
    let range, days
    if (history) {
      range = requestedPeriod(request.query, now())
      const day = request.query?.day
      if (!validOrderDay(day) || day < range.start || day > range.end || !accountRef) {
        throw httpError('선택한 주문의 계좌와 조회 기간을 확인해 주세요.', 400)
      }
      // Read only the selected order's date within the original inclusive period.
      days = [day]
    } else {
      days = (await calendar(koreanDay(now()))).days
    }
    const result = await read(broker, account, days, accountRef, signal, range)
    if (history && result.status === 'accountRequired') throw httpError('본인 계좌를 다시 선택해 주세요.', 400)
    const item = result.items.find(order => order.id === id && (!history || (order.accountRef === accountRef && order.date === days[0])))
    if (!item) throw httpError('현재 조회 계좌와 기간에서 주문을 찾을 수 없습니다.', 404)
    return { item, fetchedAt: new Date(now()).toISOString() }
  }
  return {
    list, detail,
    history: (request, options) => list(request, options, true),
    historyDetail: (request, options) => detail(request, options, true),
  }
}

export function registerRecentOrderRoutes(app, handlers = createRecentOrderHandlers({
  onBrokerError: diagnostic => app.log.warn(diagnostic, 'Recent orders broker lookup failed'),
})) {
  for (const [path, action] of [
    ['/api/account/orders/recent', 'list'], ['/api/account/orders/recent/:broker/:id', 'detail'],
    ['/api/account/orders/history', 'history'], ['/api/account/orders/history/:broker/:id', 'historyDetail'],
  ]) {
    app.get(path, { logLevel: 'silent' }, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache')
      const controller = new AbortController()
      const disconnect = () => { if (!reply.raw.writableEnded) controller.abort() }
      request.raw.on('aborted', disconnect)
      reply.raw.on('close', disconnect)
      if (request.raw.aborted || reply.raw.destroyed) controller.abort()
      try { return await handlers[action](request, { signal: controller.signal }) }
      catch (error) {
        if (controller.signal.aborted) return reply
        const code = Number(error.statusCode)
        const status = error.name === 'TimeoutError' ? 504 : Object.hasOwn(routeErrors, code) ? code : 502
        if (status === 429) reply.header('Retry-After', error.retryAfterSeconds || 30)
        return reply.code(status).send({ error: error.periodError || routeErrors[status] || '주문 내역을 조회하지 못했습니다.',
          ...(error.missing ? { missingBrokers: error.missing.map(id => ({ id, name: historyNames[id] })) } : {}) })
      } finally { request.raw.removeListener('aborted', disconnect); reply.raw.removeListener('close', disconnect) }
    })
  }
}

const routeErrors = {
  400: '조회 증권사, 계좌 또는 기간을 확인해 주세요.',
  401: '로그인 세션을 확인해 주세요.',
  403: '선택한 증권사의 API 정보를 등록해 주세요.',
  404: '선택한 계좌와 기간에서 주문을 찾을 수 없습니다.',
  429: '증권사 요청 한도를 초과했습니다. 잠시 후 다시 조회해 주세요.',
  503: '조회가 지연되고 있습니다. 잠시 후 다시 조회해 주세요.',
  504: '조회 시간이 초과됐습니다. 잠시 후 다시 조회해 주세요.',
}
