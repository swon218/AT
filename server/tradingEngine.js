import { randomUUID } from 'node:crypto'
import { TRADING_POLICY, evaluateTradingSignal, moneyMicros, microsMoney, sizeTradingOrder, tradingExitReason, tradingLimitPrice, tradingTerminal } from '../shared/tradingV1.js'
import { tradingCredentialVersion } from './tradingBrokerGateway.js'

const activeIntent = intent => !['filled', 'cancelled', 'rejected'].includes(intent.status)
const textDate = now => new Date(now).toISOString()
const quantity = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
const safeEvent = (code, at, extra = {}) => ({ code, at: textDate(at), ...extra })
const kstDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
const storedFills = executions => (executions || []).map(fill => ({ key: fill.id, quantity: fill.quantity, price: fill.price, at: fill.time }))

export function initialTradingState({ adoptedQuantity = 0, averagePrice = null, totalHoldingQuantity = 0, now = Date.now() } = {}) {
  if (quantity(adoptedQuantity) === null || quantity(totalHoldingQuantity) === null || adoptedQuantity > totalHoldingQuantity) throw new Error('invalid_adopted_position')
  return { version: 1, position: adoptedQuantity ? { tradeId: randomUUID(), quantity: adoptedQuantity, averagePrice: Number(averagePrice), costMicros: String(moneyMicros(averagePrice) * BigInt(adoptedQuantity)), initialCostMicros: String(moneyMicros(averagePrice) * BigInt(adoptedQuantity)), entryQuantity: adoptedQuantity, entryAt: null, adoptedAt: textDate(now), adopted: true, soldQuantity: 0, proceedsMicros: '0' } : null, unmanagedQuantity: totalHoldingQuantity - adoptedQuantity, closedTrades: [], intentProgress: {}, entryCount: adoptedQuantity ? 1 : 0, checkedAt: null, reason: null }
}

// Cumulative broker facts are reduced against the last durably applied facts.
// A crash after storing an order but before committing the position therefore
// replays the same delta exactly once. Reversed snapshots do not undo fills.
export function applyTradingFills(inputState, intent, order, at = Date.now()) {
  const state = structuredClone(inputState), previous = state.intentProgress?.[intent.id] || { quantity: 0, notionalMicros: '0' }
  const cumulative = quantity(order.filledQuantity)
  if (cumulative === null || cumulative > Number(intent.quantity)) throw new Error('invalid_fill_quantity')
  const notional = moneyMicros(order.filledNotional ?? 0), oldNotional = BigInt(previous.notionalMicros)
  if (cumulative < previous.quantity) return { state, events: [], reversed: true }
  if (cumulative === previous.quantity) {
    if (notional !== oldNotional) throw new Error('fill_notional_conflict')
    return { state, events: [], duplicate: true }
  }
  if (notional <= oldNotional) throw new Error('invalid_fill_notional')
  const delta = cumulative - previous.quantity, amount = notional - oldNotional
  const fillAt = (order.executions || []).filter(e => Number.isFinite(Date.parse(e.time))).map(e => e.time).sort().at(-1) || order.lastFilledAt
  if (!Number.isFinite(Date.parse(fillAt))) throw new Error('fill_time_required')
  let p = state.position
  if (intent.side === 'buy') {
    if (!p) { p = { tradeId: intent.id, quantity: 0, costMicros: '0', initialCostMicros: '0', entryQuantity: 0, entryAt: fillAt, entrySignal: intent.metadata?.signalDay || null, soldQuantity: 0, proceedsMicros: '0' }; state.entryCount = Number(state.entryCount || 0) + 1 }
    if (p.soldQuantity) throw new Error('buy_after_exit_conflict')
    p.quantity += delta; p.entryQuantity += delta; p.costMicros = String(BigInt(p.costMicros) + amount); p.initialCostMicros = p.costMicros
    p.averagePrice = microsMoney(p.costMicros) / p.quantity
    state.position = p
  } else if (intent.side === 'sell') {
    if (!p || delta > p.quantity) throw new Error('sell_exceeds_owned_position')
    const allocation = delta === p.quantity ? BigInt(p.costMicros) : BigInt(p.costMicros) * BigInt(delta) / BigInt(p.quantity)
    p.quantity -= delta; p.costMicros = String(BigInt(p.costMicros) - allocation); p.soldQuantity += delta; p.proceedsMicros = String(BigInt(p.proceedsMicros) + amount)
    if (!p.quantity) {
      const entryCost = BigInt(p.initialCostMicros), proceeds = BigInt(p.proceedsMicros)
      state.closedTrades ||= []
      state.closedTrades.push({ id: p.tradeId, entryAt: p.entryAt, adoptedAt: p.adoptedAt || null, exitAt: fillAt, decisionAt: intent.metadata?.decisionAt || null, entryPrice: microsMoney(entryCost) / p.entryQuantity, exitPrice: microsMoney(proceeds) / p.soldQuantity, quantity: p.soldQuantity, pnl: microsMoney(proceeds - entryCost), reason: intent.kind, adopted: Boolean(p.adopted), costs: 'unconfirmed' })
      state.position = null; state.lastClosedAt = fillAt
    } else p.averagePrice = microsMoney(p.costMicros) / p.quantity
  } else throw new Error('invalid_fill_side')
  state.intentProgress ||= {}; state.intentProgress[intent.id] = { quantity: cumulative, notionalMicros: String(notional) }
  state.checkedAt = textDate(at)
  return { state, events: [safeEvent('fill_confirmed', at, { intentId: intent.id, side: intent.side, quantity: delta })] }
}

export function verifiedTradingSession(calendar, at = Date.now()) {
  if (!calendar || calendar.closed || !/^\d{4}-\d{2}-\d{2}$/.test(calendar.date) || !/^\d{4}-\d{2}-\d{2}$/.test(calendar.previous) || calendar.previous >= calendar.date || (calendar.market && calendar.market !== 'KRX')) return null
  const open = Date.parse(calendar.open), close = Date.parse(calendar.close)
  if (!Number.isFinite(open) || !Number.isFinite(close) || open >= close || close - open > 10 * 3600_000) return null
  const kstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
  if (kstDate !== calendar.date) return null
  return { ...calendar, market: 'KRX', open, close, active: at >= open && at < close, opening: at >= open && at < open + TRADING_POLICY.openingWindowSeconds * 1000 }
}

export function verifyTradingQuote(quote, symbol, session, at = Date.now()) {
  const observed = Date.parse(quote?.observedAt)
  return Boolean(session?.active && quote?.symbol === symbol && quote.exchange === 'KRX' && quote.fresh === true && quote.halted === false && Number.isSafeInteger(quote.price) && quote.price > 0 && Number.isFinite(observed) && observed >= session.open && observed < session.close && observed <= at && at - observed <= TRADING_POLICY.quoteMaxAgeSeconds * 1000)
}

const publicIntent = row => ({ ...row, executionId: row.session_id, orderNumber: row.broker_order_id, actionKey: row.action_key, limitPrice: Number(row.price), date: kstDay(row.created_at), status: row.status, quantity: Number(row.quantity), reservedCash: Number(row.cash_reservation), metadata: row.metadata || {} })

export function createTradingEngine({ store, gateway, calendar, readDaily, loadAccount, credentialVersionFor = tradingCredentialVersion, flags = () => ({ workerEnabled: false, liveEnabled: false, paperEnabled: false }), now = Date.now, workerId = randomUUID() }) {
  if (!store?.call || !gateway || !calendar || !readDaily || !loadAccount) throw new Error('trading_dependencies_required')
  const call = (action, payload) => store.call(action, null, payload)
  let running = false
  return {
    async tick() {
      if (running) return { status: 'busy' }
      const enabled = typeof flags === 'function' ? flags() : flags
      if (!enabled.workerEnabled) return { status: 'disabled', processed: 0 }
      running = true
      let scope
      const report = { status: 'ok', processed: 0, submitted: 0, unknown: 0 }
      try {
        scope = await call('claim', { workerId, leaseSeconds: 90 })
        if (!scope?.lease) return { status: 'idle', processed: 0 }
        const lease = scope.lease, intents = [...(scope.intents || [])]
        const renewLease = async () => {
          const renewed = await call('renew', { lease })
          if (renewed && Number.isFinite(Number(renewed.reservedCash))) lease.reservedCash = Number(renewed.reservedCash)
          if (renewed?.expiresAt) lease.expiresAt = renewed.expiresAt
        }
        const beforeWrite = (intentId, execution) => async () => {
          // This gate runs inside the broker gateway after its slow reads and
          // immediately before the HTTP write. An expired fencing token cannot
          // regain ownership, even when the old worker resumes much later.
          let currentCredentials = false
          try { currentCredentials = credentialVersionFor(await loadAccount(execution.owner_id), execution.broker) === execution.snapshot.credentialVersion } catch { /* The fenced gate below still distinguishes an earlier consumed permit. */ }
          await renewLease()
          const permit = await call('write_gate', { lease, intentId })
          if (!permit.allowed) return permit
          const currentFlags = typeof flags === 'function' ? flags() : flags
          if (!currentCredentials || !currentFlags.workerEnabled || !currentFlags.liveEnabled) return { allowed: false, unknown: false, reason: 'not_transmitted' }
          return permit
        }
        const marketCalendar = await calendar().catch(() => null)
        for (const original of scope.sessions || []) {
          if (tradingTerminal(original.status)) continue
          await renewLease()
          const verified = verifiedTradingSession(marketCalendar, now())
          let state = structuredClone(original.state || initialTradingState()), events = []
          const priorClosedCount = state.closedTrades?.length || 0
          const spec = original.snapshot.spec, strategy = original.snapshot.strategy
          const mine = intents.filter(i => i.session_id === original.id), live = original.mode === 'LIVE'
          const commit = async (nextStatus, reason = null) => {
            state.reason = reason; state.checkedAt = textDate(now())
            await call('commit', { lease, sessionId: original.id, expectedRevision: original.revision, state, status: nextStatus, events })
            report.processed++
          }
          try {
            // Re-read flags and encrypted personal credentials on each session.
            // No account object is cached across ticks or owners.
            const currentFlags = typeof flags === 'function' ? flags() : flags
            // V1 live adapter never doubles as a simulated fill engine. PAPER
            // records remain a separate scope and cannot reach broker writes.
            if (!live || !currentFlags.liveEnabled || !currentFlags.workerEnabled) { await commit('paused', 'disabled'); continue }
            let account
            try { account = await loadAccount(original.owner_id) } catch { await commit('connection_required', 'credentials_changed'); continue }
            const context = { account, broker: original.broker, accountRef: original.account_ref, symbol: original.code }
            const refreshWriteScope = async () => {
              const activeFlags = typeof flags === 'function' ? flags() : flags
              if (!activeFlags.workerEnabled || !activeFlags.liveEnabled) return false
              try {
                const latestAccount = await loadAccount(original.owner_id)
                if (credentialVersionFor(latestAccount, original.broker) !== original.snapshot.credentialVersion) return false
                context.account = latestAccount
                return true
              } catch { return false }
            }
            let inspected
            try { inspected = await gateway.inspect(context) } catch { await commit('connection_required', 'credentials_changed'); continue }
            if (!inspected.complete || !inspected.eligible || inspected.accountRef !== original.account_ref || inspected.credentialVersion !== original.snapshot.credentialVersion) { await commit('connection_required', inspected.reason || 'credentials_changed'); continue }
            let holdings = inspected.holdingQuantity, openOrders = inspected.openOrders || []
            const orderIntents = mine.filter(i => i.kind !== 'cancel')
            const needsRead = orderIntents.filter(i => {
              const applied = state.intentProgress?.[i.id] || { quantity: 0, notionalMicros: '0' }
              // Do not reread the full lifetime of completed trades on every
              // tick. Today's cancelled remainder is still checked for a late
              // fill; an unapplied terminal result is always crash-replayed.
              return (activeIntent(i) && i.status !== 'prepared') || Number(i.cumulative_quantity || 0) !== applied.quantity || moneyMicros(i.cumulative_notional || 0) !== BigInt(applied.notionalMicros) || (i.status === 'cancelled' && publicIntent(i).date === verified?.date)
            })
            if (live && needsRead.length) {
              const recovered = await gateway.reconcile({ ...context, intents: needsRead.map(i => ({ ...publicIntent(i), accountRef: original.account_ref, symbol: original.code, credentialVersion: inspected.credentialVersion })) })
              for (const order of recovered.orders || []) {
                const intent = orderIntents.find(i => i.id === order.intentId)
                if (!intent) throw new Error('unowned_order_fact')
                if (order.status === 'unknown') { report.unknown++; continue }
                const mapped = order.status === 'open' ? 'accepted' : order.status
                const previousQty = Number(intent.cumulative_quantity || 0)
                // Stale lower cumulative snapshots never regress durable facts.
                if (Number(order.filledQuantity) < previousQty) continue
                await call('settle_intent', { lease, intentId: intent.id, status: mapped, brokerOrderId: order.orderNumber, cumulativeQuantity: order.filledQuantity, cumulativeNotional: order.filledNotional, fills: storedFills(order.executions), metadata: {} })
                const reduced = applyTradingFills(state, intent, order, now())
                state = reduced.state; events.push(...reduced.events)
                intent.status = mapped; intent.broker_order_id = order.orderNumber || intent.broker_order_id; intent.cumulative_quantity = order.filledQuantity; intent.cumulative_notional = order.filledNotional
              }
              if (!recovered.complete) { await commit('reconciliation_required', recovered.reason || 'order_unknown'); continue }
              holdings = recovered.holdingQuantity; openOrders = recovered.openOrders || []
            }
            // A cancel acknowledgement is not a cancellation fact. Only the
            // reconciled terminal parent makes its durable cancel task terminal.
            for (const cancellation of mine.filter(i => i.kind === 'cancel' && activeIntent(i))) {
              const parent = orderIntents.find(i => i.id === cancellation.metadata?.parentIntentId)
              if (parent && !activeIntent(parent)) {
                await call('settle_intent', { lease, intentId: cancellation.id, status: 'cancelled', cumulativeQuantity: 0, cumulativeNotional: 0, fills: [], metadata: {} })
                cancellation.status = 'cancelled'
              }
            }
            const unfinished = orderIntents.filter(activeIntent)
            if (unfinished.some(i => ['sending', 'unknown'].includes(i.status))) { await commit('unknown', 'order_unknown'); continue }
            if (quantity(holdings) === null || Number(holdings) !== Number(state.position?.quantity || 0) + Number(state.unmanagedQuantity || 0)) { await commit('reconciliation_required', 'external_conflict'); continue }
            const ownedNumbers = new Set(orderIntents.map(i => i.broker_order_id).filter(Boolean))
            if (openOrders.some(o => !ownedNumbers.has(o.orderNumber ?? o.order_number ?? o.broker_order_id))) { await commit('reconciliation_required', 'external_conflict'); continue }
            const stopped = Boolean(original.stop_requested), abandoned = Boolean(original.abandon_requested), removed = original.watchlisted === false
            // A definite rejection is not an unknown network result. Do not
            // quietly re-attempt the same entry forever; a user must inspect
            // it and stop/start a new saved execution.
            if (!stopped && !removed && !state.position && orderIntents.some(i => i.kind === 'entry' && i.status === 'rejected' && !i.metadata?.notTransmitted)) { await commit('reconciliation_required', 'order_rejected'); continue }
            const pendingPrepared = unfinished.find(i => i.status === 'prepared')
            if (pendingPrepared) {
              // A prepared intent has never crossed dispatch_intent. It may be
              // recovered once after fresh account/time/quote checks; sending
              // and unknown intents above can NEVER enter this path.
              const isEntry = pendingPrepared.kind === 'entry'
              const allowedTime = verified?.active && (!isEntry || spec.entryAction === 'once' || (verified.opening && pendingPrepared.metadata?.signalDay === verified.previous))
              const safePosition = isEntry ? !state.position && holdings === Number(state.unmanagedQuantity || 0) : state.position?.quantity >= Number(pendingPrepared.quantity)
              if (!verified?.active && !stopped && !removed && !abandoned) { await commit(state.position ? 'holding' : 'waiting_signal', verified ? 'market_closed' : 'calendar_unavailable'); continue }
              if ((isEntry && (stopped || removed)) || abandoned || !allowedTime || !safePosition) {
                await call('settle_intent', { lease, intentId: pendingPrepared.id, status: 'rejected', cumulativeQuantity: 0, cumulativeNotional: 0, fills: [], metadata: { notTransmitted: true } })
                if (isEntry) state.signalDay = pendingPrepared.metadata?.signalDay
                await commit(state.position ? stopped ? 'stopping' : 'holding' : stopped || removed ? 'stopped' : 'waiting_signal', isEntry ? 'missed_open' : null); continue
              }
              const quote = await gateway.quote({ ...context, session: { ...verified, open: textDate(verified.open), close: textDate(verified.close) } }).catch(() => null)
              const reason = !isEntry && state.position && quote?.price > 0 ? tradingExitReason(state.position, strategy.backtest_settings, quote.price) : null
              if (!verifyTradingQuote(quote, original.code, verified, now()) || (!isEntry && reason !== pendingPrepared.kind)) { await commit(state.position ? 'holding' : 'waiting_signal', 'quote_unavailable'); continue }
              const fresh = await gateway.inspect(context)
              if (!fresh.complete || !fresh.eligible || fresh.credentialVersion !== inspected.credentialVersion || fresh.holdingQuantity !== holdings || (isEntry && Number(pendingPrepared.cash_reservation) > fresh.cashAvailable)) { await commit('reconciliation_required', 'external_conflict'); continue }
              await renewLease()
              if (!await refreshWriteScope()) { await commit('connection_required', 'credentials_changed'); continue }
              const dispatch = await call('dispatch_intent', { lease, intentId: pendingPrepared.id })
              if (!dispatch.dispatch) { await commit('unknown', 'order_unknown'); continue }
              let result
              try { result = await gateway.submit({ ...context, intent: { ...publicIntent(dispatch.intent), status: 'sending', credentialVersion: inspected.credentialVersion, accountRef: original.account_ref, symbol: original.code, maxPrice: Number(pendingPrepared.price), ownedQuantity: isEntry ? 0 : Number(state.position.quantity) }, session: { ...verified, open: textDate(verified.open), close: textDate(verified.close) }, beforeWrite: beforeWrite(pendingPrepared.id, original) }) } catch { result = { status: 'unknown' } }
              const accepted = result.status === 'accepted', rejected = result.status === 'rejected'
              await call('settle_intent', { lease, intentId: pendingPrepared.id, status: accepted ? 'accepted' : rejected ? 'rejected' : 'unknown', brokerOrderId: result.orderNumber, cumulativeQuantity: 0, cumulativeNotional: 0, fills: [], metadata: { ...(result.notTransmitted ? { notTransmitted: true } : {}) } })
              if (isEntry && accepted) state.signalDay = pendingPrepared.metadata?.signalDay
              if (accepted) report.submitted++; else if (!rejected) report.unknown++
              events.push(safeEvent(accepted ? 'order_accepted' : rejected ? 'order_rejected' : 'order_unknown', now(), { intentId: pendingPrepared.id, side: pendingPrepared.side }))
              await commit(accepted ? isEntry ? 'buying' : 'selling' : rejected ? 'reconciliation_required' : 'unknown', accepted ? null : 'order_unknown'); continue
            }
            if (mine.some(i => i.kind === 'cancel' && ['unknown', 'sending'].includes(i.status))) { await commit('unknown', 'order_unknown'); continue }
            const entry = unfinished.find(i => i.side === 'buy'), exit = unfinished.find(i => i.side === 'sell')
            if (entry) {
              const elapsed = now() - Date.parse(entry.created_at)
              let riskTriggered = false
              if (state.position && verified?.active) {
                const partialQuote = await gateway.quote({ ...context, session: { ...verified, open: textDate(verified.open), close: textDate(verified.close) } }).catch(() => null)
                riskTriggered = verifyTradingQuote(partialQuote, original.code, verified, now()) && Boolean(tradingExitReason(state.position, strategy.backtest_settings, partialQuote.price))
              }
              if (stopped || removed || riskTriggered || elapsed >= TRADING_POLICY.entryTimeoutSeconds * 1000) {
                const cancel = mine.find(i => i.kind === 'cancel' && i.metadata?.parentIntentId === entry.id)
                if ((!cancel || cancel.status === 'prepared') && verified?.active) {
                  const prepared = cancel ? { intent: cancel, created: false } : await call('prepare_intent', { lease, sessionId: original.id, actionKey: `cancel:${entry.id}`, side: entry.side, quantity: Math.max(1, Number(entry.quantity) - Number(entry.cumulative_quantity || 0)), price: 0, kind: 'cancel', cashAvailable: 0, cashReservation: 0, metadata: { parentIntentId: entry.id } })
                  await renewLease()
                  if (!await refreshWriteScope()) { await commit('connection_required', 'credentials_changed'); continue }
                  const dispatch = await call('dispatch_intent', { lease, intentId: prepared.intent.id })
                  if (dispatch.dispatch) {
                    const result = await gateway.cancel({ ...context, intent: { ...publicIntent(entry), date: verified.date, accountRef: original.account_ref, symbol: original.code, credentialVersion: inspected.credentialVersion }, cancelIntent: { ...publicIntent(dispatch.intent || prepared.intent), status: 'sending', date: verified.date, accountRef: original.account_ref, symbol: original.code, credentialVersion: inspected.credentialVersion }, session: { ...verified, open: textDate(verified.open), close: textDate(verified.close) }, beforeWrite: beforeWrite(prepared.intent.id, original) })
                    await call('settle_intent', { lease, intentId: prepared.intent.id, status: ['accepted', 'pendingCancel'].includes(result.status) ? 'accepted' : result.status === 'rejected' ? 'rejected' : 'unknown', cumulativeQuantity: 0, cumulativeNotional: 0, fills: [], metadata: { parentIntentId: entry.id, ...(result.notTransmitted ? { notTransmitted: true } : {}) } })
                    events.push(safeEvent('entry_cancel_requested', now(), { intentId: entry.id }))
                  }
                }
              }
              await commit(stopped || removed ? 'stopping' : 'buying', 'waiting_fill'); continue
            }
            if (exit) { await commit(stopped ? 'stopping' : 'selling', 'waiting_fill'); continue }
            if (abandoned) { await commit('stopped', 'protection_stopped'); continue }
            if (!state.position && (stopped || removed)) { await commit('stopped', removed ? 'watchlist_removed' : null); continue }
            if ((state.closedTrades?.length || 0) > priorClosedCount) { await commit('closed'); continue }
            if (!verified?.active) { await commit(stopped || removed ? 'stopping' : state.position ? 'holding' : 'waiting_signal', verified ? 'market_closed' : 'calendar_unavailable'); continue }
            const quote = await gateway.quote({ ...context, session: { ...verified, open: textDate(verified.open), close: textDate(verified.close) } }).catch(() => null)
            if (!verifyTradingQuote(quote, original.code, verified, now())) { await commit(state.position ? 'holding' : 'waiting_signal', 'quote_unavailable'); continue }
            state.markPrice = quote.price; state.markAt = quote.observedAt
            let action = null
            if (state.position) {
              const reason = tradingExitReason(state.position, strategy.backtest_settings, quote.price)
              if (reason) {
                if (Number(inspected.sellableQuantity) < state.position.quantity) { await commit('reconciliation_required', 'external_conflict'); continue }
                action = { side: 'sell', kind: reason, quantity: state.position.quantity, price: 0, reserveCash: 0, key: `exit:${state.position.tradeId}`, metadata: { decisionAt: textDate(now()), decisionPrice: quote.price, ownedQuantity: state.position.quantity } }
              } else { await commit(stopped || removed ? 'stopping' : 'holding', removed ? 'watchlist_removed' : null); continue }
            } else {
              if (spec.entryAction === 'manage' || (spec.entryAction === 'once' && state.entryCount > 0)) { await commit('completed'); continue }
              let signalDay = 'once'
              if (spec.entryAction === 'signal') {
                signalDay = verified.previous
                if (state.signalDay === signalDay) { await commit('waiting_signal', 'signal_unmet'); continue }
                if (!verified.opening || Date.parse(original.created_at) >= verified.open + TRADING_POLICY.openingWindowSeconds * 1000) { state.missedSignalDay = signalDay; await commit('waiting_signal', 'missed_open'); continue }
                let signal
                try { const daily = await readDaily(original.code); signal = evaluateTradingSignal({ candles: daily.items || daily.candles || daily, strategy, previousDay: signalDay }) } catch { await commit('waiting_signal', 'daily_unavailable'); continue }
                if (!signal.matched) { state.signalDay = signalDay; await commit('waiting_signal', 'signal_unmet'); continue }
              }
              const price = tradingLimitPrice(quote.price, quote.priceLimitUp)
              // Revalidate buying power under the same fenced account lease
              // immediately before the atomic DB reservation.
              const fresh = await gateway.inspect(context)
              if (!fresh.complete || !fresh.eligible || fresh.credentialVersion !== inspected.credentialVersion || fresh.accountRef !== original.account_ref || fresh.holdingQuantity !== holdings) { await commit('reconciliation_required', 'external_conflict'); continue }
              if (spec.entryAction === 'signal' && now() >= verified.open + TRADING_POLICY.openingWindowSeconds * 1000) { state.missedSignalDay = signalDay; await commit('waiting_signal', 'missed_open'); continue }
              const cash = fresh.cashAvailable
              const size = sizeTradingOrder({ quantityMode: spec.quantityMode, quantity: spec.quantity, cashAvailable: cash, reservedCash: lease.reservedCash || 0, price })
              if (!size.quantity) { await commit('waiting_funds', 'cash_insufficient'); continue }
              action = { side: 'buy', kind: 'entry', quantity: size.quantity, price, reserveCash: size.reserveCash, key: `entry:${signalDay}`, cashAvailable: cash, metadata: { signalDay, decisionAt: textDate(now()), decisionPrice: quote.price } }
            }
            const prepared = await call('prepare_intent', { lease, sessionId: original.id, actionKey: action.key, side: action.side, quantity: action.quantity, price: action.price, kind: action.kind, cashAvailable: action.cashAvailable || 0, cashReservation: action.reserveCash, metadata: action.metadata })
            await renewLease()
            if (!await refreshWriteScope()) { await commit('connection_required', 'credentials_changed'); continue }
            const dispatch = await call('dispatch_intent', { lease, intentId: prepared.intent.id })
            if (!dispatch.dispatch) { await commit('unknown', 'order_unknown'); continue }
            const intent = { ...publicIntent(dispatch.intent || prepared.intent), status: 'sending', date: verified.date, credentialVersion: inspected.credentialVersion, accountRef: original.account_ref, symbol: original.code, maxPrice: action.price, ownedQuantity: action.side === 'sell' ? action.quantity : 0 }
            let result
            try { result = await gateway.submit({ ...context, intent, session: { ...verified, open: textDate(verified.open), close: textDate(verified.close) }, beforeWrite: beforeWrite(intent.id, original) }) } catch { result = { status: 'unknown', code: 'order_unknown' } }
            const accepted = result.status === 'accepted', rejected = result.status === 'rejected'
            await call('settle_intent', { lease, intentId: intent.id, status: accepted ? 'accepted' : rejected ? 'rejected' : 'unknown', brokerOrderId: result.orderNumber, cumulativeQuantity: 0, cumulativeNotional: 0, fills: [], metadata: { ...(result.notTransmitted ? { notTransmitted: true } : {}) } })
            if (action.side === 'buy' && accepted) state.signalDay = action.metadata.signalDay
            events.push(safeEvent(accepted ? 'order_accepted' : rejected ? 'order_rejected' : 'order_unknown', now(), { intentId: intent.id, side: action.side }))
            if (accepted) { report.submitted++; lease.reservedCash = Number(lease.reservedCash || 0) + action.reserveCash } else if (!rejected) report.unknown++
            await commit(!accepted ? rejected ? 'reconciliation_required' : 'unknown' : action.side === 'buy' ? 'buying' : 'selling', !accepted ? 'order_unknown' : null)
          } catch (error) {
            // Never log broker bodies, account context or arbitrary exception text.
            // A lease/CAS failure is not converted into a writable success state.
            if (String(error?.code || error?.message).includes('lease') || String(error?.code || error?.message).includes('revision')) throw error
            await commit('reconciliation_required', 'external_conflict')
          }
        }
        return report
      } finally {
        if (scope?.lease) await call('release', { lease: scope.lease }).catch(() => {})
        running = false
      }
    },
  }
}
