import { randomUUID } from 'node:crypto'
import { ALERT_FREQUENCIES, ALERT_KINDS, ALERT_RULES_PER_SYMBOL, alertCode, alertCondition, alertExpiry, alertFrequencyLabel, alertThreshold, alertUuid, koreanAlertDay } from '../shared/alertRules.js'
import { alertError, alertSettings, createAlertStore } from './alertStore.js'
import { createAlertAccess } from './alertAccess.js'
import { readAlertAfterMarket } from './alertSessions.js'

const validId = value => typeof value === 'string' && alertUuid.test(value)

export function normalizeAlertRule(value) {
  if (!value || typeof value.code !== 'string' || !alertCode.test(value.code) || !alertExpiry(value.expires_on)
    || !Object.hasOwn(ALERT_KINDS, value.kind) || !Object.hasOwn(ALERT_FREQUENCIES, value.frequency)) return null
  const threshold = alertThreshold(value.kind, value.threshold)
  return threshold === null ? null : { code: value.code, kind: value.kind, threshold, expires_on: value.expires_on, frequency: value.frequency }
}

export function alertEditor(value, watchlist, rules = []) {
  const revision = alertUuid.test(value?.revision) ? value.revision : null
  const draft = value?.draft
  if (!alertUuid.test(draft?.id) || !watchlist.some(row => row.code === draft.code)) return { revision, draft: null }
  const saved = draft.rule_id && rules.find(rule => rule.rule_id === draft.rule_id && rule.version === draft.version && rule.code === draft.code)
  if (draft.rule_id && !saved) return { revision, draft: null }
  return { revision, draft: { id: draft.id, code: draft.code, kind: Object.hasOwn(ALERT_KINDS, draft.kind) ? draft.kind : null,
    ...(saved ? { rule_id: saved.rule_id, version: saved.version } : {}),
    threshold: alertThreshold(draft.kind, draft.threshold), expires_on: alertExpiry(draft.expires_on) ? draft.expires_on : null,
    frequency: Object.hasOwn(ALERT_FREQUENCIES, draft.frequency) ? draft.frequency : 'once' } }
}

const states = {
  active: '감시 중', stopped: '중지', expired: '만료', queued: '조건 충족 · 발송 대기',
  sending: '발송 요청 중', sent: '카카오 전송 성공', failed: '발송 실패',
  unknown: '발송 결과 확인 불가', canceled: '취소',
}

export async function alertAnswer(action, { store, userId, roomId, requestId, editor }) {
  if (!action || !userId) return null
  const base = { kind: 'concept', as_of: new Date().toISOString(), claims: [], sources: [], coverage: [], result_sets: [] }
  const say = content => ({ ...base, content })
  if (action.kind === 'unavailable') return say('로그인하고 관심종목을 등록하면 알림 초안을 만들 수 있습니다.')
  if (action.kind === 'ambiguous') return say('어느 종목인지 정확한 종목명이나 종목코드를 알려 주세요.')
  if (action.kind === 'unsupported') return say('목표가 도달과 전일 기준가 대비 상승률·하락률을 지원합니다. 어떤 조건을 사용할까요?')
  if (action.kind === 'legacy_conversion_required') return say('기존 이상·이하 규칙은 현재 방식으로 계속 감시됩니다. 수정하려면 양방향 목표가 도달로 전환할지 알려 주세요. 종목 옆 관리 버튼에서 직접 변경할 수도 있습니다.')
  if (action.kind === 'watchlist_required') return say('이 종목은 관심종목에 등록한 뒤 알림 초안을 만들 수 있습니다.')
  if (action.kind === 'invalid') return say('조건값이나 기준을 확인해 주세요. 만료일은 오늘부터 30일 이내로 지정할 수 있습니다.')
  const data = await store('read', { user_id: userId })
  if (action.kind === 'status') {
    const code = action.code && alertCode.test(action.code) ? action.code : null
    const relevant = rows => rows.filter(row => !code || row.code === code)
    const named = new Map(data.watchlist.map(row => [row.code, row.name]))
    const rules = relevant(data.rules).slice(0, 20).map(r =>
      `• ${named.get(r.code) || r.code} · ${alertCondition(r.kind, r.threshold)} · ${alertFrequencyLabel(r.frequency)} · ${states[r.status]}`)
    const history = relevant(data.history).slice(0, 5).map(e => `• ${e.name} · ${states[e.status]}`)
    return say(['서버에 저장된 알림 상태입니다.', rules.join('\n') || '저장된 규칙 없음', '최근 이력', history.join('\n') || '이력 없음'].join('\n\n'))
  }
  if (action.kind === 'ambiguous_rule') {
    const matching = data.rules.filter(rule => rule.code === action.code).map(rule =>
      `• ${alertCondition(rule.kind, rule.threshold)} · ${alertFrequencyLabel(rule.frequency)} · ${rule.expires_on}까지 · ${states[rule.status]}`)
    return say(['어느 저장 조건을 바꿀지 조건과 만료일을 알려 주세요. 종목 옆 관리 버튼에서도 직접 선택할 수 있습니다.', ...matching].join('\n'))
  }
  if (action.kind !== 'draft') return null
  const rule = normalizeAlertRule({ frequency: 'once', ...action.rule })
  const stock = rule && data.watchlist.find(row => row.code === rule.code)
  if (!stock) return say('조건이 유효하고 관심종목에 있는 종목만 초안으로 만들 수 있습니다.')
  if (action.edit && (!editor.draft || rule.code !== editor.draft.code)) {
    return say('현재 대화의 알림 초안을 찾지 못했습니다. 바꿀 종목과 조건을 다시 알려 주세요.')
  }
  const target = action.edit ? editor.draft : action
  const saved = target.rule_id && data.rules.find(row => row.rule_id === target.rule_id
    && row.version === target.version && row.code === rule.code && row.status !== 'sending')
  if (target.rule_id && !saved) return say('저장된 조건의 상태가 바뀌었습니다. 종목 옆 관리 버튼에서 최신 조건을 확인해 주세요.')
  const instruction = saved ? '미저장 변경을 검토한 뒤 직접 저장해 주세요. 기존 조건은 종목 옆 관리 버튼에서 확인할 수 있습니다.'
    : '알림 화면에서 초안을 확인하고 ‘저장하고 시작’을 누르면 감시를 시작합니다.'
  return {
    ...say(`${stock.name}(${stock.code}) · ${alertCondition(rule.kind, rule.threshold)} · ${alertFrequencyLabel(rule.frequency)} · ${rule.expires_on}까지. ${instruction}`),
    alertDraft: { ...rule, ...(saved ? { rule_id: saved.rule_id, version: saved.version } : {}),
      id: action.edit ? editor.draft.id : randomUUID(), revision: randomUUID(),
      baseRevision: editor.revision, roomId, requestId },
  }
}

export function registerAlertRoutes(app, {
  actor, wrap, store = createAlertStore(), settings = alertSettings(), access = createAlertAccess(), afterMarket = readAlertAfterMarket,
}) {
  async function owner(request, reply) {
    reply.header('Cache-Control', 'no-store')
    if (!request.headers.authorization) throw alertError('invalid_authentication', 401)
    const key = await actor(request, reply)
    if (!key.startsWith('u:')) throw alertError('invalid_authentication', 401)
    return key.slice(2)
  }
  async function state(user_id) {
    const data = await store('read', { user_id })
    const today = koreanAlertDay()
    const after = await afterMarket(today)
    const watched = new Set((data.watchlist || []).map(item => item.code))
    return { ...data, enabled: settings.enabled, consentAvailable: settings.consent,
      afterMarketDate: after?.date, afterMarketSymbols: after?.symbols.filter(code => watched.has(code)) || [] }
  }
  app.get('/api/agent/alerts', wrap(async (request, reply) => state(await owner(request, reply))))
  app.post('/api/agent/alerts', { bodyLimit: 8000 }, wrap(async (request, reply) => {
    const user_id = await owner(request, reply)
    const { action, operation, rule_id, version, rule, rules } = request.body ?? {}
    const fields = { create: ['rules'], update: ['rule_id', 'version', 'rule'], cancel: ['rule_id', 'version'], restart: ['rule_id', 'version', 'rule'] }
    if (!Object.hasOwn(fields, action) || !validId(operation)
      || Object.keys(request.body).some(key => !['action', 'operation', ...fields[action]].includes(key))) {
      throw alertError('alert_invalid', 400)
    }
    const input = { user_id, operation, mutation: action }
    if (action === 'create') {
      if (!Array.isArray(rules) || rules.length < 1 || rules.length > 20) throw alertError('alert_invalid', 400)
      input.rules = rules.map(normalizeAlertRule)
      if (input.rules.some(row => !row)) throw alertError('alert_invalid', 400)
      const count = new Map()
      for (const row of input.rules) {
        count.set(row.code, (count.get(row.code) || 0) + 1)
        if (count.get(row.code) > ALERT_RULES_PER_SYMBOL) throw alertError('alert_rule_limit', 409)
      }
    } else {
      if (!validId(rule_id) || !validId(version)) throw alertError('alert_invalid', 400)
      Object.assign(input, { rule_id, version })
      if (action !== 'cancel') {
        input.rule = normalizeAlertRule(rule)
        if (!input.rule) throw alertError('alert_invalid', 400)
      }
    }
    if (!await store('mutation_replay', input)) {
      if (action !== 'cancel') {
        if (!settings.enabled) throw alertError('alert_disabled', 503)
        const check = await access(user_id, true)
        if (check.status === 'unavailable') throw alertError('alert_kakao_unavailable', 503)
        if (check.status !== 'ready') throw alertError('alert_kakao_required', 409)
      }
      await store('mutate', input)
    }
    return state(user_id)
  }))
}
