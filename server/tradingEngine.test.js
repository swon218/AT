import test from 'node:test'
import assert from 'node:assert/strict'
import { createTradingEngine, initialTradingState, applyTradingFills, verifiedTradingSession, verifyTradingQuote } from './tradingEngine.js'
import { evaluateTradingSignal, moneyMicros, sizeTradingOrder, tradingExitReason, tradingPerformance, tradingReadiness, validateTradingSpec } from '../shared/tradingV1.js'
import { calculateConditionEvaluator } from '../src/utils/entryConditions.js'

const at = Date.parse('2026-11-16T09:00:10+09:00'), open = '2026-11-16T09:00:00+09:00', close = '2026-11-16T15:30:00+09:00'
const calendar = { date: '2026-11-16', previous: '2026-11-13', open, close }
const strategy = { id: 'strategy', name: '익절손절', revision: 1, schema_version: 2, indicators: [], backtest_settings: { takeProfitPct: 10, stopLossPct: 5, entryConditions: [], entryMode: 'all' } }
const spec = { code: '005930', broker: 'kiwoom', accountRef: 'a'.repeat(32), strategyId: strategy.id, strategyRevision: 1, quantityMode: 'fixed', quantity: 2, entryAction: 'once' }
const snapshot = { spec, strategy, credentialVersion: 'private-version' }
const intent = { id: 'entry-1', session_id: 'run', side: 'buy', quantity: 4, kind: 'entry', metadata: {}, created_at: new Date(at).toISOString() }
const fact = (qty, notional, time = '2026-11-16T00:00:11Z') => ({ filledQuantity: qty, filledNotional: notional, executions: [{ id: `fill-${qty}`, quantity: qty, price: qty ? notional / qty : 0, time }] })

function fixture({ mode = 'LIVE', state = initialTradingState(), customSpec = spec, customStrategy = strategy, time = at } = {}) {
  let clock = time, busy = false, epoch = 0
  const session = { id: 'run', owner_id: 'user', broker: 'kiwoom', account_ref: spec.accountRef, code: spec.code, mode, snapshot: { ...snapshot, spec: structuredClone(customSpec), strategy: structuredClone(customStrategy) }, state: structuredClone(state), revision: 1, status: 'waiting_signal', created_at: new Date(at - 60_000).toISOString(), watchlisted: true, stop_requested: false, abandon_requested: false }
  const intents = [], facts = new Map(), calls = [], submits = [], cancels = [], events = []
  const lease = { accountKey: 'scope', ownerId: 'user', broker: 'kiwoom', accountRef: spec.accountRef, mode, token: 'lease', epoch: 0, reservedCash: 0 }
  const store = { async call(action, actor, p) {
    calls.push(action)
    if (action === 'claim') { if (busy) return null; busy = true; lease.epoch = ++epoch; return { lease: structuredClone(lease), sessions: [structuredClone(session)], intents: structuredClone(intents) } }
    if (action === 'release') { busy = false; return true }
    assert.equal(p.lease.epoch, epoch, 'fenced stale worker')
    if (action === 'renew') return true
    if (action === 'commit') { assert.equal(p.expectedRevision, session.revision); session.state = structuredClone(p.state); session.status = p.status; session.revision++; events.push(...p.events); return session }
    if (action === 'prepare_intent') { const existing = intents.find(i => i.action_key === p.actionKey); if (existing) return { intent: structuredClone(existing), created: false }; const row = { id: `intent-${intents.length + 1}`, session_id: p.sessionId, action_key: p.actionKey, side: p.side, quantity: p.quantity, price: p.price, kind: p.kind, cash_reservation: p.cashReservation, metadata: p.metadata, status: 'prepared', created_at: new Date(clock).toISOString(), cumulative_quantity: 0, cumulative_notional: 0 }; intents.push(row); return { intent: structuredClone(row), created: true } }
    if (action === 'dispatch_intent') { const i = intents.find(i => i.id === p.intentId); if (i.status !== 'prepared') return { dispatch: false, intent: structuredClone(i) }; i.status = 'sending'; return { dispatch: true, intent: structuredClone(i) } }
    if (action === 'write_gate') { const i = intents.find(i => i.id === p.intentId); if (i.granted || i.status !== 'sending') return { allowed: false, unknown: true }; if ((session.stop_requested || session.watchlisted === false) && i.kind === 'entry' || session.abandon_requested && i.kind !== 'cancel') { i.status = 'rejected'; i.metadata.notTransmitted = true; i.cash_reservation = 0; return { allowed: false, unknown: false } }; i.granted = true; return { allowed: true } }
    if (action === 'settle_intent') { const i = intents.find(i => i.id === p.intentId); i.status = p.status; i.broker_order_id = p.brokerOrderId || i.broker_order_id; i.cumulative_quantity = p.cumulativeQuantity; i.cumulative_notional = p.cumulativeNotional; i.metadata = { ...i.metadata, ...p.metadata }; if (['filled', 'cancelled', 'rejected'].includes(i.status)) i.cash_reservation = 0; return i }
    throw new Error(`unexpected ${action}`)
  } }
  const inspected = { accountRef: spec.accountRef, credentialVersion: 'private-version', cashAvailable: 10000, holdingQuantity: state.position?.quantity || 0, sellableQuantity: state.position?.quantity || 0, averagePrice: state.position?.averagePrice || null, openOrders: [], complete: true, eligible: true }
  let inspectOverride, quoteOverride
  const gateway = {
    async inspect() { return { ...inspected, ...inspectOverride } },
    async quote() { return { price: 100, observedAt: new Date(clock).toISOString(), exchange: 'KRX', symbol: spec.code, fresh: true, halted: false, ...quoteOverride } },
    async reconcile({ intents: input }) { return { complete: true, holdingQuantity: inspected.holdingQuantity, openOrders: inspected.openOrders, orders: input.map(i => ({ intentId: i.id, orderNumber: i.orderNumber, status: facts.get(i.id)?.status || (i.status === 'accepted' ? 'open' : i.status), ...fact(Number(i.cumulative_quantity || 0), Number(i.cumulative_notional || 0)), ...facts.get(i.id) })) } },
    async submit(input) { const permit = await input.beforeWrite(); if (!permit.allowed) return { status: permit.unknown ? 'unknown' : 'rejected', notTransmitted: !permit.unknown }; submits.push(input); return { status: 'accepted', orderNumber: `raw-order-${input.intent.id}` } },
    async cancel(input) { const permit = await input.beforeWrite(); if (!permit.allowed) return { status: permit.unknown ? 'unknown' : 'rejected', notTransmitted: !permit.unknown }; cancels.push(input); return { status: 'accepted' } },
  }
  const options = { store, gateway, calendar: async () => calendar, readDaily: async () => [], loadAccount: async () => ({ user: { id: 'user' }, credentials: {} }), credentialVersionFor: () => 'private-version', flags: () => ({ workerEnabled: true, liveEnabled: true, paperEnabled: true }), now: () => clock }
  return { engine: createTradingEngine(options), options, session, intents, submits, cancels, calls, inspected, facts, events, tick: () => createTradingEngine(options).tick(), time: v => { clock = v }, inspect: v => { inspectOverride = v }, quote: v => { quoteOverride = v }, loseLease: () => { epoch++; busy = false } }
}

test('strategy validation accepts complete risk-only but requires explicit first action and owner revision snapshot', () => {
  assert.equal(tradingReadiness(strategy, 'once').ready, true)
  assert.equal(tradingReadiness(strategy, 'signal').ready, false)
  assert.equal(tradingReadiness({ ...strategy, backtest_settings: { ...strategy.backtest_settings, stopLossPct: '' } }, 'once').ready, false)
  assert.equal(validateTradingSpec(spec, strategy).strategy.revision, 1)
  assert.throws(() => validateTradingSpec({ ...spec, strategyRevision: 2 }, strategy), /변경/)
  assert.throws(() => validateTradingSpec({ ...spec, quantity: 1.5 }, strategy), /정수/)
  assert.equal(validateTradingSpec({ ...spec, quantity: '', quantityMode: 'all_cash' }, strategy).spec.quantity, 1)
  const tiny = { ...strategy, backtest_settings: { ...strategy.backtest_settings, takeProfitPct: 0.0000001 } }
  assert.equal(tradingReadiness(tiny, 'once').ready, false)
  assert.match(tradingReadiness(tiny, 'once').issues.join(' '), /소수점 6자리/)
})
test('cash sizing uses exact reservation, fee buffer, fixed quantity never shrinks, all-cash floors', () => {
  assert.deepEqual(sizeTradingOrder({ quantityMode: 'fixed', quantity: 10, cashAvailable: 1000, price: 100 }), { quantity: 0, reserveCash: 0, reason: 'cash_insufficient' })
  assert.deepEqual(sizeTradingOrder({ quantityMode: 'all_cash', quantity: 99, cashAvailable: '1015', reservedCash: 100, price: 100 }), { quantity: 9, reserveCash: 914, reason: null })
  assert.equal(sizeTradingOrder({ quantityMode: 'fixed', quantity: 10, cashAvailable: '1015', price: 100 }).reserveCash, 1015)
  assert.throws(() => moneyMicros('NaN'))
})
test('confirmed daily signal uses exact same laboratory evaluator, excludes incomplete current daily and rejects missing/quarantined', () => {
  const indicators = [{ id: 'ma', type: 'SMA', shortPeriod: 2, longPeriod: 3 }]
  const condition = { indicatorId: 'ma', enabled: true, left: 'short', operator: 'gt', right: { type: 'series', field: 'long' } }
  const bars = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'].map((time, i) => ({ time, open: i + 1, high: i + 1, low: i + 1, close: i + 1, volume: 100 }))
  const s = { ...strategy, indicators, backtest_settings: { ...strategy.backtest_settings, entryConditions: [condition] } }
  const signal = evaluateTradingSignal({ candles: bars, strategy: s, previousDay: '2026-11-13' })
  assert.equal(signal.matched, calculateConditionEvaluator(bars.slice(0, 4), indicators)(condition, 3))
  assert.equal(signal.signalDay, '2026-11-13')
  assert.equal(evaluateTradingSignal({ candles: bars.map(c => c.time === '2026-11-13' ? { ...c, volume: 0 } : c), strategy: s, previousDay: '2026-11-13' }).matched, false)
  assert.throws(() => evaluateTradingSignal({ candles: bars.slice(0, 3), strategy: s, previousDay: '2026-11-13' }))
  assert.throws(() => evaluateTradingSignal({ candles: bars.map((c, i) => i === 2 ? { ...c, quality: 'quarantined' } : c), strategy: s, previousDay: '2026-11-13' }))
})
test('special calendar opening and fresh KRX quote required, no browser timezone or normal-hours assumption', () => {
  const special = verifiedTradingSession({ ...calendar, open: '2026-11-16T10:00:00+09:00' }, Date.parse('2026-11-16T10:00:10+09:00'))
  assert.equal(special.opening, true)
  assert.equal(verifiedTradingSession({ ...calendar, closed: true }, at), null)
  const q = { price: 100, observedAt: new Date(at).toISOString(), symbol: '005930', exchange: 'KRX', fresh: true, halted: false }
  assert.equal(verifyTradingQuote(q, '005930', verifiedTradingSession(calendar, at), at), true)
  for (const override of [{ exchange: 'NXT' }, { halted: true }, { symbol: '000660' }, { observedAt: new Date(at - 31_000).toISOString() }]) assert.equal(verifyTradingQuote({ ...q, ...override }, '005930', verifiedTradingSession(calendar, at), at), false)
})
test('duplicate and reversed cumulative fills do not duplicate position; actual average and owned-only gross PnL', () => {
  let s = initialTradingState()
  s = applyTradingFills(s, intent, fact(2, 200)).state
  assert.equal(s.position.averagePrice, 100)
  assert.equal(applyTradingFills(s, intent, fact(2, 200)).duplicate, true)
  assert.equal(applyTradingFills(s, intent, fact(1, 100)).reversed, true)
  assert.throws(() => applyTradingFills(s, intent, fact(2, 202)), /conflict/)
  s = applyTradingFills(s, intent, fact(4, 440)).state
  assert.equal(s.position.averagePrice, 110)
  assert.equal(tradingExitReason(s.position, strategy.backtest_settings, 121), 'take_profit')
  const exit = { ...intent, id: 'exit', side: 'sell', kind: 'take_profit', metadata: { decisionAt: new Date(at).toISOString() } }
  s = applyTradingFills(s, exit, fact(1, 125)).state
  assert.equal(s.position.quantity, 3)
  s = applyTradingFills(s, exit, fact(4, 500)).state
  assert.equal(s.position, null)
  assert.equal(s.closedTrades[0].pnl, 60)
  assert.equal(s.closedTrades[0].entryPrice, 110)
  assert.equal(tradingPerformance(s).realizedPnl, 60)
  assert.equal(tradingPerformance(s).gross, true)
})
test('default deployment and PAPER records never call a broker write', async () => {
  const f = fixture(), disabled = createTradingEngine({ ...f.options, flags: () => ({ workerEnabled: false }) })
  assert.equal((await disabled.tick()).status, 'disabled'); assert.equal(f.calls.length, 0)
  const paper = fixture({ mode: 'PAPER' }); await paper.engine.tick()
  assert.equal(paper.session.status, 'paused'); assert.equal(paper.submits.length, 0)
})
test('once strategy submits one durable intent and unknown response is not blindly retried after worker restart', async () => {
  const f = fixture()
  f.options.gateway.submit = async input => { f.submits.push(input); throw new Error('timeout-without-sensitive-body') }
  await f.tick()
  assert.equal(f.intents.length, 1); assert.equal(f.intents[0].status, 'unknown'); assert.equal(f.submits.length, 1)
  await f.tick()
  assert.equal(f.submits.length, 1); assert.equal(f.session.status, 'unknown')
  assert.equal(f.intents[0].cash_reservation > 0, true)
})
test('definite rejection stays a rejection and requires review instead of automatic resubmission', async () => {
  const f = fixture(); f.options.gateway.submit = async input => { f.submits.push(input); return { status: 'rejected' } }
  await f.tick(); await f.tick()
  assert.equal(f.submits.length, 1); assert.equal(f.session.status, 'reconciliation_required'); assert.equal(f.session.state.reason, 'order_rejected')
})
test('two workers compete for one fenced account and only one sends; browser never participates', async () => {
  const f = fixture(), second = createTradingEngine({ ...f.options, workerId: 'second' })
  await Promise.all([f.engine.tick(), second.tick()])
  assert.equal(f.submits.length, 1); assert.equal(f.intents.length, 1)
})
test('crash after broker cumulative fill is stored recovers terminal intent before position commit', async () => {
  const f = fixture(); await f.tick()
  const i = f.intents[0]; i.status = 'filled'; i.cumulative_quantity = 2; i.cumulative_notional = 200
  f.inspected.holdingQuantity = 2; f.inspected.sellableQuantity = 2
  f.facts.set(i.id, { status: 'filled', ...fact(2, 200) })
  await f.tick()
  assert.equal(f.session.state.position.quantity, 2)
  assert.equal(f.submits.length, 1)
  await f.tick(); assert.equal(f.session.state.position.quantity, 2)
})
test('partial fill stop cancels only owned entry remainder and incorporates late fill while protecting position', async () => {
  const f = fixture(); await f.tick(); const i = f.intents[0]
  f.inspected.holdingQuantity = 1; f.inspected.sellableQuantity = 1; f.facts.set(i.id, { status: 'partial', ...fact(1, 100) }); f.session.stop_requested = true
  await f.tick()
  assert.equal(f.session.status, 'stopping'); assert.equal(f.cancels.length, 1); assert.equal(f.cancels[0].intent.id, i.id)
  assert.equal(f.cancels[0].cancelIntent.status, 'sending')
  f.inspected.holdingQuantity = 2; f.inspected.sellableQuantity = 2; f.facts.set(i.id, { status: 'filled', ...fact(2, 200) })
  await f.tick(); assert.equal(f.session.state.position.quantity, 2); assert.equal(f.session.status, 'stopping'); assert.equal(f.submits.length, 1)
})
test('abandon explicitly stops protection without liquidation and keeps remaining position', async () => {
  const f = fixture({ state: initialTradingState({ adoptedQuantity: 2, averagePrice: 100, totalHoldingQuantity: 2, now: at }) })
  f.session.stop_requested = true; f.session.abandon_requested = true; f.quote({ price: 80 })
  await f.tick()
  assert.equal(f.session.status, 'stopped'); assert.equal(f.session.state.position.quantity, 2); assert.equal(f.submits.length, 0)
})
test('API deletion, external holdings, non-watchlist and insufficient funds block new buy independently', async () => {
  const deleted = fixture(); deleted.inspect({ credentialVersion: 'replacement' }); await deleted.tick(); assert.equal(deleted.session.status, 'connection_required'); assert.equal(deleted.submits.length, 0)
  const external = fixture(); external.inspected.holdingQuantity = 1; await external.tick(); assert.equal(external.session.status, 'reconciliation_required'); assert.equal(external.submits.length, 0)
  const removed = fixture(); removed.session.watchlisted = false; await removed.tick(); assert.equal(removed.session.status, 'stopped'); assert.equal(removed.submits.length, 0)
  const funds = fixture(); funds.inspected.cashAvailable = 100; await funds.tick(); assert.equal(funds.session.status, 'waiting_funds'); assert.equal(funds.submits.length, 0)
})
test('late indicator start does not chase an old opening signal or query fresh daily repeatedly', async () => {
  const s = { ...strategy, indicators: [{ id: 'ma', type: 'SMA', shortPeriod: 2, longPeriod: 3 }], backtest_settings: { ...strategy.backtest_settings, entryConditions: [{ indicatorId: 'ma', enabled: true, left: 'short', operator: 'gt', right: { type: 'series', field: 'long' } }] } }
  const f = fixture({ customSpec: { ...spec, entryAction: 'signal' }, customStrategy: s, time: at + 3600_000 })
  let reads = 0; f.options.readDaily = async () => { reads++; return [] }
  await f.tick()
  assert.equal(f.session.state.reason, 'missed_open'); assert.equal(f.submits.length, 0); assert.equal(reads, 0)
})

test('prepared-before-send crash recovers only that intent, with fresh scope; sending is never redispatched', async () => {
  const f = fixture()
  f.intents.push({ id: 'prepared-intent', session_id: 'run', action_key: 'entry:once', kind: 'entry', side: 'buy', quantity: 2, price: 102, cash_reservation: 208, metadata: { signalDay: 'once' }, status: 'prepared', created_at: new Date(at).toISOString(), cumulative_quantity: 0, cumulative_notional: 0 })
  await f.tick()
  assert.equal(f.submits.length, 1); assert.equal(f.submits[0].intent.id, 'prepared-intent')
  assert.equal(f.session.status, 'buying')
  await f.tick(); assert.equal(f.submits.length, 1)
})
test('credential deletion or server stop during reads is rechecked before first durable dispatch', async () => {
  const deleted = fixture(); let reads = 0
  deleted.options.loadAccount = async () => ({ version: ++reads > 1 ? 'deleted' : 'private-version' })
  deleted.options.credentialVersionFor = account => account.version
  await deleted.tick()
  assert.equal(deleted.submits.length, 0); assert.equal(deleted.session.status, 'connection_required'); assert.equal(deleted.intents[0].status, 'prepared')
  const disabled = fixture(); let enabled = true
  disabled.options.gateway.quote = async () => { enabled = false; return { price: 100, observedAt: new Date(at).toISOString(), symbol: spec.code, exchange: 'KRX', fresh: true, halted: false } }
  disabled.options.flags = () => ({ workerEnabled: enabled, liveEnabled: true })
  await disabled.tick(); assert.equal(disabled.submits.length, 0)
})
test('partial-fill risk trigger first cancels owned entry remainder; cancel response is not a fill or liquidation', async () => {
  const f = fixture(); await f.tick(); const i = f.intents[0]
  f.inspected.holdingQuantity = 1; f.inspected.sellableQuantity = 1; f.facts.set(i.id, { status: 'partial', ...fact(1, 100) }); f.quote({ price: 111 })
  f.options.gateway.cancel = async input => { f.cancels.push(input); return { status: 'pendingCancel' } }
  await f.tick()
  assert.equal(f.cancels.length, 1); assert.equal(f.submits.length, 1)
  assert.equal(f.intents.find(i => i.kind === 'cancel').status, 'accepted')
  assert.equal(f.session.state.position.quantity, 1)
})
test('explicit adopted subset never sells unrelated holdings and stale quotes do not trigger an exit', async () => {
  const managed = initialTradingState({ adoptedQuantity: 3, averagePrice: 100, totalHoldingQuantity: 20, now: at })
  const f = fixture({ state: managed, customSpec: { ...spec, entryAction: 'manage', manageQuantity: 3 } })
  f.inspected.holdingQuantity = 20; f.inspected.sellableQuantity = 20
  f.quote({ price: 80, observedAt: new Date(at - 40_000).toISOString() }); await f.tick()
  assert.equal(f.submits.length, 0); assert.equal(f.session.state.reason, 'quote_unavailable')
  f.quote({ price: 80 }); await f.tick()
  assert.equal(f.submits.length, 1); assert.equal(f.submits[0].intent.side, 'sell'); assert.equal(f.submits[0].intent.quantity, 3)
  assert.equal(f.session.state.unmanagedQuantity, 17)
})
test('actual write gate after preflight prevents stopped or stale-fenced workers from POSTing', async () => {
  const stopped = fixture(); let writes = 0
  stopped.options.gateway.submit = async input => { stopped.session.stop_requested = true; const permit = await input.beforeWrite(); if (permit.allowed) writes++; return { status: permit.allowed ? 'accepted' : permit.unknown ? 'unknown' : 'rejected', notTransmitted: !permit.allowed && !permit.unknown } }
  await stopped.tick(); assert.equal(writes, 0); assert.equal(stopped.intents[0].metadata.notTransmitted, true)
  const stale = fixture()
  stale.options.gateway.submit = async input => { stale.loseLease(); await input.beforeWrite(); writes++; return { status: 'accepted' } }
  await assert.rejects(stale.tick(), /fenced stale worker/)
  assert.equal(writes, 0); assert.equal(stale.intents[0].status, 'sending'); assert.equal(stale.intents[0].cash_reservation > 0, true)
})
