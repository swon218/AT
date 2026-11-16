// Server-only execution boundary. The caller must persist/lease an intent before
// crossing this boundary; an uncertain write is never repeated here.
import { requestKiwoomWithCredentials } from './kiwoomClient.js'
import { createKiwoomChartService } from './charts.js'
import { createBrokerHistory } from './brokerOrderHistory.js'
import { createOpenOrderBrokers, publicOpenOrder } from './openOrderBrokers.js'
import { normalizeKiwoomHoldings } from './kiwoomAccount.js'
import { accountRef as makeAccountRef, credentialVersion, digest, personalAuth } from './personalBroker.js'
import { koreanOrderDay } from '../src/utils/orderPeriod.js'
import {tradingCredentialVersion} from './tradingBrokerCommon.js'
import {createTradingTossGateway} from './tradingTossGateway.js'
import {createTradingNhGateway} from './tradingNhGateway.js'
import {tradingExecutionPolicy} from '../shared/tradingPolicies.js'
export {tradingCredentialVersion} from './tradingBrokerCommon.js'

export const TRADING_BROKER_SOURCES = Object.freeze({
  kiwoom: 'https://raw.githubusercontent.com/Kiwoom-Securities/Kiwoom-REST-API/main/kiwoom/_data/kiwoom_api_spec.json',
  toss: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
  nh: 'https://www.nhplug.com/openapi-docs/krstock/openapi.json',
  kb: 'https://openapi.kbsec.com/api/apis/catalog/57bc6bac-8951-4f40-af53-d98ea5408329/tr-list',
})
const LIMITS = Object.freeze({ quoteAgeMs: 15_000, maximumQuantity: 1_000_000, maximumPrice: 1_000_000_000, maximumPages: 50 })
const disabled = {
  nh: ['nh_recovery_contract_unverified', 'NH 시장주문번호와 체결 조회 통합주문번호의 연결 및 재시작 후 실제 체결시각 복원 계약이 확인되지 않았습니다. 조회만 지원합니다.'],
  kb: ['holdings_quote_reconciliation_unverified', 'KB의 현재 보유수량·개인 KRX 시세 시각·정확한 체결 대사 계약이 확인되지 않아 자동매매를 지원하지 않습니다.'],
}
export function tradingBrokerCapabilities(broker) {
  if (broker === 'kiwoom') return { broker, supported: true, exchange: 'KRX', entryType: 'limit', exitType: 'market', timeInForce: 'DAY', source: TRADING_BROKER_SOURCES.kiwoom }
  if (broker === 'toss') return {broker,supported:true,exchange:'SOR',entryType:'limit',exitType:'market',timeInForce:'DAY',source:TRADING_BROKER_SOURCES.toss}
  const [code, reason] = disabled[broker] || ['broker_unsupported', '지원하지 않는 증권사입니다.']
  return { broker, supported: false,readSupported:broker==='nh',code, reason, source: TRADING_BROKER_SOURCES[broker] || null }
}
const failure = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode })
const strictInteger = (value, { positive = false, absolute = false } = {}) => {
  const text = String(value ?? '').trim().replaceAll(',', '')
  if (!/^[+-]?\d+$/.test(text)) return null
  const parsed = absolute ? Math.abs(Number(text)) : Number(text)
  return Number.isSafeInteger(parsed) && parsed >= (positive ? 1 : 0) ? parsed : null
}
const orderId = value => String(value ?? '').trim().replace(/^0+(?=\d)/, '')
const validOrderId = value => /^\d{1,7}$/.test(String(value)) && Number(value) > 0
const enabled = value => typeof value === 'function' ? value() === true : value === true
const timeout = (signal, milliseconds = 20_000) => signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds)
const safeRead = async work => {
  try { return await work() } catch (error) {
    if (String(error?.code || '').startsWith('trading_')) throw error
    throw failure('trading_read_unavailable', '증권사 읽기 전용 조회를 완료하지 못했습니다.', 502)
  }
}
const assertSymbol = symbol => {
  if (!/^[0-9][0-9A-Z]{5}$/.test(String(symbol || ''))) throw failure('trading_symbol_invalid', '국내주식 종목코드를 확인해 주세요.', 400)
}
const stateBlocked = /거래정지|매매정지|정리매매|관리종목|투자위험|단기과열|상장폐지|불성실/

// The private registration epoch also fences delete -> same-key registration.
// It is not used by shared manual-order credentials/caches or returned raw.
export function parseTradingQuote(payload, symbol, currentTime, session) {
  assertSymbol(symbol)
  if (String(payload?.return_code) !== '0' || payload?.stk_cd !== symbol || !Array.isArray(payload.stk_tic_chart_qry)) throw failure('trading_quote_invalid', 'KRX 시세 응답을 확인할 수 없습니다.')
  const row = payload.stk_tic_chart_qry[0]
  const fields = /^(\d{4})(\d{2})(\d{2})([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/.exec(String(row?.cntr_tm || ''))
  if (!fields) throw failure('trading_quote_timestamp_missing', '시세의 실제 체결 시각을 확인할 수 없습니다.')
  const day = `${fields[1]}-${fields[2]}-${fields[3]}`
  const observed = Date.parse(`${day}T${fields[4]}:${fields[5]}:${fields[6]}+09:00`)
  const price = strictInteger(row.cur_prc, { positive: true, absolute: true })
  if (!price || !Number.isFinite(observed) || koreanOrderDay(observed) !== day || day !== koreanOrderDay(currentTime)
    || observed > currentTime || currentTime - observed > LIMITS.quoteAgeMs) throw failure('trading_quote_stale', '최신 KRX 체결 시세를 확인할 수 없습니다.')
  if (session && (session.market !== 'KRX' || day !== session.date || !Number.isFinite(Date.parse(session.open)) || !Number.isFinite(Date.parse(session.close))
    || Date.parse(session.open) >= Date.parse(session.close) || observed < Date.parse(session.open) || observed >= Date.parse(session.close))) throw failure('trading_quote_session_invalid', '정규장 시세를 확인할 수 없습니다.')
  return { symbol, exchange: 'KRX', price, observedAt: new Date(observed).toISOString(), receivedAt: new Date(currentTime).toISOString(), fresh: true }
}

export function createKiwoomTradingGateway({
  settings = {}, request = requestKiwoomWithCredentials, now = Date.now, loadAccount,
  openOrders = createOpenOrderBrokers({ kiwoom: request, now }),
  history = createBrokerHistory({ kiwoom: definition => request({ ...definition, body: { ...definition.body, dmst_stex_tp: 'KRX' } }) }),
  charts = createKiwoomChartService({ requester: request, now }),
} = {}) {
  const capabilities = broker => {
    const capability = tradingBrokerCapabilities(broker)
    const ordersEnabled = capability.supported && enabled(settings.kiwoomOrdersEnabled)
    return { ...capability, ordersEnabled,
      ...(!ordersEnabled && capability.supported ? { code: 'broker_orders_disabled', reason: 'VPS에서 키움 주문 기능이 활성화되지 않았습니다.' } : {}) }
  }
  function scope({ account, broker, accountRef = '', symbol, expectedCredentialVersion }) {
    if(broker!=='kiwoom')throw failure('trading_broker_unsupported','키움 어댑터의 증권사 범위를 확인해 주세요.')
    const capability = tradingBrokerCapabilities(broker)
    if (!capability.supported) throw failure(`trading_${capability.code}`, capability.reason)
    let auth
    try { auth = personalAuth(account, broker) } catch (error) {
      throw failure(error.statusCode === 401 ? 'trading_auth_required' : 'trading_credentials_missing', error.statusCode === 401 ? '로그인이 필요합니다.' : '선택한 증권사의 개인 API를 등록해 주세요.', error.statusCode === 401 ? 401 : 403)
    }
    if (symbol !== undefined) assertSymbol(symbol)
    const selectedAccountRef = makeAccountRef(account, broker, auth, 'linked')
    const version = tradingCredentialVersion(account, broker, auth)
    if (accountRef && accountRef !== selectedAccountRef) throw failure('trading_account_scope_changed', '본인 계좌를 다시 선택해 주세요.')
    if (expectedCredentialVersion && expectedCredentialVersion !== version) throw failure('trading_credentials_changed', 'API 정보가 변경되어 실행을 계속할 수 없습니다.')
    return { auth, selectedAccountRef, version }
  }
  async function call(auth, apiId, endpoint, body, signal, extra = {}) {
    const result = await request({ ...auth, apiId, endpoint, body, signal, timeoutMs: 12_000, ...extra })
    const payload = extra.returnPage ? result?.body : result
    if (String(payload?.return_code) !== '0') throw failure('trading_business_error', '증권사가 조회를 정상 처리하지 못했습니다.', 502)
    return result
  }
  async function security(auth, symbol, signal) {
    const item = await call(auth, 'ka10100', '/api/dostk/stkinfo', { stk_cd: symbol }, signal)
    if (item.code !== symbol || !['0', '10'].includes(String(item.marketCode)) || String(item.orderWarning) !== '0'
      || typeof item.state !== 'string' || !item.state.trim() || stateBlocked.test(`${item.state}|${item.auditInfo || ''}`)) {
      throw failure('trading_security_restricted', 'KRX 현금 주식의 거래 가능 상태를 확인할 수 없습니다.')
    }
    return item
  }
  async function quote(input) {
    return safeRead(async () => {
      const { auth } = scope(input), signal = timeout(input.signal)
      await security(auth, input.symbol, signal)
      const info = await call(auth, 'ka10001', '/api/dostk/stkinfo', { stk_cd: input.symbol }, signal)
      if (info.stk_cd !== input.symbol) throw failure('trading_security_mismatch', '시세의 종목 일치 여부를 확인할 수 없습니다.')
      const tick = await call(auth, 'ka10079', '/api/dostk/chart', { stk_cd: input.symbol, tic_scope: '1', upd_stkpc_tp: '0' }, signal)
      const result = parseTradingQuote(tick, input.symbol, now(), input.session)
      const priceLimitUp = strictInteger(info.upl_pric, { positive: true, absolute: true }), priceLimitDown = strictInteger(info.lst_pric, { positive: true, absolute: true })
      if (!priceLimitUp || !priceLimitDown || priceLimitDown > result.price || priceLimitUp < result.price) throw failure('trading_price_limits_unknown', '종목 상하한가를 확인할 수 없습니다.')
      return { ...result, halted: false, priceLimitUp, priceLimitDown }
    })
  }
  async function balance(auth, signal) {
    const rows = [], cursors = new Set(); let nextKey = '', last
    for (let page = 0; page < LIMITS.maximumPages; page++) {
      const result = await call(auth, 'kt00018', '/api/dostk/acnt', { qry_tp: '2', dmst_stex_tp: 'KRX' }, signal,
        { returnPage: true, contYn: nextKey ? 'Y' : 'N', nextKey })
      normalizeKiwoomHoldings(result.body)
      last = result.body; rows.push(...(result.body.acnt_evlt_remn_indv_tot || []))
      if (result.contYn !== 'Y') return { ...last, acnt_evlt_remn_indv_tot: rows }
      if (!result.nextKey || cursors.has(result.nextKey)) break
      nextKey = result.nextKey; cursors.add(nextKey)
    }
    throw failure('trading_balance_incomplete', '보유정보 연속 조회를 완료하지 못했습니다.')
  }
  async function inspect(input) {
    return safeRead(async () => {
      const { auth, selectedAccountRef, version } = scope(input), signal = timeout(input.signal, 30_000)
      if (!input.reconciliationOnly) await security(auth, input.symbol, signal)
      const positions = await balance(auth, signal)
      const matching = positions.acnt_evlt_remn_indv_tot.filter(row => String(row.stk_cd || '').replace(/^A/, '') === input.symbol)
      if (matching.length > 1 || matching.some(row => row.crd_tp !== '00' || String(row.crd_loan_dt || '').trim())) throw failure('trading_holding_ambiguous', '복수 보유 구분 또는 신용 보유가 있어 현금 보유분을 확인할 수 없습니다.')
      const holding = matching.length ? normalizeKiwoomHoldings({ ...positions, acnt_evlt_remn_indv_tot: matching })[0] : null
      const holdingQuantity = matching.length ? strictInteger(matching[0].rmnd_qty) : 0
      const sellableQuantity = matching.length ? strictInteger(matching[0].trde_able_qty) : 0
      if (holdingQuantity === null || sellableQuantity === null || sellableQuantity > holdingQuantity) throw failure('trading_holding_quantity_unknown', '현재 보유수량과 매도가능수량을 확인할 수 없습니다.')
      const opens = await openOrders.read(input.broker, input.account, selectedAccountRef, signal)
      if (opens.status !== 'success' || opens.selectedAccountRef !== selectedAccountRef) throw failure('trading_open_orders_incomplete', '미체결 주문을 모두 확인하지 못했습니다.')
      let price = strictInteger(input.price, { positive: true })
      if (!price) {
        // A reference price is sufficient for an account-limit inquiry outside
        // market hours. It is never represented as a fresh execution quote.
        const reference = await call(auth, 'ka10001', '/api/dostk/stkinfo', { stk_cd: input.symbol }, signal)
        if (reference.stk_cd !== input.symbol) throw failure('trading_security_mismatch', '계좌 조회 기준 종목을 확인할 수 없습니다.')
        price = strictInteger(reference.cur_prc, { positive: true, absolute: true })
        if (!price) throw failure('trading_reference_price_unknown', '주문가능금액 조회의 기준가격을 확인할 수 없습니다.')
      }
      const funds = await call(auth, 'kt00011', '/api/dostk/acnt', { stk_cd: input.symbol, uv: String(price) }, signal)
      const amounts = ['ord_alowa', 'min_ord_alow_amt', 'profa_100ord_alow_amt'].map(field => strictInteger(funds[field]))
      const quantities = ['min_ord_alowq', 'profa_100ord_alowq'].map(field => strictInteger(funds[field]))
      if (amounts.some(value => value === null) || quantities.some(value => value === null) || strictInteger(funds.uncla) !== 0) throw failure('trading_cash_unconfirmed', '미수 없는 현금 주문가능금액을 확인할 수 없습니다.')
      return { broker: input.broker, accountRef: selectedAccountRef, credentialVersion: version,
        accountScope: digest([input.account.user.id, input.broker, 'linked']),
        cashAvailable: Math.min(...amounts), buyableQuantity: Math.min(...quantities), holdingQuantity, sellableQuantity,
        averagePrice: holding?.averagePrice > 0 ? holding.averagePrice : null,
        openOrders: opens.items.map(publicOpenOrder), complete: true, eligible: true, reason: null,
        referencePrice: price, fetchedAt: new Date(now()).toISOString() }
    })
  }
  async function candles(input) {
    return safeRead(async () => {
      const { auth, version } = scope(input)
      const interval = input.interval || '일'
      if (!['1분', '5분', '10분', '15분', '30분', '60분', '일', '주', '월'].includes(interval)) throw failure('trading_chart_interval_invalid', '지원하는 차트 주기를 선택해 주세요.', 400)
      const result = await charts.getCandleResponse(input.symbol, interval, input.limit || 500, {
        market: 'KRX', adjusted: true, baseDate: input.baseDate,
        cacheScope: `trading:${input.account.user.id}:${version}`, signal: input.signal,
        requester: definition => request({ ...definition, ...auth }),
      })
      const metadata = result.meta || result.metadata
      if (!metadata || metadata.partial || metadata.invalidRows > 0 || metadata.source !== 'kiwoom' || metadata.market !== 'KRX') throw failure('trading_candles_incomplete', '개인 KRX 일봉을 모두 확인하지 못했습니다.')
      return { candles: result.items, metadata }
    })
  }
  function writeScope(input, { entry = false } = {}) {
    if (!enabled(settings.liveEnabled) || !enabled(settings.workerEnabled) || !enabled(settings.kiwoomOrdersEnabled)) throw failure('trading_live_disabled', '실거래 실행이 비활성화되어 있습니다.', 503)
    const intent = input.intent
    if (!intent || !/^[a-zA-Z0-9_-]{8,100}$/.test(String(intent.id || '')) || !intent.executionId || intent.status !== 'sending'
      || intent.accountRef !== input.accountRef || intent.symbol !== input.symbol || !intent.credentialVersion) throw failure('trading_intent_invalid', '저장된 실행 주문 요청을 확인할 수 없습니다.')
    const context = scope({ ...input, expectedCredentialVersion: intent.credentialVersion })
    const session = input.session, current = now()
    if (!session || session.market !== 'KRX' || session.date !== koreanOrderDay(current)
      || !Number.isFinite(Date.parse(session.open)) || !Number.isFinite(Date.parse(session.close))
      || current < Date.parse(session.open) || current >= Date.parse(session.close)) throw failure('trading_market_closed', '검증된 KRX 정규장에만 실행할 수 있습니다.')
    if (entry && intent.side === 'buy') {
      const signalDay = intent.metadata?.signalDay
      if (signalDay !== 'once' && (!/^\d{4}-\d{2}-\d{2}$/.test(String(signalDay || '')) || signalDay !== session.previous
        || current >= Date.parse(session.open) + 60_000)) throw failure('trading_opening_window_expired', '확정 일봉 신호의 개장 진입 시간이 지나 주문을 보내지 않았습니다.')
    }
    return { ...context, intent }
  }
  async function currentWriteScope(input, options) {
    if (typeof loadAccount === 'function') {
      let current
      try { current = await loadAccount(input.account.user.id) } catch { throw failure('trading_credentials_changed', '주문 전 현재 개인 API 상태를 확인할 수 없습니다.') }
      if (current?.user?.id !== input.account.user.id) throw failure('trading_credentials_changed', '현재 회원의 API 상태를 확인할 수 없습니다.')
      try { scope({ ...input, account: current, expectedCredentialVersion: input.intent.credentialVersion }) }
      catch { throw failure('trading_credentials_changed', '주문 전 개인 API가 삭제·변경되어 전송을 중단했습니다.') }
    }
    return writeScope(input, options)
  }
  const guardError = unknown => Object.assign(failure(unknown ? 'trading_write_gate_unknown' : 'trading_write_gate_rejected', '전송 직전 실행 권한을 확인하지 못했습니다.'), { notTransmitted: !unknown, writeGateUnknown: unknown })
  const notTransmitted = () => ({ status: 'rejected', code: 'trading_write_gate_rejected', notTransmitted: true })
  const transportGuard = (input, options, observedAt) => async () => {
    // Invoked exactly once by the Kiwoom transport after token/flow waiting.
    await currentWriteScope(input, options)
    let result
    try { result = await input.beforeWrite() } catch { throw guardError(true) }
    if (result !== true && result?.allowed !== true) throw guardError(result !== false && result?.unknown !== false)
    // No further await after the one-use SQL grant: recheck synchronous local
    // conditions before returning directly to the broker's fetch boundary.
    try {
      writeScope(input, options)
      if (observedAt && now() - Date.parse(observedAt) > LIMITS.quoteAgeMs) throw new Error()
    } catch { throw guardError(false) }
    return true
  }
  const writeFailure = error => error?.notTransmitted ? notTransmitted() : ({ status: error?.definitiveRejection ? 'rejected' : 'unknown',
    code: error?.definitiveRejection ? 'trading_broker_rejected' : error?.writeGateUnknown ? 'trading_write_gate_unknown' : 'trading_submission_unknown' })
  async function submit(input) {
    const { auth, intent } = writeScope(input, { entry: true })
    if (typeof input.beforeWrite !== 'function') return notTransmitted()
    const quantity = strictInteger(intent.quantity, { positive: true })
    if (!quantity || quantity > LIMITS.maximumQuantity || !['buy', 'sell'].includes(intent.side)) throw failure('trading_order_invalid', '자동매매 주문수량을 확인해 주세요.')
    const price = intent.side === 'buy' ? strictInteger(intent.limitPrice, { positive: true }) : null
    if (intent.side === 'buy' && (!price || price > LIMITS.maximumPrice || !Number.isSafeInteger(intent.maxPrice) || price > intent.maxPrice
      || !Number.isSafeInteger(quantity * price) || !Number.isSafeInteger(intent.reservedCash) || quantity * price > intent.reservedCash)) throw failure('trading_price_bound_invalid', '예약한 현금과 매수 상한가격을 확인할 수 없습니다.')
    if (intent.side === 'sell' && (!Number.isSafeInteger(intent.ownedQuantity) || quantity > intent.ownedQuantity)) throw failure('trading_owned_quantity_invalid', '이 실행에 귀속된 보유수량을 확인할 수 없습니다.')
    const signal = timeout(input.signal, 30_000)
    const latest = await quote({ ...input, signal })
    if (intent.side === 'buy' && (price < latest.priceLimitDown || price > latest.priceLimitUp)) throw failure('trading_price_bound_invalid', '매수 지정가가 상하한가 범위를 벗어났습니다.')
    const inspected = await inspect({ ...input, price: price || latest.price, signal })
    if (inspected.openOrders.some(order => !order.symbol || order.symbol === input.symbol)) throw failure('trading_external_order_conflict', '같은 종목의 미체결 주문이 있어 새 주문을 보내지 않았습니다.')
    if (intent.side === 'buy' && (quantity * price > inspected.cashAvailable || quantity > inspected.buyableQuantity)) throw failure('trading_cash_insufficient', '미수 없는 현금 주문가능금액이 부족합니다.')
    if (intent.side === 'sell' && (quantity > inspected.holdingQuantity || quantity > inspected.sellableQuantity)) throw failure('trading_sellable_insufficient', '현재 보유수량 또는 매도가능수량이 부족합니다.')
    // Recheck flags/calendar after potentially slow account reads. No retries on
    // the write, including rate-limit and token errors after transport begins.
    await currentWriteScope(input, { entry: true })
    if (now() - Date.parse(latest.observedAt) > LIMITS.quoteAgeMs) throw failure('trading_quote_stale', '계좌 확인 중 시세가 오래되어 주문을 보내지 않았습니다.')
    let result
    try {
      result = await request({ ...auth, apiId: intent.side === 'buy' ? 'kt10000' : 'kt10001', endpoint: '/api/dostk/ordr',
        body: { dmst_stex_tp: 'KRX', stk_cd: input.symbol, ord_qty: String(quantity), ord_uv: price ? String(price) : '', trde_tp: price ? '0' : '3', cond_uv: '' },
        signal: timeout(input.signal, 12_000), timeoutMs: 12_000, retry: false, rateRetry: false,
        beforeWrite: transportGuard(input, { entry: true }, latest.observedAt) })
    } catch (error) { return writeFailure(error) }
    if (String(result?.return_code) !== '0') return { status: result?.return_code !== undefined ? 'rejected' : 'unknown', code: 'trading_broker_response_invalid' }
    const number = orderId(result.ord_no)
    if (!validOrderId(number) || result.dmst_stex_tp !== 'KRX') return { status: 'unknown', code: 'trading_acceptance_unconfirmed' }
    return { status: 'accepted', orderNumber: number }
  }
  async function cancel(input) {
    const intent = input.intent
    const cancelInput = { ...input, intent: input.cancelIntent }
    const { auth } = writeScope(cancelInput)
    if (typeof input.beforeWrite !== 'function') return notTransmitted()
    if (!intent || intent.executionId !== input.cancelIntent.executionId || intent.credentialVersion !== input.cancelIntent.credentialVersion
      || intent.accountRef !== input.accountRef || intent.symbol !== input.symbol) throw failure('trading_cancel_scope_invalid', '실행 소유 주문의 범위를 확인할 수 없습니다.')
    if (!validOrderId(orderId(intent.orderNumber)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(intent.date || '')) || intent.date !== input.session.date) throw failure('trading_cancel_scope_invalid', '실행이 접수한 당일 주문을 확인할 수 없습니다.')
    const current = await openOrders.read(input.broker, input.account, input.accountRef, timeout(input.signal))
    if (current.status !== 'success') throw failure('trading_cancel_read_incomplete', '취소 전 미체결 조회를 완료하지 못했습니다.')
    const candidates = current.items.filter(item => orderId(item.orderNumber) === orderId(intent.orderNumber) && item.date === intent.date && item.accountRef === input.accountRef)
    const item = candidates.length === 1 ? candidates[0] : null
    if (!item || item.symbol !== input.symbol || item.side !== intent.side || item.quantity !== intent.quantity || !item.canCancel
      || item.control?.exchange !== 'KRX' || item.control?.cash !== true) throw failure('trading_cancel_ownership_unconfirmed', '실행 소유 주문의 취소가능 잔량을 확인할 수 없습니다.')
    await currentWriteScope(cancelInput)
    let result
    try {
      result = await request({ ...auth, apiId: 'kt10003', endpoint: '/api/dostk/ordr',
        body: { dmst_stex_tp: 'KRX', orig_ord_no: item.control.rawId || item.orderNumber, stk_cd: input.symbol, cncl_qty: String(item.remainingQuantity) },
        signal: timeout(input.signal, 12_000), timeoutMs: 12_000, retry: false, rateRetry: false, beforeWrite: transportGuard(cancelInput) })
    } catch (error) { return writeFailure(error) }
    const number = orderId(result?.ord_no)
    if (String(result?.return_code) !== '0' || !validOrderId(number)
      || result.base_orig_ord_no && orderId(result.base_orig_ord_no) !== orderId(intent.orderNumber)) return { status: 'unknown', code: 'trading_cancel_response_unconfirmed' }
    return { status: 'pendingCancel', orderNumber: number }
  }
  async function reconcile(input) {
    return safeRead(async () => {
      scope(input)
      const intents = Array.isArray(input.intents) ? input.intents : []
      if (intents.length > 100) throw failure('trading_reconcile_limit', '한 번에 확인할 실행 주문이 너무 많습니다.')
      const inspected = await inspect({ ...input, reconciliationOnly: true })
      const dates = [...new Set(intents.map(item => item.date).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(String(day))))].sort().reverse()
      if (dates.length > 5) throw failure('trading_reconcile_limit', '장기 미확인 주문은 운영 확인이 필요합니다.')
      let read = { status: 'ready', completedDays: [], items: [] }
      if (dates.length) read = await history(input.broker, input.account, dates, inspected.accountRef, timeout(input.signal, 30_000), { timeBudgetMs: 25_000 })
      let complete = inspected.complete && read.status === 'ready' && dates.every(day => read.completedDays.includes(day))
      const orders = intents.map(intent => {
        const unknown = { intentId: intent.id, orderNumber: intent.orderNumber || null, status: 'unknown', filledQuantity: null, filledNotional: null, executions: [] }
        if (!validOrderId(orderId(intent.orderNumber)) || intent.accountRef !== inspected.accountRef || intent.symbol !== input.symbol || !dates.includes(intent.date)) { complete = false; return unknown }
        // The shared history adapter deliberately discards the raw order number.
        // Reconstruct its exact identity from the execution-owned accepted id;
        // never guess a match by symbol, price or approximate creation time.
        const expectedId = digest([input.broker, inspected.accountRef, intent.date, orderId(intent.orderNumber)])
        const matches = read.items.filter(row => row.id === expectedId && row.date === intent.date && row.accountRef === inspected.accountRef)
        if (matches.length !== 1) { complete = false; return unknown }
        const row = matches[0]
        if (row.symbol !== input.symbol || row.side !== intent.side || row.quantity !== intent.quantity) { complete = false; return unknown }
        const seen = new Set(), executions = []; let filledQuantity = 0, filledNotional = 0
        for (const fill of row.executions || []) {
          if (!fill.id || seen.has(fill.id) || !strictInteger(fill.quantity, { positive: true }) || !strictInteger(fill.price, { positive: true }) || !Number.isFinite(Date.parse(fill.at))) { complete = false; return unknown }
          seen.add(fill.id); filledQuantity += fill.quantity; filledNotional += fill.quantity * fill.price
          executions.push({ id: fill.id, quantity: fill.quantity, price: fill.price, time: fill.at })
        }
        if (filledQuantity !== row.filledQuantity || filledQuantity > intent.quantity || !Number.isSafeInteger(filledNotional)) { complete = false; return unknown }
        const status = { filled: 'filled', partiallyFilled: 'partial', partial: 'partial', cancelled: 'cancelled', residualCancelled: 'cancelled', rejected: 'rejected', pending: 'open', unknown: 'unknown' }[row.status] || 'unknown'
        if (status === 'unknown') complete = false
        const openMatches = inspected.openOrders.filter(item => orderId(item.orderNumber) === orderId(intent.orderNumber) && item.date === intent.date && item.accountRef === inspected.accountRef)
        const open = openMatches.length === 1 ? openMatches[0] : null
        if (openMatches.length > 1 || (open && (open.exchange !== 'KRX' || open.symbol !== input.symbol || open.side !== intent.side || open.quantity !== intent.quantity || open.filledQuantity !== filledQuantity || open.remainingQuantity + filledQuantity !== intent.quantity))
          || (['open', 'partial'].includes(status) && !open) || (['filled', 'cancelled', 'rejected'].includes(status) && open?.remainingQuantity > 0)) { complete = false; return unknown }
        return { intentId: intent.id, orderNumber: orderId(intent.orderNumber), status, filledQuantity, filledNotional, executions,
          remainingQuantity: open?.remainingQuantity ?? 0, cashReflected: false }
      })
      return { complete, holdingQuantity: inspected.holdingQuantity, averagePrice: inspected.averagePrice,
        openOrders: inspected.openOrders, orders, reason: complete ? null : 'trading_reconciliation_incomplete' }
    })
  }
  return { capabilities, inspect, quote, candles, submit, cancel, reconcile }
}

// Shared orchestration never chooses a substitute broker. Each adapter retains
// its own account, response, order identifier, transport and recovery contracts.
export function createTradingBrokerGateway(options={}) {
  const kiwoom=options.kiwoomAdapter||createKiwoomTradingGateway(options)
  const toss=options.tossAdapter||createTradingTossGateway({settings:options.settings,now:options.now,loadAccount:options.loadAccount,...options.tossOptions})
  const nh=options.nhAdapter||createTradingNhGateway({settings:options.settings,now:options.now,loadAccount:options.loadAccount,...options.nhOptions})
  const adapters={kiwoom,toss,nh}
  const select=broker=>{const adapter=adapters[broker];if(!adapter)throw failure('trading_broker_unsupported',tradingBrokerCapabilities(broker).reason);return adapter}
  return {
    capabilities(broker){const found=adapters[broker];return {...(found?found.capabilities(broker):tradingBrokerCapabilities(broker)),executionPolicy:tradingExecutionPolicy(broker)}},
    async accounts(input){
      if(input.broker==='kiwoom'){
        const auth=personalAuth(input.account,'kiwoom')
        return {accounts:[{ref:makeAccountRef(input.account,'kiwoom',auth,'linked'),label:'키움 API 연결 계좌'}],credentialVersion:tradingCredentialVersion(input.account,'kiwoom',auth)}
      }
      return select(input.broker).accounts(input)
    },
    async inspect(input){return select(input.broker).inspect(input)},
    async quote(input){return {...await select(input.broker).quote(input),sourceBroker:input.broker}},
    async candles(input){return select(input.broker).candles(input)},
    async submit(input){return select(input.broker).submit(input)},
    async cancel(input){return select(input.broker).cancel(input)},
    async reconcile(input){return select(input.broker).reconcile(input)},
  }
}
