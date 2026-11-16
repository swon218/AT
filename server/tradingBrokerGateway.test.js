import test from 'node:test'
import assert from 'node:assert/strict'
import { createTradingBrokerGateway, parseTradingQuote, tradingBrokerCapabilities, tradingCredentialVersion } from './tradingBrokerGateway.js'
import { accountRef } from './personalBroker.js'
import { normalizeHistoryOrder } from './brokerOrderHistory.js'

const currentTime = Date.parse('2026-11-16T00:00:10Z')
const session = { market: 'KRX', date: '2026-11-16', previous: '2026-11-13', open: '2026-11-16T09:00:00+09:00', close: '2026-11-16T15:30:00+09:00' }
const account = { user: { id: 'fixture-user' }, credentials: { kiwoomAppKey: 'fixture-personal-key', kiwoomSecretKey: 'fixture-personal-secret' }, status: { kiwoomConfigured: true } }
const auth = { appKey: account.credentials.kiwoomAppKey, secretKey: account.credentials.kiwoomSecretKey }
const ref = accountRef(account, 'kiwoom', auth, 'linked'), version = tradingCredentialVersion(account, 'kiwoom', auth)
const input = { account, broker: 'kiwoom', accountRef: ref, symbol: '005930', session, beforeWrite: async () => ({ allowed: true }) }
const intent = { id: 'fixture-intent-0001', executionId: 'fixture-execution-1', accountRef: ref, credentialVersion: version, symbol: '005930',
  status: 'sending', date: session.date, side: 'buy', quantity: 2, limitPrice: 100_000, maxPrice: 100_500, reservedCash: 201_000, metadata: { signalDay: 'once' } }
const rawTick = (time = '20261116090000') => ({ return_code: 0, stk_cd: '005930', stk_tic_chart_qry: [{ cntr_tm: time, cur_prc: '+100000' }] })
function fixture(overrides = {}) {
  const calls = [], changes = []
  const settings = { liveEnabled: true, workerEnabled: true, kiwoomOrdersEnabled: true }
  const position = { stk_cd: 'A005930', stk_nm: '삼성전자', rmnd_qty: '0', trde_able_qty: '0', pur_pric: '100000', crd_tp: '00', crd_loan_dt: '' }
  const replies = {
    ka10100: { return_code: 0, code: '005930', marketCode: '0', state: '증거금20%|신용가능', orderWarning: '0', auditInfo: '정상' },
    ka10001: { return_code: 0, stk_cd: '005930', cur_prc: '100000', upl_pric: '130000', lst_pric: '70000' },
    ka10079: rawTick(),
    kt00018: { return_code: 0, tot_pur_amt: '0', tot_evlt_amt: '0', acnt_evlt_remn_indv_tot: [position] },
    kt00011: { return_code: 0, ord_alowa: '1000000', min_ord_alow_amt: '1000000', profa_100ord_alow_amt: '1000000', min_ord_alowq: '10', profa_100ord_alowq: '10', uncla: '0' },
    kt10000: { return_code: 0, ord_no: '0012345', dmst_stex_tp: 'KRX' },
    kt10001: { return_code: 0, ord_no: '0012346', dmst_stex_tp: 'KRX' },
    kt10003: { return_code: 0, ord_no: '0012347', base_orig_ord_no: '0012345' },
  }
  const request = async definition => {
    // A faithful transport fixture: fencing happens after preflight and before
    // recording an actual broker HTTP write, exactly as the production client.
    if (definition.endpoint === '/api/dostk/ordr' && definition.beforeWrite) await definition.beforeWrite()
    calls.push(definition)
    if (overrides.request) return overrides.request(definition, replies)
    const reply = structuredClone(replies[definition.apiId])
    return definition.returnPage ? { body: reply, contYn: 'N', nextKey: '' } : reply
  }
  const opens = { status: 'success', selectedAccountRef: ref, items: [] }
  const historyReply = { status: 'ready', selectedAccountRef: ref, completedDays: [session.date], items: [] }
  const chartCalls = []
  const gateway = createTradingBrokerGateway({ settings, request, now: overrides.now || (() => currentTime), loadAccount: overrides.loadAccount,
    openOrders: { read: async (...args) => { if (overrides.readOpen) return overrides.readOpen(...args); return opens },
      submit: async (...args) => { changes.push(args); if (overrides.cancel) return overrides.cancel(...args); return { orderNumber: '12347', status: 'accepted' } } },
    history: async (...args) => { if (overrides.history) return overrides.history(...args); return historyReply },
    charts: { getCandleResponse: async (...args) => { chartCalls.push(args); return { items: [{ time: '2026-11-13', open: 100, high: 110, low: 90, close: 105, volume: 10 }], meta: { source: 'kiwoom', market: 'KRX', partial: false, invalidRows: 0 } } } },
  })
  return { gateway, request, calls, changes, settings, position, replies, opens, historyReply, chartCalls }
}

test('Kiwoom KRX and Toss SOR policies are distinct; unavailable adapters never fall back', async () => {
  const f = fixture()
  assert.equal(tradingBrokerCapabilities('kiwoom').supported, true)
  assert.equal(tradingBrokerCapabilities('toss').supported,true)
  assert.equal(tradingBrokerCapabilities('toss').exchange,'SOR')
  for (const broker of ['nh', 'kb']) {
    assert.equal(tradingBrokerCapabilities(broker).supported, false)
    assert.ok(tradingBrokerCapabilities(broker).reason)
    await assert.rejects(f.gateway.inspect({ ...input, broker }), error => error.code.startsWith('trading_'))
  }
  assert.equal(f.calls.length, 0)
})

test('reads require authenticated personal keys, account ownership and current credential version', async () => {
  const f = fixture()
  await assert.rejects(f.gateway.inspect({ ...input, account: { ...account, user: null } }), { code: 'trading_auth_required', statusCode: 401 })
  await assert.rejects(f.gateway.inspect({ ...input, accountRef: 'different-account' }), { code: 'trading_account_scope_changed' })
  await assert.rejects(f.gateway.inspect({ ...input, expectedCredentialVersion: 'old-version' }), { code: 'trading_credentials_changed' })
  assert.equal(f.calls.length, 0)
})

test('cash proof uses cash/100%/no-credit limits; owned quantity does not become sellable quantity', async () => {
  const f = fixture()
  f.position.rmnd_qty = '5'; f.position.trde_able_qty = '2'
  f.replies.kt00011.profa_100ord_alow_amt = '250000'; f.replies.kt00011.min_ord_alowq = '2'
  const result = await f.gateway.inspect({ ...input, price: 100000 })
  assert.equal(result.cashAvailable, 250000)
  assert.equal(result.buyableQuantity, 2)
  assert.equal(result.holdingQuantity, 5)
  assert.equal(result.sellableQuantity, 2)
  assert.ok(f.calls.every(call => call.appKey === auth.appKey && call.secretKey === auth.secretKey))
  assert.ok(!JSON.stringify(result).includes(auth.secretKey))
  f.replies.kt00011.uncla = '1'
  await assert.rejects(f.gateway.inspect({ ...input, price: 100000 }), { code: 'trading_cash_unconfirmed' })
})

test('missing cash, ambiguous/credit holding and incomplete paging fail closed', async () => {
  const f = fixture()
  delete f.replies.kt00011.ord_alowa
  await assert.rejects(f.gateway.inspect({ ...input, price: 100000 }), { code: 'trading_cash_unconfirmed' })
  f.replies.kt00018.acnt_evlt_remn_indv_tot.push({ ...f.position })
  await assert.rejects(f.gateway.inspect({ ...input, price: 100000 }), { code: 'trading_holding_ambiguous' })
  f.replies.kt00018.acnt_evlt_remn_indv_tot.pop(); f.position.crd_tp = '03'
  await assert.rejects(f.gateway.inspect({ ...input, price: 100000 }), { code: 'trading_holding_ambiguous' })
  const paged = fixture({ request: async (definition, replies) => definition.returnPage ? { body: replies.kt00018, contYn: 'Y', nextKey: 'repeated' } : replies[definition.apiId] })
  await assert.rejects(paged.gateway.inspect({ ...input, price: 100000 }), { code: 'trading_balance_incomplete' })
})

test('fresh quote uses actual dated KRX tick, never local receipt time or integrated symbol', async () => {
  assert.equal(parseTradingQuote(rawTick(), '005930', currentTime, session).observedAt, '2026-11-16T00:00:00.000Z')
  for (const time of ['20261116085900', '20261116090011', '20260230090000', '090000']) await assert.rejects(async () => parseTradingQuote(rawTick(time), '005930', currentTime, session))
  const integrated = { ...rawTick(), stk_cd: '005930_AL' }
  assert.throws(() => parseTradingQuote(integrated, '005930', currentTime, session), { code: 'trading_quote_invalid' })
  const f = fixture()
  const result = await f.gateway.quote(input)
  assert.equal(result.exchange, 'KRX'); assert.equal(result.price, 100000); assert.equal(result.halted, false)
  f.replies.ka10100.state = '거래정지'
  await assert.rejects(f.gateway.quote(input), { code: 'trading_security_restricted' })
})

test('daily candles are personal KRX requests with credential-isolated cache; no operator substitute', async () => {
  const f = fixture(), result = await f.gateway.candles(input)
  assert.equal(result.candles[0].time, '2026-11-13')
  const options = f.chartCalls[0][3]
  assert.equal(options.market, 'KRX'); assert.ok(options.cacheScope.includes(version)); assert.ok(options.cacheScope.includes(account.user.id))
  await options.requester({ apiId: 'ka10081' })
  assert.equal(f.calls.at(-1).appKey, auth.appKey)
})

test('default write flags and changed credentials prevent every broker write', async () => {
  const f = fixture()
  f.settings.liveEnabled = false
  await assert.rejects(f.gateway.submit({ ...input, intent }), { code: 'trading_live_disabled' })
  f.settings.liveEnabled = true
  await assert.rejects(f.gateway.submit({ ...input, intent: { ...intent, credentialVersion: 'stale' } }), { code: 'trading_credentials_changed' })
  assert.equal(f.calls.length, 0)
  const defaultGateway = createTradingBrokerGateway({ request: async () => { throw new Error('unexpected request') } })
  await assert.rejects(defaultGateway.submit({ ...input, intent }), { code: 'trading_live_disabled' })
})

test('bounded cash DAY limit buy is a single nonretrying KRX request', async () => {
  const f = fixture()
  const result = await f.gateway.submit({ ...input, intent })
  assert.deepEqual(result, { status: 'accepted', orderNumber: '12345' })
  const writes = f.calls.filter(call => call.endpoint === '/api/dostk/ordr')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].body, { dmst_stex_tp: 'KRX', stk_cd: '005930', ord_qty: '2', ord_uv: '100000', trde_tp: '0', cond_uv: '' })
  assert.equal(writes[0].retry, false); assert.equal(writes[0].rateRetry, false)
  await assert.rejects(f.gateway.submit({ ...input, intent: { ...intent, reservedCash: 1 } }), { code: 'trading_price_bound_invalid' })
})

test('final Kiwoom inspection rejects a newly appeared same-symbol or unidentified open order', async () => {
  for (const symbol of [input.symbol, undefined, '000660']) {
    const f = fixture({ request: async (definition, replies) => {
      // A manual order appears while slow holdings/cash preflight is running.
      if (definition.apiId === 'kt00018') f.opens.items = [{ accountRef: ref, orderNumber: 'manual-order', symbol }]
      const body = structuredClone(replies[definition.apiId])
      return definition.returnPage ? { body, contYn: 'N', nextKey: '' } : body
    } })
    if (symbol === '000660') assert.equal((await f.gateway.submit({ ...input, intent })).status, 'accepted')
    else await assert.rejects(f.gateway.submit({ ...input, intent }), { code: 'trading_external_order_conflict' })
    assert.equal(f.calls.filter(call => call.endpoint === '/api/dostk/ordr').length, symbol === '000660' ? 1 : 0)
  }
})

test('unknown write results are never retried; rejection codes do not expose broker text', async () => {
  for (const definitiveRejection of [false, true]) {
    const f = fixture({ request: async (definition, replies) => {
      if (definition.endpoint === '/api/dostk/ordr') throw Object.assign(new Error('sensitive provider original'), { definitiveRejection })
      return definition.returnPage ? { body: replies[definition.apiId], contYn: 'N' } : replies[definition.apiId]
    } })
    const result = await f.gateway.submit({ ...input, intent })
    assert.equal(result.status, definitiveRejection ? 'rejected' : 'unknown')
    assert.equal(f.calls.filter(call => call.endpoint === '/api/dostk/ordr').length, 1)
    assert.ok(!JSON.stringify(result).includes('sensitive'))
  }
})

test('sell is market KRX and capped by execution ownership plus current sellable balance', async () => {
  const f = fixture(); f.position.rmnd_qty = '4'; f.position.trde_able_qty = '3'
  const sell = { ...intent, side: 'sell', quantity: 3, ownedQuantity: 3 }
  const result = await f.gateway.submit({ ...input, intent: sell })
  assert.equal(result.status, 'accepted')
  assert.equal(f.calls.at(-1).apiId, 'kt10001'); assert.equal(f.calls.at(-1).body.trde_tp, '3'); assert.equal(f.calls.at(-1).body.ord_uv, '')
  await assert.rejects(f.gateway.submit({ ...input, intent: { ...sell, quantity: 4 } }), { code: 'trading_owned_quantity_invalid' })
})

test('cancel needs a leased separate cancellation intent and exact owned open order', async () => {
  const f = fixture()
  const original = { ...intent, status: 'accepted', orderNumber: '12345', quantity: 5 }
  const cancelIntent = { ...intent, id: 'fixture-cancel-001', status: 'sending' }
  f.opens.items = [{ accountRef: ref, orderNumber: '0012345', date: session.date, symbol: '005930', side: 'buy', quantity: 5, remainingQuantity: 3, canCancel: true, control: { exchange: 'KRX', cash: true } }]
  const result = await f.gateway.cancel({ ...input, intent: original, cancelIntent })
  assert.equal(result.status, 'pendingCancel')
  const writes = f.calls.filter(call => call.apiId === 'kt10003')
  assert.equal(writes.length, 1); assert.equal(writes[0].body.cncl_qty, '3'); assert.equal(writes[0].retry, false)
  assert.equal(writes[0].body.orig_ord_no, '0012345')
  await assert.rejects(f.gateway.cancel({ ...input, intent: { ...original, executionId: 'unowned' }, cancelIntent }), { code: 'trading_cancel_scope_invalid' })
  f.opens.items[0].symbol = '000660'
  await assert.rejects(f.gateway.cancel({ ...input, intent: original, cancelIntent }), { code: 'trading_cancel_ownership_unconfirmed' })
  assert.equal(f.calls.filter(call => call.apiId === 'kt10003').length, 1)
})

test('reconciliation uses exact accepted order identity and actual executions, including partial cancellation', async () => {
  const f = fixture()
  f.position.rmnd_qty = '2'; f.position.trde_able_qty = '2'
  f.historyReply.items = [normalizeHistoryOrder('kiwoom', ref, session.date, '0012345', { symbol: '005930', side: 'buy', quantity: 5, filledQuantity: 2,
    cancelledQuantity: 3, executions: [{ id: 'fill-1:KRX', quantity: 1, price: 99000, at: '2026-11-16T09:00:01+09:00' }, { id: 'fill-2:KRX', quantity: 1, price: 100000, at: '2026-11-16T09:00:02+09:00' }] })]
  const original = { ...intent, orderNumber: '12345', quantity: 5 }
  const result = await f.gateway.reconcile({ ...input, intents: [original] })
  assert.equal(result.complete, true); assert.equal(result.orders[0].status, 'cancelled'); assert.equal(result.orders[0].filledQuantity, 2); assert.equal(result.orders[0].filledNotional, 199000)
  const unknown = await f.gateway.reconcile({ ...input, intents: [{ ...original, orderNumber: null }] })
  assert.equal(unknown.complete, false); assert.equal(unknown.orders[0].status, 'unknown')
  f.historyReply.items[0].filledQuantity = 3
  const incomplete = await f.gateway.reconcile({ ...input, intents: [original] })
  assert.equal(incomplete.complete, false); assert.equal(incomplete.orders[0].filledQuantity, null)
})

test('partial reconciliation must agree with exact open order remaining and fill quantities', async () => {
  const f = fixture(), original = { ...intent, orderNumber: '12345', quantity: 5 }
  f.historyReply.items = [normalizeHistoryOrder('kiwoom', ref, session.date, '12345', { symbol: '005930', side: 'buy', quantity: 5, filledQuantity: 2,
    executions: [{ id: 'fill-1:KRX', quantity: 2, price: 100000, at: '2026-11-16T09:00:01+09:00' }] })]
  f.opens.items = [{ accountRef: ref, orderNumber: '0012345', date: session.date, symbol: '005930', side: 'buy', quantity: 5, filledQuantity: 2, remainingQuantity: 3, exchange: 'KRX' }]
  let result = await f.gateway.reconcile({ ...input, intents: [original] })
  assert.equal(result.complete, true); assert.equal(result.orders[0].status, 'partial'); assert.equal(result.orders[0].remainingQuantity, 3)
  assert.equal(result.orders[0].cashReflected, false)
  f.opens.items[0].remainingQuantity = 2
  result = await f.gateway.reconcile({ ...input, intents: [original] })
  assert.equal(result.complete, false); assert.equal(result.orders[0].status, 'unknown')
})

test('closed-market reconciliation does not demand a fabricated fresh quote or place a write', async () => {
  const f = fixture({ now: () => Date.parse('2026-11-16T08:00:00Z') })
  f.replies.ka10100.state = '거래정지'
  const result = await f.gateway.reconcile({ ...input, intents: [] })
  assert.equal(result.complete, true)
  assert.ok(!f.calls.some(call => call.apiId === 'ka10079' || call.endpoint === '/api/dostk/ordr'))
  await assert.rejects(f.gateway.submit({ ...input, intent }), { code: 'trading_market_closed' })
})

test('a slow account read or a runtime flag change prevents the subsequent submission', async () => {
  let clock = currentTime
  const f = fixture({ now: () => clock, readOpen: async () => { clock += 20000; return { status: 'success', selectedAccountRef: ref, items: [] } } })
  await assert.rejects(f.gateway.submit({ ...input, intent }), { code: 'trading_quote_stale' })
  assert.ok(!f.calls.some(call => call.endpoint === '/api/dostk/ordr'))
  const toggled = fixture({ readOpen: async () => { toggled.settings.liveEnabled = false; return { status: 'success', selectedAccountRef: ref, items: [] } } })
  await assert.rejects(toggled.gateway.submit({ ...input, intent }), { code: 'trading_live_disabled' })
  assert.ok(!toggled.calls.some(call => call.endpoint === '/api/dostk/ordr'))
})

test('API deletion or rotation during slow preflight reads blocks the actual order and cancel transport', async () => {
  const deleted = { ...account, credentials: {}, status: { kiwoomConfigured: false } }
  const f = fixture({ loadAccount: async owner => { assert.equal(owner, account.user.id); return deleted } })
  await assert.rejects(f.gateway.submit({ ...input, intent }), { code: 'trading_credentials_changed' })
  assert.ok(!f.calls.some(call => call.endpoint === '/api/dostk/ordr'))
  f.opens.items = [{ accountRef: ref, orderNumber: '12345', date: session.date, symbol: '005930', side: 'buy', quantity: 2, remainingQuantity: 2, canCancel: true, control: { exchange: 'KRX', cash: true } }]
  await assert.rejects(f.gateway.cancel({ ...input, intent: { ...intent, status: 'accepted', orderNumber: '12345' }, cancelIntent: { ...intent, id: 'cancel-after-key-delete' } }), { code: 'trading_credentials_changed' })
  assert.equal(f.changes.length, 0)
})

test('deleting then registering identical key material still invalidates the old execution epoch', async () => {
  const first = { ...account, tradingCredentialEpoch: 'first-registration-epoch' }
  const registeredAgain = { ...account, tradingCredentialEpoch: 'second-registration-epoch' }
  const previousVersion = tradingCredentialVersion(first, 'kiwoom', auth)
  assert.notEqual(previousVersion, tradingCredentialVersion(registeredAgain, 'kiwoom', auth))
  const f = fixture({ loadAccount: async () => registeredAgain })
  await assert.rejects(f.gateway.submit({ ...input, account: first, intent: { ...intent, credentialVersion: previousVersion } }), { code: 'trading_credentials_changed' })
  assert.ok(!f.calls.some(call => call.endpoint === '/api/dostk/ordr'))
})

test('real shared history adapter hashes the accepted identity and yields exact KRX fill facts to reconciliation', async () => {
  const f = fixture()
  f.position.rmnd_qty = '2'; f.position.trde_able_qty = '2'
  f.replies.kt00007 = { return_code: 0, acnt_ord_cntr_prps_dtl: [{ ord_no: '0012345', stk_cd: 'A005930', stk_nm: '삼성전자', io_tp_nm: '매수', ord_tm: '090000', ord_qty: '2', cntr_qty: '2', ord_uv: '100000', trde_tp: '보통', acpt_tp: '체결', mdfy_cncl: '', ori_ord: '0000000', cnfm_qty: '0' }] }
  f.replies.kt00009 = { return_code: 0, acnt_ord_cntr_prst_array: [{ ord_no: '0012345', cntr_no: '0000100', stk_cd: 'A005930', cntr_qty: '2', cntr_uv: '100000', cntr_tm: '09:00:01', dmst_stex_tp: 'KRX' }] }
  const gateway = createTradingBrokerGateway({ request: f.request, now: () => currentTime, openOrders: { read: async () => f.opens } })
  const result = await gateway.reconcile({ ...input, intents: [{ ...intent, orderNumber: '12345' }] })
  assert.equal(result.complete, true)
  assert.equal(result.orders[0].status, 'filled'); assert.equal(result.orders[0].orderNumber, '12345')
  assert.equal(result.orders[0].filledQuantity, 2); assert.equal(result.orders[0].filledNotional, 200000)
  assert.deepEqual(result.orders[0].executions[0], { id: '100:KRX', quantity: 2, price: 100000, time: '2026-11-16T09:00:01+09:00' })
  const historyCalls = f.calls.filter(call => ['kt00007', 'kt00009'].includes(call.apiId))
  assert.equal(historyCalls.length, 2); assert.ok(historyCalls.every(call => call.body.dmst_stex_tp === 'KRX'))
})

test('signal entries are not chased when slow preflight crosses the one-minute opening window', async () => {
  let clock = Date.parse('2026-11-16T00:00:50Z')
  const f = fixture({ now: () => clock, readOpen: async () => { clock += 11_000; return { status: 'success', selectedAccountRef: ref, items: [] } } })
  f.replies.ka10079 = rawTick('20261116090050')
  const signalIntent = { ...intent, metadata: { signalDay: session.previous } }
  await assert.rejects(f.gateway.submit({ ...input, intent: signalIntent }), { code: 'trading_opening_window_expired' })
  assert.ok(!f.calls.some(call => call.endpoint === '/api/dostk/ordr'))
  await assert.rejects(f.gateway.submit({ ...input, intent: { ...signalIntent, metadata: { signalDay: '2026-11-12' } } }), { code: 'trading_opening_window_expired' })
})

test('one-use fenced write permission is mandatory and rejects before HTTP without retrying consumed or uncertain grants', async () => {
  const cases = [
    { callback: undefined, status: 'rejected', notTransmitted: true, calls: 0 },
    { callback: async () => false, status: 'rejected', notTransmitted: true, calls: 1 },
    { callback: async () => ({ allowed: false, unknown: false, reason: 'not_transmitted' }), status: 'rejected', notTransmitted: true, calls: 1 },
    { callback: async () => ({ allowed: false, unknown: true, reason: 'already_authorized_or_not_sending' }), status: 'unknown', notTransmitted: undefined, calls: 1 },
    { callback: async () => { throw Object.assign(new Error('PRIVATE lease failure'), { code: 'trading_lease_lost' }) }, status: 'unknown', notTransmitted: undefined, calls: 1 },
  ]
  for (const scenario of cases) {
    const f = fixture(); let calls = 0
    const beforeWrite = scenario.callback ? async () => { calls++; return scenario.callback() } : undefined
    const result = await f.gateway.submit({ ...input, intent, beforeWrite })
    assert.equal(result.status, scenario.status); assert.equal(result.notTransmitted, scenario.notTransmitted); assert.equal(calls, scenario.calls)
    assert.ok(!f.calls.some(call => call.endpoint === '/api/dostk/ordr'))
    assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  }
})

test('owned cancellation also consumes one final fenced guard and cannot POST after stop or expired lease', async () => {
  for (const permitted of [false, { allowed: false, unknown: true }]) {
    const f = fixture(); let guards = 0
    const original = { ...intent, status: 'accepted', orderNumber: '12345', quantity: 2 }
    f.opens.items = [{ accountRef: ref, orderNumber: '0012345', date: session.date, symbol: '005930', side: 'buy', quantity: 2, remainingQuantity: 2, canCancel: true, control: { rawId: '0012345', exchange: 'KRX', cash: true } }]
    const result = await f.gateway.cancel({ ...input, intent: original, cancelIntent: { ...intent, id: 'cancel-final-fence' }, beforeWrite: async () => { guards++; return permitted } })
    assert.equal(guards, 1); assert.equal(result.status, permitted === false ? 'rejected' : 'unknown')
    assert.ok(!f.calls.some(call => call.apiId === 'kt10003'))
  }
})
