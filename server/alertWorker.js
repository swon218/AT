import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { alertCode, alertCondition, alertFrequencyLabel, alertSessionLabel } from '../shared/alertRules.js'
import { createAgentBridge } from './agent.js'
import { createAlertAccess } from './alertAccess.js'
import { alertSettings, createAlertStore } from './alertStore.js'
import { config } from './config.js'
import { decryptCredentials } from './credentialCrypto.js'
import { createKakaoProvider } from './kakaoProvider.js'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'
import { activeAlertSession, readAlertAfterMarket, selectAlertSession } from './alertSessions.js'

const ageLimit = 90_000
const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
})
const brokerSymbol = (code, session) => session.market === 'NXT' ? `${code}_NX` : code

function integral(value) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return /^[+-]?\d{1,10}$/.test(text) ? Number(text) : null
}

export function parseAlertReference(daily, info, symbol, previousDay) {
  if (String(daily?.return_code) !== '0' || String(info?.return_code) !== '0'
    || daily.stk_cd !== symbol || info.stk_cd !== symbol || !Array.isArray(daily.stk_dt_pole_chart_qry)) return null
  const basePrice = integral(info.base_pric)
  if (!basePrice || basePrice < 0) return null
  let last = null
  for (const row of daily.stk_dt_pole_chart_qry) {
    const fields = /^(\d{4})(\d{2})(\d{2})$/.exec(row.dt)
    if (!fields) continue
    const date = `${fields[1]}-${fields[2]}-${fields[3]}`
    const timestamp = Date.parse(date)
    const close = integral(row.cur_prc)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date || date > previousDay
      || !close || !/^\+?\d{1,15}$/.test(String(row.trde_qty)) || Number(row.trde_qty) <= 0) continue
    if (!last || date > last.date) last = { date, close: Math.abs(close) }
  }
  return last && { base_day: last.date, base_price: basePrice, prior_close: last.close }
}

export function parseAlertQuote(payload, code, session, now, reference) {
  if (!activeAlertSession(session, now) || !alertCode.test(code) || payload?.stk_cd !== brokerSymbol(code, session)
    || String(payload.return_code) !== '0' || !Array.isArray(payload.stk_tic_chart_qry)) return null
  // The one-tick TR supplies date, time, current price and prior-close delta in one record.
  const row = payload.stk_tic_chart_qry[0]
  const fields = /^(\d{4})(\d{2})(\d{2})([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/.exec(row?.cntr_tm)
  if (!fields || `${fields[1]}-${fields[2]}-${fields[3]}` !== session.date) return null
  const observed = Date.parse(`${session.date}T${fields[4]}:${fields[5]}:${fields[6]}+09:00`)
  if (observed < Date.parse(session.open) || observed >= Date.parse(session.close)
    || observed > now || now - observed > ageLimit) return null
  const rawPrice = integral(row.cur_prc), rawDelta = integral(row.pred_pre)
  if (rawPrice === null || rawDelta === null || rawPrice === 0) return null
  const direction = { 1: 1, 2: 1, 3: 0, 4: -1, 5: -1 }[row.pred_pre_sig]
  if (direction === undefined || (rawDelta === 0) !== (direction === 0)) return null
  const price = Math.abs(rawPrice), delta = direction * Math.abs(rawDelta), previous = price - delta
  if (previous <= 0 || reference?.base_price !== previous || reference.base_day > session.previous) return null
  const change_rate = (100 * delta) / previous
  if (change_rate < -100 || change_rate > 1000) return null
  return { ...reference, trade_day: session.date, observed_at: new Date(observed).toISOString(), price, change_rate }
}

export function alertMessage(event, historyUrl) {
  const name = Array.from(event.name.replace(/\s+/g, ' ')).slice(0, 35).join('')
  const rate = Number(event.change_rate).toLocaleString('ko-KR', { maximumFractionDigits: 4, signDisplay: 'exceptZero' })
  const price = Number(event.price).toLocaleString('ko-KR')
  const link = { web_url: historyUrl, mobile_web_url: historyUrl }
  return {
    object_type: 'text',
    text: `${name} (${event.code})\n조건: ${alertCondition(event.kind, event.threshold)} · ${alertFrequencyLabel(event.frequency)}\n관측: ${price}원 · 전일 대비 ${rate}%\n${dateTime.format(new Date(event.observed_at))} · ${alertSessionLabel(event.market)}`,
    link, buttons: [{ title: '알림 내역', link }],
  }
}

export function createAlertWorker({
  settings = alertSettings(), store = createAlertStore(), access = createAlertAccess(), provider = createKakaoProvider(config),
  calendar = () => createAgentBridge().call('/calendar/alert-session'), request = requestKiwoomWithCredentials,
  afterMarket = readAlertAfterMarket, decrypt = decryptCredentials, now = Date.now, pause = sleep,
} = {}) {
  const references = new Map()
  let referenceDay
  return async function tick() {
    if (!settings.enabled) return { status: 'disabled' }
    const operation = randomUUID()
    const deadline = now() + 110_000
    const call = (action, p) => store(action, { ...p, operation })
    if (!await call('begin_tick')) return { status: 'busy' }
    const report = { status: 'ok', quotes: 0, sent: 0, unknown: 0 }
    try {
      for (const user_id of await call('scope_due')) {
        if (now() >= deadline) break
        try {
          const result = await access(user_id)
          if (result.status === 'kakao_required') await call('kakao_block', { user_id })
        } catch { /* Other accounts still get checked. */ }
        await call('scope_checked', { user_id })
      }
      const regular = await calendar().catch(() => null)
      const after = regular && !regular.closed && !activeAlertSession(regular, now()) ? await afterMarket(regular.date) : null
      const session = selectAlertSession(regular, after, now())
      if (!session) return { ...report, status: regular ? 'closed' : 'calendar_unavailable' }
      const window = { market: session.market, phase: session.phase, trade_day: session.date, previous_day: session.previous,
        session_open: session.open, session_close: session.close, ...(session.symbols ? { symbols: session.symbols } : {}) }
      if (referenceDay !== session.date) { references.clear(); referenceDay = session.date }
      const codes = await call('symbols', window)
      let callsLeft = 10
      async function quoteRequest(apiId, endpoint, body) {
        if (!callsLeft || now() >= deadline || !activeAlertSession(session, now())) return null
        callsLeft--
        try { return await request({ ...settings.credentials, apiId, endpoint, body, timeoutMs: 3000 }) }
        catch { return null }
        finally { await pause(1000) }
      }
      for (const code of codes) {
        if (!callsLeft || now() >= deadline || !activeAlertSession(session, now())) break
        const symbol = brokerSymbol(code, session)
        let reference = references.get(symbol)
        if (!reference) {
          if (callsLeft < 3) break
          const daily = await quoteRequest('ka10081', '/api/dostk/chart', { stk_cd: symbol,
            base_dt: session.previous.replaceAll('-', ''), upd_stkpc_tp: '0' })
          const info = daily && await quoteRequest('ka10001', '/api/dostk/stkinfo', { stk_cd: symbol })
          reference = parseAlertReference(daily, info, symbol, session.previous)
          if (reference) references.set(symbol, reference)
        }
        const data = reference && await quoteRequest('ka10079', '/api/dostk/chart',
          { stk_cd: symbol, tic_scope: '1', upd_stkpc_tp: '0' })
        let quote = parseAlertQuote(data, code, session, now(), reference)
        if (quote && now() - Date.parse(quote.observed_at) > ageLimit - 2_000) quote = null
        await call('observe', { ...window, code, quote, reason: reference && !data ? 'quote_unavailable' : 'reference_or_quote_unavailable' })
        report.quotes += Number(Boolean(quote))
      }
      for (const entry of await call('queue', window)) {
        if (now() >= deadline || !activeAlertSession(session, now())) break
        const user_id = entry.user_id
        const available = await access(user_id).catch(() => ({ status: 'unavailable' }))
        if (available.status === 'kakao_required') await call('kakao_block', { user_id })
        if (available.status !== 'ready') continue
        const { link } = available
        let token
        try {
          token = decrypt(`kakao:${user_id}`, link.tokens).access
          if (!await provider.messageScope(token, link.kakao_id)) {
            await call('kakao_block', { user_id })
            continue
          }
        } catch (error) {
          if (['consent_required', 'revoked'].includes(error.kind)) await call('kakao_block', { user_id })
          continue
        }
        if (now() >= deadline || !activeAlertSession(session, now())) break
        const args = { ...window, event_id: entry.id, kakao_id: link.kakao_id, tokens: link.tokens, day_limit: settings.dailyLimit }
        const event = await call('dispatch', args)
        if (!event) continue
        let result = 'failed', reason = 'market_closed'
        if (activeAlertSession(session, now()) && Date.parse(event.lease_until) > now() + 10_000) {
          try {
            await provider.sendMemo(token, alertMessage(event, settings.historyUrl))
            result = 'sent'
            reason = null
          } catch (error) {
            if (error.kind === 'quota') { result = 'retry'; reason = 'quota' }
            else if (error.kind === 'quota_exhausted') reason = 'quota'
            else if (['revoked', 'consent_required'].includes(error.kind)) reason = 'kakao_required'
            else if (error.kind === 'rejected') reason = 'provider_rejected'
            else { result = 'unknown'; reason = 'response_unknown' }
          }
        }
        await call('finish', { event_id: entry.id, result, reason })
        if (reason === 'kakao_required') await call('kakao_block', { user_id })
        report.sent += Number(result === 'sent')
        report.unknown += Number(result === 'unknown')
        if (result === 'retry') break
        await pause(1000)
      }
      return report
    } finally {
      await call('end_tick').catch(() => {})
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tick = createAlertWorker()
  const loop = process.argv.includes('--loop')
  do {
    try {
      const report = await tick()
      console.log(JSON.stringify(report))
      if (report.status === 'disabled') break
    } catch {
      console.error('ATLAS alert tick failed')
      if (!loop) process.exitCode = 1
    }
    if (loop) await sleep(60_000)
  } while (loop)
}
