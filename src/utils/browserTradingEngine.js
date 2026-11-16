import { evaluateTradingSignal, moneyMicros, microsMoney, sizeTradingOrder, tradingExitReason, tradingPerformance, validateTradingSpec } from '../../shared/tradingV1.js'
import { validDailyDate } from './dataQuality.js'

export const BROWSER_TRADING_MODE = 'BROWSER_SIMULATION'
export const browserTradingStorageKey = userId => `atlas.browser-trading.v1:${userId}`
export const browserTradingAccountRef = broker => `browser-scope-${broker}-000000`
const brokers = ['kiwoom', 'toss', 'nh', 'kb']
const active = row => !['stopped', 'completed'].includes(row.status)
const copy = value => structuredClone(value)
const problem = (code, message) => Object.assign(new Error(message), { code })
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
const isoInstant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const validCode = value => typeof value === 'string' && /^[0-9][0-9A-Z]{5}$/.test(value)

// This engine has no network dependency, broker gateway, account reader or worker.
// Its storage and every durable record have a distinct internal execution mode.
export function createBrowserTradingEngine({ userId, storage, now = Date.now, uuid = () => crypto.randomUUID(), initialCapital = 10_000_000 } = {}) {
  if (typeof userId !== 'string' || !userId || userId.length > 128) throw problem('browser_auth_required', '로그인 후 사용할 수 있습니다.')
  if (!Number.isSafeInteger(initialCapital) || initialCapital < 1 || initialCapital > 1_000_000_000_000) throw problem('browser_capital_invalid', '운용 자금을 확인해 주세요.')
  const stamp = () => new Date(now()).toISOString()
  const key = browserTradingStorageKey(userId), previews = new Map()
  let watchlist = [], strategies = [], storageError = '', startedSessionId = null
  const blank = () => ({ version: 1, mode: BROWSER_TRADING_MODE, owner: userId, configs: [], sessions: [], events: [], requests: {}, funds: Object.fromEntries(brokers.map(b => [b, { initial: String(moneyMicros(initialCapital)), cash: String(moneyMicros(initialCapital)) }])) })
  let data = blank()
  function persist() {
    try { storage?.setItem(key, JSON.stringify(data)); storageError = '' }
    catch { storageError = '이 브라우저에 실행 기록을 저장하지 못했습니다. 현재 화면의 기록만 유지됩니다.' }
  }
  try {
    const raw = storage?.getItem(key)
    if (raw) {
      if (raw.length > 2_000_000) throw new Error()
      const saved = JSON.parse(raw)
      if (saved.version !== 1 || saved.mode !== BROWSER_TRADING_MODE || saved.owner !== userId || !Array.isArray(saved.configs) || saved.configs.length > 20 || !Array.isArray(saved.sessions) || saved.sessions.length > 500 || !Array.isArray(saved.events) || !saved.requests || typeof saved.requests !== 'object') throw new Error()
      for (const config of saved.configs) {
        if (config.mode !== BROWSER_TRADING_MODE || config.owner_id !== userId || !Number.isInteger(config.revision) || config.revision < 1) throw new Error()
        const checked = validateTradingSpec(config.spec, config.strategy_snapshot)
        if (checked.spec.entryAction === 'manage' || checked.spec.accountRef !== browserTradingAccountRef(checked.spec.broker) || config.code !== checked.spec.code) throw new Error()
      }
      for (const session of saved.sessions) {
        if (session.mode !== BROWSER_TRADING_MODE || session.owner_id !== userId || session.snapshot?.mode !== BROWSER_TRADING_MODE || session.state?.mode !== BROWSER_TRADING_MODE || session.broker !== session.snapshot?.spec?.broker || session.code !== session.snapshot?.spec?.code || session.account_ref !== browserTradingAccountRef(session.broker) || !Array.isArray(session.state?.closedTrades)) throw new Error()
        validateTradingSpec(session.snapshot.spec, session.snapshot.strategy)
        if (session.state.position && (!Number.isSafeInteger(session.state.position.quantity) || session.state.position.quantity < 1 || BigInt(session.state.position.costMicros) <= 0n)) throw new Error()
        if (session.state.closedTrades.some(t => t.mode !== BROWSER_TRADING_MODE || !isoInstant(t.entryAt) || !isoInstant(t.exitAt))) throw new Error()
      }
      for (const broker of brokers) {
        if (BigInt(saved.funds?.[broker]?.initial) <= 0n || BigInt(saved.funds?.[broker]?.cash) < 0n) throw new Error()
      }
      if (saved.events.some(row => row.mode !== BROWSER_TRADING_MODE || row.owner_id !== userId || !saved.sessions.some(session => session.id === row.session_id))) throw new Error()
      data = saved
      // Reopening never evaluates missed prices or restarts a previous run.
      for (const session of data.sessions.filter(active)) {
        session.status = 'stopped'; session.revision++
        session.state.phase = 'stopped'; session.state.reason = 'screen_closed'
        session.state.error = ''; session.stop_requested = true
      }
      persist()
    }
  } catch {
    data = blank()
    storageError = '저장된 실행 기록을 읽지 못했습니다. 다른 실행 방식의 기록은 불러오지 않습니다.'
  }
  const find = id => {
    const session = data.sessions.find(row => row.id === id)
    if (!session || session.owner_id !== userId || session.mode !== BROWSER_TRADING_MODE) throw problem('browser_not_found', '실행을 찾을 수 없습니다.')
    return session
  }
  const touch = session => { session.revision++; session.updated_at = stamp() }
  const event = (session, code) => {
    data.events.push({ id: uuid(), mode: BROWSER_TRADING_MODE, owner_id: userId, session_id: session.id, code, kind: code, created_at: stamp() })
    data.events = data.events.slice(-1000)
  }
  function context() {
    return copy({ mode: BROWSER_TRADING_MODE, owner: userId,
      flags: { browserSimulation: true, workerEnabled: true, workerReady: true, liveEnabled: false, storageV2: true },
      capabilities: Object.fromEntries(brokers.map(broker => [broker, { broker, supported: true, ordersEnabled: false, readSupported: true }])),
      watchlist, strategies, configs: data.configs, sessions: [...data.sessions].reverse().map(row => ({ ...row, performance: tradingPerformance(row.state) })), intents: [], events: data.events,
      virtualFunds: Object.fromEntries(brokers.map(broker => [broker, { initial: microsMoney(data.funds[broker].initial), cash: microsMoney(data.funds[broker].cash) }])),
      storageError, startedSessionId,
    })
  }
  function setCatalog(input = {}) {
    if (!Array.isArray(input.watchlist) || input.watchlist.length > 20 || input.watchlist.some(row => !validCode(row.code)) || new Set(input.watchlist.map(row => row.code)).size !== input.watchlist.length) throw problem('browser_watchlist_invalid', '관심종목 목록을 확인해 주세요. 최대 20개까지 사용할 수 있습니다.')
    watchlist = copy(input.watchlist)
    strategies = Array.isArray(input.strategies) ? copy(input.strategies) : []
    return context()
  }
  function save({ id, expectedRevision = 0, spec } = {}) {
    if (!watchlist.some(row => row.code === spec?.code)) throw problem('browser_watchlist_required', '관심종목에 등록한 종목만 저장할 수 있습니다.')
    if (data.sessions.some(row => row.code === spec.code && active(row))) throw problem('browser_run_active', '진행 중인 실행을 먼저 정지해 주세요.')
    const strategy = strategies.find(row => row.id === spec.strategyId && Number(row.revision) === Number(spec.strategyRevision))
    const checked = validateTradingSpec(spec, strategy)
    if (checked.spec.entryAction === 'manage') throw problem('browser_manage_unsupported', '기존 계좌 보유분을 가져오는 방식은 지원하지 않습니다. 신규 진입 방식을 선택해 주세요.')
    if (checked.spec.accountRef !== browserTradingAccountRef(spec.broker)) throw problem('browser_account_scope', '운용 범위를 다시 선택해 주세요.')
    const old = data.configs.find(row => row.code === spec.code)
    if (old ? old.id !== id || old.revision !== Number(expectedRevision) : id || Number(expectedRevision) !== 0) throw problem('browser_revision_conflict', '저장 설정이 변경되었습니다. 다시 확인해 주세요.')
    const config = { id: old?.id || uuid(), mode: BROWSER_TRADING_MODE, owner_id: userId, code: spec.code, revision: (old?.revision || 0) + 1, spec: checked.spec,
      strategy_snapshot: checked.strategy, strategySnapshot: checked.strategy, account_label: '운용 자금', accountLabel: '운용 자금', created_at: old?.created_at || stamp(), updated_at: stamp() }
    // Creation order is the saved execution order. Editing an existing row does
    // not silently move it or alter which row a bulk start selects first.
    if (old) data.configs[data.configs.indexOf(old)] = config
    else data.configs.push(config)
    persist(); return context()
  }
  function preview({ configId, configRevision } = {}) {
    const config = data.configs.find(row => row.id === configId && row.revision === Number(configRevision))
    if (!config) throw problem('browser_config_changed', '저장 설정을 다시 확인해 주세요.')
    if (!watchlist.some(row => row.code === config.code)) throw problem('browser_watchlist_required', '관심종목에 등록한 종목만 시작할 수 있습니다.')
    const strategy = strategies.find(row => row.id === config.spec.strategyId && Number(row.revision) === Number(config.spec.strategyRevision))
    if (!strategy) throw problem('browser_strategy_changed', '전략이 변경되었습니다. 설정에서 다시 저장해 주세요.')
    validateTradingSpec(config.spec, strategy)
    if (data.sessions.some(row => row.code === config.code && active(row))) throw problem('browser_run_active', '이미 실행 중입니다.')
    const value = { id: uuid(), mode: BROWSER_TRADING_MODE, configId, configRevision: config.revision, expiresAt: now() + 300_000,
      summary: { code: config.code, broker: config.spec.broker, spec: copy(config.spec), strategy: copy(config.strategy_snapshot), accountLabel: '운용 자금', mode: BROWSER_TRADING_MODE } }
    previews.set(value.id, value)
    return copy(value)
  }
  function start({ previewId, requestId, confirmed } = {}) {
    if (confirmed !== true || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw problem('browser_confirmation_required', '시작할 항목을 확인해 주세요.')
    if (Object.hasOwn(data.requests, requestId)) { startedSessionId = data.requests[requestId]; return context() }
    const view = previews.get(previewId)
    if (!view || view.expiresAt <= now()) throw problem('browser_confirmation_expired', '시작 요청이 만료되었습니다. 다시 시작해 주세요.')
    const config = data.configs.find(row => row.id === view.configId && row.revision === view.configRevision)
    if (!config || !watchlist.some(row => row.code === config.code)) throw problem('browser_config_changed', '저장 설정을 다시 확인해 주세요.')
    if (!strategies.some(row => row.id === config.spec.strategyId && Number(row.revision) === Number(config.spec.strategyRevision))) throw problem('browser_strategy_changed', '전략이 변경되었습니다. 다시 저장해 주세요.')
    if (data.sessions.some(row => row.code === config.code && active(row))) throw problem('browser_run_active', '이미 실행 중입니다.')
    if (data.sessions.filter(active).length >= 20 || data.sessions.length >= 500) throw problem('browser_run_limit', '실행 기록 한도에 도달했습니다.')
    const id = uuid(), time = stamp(), session = { id, mode: BROWSER_TRADING_MODE, owner_id: userId, config_id: config.id, code: config.code, broker: config.spec.broker,
      account_ref: config.spec.accountRef, revision: 1, status: 'waiting_signal', created_at: time, updated_at: time,
      snapshot: { mode: BROWSER_TRADING_MODE, name: watchlist.find(row => row.code === config.code)?.name || config.code, spec: copy(config.spec), strategy: copy(config.strategy_snapshot), accountLabel: '운용 자금' },
      state: { mode: BROWSER_TRADING_MODE, phase: 'waiting_signal', reason: 'signal_unmet', error: '', position: null, closedTrades: [], entryCount: 0,
        checkedAt: null, evaluatedAt: null, markAt: null, markPrice: null, decisionTimeframe: 'confirmed_daily', priority: data.configs.findIndex(row => row.id === config.id) + 1 }, stop_requested: false }
    data.sessions.push(session); data.requests[requestId] = id; previews.delete(previewId); startedSessionId = id
    event(session, 'run_started'); persist(); return context()
  }
  function stop({ sessionId, expectedRevision } = {}) {
    const session = find(sessionId)
    if (!active(session)) return context()
    if (expectedRevision != null && Number(expectedRevision) !== session.revision) throw problem('browser_revision_conflict', '실행 상태가 변경되었습니다. 다시 확인해 주세요.')
    session.status = 'stopped'; session.stop_requested = true; session.state.phase = 'stopped'; session.state.reason = 'stopped'; session.state.error = ''
    touch(session); event(session, 'run_stopped'); persist(); return context()
  }
  function fail(sessionId, message) {
    const session = find(sessionId)
    if (!active(session)) return context()
    session.state.error = String(message || '시세 데이터를 확인할 수 없습니다.').slice(0, 500)
    session.state.reason = 'data_error'; session.state.checkedAt = stamp(); session.state.markPrice = null
    session.status = session.state.phase = session.state.position ? 'holding' : 'waiting_signal'
    touch(session); persist(); return context()
  }
  function evaluate(sessionId, observation = {}) {
    const session = find(sessionId)
    if (!active(session)) return context()
    const state = session.state, current = now(), time = new Date(current).toISOString()
    const wait = (reason, error = '') => {
      state.checkedAt = time; state.reason = reason; state.error = error
      if (reason === 'quote_unavailable' || reason === 'data_error') state.markPrice = null
      session.status = state.phase = state.position ? 'holding' : 'waiting_signal'
      touch(session); persist(); return context()
    }
    if (!state.position && !watchlist.some(row => row.code === session.code)) return wait('watchlist_removed', '관심종목에서 삭제되어 신규 진입을 중단했습니다.')
    if (observation.marketUnavailable === true) return wait('data_error', observation.marketReason || '거래시간 정보를 확인할 수 없습니다. 다시 조회해 주세요.')
    if (observation.marketOpen !== true || observation.marketDate !== day(current)) return wait('market_closed', observation.marketReason || '')
    const observed = isoInstant(observation.observedAt) ? Date.parse(observation.observedAt) : NaN
    const maximumAge = Math.min(90_000, Number(observation.maxObservationAgeMs) || 90_000)
    const price = observation.price
    if (!Number.isSafeInteger(price) || price < 1 || price > 1_000_000_000 || !Number.isFinite(observed) || observed > current || maximumAge <= 0 || current - observed > maximumAge || day(observed) !== observation.marketDate) return wait('quote_unavailable', '최신 시세와 수신 시각을 확인해 주세요.')
    if (state.sourceObservedAt && observed < Date.parse(state.sourceObservedAt)) return context()
    if (state.sourceObservedAt && Date.parse(state.sourceObservedAt) === observed && state.lastObservedPrice === price) return context()
    state.sourceObservedAt = observation.observedAt; state.lastObservedPrice = price
    state.checkedAt = time; state.evaluatedAt = time; state.markPrice = price; state.markAt = time; state.error = ''; state.reason = null
    state.marketAt = observation.marketAt || observation.observedAt
    const fund = data.funds[session.broker], spec = session.snapshot.spec, strategy = session.snapshot.strategy
    if (state.position) {
      const reason = tradingExitReason(state.position, strategy.backtest_settings, price)
      if (reason) {
        const p = state.position, proceeds = moneyMicros(price) * BigInt(p.quantity)
        const trade = { id: p.tradeId, mode: BROWSER_TRADING_MODE, entryAt: p.entryAt, exitAt: time, decisionAt: time, sourceEntryAt: p.sourceObservedAt, sourceExitAt: observation.observedAt,
          entryPrice: p.averagePrice, exitPrice: price, quantity: p.quantity, pnl: microsMoney(proceeds - BigInt(p.costMicros)), reason, costs: 'not_included' }
        state.closedTrades.push(trade); state.position = null; state.lastClosedAt = time; fund.cash = String(BigInt(fund.cash) + proceeds)
        session.status = state.phase = spec.entryAction === 'once' ? 'completed' : 'waiting_signal'
        event(session, reason)
      } else session.status = state.phase = 'holding'
      touch(session); persist(); return context()
    }
    let matched = spec.entryAction === 'once'
    if (spec.entryAction === 'signal') {
      if (!validDailyDate(observation.previousDay) || observation.previousDay >= observation.marketDate) return wait('daily_unavailable', '확정 일봉의 기준 거래일을 확인할 수 없습니다.')
      let signal
      try { signal = evaluateTradingSignal({ candles: observation.daily, strategy, previousDay: observation.previousDay, tradingDays: observation.tradingDays, calendarThrough: observation.calendarThrough }) }
      catch { return wait('daily_unavailable', '진입 조건에 필요한 확정 일봉이나 지표 준비 데이터를 확인할 수 없습니다.') }
      state.signalDay = signal.signalDay
      matched = signal.matched && state.enteredSignalDay !== signal.signalDay
    }
    if (!matched) { session.status = state.phase = 'waiting_signal'; state.reason = 'signal_unmet'; touch(session); persist(); return context() }
    const sized = sizeTradingOrder({ quantityMode: spec.quantityMode, quantity: spec.quantity, cashAvailable: microsMoney(fund.cash), price })
    if (!sized.quantity) return wait('cash_insufficient')
    const cost = moneyMicros(price) * BigInt(sized.quantity)
    if (cost > BigInt(fund.cash)) return wait('cash_insufficient')
    fund.cash = String(BigInt(fund.cash) - cost)
    state.position = { tradeId: uuid(), mode: BROWSER_TRADING_MODE, quantity: sized.quantity, entryQuantity: sized.quantity, averagePrice: price,
      costMicros: String(cost), initialCostMicros: String(cost), entryAt: time, sourceObservedAt: observation.observedAt }
    state.entryCount++; state.enteredSignalDay = state.signalDay || null
    session.status = state.phase = 'holding'; event(session, 'position_entered')
    touch(session); persist(); return context()
  }
  function suspend(reason = 'screen_closed') {
    for (const session of data.sessions.filter(active)) {
      session.status = session.state.phase = 'stopped'; session.stop_requested = true; session.state.reason = reason; session.state.error = ''
      touch(session)
    }
    persist(); return context()
  }
  return { setCatalog, context, save, preview, start, stop, evaluate, fail, suspend }
}
