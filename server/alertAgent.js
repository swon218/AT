import { randomUUID } from 'node:crypto'
import { ALERT_KINDS, alertCode, alertCondition, alertExpiry, alertThreshold, alertUuid } from '../shared/alertRules.js'
import { alertError, alertSettings, createAlertStore } from './alertStore.js'
import { createAlertAccess } from './alertAccess.js'

export function normalizeAlertRule(value) {
  if (!value || typeof value.code !== 'string' || !alertCode.test(value.code) || !alertExpiry(value.expires_on)) return null
  const threshold = alertThreshold(value.kind, value.threshold)
  return threshold === null ? null : { code: value.code, kind: value.kind, threshold, expires_on: value.expires_on }
}

export function alertEditor(value, watchlist) {
  const revision = alertUuid.test(value?.revision) ? value.revision : null
  const draft = value?.draft
  if (!alertUuid.test(draft?.id) || !watchlist.some(row => row.code === draft.code)) return { revision, draft: null }
  return { revision, draft: { id: draft.id, code: draft.code, kind: Object.hasOwn(ALERT_KINDS, draft.kind) ? draft.kind : null,
    threshold: alertThreshold(draft.kind, draft.threshold), expires_on: alertExpiry(draft.expires_on) ? draft.expires_on : null } }
}

const states = {
  active: '감시 중', stopped: '중지', expired: '만료', queued: '조건 충족 · 발송 대기',
  sending: '발송 요청 중', sent: '카카오 전송 성공', failed: '발송 실패',
  unknown: '발송 결과 확인 불가', canceled: '발송 취소',
}

export async function alertAnswer(action, { store, userId, roomId, requestId, editor }) {
  if (!action || !userId) return null
  const base = { kind: 'concept', as_of: new Date().toISOString(), claims: [], sources: [], coverage: [], result_sets: [] }
  const say = content => ({ ...base, content })
  if (action.kind === 'unavailable') return say('로그인하고 관심종목을 등록하면 알림 초안을 만들 수 있습니다.')
  if (action.kind === 'ambiguous') return say('어느 종목인지 정확한 종목명이나 종목코드를 알려 주세요.')
  if (action.kind === 'unsupported') return say('초기 알림은 지정 원화 가격과 전일 종가 대비 등락률을 지원합니다. 어떤 조건을 사용할까요?')
  if (action.kind === 'watchlist_required') return say('이 종목은 관심종목에 등록한 뒤 알림 초안을 만들 수 있습니다.')
  if (action.kind === 'invalid') return say('조건값이나 기준을 확인해 주세요. 만료일은 오늘부터 30일 이내로 지정할 수 있습니다.')
  const data = await store('read', { user_id: userId })
  if (action.kind === 'status') {
    const code = action.code && alertCode.test(action.code) ? action.code : null
    const relevant = rows => rows.filter(row => !code || row.code === code)
    const named = new Map(data.watchlist.map(row => [row.code, row.name]))
    const rules = relevant(data.rules).slice(0, 20).map(r =>
      `• ${named.get(r.code) || r.code} · ${alertCondition(r.kind, r.threshold)} · ${states[r.status]}`)
    const history = relevant(data.history).slice(0, 5).map(e => `• ${e.name} · ${states[e.status]}`)
    return say(['서버에 저장된 알림 상태입니다.', rules.join('\n') || '저장된 규칙 없음', '최근 이력', history.join('\n') || '이력 없음'].join('\n\n'))
  }
  if (action.kind !== 'draft') return null
  const rule = normalizeAlertRule(action.rule)
  const stock = rule && data.watchlist.find(row => row.code === rule.code)
  if (!stock) return say('조건이 유효하고 관심종목에 있는 종목만 초안으로 만들 수 있습니다.')
  if (action.edit && (!editor.draft || rule.code !== editor.draft.code)) {
    return say('현재 대화의 알림 초안을 찾지 못했습니다. 바꿀 종목과 조건을 다시 알려 주세요.')
  }
  return {
    ...say(`${stock.name}(${stock.code}) · ${alertCondition(rule.kind, rule.threshold)} · ${rule.expires_on}까지. 알림 화면에서 초안을 확인하고 ‘저장하고 시작’을 누르면 감시를 시작합니다.`),
    alertDraft: { ...rule, id: action.edit ? editor.draft.id : randomUUID(), revision: randomUUID(),
      baseRevision: editor.revision, roomId, requestId },
  }
}

export function registerAlertRoutes(app, {
  actor, wrap, store = createAlertStore(), settings = alertSettings(), access = createAlertAccess(),
}) {
  async function owner(request, reply) {
    reply.header('Cache-Control', 'no-store')
    if (!request.headers.authorization) throw alertError('invalid_authentication', 401)
    const key = await actor(request, reply)
    if (!key.startsWith('u:')) throw alertError('invalid_authentication', 401)
    return key.slice(2)
  }
  app.get('/api/agent/alerts', wrap(async (request, reply) => {
    const user_id = await owner(request, reply)
    const data = await store('read', { user_id })
    return { ...data, enabled: settings.enabled, consentAvailable: settings.consent }
  }))
  app.post('/api/agent/alerts', { bodyLimit: 8000 }, wrap(async (request, reply) => {
    const user_id = await owner(request, reply)
    const { action, code, rules } = request.body ?? {}
    if (!['save', 'resume', 'stop'].includes(action) || Object.keys(request.body ?? {}).some(k => !['action', 'code', 'rules'].includes(k))) {
      throw alertError('alert_invalid', 400)
    }
    if (action !== 'save' && (typeof code !== 'string' || !alertCode.test(code))) throw alertError('alert_invalid', 400)
    let values
    if (action === 'save') {
      if (!Array.isArray(rules) || rules.length < 1 || rules.length > 20) throw alertError('alert_invalid', 400)
      values = rules.map(normalizeAlertRule)
      if (values.some(rule => !rule) || new Set(values.map(rule => rule.code)).size !== values.length) throw alertError('alert_invalid', 400)
    }
    if (action !== 'stop') {
      if (!settings.enabled) throw alertError('alert_disabled', 503)
      const check = await access(user_id, true)
      if (check.status === 'unavailable') throw alertError('alert_kakao_unavailable', 503)
      if (check.status !== 'ready') throw alertError('alert_kakao_required', 409)
    }
    await store(action, { user_id, code, rules: values })
    return { ...await store('read', { user_id }), enabled: settings.enabled, consentAvailable: settings.consent }
  }))
}
