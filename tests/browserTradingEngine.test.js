import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_TRADING_MODE, browserTradingAccountRef, browserTradingStorageKey, createBrowserTradingEngine } from '../src/utils/browserTradingEngine.js'

const startingTime = Date.parse('2026-11-16T09:30:00+09:00')
const risk = { id: 'strategy-risk', name: '익절·손절', revision: 1, schema_version: 2, indicators: [], backtest_settings: { takeProfitPct: 5, stopLossPct: 3, entryConditions: [], entryMode: 'all' } }
const signal = { ...risk, id: 'strategy-signal', name: 'RSI·볼린저', indicators: [
  { id: 'rsi', period: 3, lower: 30, upper: 70, color: '#2255ff' },
  { id: 'bollinger', period: 3, multiplier: 2, color: '#228844' },
], backtest_settings: { ...risk.backtest_settings, entryConditions: [{ indicatorId: 'rsi', enabled: true, left: 'rsi', operator: 'lte', right: { type: 'constant', value: 30 } }] } }
const days = ['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13']
const daily = rising => days.map((time, i) => { const close = rising ? 100 + i * 2 : 100 - i * 2; return { time, open: close, high: close + 1, low: close - 1, close, volume: 100 } })
function fixture({ userId = 'owner-a', storage, capital = 10_000_000 } = {}) {
  const values = new Map(), memory = storage || { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }
  let at = startingTime, sequence = 0
  const engine = createBrowserTradingEngine({ userId, storage: memory, now: () => at, uuid: () => `browser-${++sequence}`, initialCapital: capital })
  const watchlist = [{ code: '089970', name: '브이엠' }, { code: '005930', name: '삼성전자' }]
  engine.setCatalog({ watchlist, strategies: [risk, signal] })
  const spec = (code = '089970', broker = 'toss', strategy = risk) => ({ code, broker, accountRef: browserTradingAccountRef(broker), strategyId: strategy.id,
    strategyRevision: strategy.revision, quantityMode: 'fixed', quantity: 3, entryAction: strategy === signal ? 'signal' : 'once' })
  const save = value => { engine.save({ spec: value }); return engine.context().configs.find(row => row.code === value.code) }
  const start = config => { const preview = engine.preview({ configId: config.id, configRevision: config.revision }); const requestId = `request-${++sequence}`; engine.start({ previewId: preview.id, requestId, confirmed: true }); return engine.context().sessions.find(row => row.config_id === config.id && row.status === 'waiting_signal') }
  const observation = (price = 200_000, patch = {}) => ({ marketOpen: true, marketDate: '2026-11-16', previousDay: '2026-11-13', daily: daily(false), price,
    observedAt: new Date(at - 30_000).toISOString(), maxObservationAgeMs: 90_000, ...patch })
  return { engine, memory, values, userId, watchlist, spec, save, start, observation, now: () => at, advance: delta => { at += delta } }
}
const current = (f, id) => f.engine.context().sessions.find(row => row.id === id)

test('save is independent from start and rejects missing membership, invalid strategy and real account scope', () => {
  const f = fixture(), config = f.save(f.spec())
  assert.equal(f.engine.context().sessions.length, 0)
  assert.equal(config.mode, BROWSER_TRADING_MODE)
  assert.throws(() => f.save({ ...f.spec(), code: '000660' }), /관심종목/)
  assert.throws(() => f.save({ ...f.spec('005930'), quantity: 0 }), /주문수량/)
  assert.throws(() => f.save({ ...f.spec('005930'), accountRef: 'real-account-number-123' }), /운용 범위/)
  assert.throws(() => f.save({ ...f.spec('005930'), entryAction: 'manage', manageQuantity: 1 }), /기존 계좌/)
  assert.throws(() => f.engine.setCatalog({ watchlist: Array.from({ length: 21 }, (_, i) => ({ code: String(i + 1).padStart(6, '0') })), strategies: [] }), /20개/)
  const invalid = { ...risk, backtest_settings: { ...risk.backtest_settings, stopLossPct: '' } }
  f.engine.setCatalog({ watchlist: f.watchlist, strategies: [invalid] })
  assert.throws(() => f.engine.save({ spec: f.spec('005930') }), /손절/)
})

test('worker/LIVE state has no authority over local start and duplicate starts cannot create another execution', () => {
  const f = fixture(), config = f.save(f.spec()), preview = f.engine.preview({ configId: config.id, configRevision: config.revision })
  const input = { previewId: preview.id, requestId: 'same-request', confirmed: true }
  f.engine.start(input); f.engine.start(input)
  const context = f.engine.context()
  assert.equal(context.flags.liveEnabled, false)
  assert.equal(context.sessions.length, 1)
  assert.equal(context.sessions[0].mode, BROWSER_TRADING_MODE)
  assert.equal(context.sessions[0].state.mode, BROWSER_TRADING_MODE)
  assert.deepEqual(context.intents, [])
  assert.throws(() => f.engine.preview({ configId: config.id, configRevision: config.revision }), /이미 실행 중/)
})

test('saved creation order remains stable across edits and changed watchlist ordering', () => {
  const f = fixture()
  const second = f.save(f.spec('005930')), first = f.save(f.spec('089970'))
  assert.deepEqual(f.engine.context().configs.map(row => row.id), [second.id, first.id])
  f.engine.save({ id: second.id, expectedRevision: second.revision, spec: { ...second.spec, quantity: 4 } })
  f.engine.setCatalog({ watchlist: [...f.watchlist].reverse(), strategies: [risk, signal] })
  assert.deepEqual(f.engine.context().configs.map(row => row.id), [second.id, first.id])
  const run = f.start(f.engine.context().configs[0])
  assert.equal(run.code, '005930'); assert.equal(run.state.priority, 1)
})

test('virtual position and TP/SL results come from observed prices without broker order/fill identifiers', () => {
  const f = fixture(), run = f.start(f.save(f.spec()))
  f.engine.evaluate(run.id, f.observation())
  let s = current(f, run.id)
  assert.equal(s.state.position.averagePrice, 200_000)
  assert.equal(s.state.position.quantity, 3)
  assert.equal(s.state.position.entryAt, new Date(startingTime).toISOString(), 'internal entry is the observation processing time, never historical candle time')
  assert.notEqual(s.state.position.entryAt, s.state.sourceObservedAt)
  assert.equal(f.engine.context().virtualFunds.toss.cash, 9_400_000)
  f.advance(15_000); f.engine.evaluate(run.id, f.observation(211_000))
  s = current(f, run.id)
  assert.equal(s.status, 'completed'); assert.equal(s.state.position, null)
  assert.equal(s.state.closedTrades.length, 1)
  assert.equal(s.state.closedTrades[0].pnl, 33_000)
  assert.equal(s.state.closedTrades[0].reason, 'take_profit')
  assert.equal(s.performance.entries, 1); assert.equal(s.performance.closedTrades, 1)
  assert.equal(f.engine.context().virtualFunds.toss.cash, 10_033_000)
  const serialized = JSON.stringify(f.engine.context())
  assert.doesNotMatch(serialized, /broker_order|orderNumber|fillId|executionId/)
  assert.doesNotMatch(serialized, /"mode":"LIVE"/)
})

test('a losing strategy records an actual virtual loss instead of forcing favorable exits', () => {
  const f = fixture(), run = f.start(f.save(f.spec()))
  f.engine.evaluate(run.id, f.observation(100_000))
  f.advance(15_000); f.engine.evaluate(run.id, f.observation(96_000))
  const s = current(f, run.id)
  assert.equal(s.state.closedTrades[0].reason, 'stop_loss')
  assert.equal(s.state.closedTrades[0].pnl, -12_000)
  assert.equal(s.performance.takeProfits, 0); assert.equal(s.performance.stopLosses, 1)
})

test('confirmed daily RSI signals and immutable indicator settings are separate from the chart period', () => {
  const f = fixture(), config = f.save(f.spec('089970', 'nh', signal)), run = f.start(config)
  const changed = { ...signal, name: '변경 후', revision: 2, indicators: [{ ...signal.indicators[0], period: 10 }] }
  f.engine.setCatalog({ watchlist: f.watchlist, strategies: [changed] })
  f.engine.evaluate(run.id, f.observation(100_000, { daily: daily(true), chartPeriod: '15분' }))
  assert.equal(current(f, run.id).state.reason, 'signal_unmet')
  assert.equal(current(f, run.id).state.position, null)
  f.advance(15_000); f.engine.evaluate(run.id, f.observation(100_000, { daily: daily(false), chartPeriod: '15분' }))
  const s = current(f, run.id)
  assert.equal(s.state.position.quantity, 3)
  assert.equal(s.state.decisionTimeframe, 'confirmed_daily')
  assert.equal(s.snapshot.strategy.name, signal.name)
  assert.deepEqual(s.snapshot.strategy.indicators, signal.indicators)
  assert.equal(s.state.signalDay, '2026-11-13')
  f.advance(15_000); f.engine.evaluate(run.id, f.observation(110_000))
  f.advance(15_000); f.engine.evaluate(run.id, f.observation(100_000))
  assert.equal(current(f, run.id).state.entryCount, 1, 'same confirmed-day signal cannot create a second entry after closure')
})

test('unmet, unprepared and malformed daily conditions never become entries', () => {
  for (const dailyValues of [[], daily(false).slice(-2), [{ ...daily(false)[0], time: '2026-11-31' }]]) {
    const f = fixture(), run = f.start(f.save(f.spec('089970', 'kiwoom', signal)))
    f.engine.evaluate(run.id, f.observation(100_000, { daily: dailyValues }))
    assert.equal(current(f, run.id).state.position, null)
    assert.equal(current(f, run.id).state.reason, 'daily_unavailable')
  }
})

test('closed, stale, future or reversed observations cannot invent execution or candle history', () => {
  for (const patch of [{ marketOpen: false }, { marketDate: '2026-11-13' }, { observedAt: '2026-11-16T09:28:00+09:00' }, { observedAt: '2026-11-16T09:30:01+09:00' }, { price: 0 }, { observedAt: 'not-a-time' }]) {
    const f = fixture(), run = f.start(f.save(f.spec()))
    f.engine.evaluate(run.id, f.observation(100_000, patch))
    assert.equal(current(f, run.id).state.position, null)
    assert.equal(current(f, run.id).state.closedTrades.length, 0)
  }
  const f = fixture(), run = f.start(f.save(f.spec()))
  const quote = f.observation(100_000)
  f.engine.evaluate(run.id, quote)
  const revision = current(f, run.id).revision
  f.engine.evaluate(run.id, quote)
  assert.equal(current(f, run.id).revision, revision)
  f.engine.evaluate(run.id, { ...quote, observedAt: new Date(Date.parse(quote.observedAt) - 1000).toISOString(), price: 120_000 })
  assert.equal(current(f, run.id).state.closedTrades.length, 0)
  f.engine.evaluate(run.id, { ...quote, price: 110_000 })
  assert.equal(current(f, run.id).state.closedTrades.length, 1, 'a genuine updated close in the same bucket can cross a threshold')
})

test('an unavailable calendar is a data error while a confirmed closed market remains a closed state', () => {
  const f = fixture(), run = f.start(f.save(f.spec()))
  f.engine.evaluate(run.id, f.observation(100_000, { marketOpen: false, marketUnavailable: true, marketReason: '거래시간 조회 연결 실패' }))
  let state = current(f, run.id).state
  assert.equal(state.reason, 'data_error')
  assert.equal(state.error, '거래시간 조회 연결 실패')
  assert.equal(state.position, null)
  assert.equal(state.markPrice, null)
  f.engine.evaluate(run.id, f.observation(100_000, { marketOpen: false, marketUnavailable: false, marketReason: '정규장 종료' }))
  state = current(f, run.id).state
  assert.equal(state.reason, 'market_closed')
  assert.equal(state.error, '정규장 종료')
  assert.equal(state.position, null)
  assert.equal(state.closedTrades.length, 0)
})

test('per-broker capital is shared conservatively across starts without touching another broker or real holding', () => {
  const f = fixture({ capital: 1_000_000 })
  const a = f.start(f.save({ ...f.spec(), quantityMode: 'all_cash' }))
  const b = f.start(f.save(f.spec('005930')))
  f.engine.evaluate(a.id, f.observation(100_000)); f.engine.evaluate(b.id, f.observation(100_000))
  assert.equal(current(f, a.id).state.position.quantity, 9)
  assert.equal(current(f, b.id).state.position, null)
  assert.equal(current(f, b.id).state.reason, 'cash_insufficient')
  assert.equal(f.engine.context().virtualFunds.toss.cash, 100_000)
  assert.equal(f.engine.context().virtualFunds.kiwoom.cash, 1_000_000)
  f.engine.stop({ sessionId: a.id })
  assert.equal(current(f, a.id).state.position.quantity, 9, 'stop freezes the internal position instead of liquidating it')
  assert.equal(f.engine.context().virtualFunds.toss.cash, 100_000)
})

test('read failures clear current valuation and cannot create a new position', () => {
  const f = fixture(), run = f.start(f.save(f.spec()))
  f.engine.fail(run.id, '조회 연결 실패')
  assert.equal(current(f, run.id).state.error, '조회 연결 실패')
  assert.equal(current(f, run.id).state.position, null)
  f.engine.evaluate(run.id, f.observation())
  f.engine.fail(run.id, '재조회 실패')
  assert.equal(current(f, run.id).state.markPrice, null)
  assert.equal(current(f, run.id).state.position.quantity, 3)
  assert.equal(current(f, run.id).state.closedTrades.length, 0)
})

test('restart and owner changes preserve only that owner records, stop active work and never replay missed prices', () => {
  const f = fixture(), run = f.start(f.save(f.spec()))
  f.engine.evaluate(run.id, f.observation())
  const saved = JSON.parse(f.memory.getItem(browserTradingStorageKey(f.userId)))
  const reloaded = fixture({ storage: f.memory })
  const prior = reloaded.engine.context().sessions[0]
  assert.equal(prior.status, 'stopped'); assert.equal(prior.state.reason, 'screen_closed')
  assert.deepEqual(prior.state.position, saved.sessions[0].state.position)
  assert.equal(prior.state.closedTrades.length, 0)
  assert.equal(reloaded.engine.context().startedSessionId, null)
  const other = fixture({ userId: 'owner-b', storage: f.memory })
  assert.equal(other.engine.context().sessions.length, 0)
  assert.throws(() => other.engine.stop({ sessionId: run.id }), /실행을 찾을/)
  reloaded.engine.evaluate(run.id, reloaded.observation(220_000))
  assert.equal(reloaded.engine.context().sessions[0].state.closedTrades.length, 0)
})

test('foreign/LIVE storage is rejected, and storage failures use only in-memory state', () => {
  const f = fixture(), run = f.start(f.save(f.spec()))
  const raw = JSON.parse(f.memory.getItem(browserTradingStorageKey(f.userId)))
  raw.sessions[0].mode = 'LIVE'
  f.memory.setItem(browserTradingStorageKey(f.userId), JSON.stringify(raw))
  const rejected = fixture({ storage: f.memory }).engine.context()
  assert.equal(rejected.sessions.length, 0); assert.match(rejected.storageError, /다른 실행 방식/)
  const broken = fixture({ storage: { getItem() { throw Error() }, setItem() { throw Error() } } })
  assert.doesNotThrow(() => broken.start(broken.save(broken.spec())))
  assert.match(broken.engine.context().storageError, /저장하지 못했습니다/)
  assert.ok(run.id)
})

test('the complete start/evaluate/stop/restart lifecycle has no network or broker gateway dependency', t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', () => { requests++; throw Error('REAL ORDER GATEWAY MUST NEVER BE REACHED') })
  const f = fixture(), run = f.start(f.save(f.spec()))
  f.engine.evaluate(run.id, f.observation())
  f.advance(15_000); f.engine.evaluate(run.id, f.observation(210_000))
  f.engine.stop({ sessionId: run.id }); f.engine.suspend()
  const restarted = fixture({ storage: f.memory })
  assert.equal(requests, 0)
  assert.deepEqual(restarted.engine.context().intents, [])
  assert.equal(restarted.engine.context().sessions[0].state.closedTrades.length, 1)
})
