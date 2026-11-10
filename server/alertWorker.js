import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { alertCode, alertCondition, koreanAlertDay } from '../shared/alertRules.js'
import { createAgentBridge } from './agent.js'
import { createAlertAccess } from './alertAccess.js'
import { alertSettings, createAlertStore } from './alertStore.js'
import { config } from './config.js'
import { decryptCredentials } from './credentialCrypto.js'
import { createKakaoProvider } from './kakaoProvider.js'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'

const ageLimit = 90_000
const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium',
})
const activeSession = (session, at) => session?.date === koreanAlertDay(at)
  && session.previous < session.date && Date.parse(session.open) <= at && at < Date.parse(session.close)

function integral(value) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return /^[+-]?\d{1,10}$/.test(text) ? Number(text) : null
}

export function parseAlertQuote(payload, code, session, now) {
  if (!activeSession(session, now) || !alertCode.test(code) || payload?.stk_cd !== code
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
  if (previous <= 0) return null
  const change_rate = (100 * delta) / previous
  if (change_rate < -100 || change_rate > 1000) return null
  return { market: 'KRX', trade_day: session.date, base_day: session.previous,
    observed_at: new Date(observed).toISOString(), price, change_rate }
}

export function alertMessage(event, historyUrl) {
  const name = Array.from(event.name.replace(/\s+/g, ' ')).slice(0, 35).join('')
  const rate = Number(event.change_rate).toLocaleString('ko-KR', { maximumFractionDigits: 4, signDisplay: 'exceptZero' })
  const price = Number(event.price).toLocaleString('ko-KR')
  const link = { web_url: historyUrl, mobile_web_url: historyUrl }
  return {
    object_type: 'text',
    text: `${name} (${event.code})\n조건: ${alertCondition(event.kind, event.threshold)}\n관측: ${price}원 · 전일 대비 ${rate}%\n${dateTime.format(new Date(event.observed_at))} · KRX`,
    link, buttons: [{ title: '알림 내역', link }],
  }
}

export function createAlertWorker({
  settings = alertSettings(), store = createAlertStore(), access = createAlertAccess(), provider = createKakaoProvider(config),
  calendar = () => createAgentBridge().call('/calendar/alert-session'), request = requestKiwoomWithCredentials,
  decrypt = decryptCredentials, now = Date.now, pause = sleep,
} = {}) {
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
      const session = await calendar().catch(() => null)
      if (!activeSession(session, now())) return { ...report, status: session ? 'closed' : 'calendar_unavailable' }
      const codes = await call('symbols')
      for (const code of codes) {
        if (now() >= deadline || !activeSession(session, now())) break
        let quote = null
        try {
          const data = await request({ ...settings.credentials, apiId: 'ka10079', endpoint: '/api/dostk/chart',
            body: { stk_cd: code, tic_scope: '1', upd_stkpc_tp: '0' }, timeoutMs: 3000 })
          quote = parseAlertQuote(data, code, session, now())
        } catch { /* An unavailable observation never fires a rule. */ }
        if (quote && now() - Date.parse(quote.observed_at) > ageLimit - 2_000) quote = null
        await call('observe', { code, quote })
        report.quotes += Number(Boolean(quote))
        await pause(1000)
      }
      for (const entry of await call('queue')) {
        if (now() >= deadline || !activeSession(session, now())) break
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
        if (now() >= deadline || !activeSession(session, now())) break
        const args = { event_id: entry.id, kakao_id: link.kakao_id, tokens: link.tokens, day_limit: settings.dailyLimit }
        const event = await call('dispatch', args)
        if (!event) continue
        let result = 'failed', reason = 'market_closed'
        if (activeSession(session, now()) && Date.parse(event.lease_until) > now() + 10_000) {
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
