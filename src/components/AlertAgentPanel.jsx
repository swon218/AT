import { useEffect, useRef, useState } from 'react'
import { Bell, Bot, ChartNoAxesCombined, CircleAlert, CircleCheck, Info, LockKeyhole } from 'lucide-react'
import { ALERT_KINDS, ALERT_RULES_PER_SYMBOL, addAlertDays, alertCondition, alertExpiry, alertFrequencyLabel, alertSessionLabel, alertThreshold, koreanAlertDay, legacyAlertKind } from '../../shared/alertRules'
import { agentApi } from '../services/agentApi'
import { displayAlertStatus, reasons, stateLabels } from '../utils/alertPresentation'
import AlertHelp from './AlertHelp'
import AlertManageDialog from './AlertManageDialog'
import { AlertFrequencySelect, AlertValueInput } from './AlertConditionInputs'
import './AlertAgentPanel.css'

export const agentModes = [
  ['analysis', '분석 에이전트', Bot],
  ['alerts', '알림 에이전트', Bell],
  ['trading', '매매 에이전트', ChartNoAxesCombined],
]

export function AgentModeTabs({ mode, onChange }) {
  const buttons = useRef([])
  return <div role="tablist" aria-label="에이전트 선택" className="agent-mode-tabs">
    {agentModes.map(([key, label, Icon], i) => <button key={key} type="button" role="tab" id={`agent-tab-${key}`}
      ref={el => { buttons.current[i] = el }} aria-selected={mode === key} aria-controls="agent-mode-panel"
      tabIndex={mode === key ? 0 : -1} onClick={() => onChange(key)} onKeyDown={event => {
        const next = { ArrowRight: (i + 1) % 3, ArrowLeft: (i + 2) % 3, Home: 0, End: 2 }[event.key]
        if (next === undefined) return
        event.preventDefault()
        onChange(agentModes[next][0])
        buttons.current[next]?.focus()
      }}><Icon size={17} aria-hidden="true"/>{label}</button>)}
  </div>
}

export function TradingAgentPanel() {
  return <section className="agent-mode-card agent-trading-placeholder">
    <LockKeyhole size={26} aria-hidden="true"/>
    <h2>매매 에이전트</h2>
    <p>주문 자동화 기능을 준비 중입니다.</p>
    <div className="alert-actions"><button type="button" disabled>매매 설정</button><button type="button" disabled>실행</button></div>
  </section>
}

const kakaoStates = {
  ready: ['카카오 메시지 전송 동의 완료', CircleCheck, 'success'],
  consent_required: ['카카오 연결됨 · 메시지 전송 동의 필요', Info, 'warning'],
  unavailable: ['카카오 연결 상태 확인 불가', CircleAlert, 'warning'],
  reconnect: ['카카오 재연결 필요', CircleAlert, 'warning'],
  disconnected: ['카카오 연결 필요', Info, 'neutral'],
}
const toTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' })
const editable = row => ({ kind: '', threshold: '', expires_on: '', frequency: 'once', ...row,
  ...(legacyAlertKind(row?.kind) ? { kind: 'price_touch' } : {}) })

export default function AlertAgentPanel({ userId, watchlist, drafts, roomId, notice, onLogin, onKakao, settingsOpen }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(Boolean(userId))
  const [activeHelp, setActiveHelp] = useState(null)
  const [manager, setManager] = useState(null)
  const [mutationMessage, setMutationMessage] = useState(null)
  const updateRef = useRef(0)
  const mounted = useRef(false)
  const history = useRef(null)
  const title = useRef(null)
  const busyRef = useRef(false)
  const intents = useRef(new Map())
  const draft = drafts.room(roomId)
  const today = koreanAlertDay()
  const afterSymbols = new Set(data?.afterMarketDate === today ? data.afterMarketSymbols : [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (userId && !loading && window.location.hash === '#alert-history') history.current?.scrollIntoView()
  }, [userId, loading])
  useEffect(() => {
    if (!userId || settingsOpen) return
    const controller = new AbortController()
    const load = async () => {
      const run = ++updateRef.current
      try {
        const result = await agentApi('/alerts', { userId, signal: controller.signal })
        if (run === updateRef.current && !controller.signal.aborted) { setData(result); setError('') }
      } catch (cause) {
        if (!controller.signal.aborted && run === updateRef.current) setError(cause.message)
      } finally {
        if (!controller.signal.aborted && run === updateRef.current) setLoading(false)
      }
    }
    void load()
    const timer = setInterval(load, 20_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [userId, settingsOpen, watchlist.rows])

  const rows = watchlist.ready ? watchlist.rows : data?.watchlist || []
  const byCode = new Map()
  for (const rule of data?.rules || []) {
    if (!byCode.has(rule.code)) byCode.set(rule.code, [])
    byCode.get(rule.code).push(rule)
  }
  const chatDrafts = rows.filter(({ code }) => draft.rows[code]?.roomId === roomId && draft.rows[code]?.dirty)
  const savedDrafts = Object.values(draft.saved)
  const [kakaoLabel, KakaoStatusIcon, kakaoTone] = kakaoStates[data?.kakao] ?? kakaoStates.disconnected
  const help = { active: activeHelp, setActive: setActiveHelp }
  const selected = rows.filter(({ code }) => draft.rows[code]?.selected)
  const rules = selected.map(({ code }) => {
    const row = editable(draft.rows[code])
    return { code, kind: row.kind, threshold: alertThreshold(row.kind, row.threshold), expires_on: row.expires_on, frequency: row.frequency }
  })
  const valid = rules.length > 0 && rules.every(rule => rule.threshold !== null && alertExpiry(rule.expires_on, today))
  const available = data?.conditionVersion === 3
  const canActivate = available && data.enabled && data.kakao === 'ready'
  const atLimit = selected.some(({ code }) => (byCode.get(code)?.length || 0) >= ALERT_RULES_PER_SYMBOL)
  const edit = (code, patch) => {
    const row = editable(draft.rows[code])
    drafts.edit(roomId, code, { ...row, ...patch })
    setMutationMessage(null)
  }
  function openManager(event, code, savedDraft) {
    setActiveHelp(null)
    setManager({ trigger: event.currentTarget, code, draft: savedDraft })
  }
  function closeManager() {
    const trigger = manager.trigger
    setManager(null)
    requestAnimationFrame(() => (trigger.isConnected ? trigger : title.current)?.focus())
  }
  async function change(body) {
    if (busyRef.current) return { ok: false, message: '앞선 변경을 처리하고 있습니다.' }
    busyRef.current = true
    setBusy(true)
    ++updateRef.current
    const key = JSON.stringify(body)
    const operation = intents.current.get(key) || crypto.randomUUID()
    intents.current.set(key, operation)
    try {
      const result = await agentApi('/alerts', { method: 'POST', body: { ...body, operation }, userId, signal: AbortSignal.timeout(45_000) })
      intents.current.delete(key)
      if (mounted.current) { ++updateRef.current; setData(result); setError('') }
      return { ok: true }
    } catch (cause) {
      if (cause.code && cause.code !== 'alert_unavailable' && cause.code !== 'agent_proxy_unavailable') intents.current.delete(key)
      if (mounted.current) {
        const run = ++updateRef.current
        const latest = await agentApi('/alerts', { userId, signal: AbortSignal.timeout(8000) }).catch(() => null)
        if (latest && mounted.current && run === updateRef.current) setData(latest)
      }
      return { ok: false, message: cause.message }
    } finally {
      busyRef.current = false
      if (mounted.current) { setBusy(false); setLoading(false) }
    }
  }
  async function createSelected() {
    setMutationMessage(null)
    const result = await change({ action: 'create', rules })
    if (!mounted.current) return
    if (result.ok) drafts.clear(roomId, rules.map(rule => rule.code), draft.revision)
    setMutationMessage({ ...result, message: result.ok ? '새 알림 조건을 저장했습니다.' : result.message })
  }

  return <section className="agent-mode-card alert-agent" aria-label="관심종목 알림 설정">
    <div className="alert-heading">
      <div className="alert-title"><h2 ref={title} tabIndex={-1}>관심종목 알림</h2>
        <AlertHelp {...help} label="관심종목 알림 안내">최초 1회 또는 만료일까지 반복을 선택할 수 있습니다. 반복 알림은 조건에 다시 진입할 때 발송합니다. 만료일은 한국 시간이며 해당 날짜의 마지막 지원 세션까지만 감시합니다.</AlertHelp>
      </div>
      <div className="alert-channel">
        <div className="alert-channel-actions">
          {userId ? <button type="button" className="alert-kakao-settings" onClick={onKakao}>카카오 연결 설정</button> : <button type="button" onClick={onLogin}>로그인</button>}
          <AlertHelp {...help} label="카카오 전송 방식 안내">카카오톡 나와의 채팅에 메시지를 남깁니다. 푸시 알림이나 알림음은 발생하지 않습니다.</AlertHelp>
        </div>
      </div>
    </div>
    {!userId ? <p role="status">로그인하면 관심종목의 알림 조건을 설정할 수 있습니다.</p> : <>
      {loading && <p role="status">알림 설정을 불러오는 중입니다.</p>}
      {data && <p role="status" className="alert-message alert-kakao-status" data-tone={kakaoTone}>
        <KakaoStatusIcon size={14} aria-hidden="true"/><span>{kakaoLabel}{!data.enabled && ' · 알림 감시 준비 중'}</span>
      </p>}
      {data && !available && <p role="status" className="alert-message">알림 관리 업데이트 적용을 기다리는 중입니다.</p>}
      {chatDrafts.length > 0 && <div className="alert-draft-notice">
        <p role="status" className="alert-message">미저장 초안 · 저장 후 알림이 시작됩니다.</p>
        <AlertHelp {...help} label="미저장 초안 안내">대화에서 요청한 조건을 입력했습니다. 내용을 확인한 뒤 저장해야 알림이 활성화됩니다.</AlertHelp>
      </div>}
      {savedDrafts.map(saved => <div key={saved.rule_id} className="alert-draft-notice alert-saved-draft">
        <p role="status" className="alert-message">미저장 변경 · {rows.find(row => row.code === saved.code)?.name || saved.code} · {alertCondition(saved.kind, saved.threshold)} · {alertFrequencyLabel(saved.frequency)} · 저장 후 적용</p>
        <button type="button" onClick={event => openManager(event, saved.code, saved)}>초안 확인</button>
        <button type="button" onClick={() => drafts.clearSaved(roomId, saved)}>초안 버리기</button>
      </div>)}
      {notice && <p role="status" className="alert-message">{notice}</p>}
      {error && <p className="alert-error" role="alert">{error}</p>}
      {!loading && rows.length === 0 && <p>관심종목을 등록하면 이 표에서 조건을 선택할 수 있습니다.</p>}
      {rows.length > 0 && <div className="alert-table-scroll" tabIndex={0} role="region" aria-label="종목별 알림 조건 표">
        <table><thead><tr><th scope="col">대상</th><th scope="col">종목</th><th scope="col">조건 종류</th><th scope="col">조건값 · 기준</th>
          <th scope="col">알림 횟수</th><th scope="col">만료일</th><th scope="col">저장된 조건</th><th scope="col">관리</th></tr></thead>
          <tbody>{rows.map(({ code, name }) => {
            const saved = byCode.get(code) || []
            const row = editable(draft.rows[code])
            const counts = new Map()
            for (const rule of saved) {
              const status = displayAlertStatus(rule, today)
              counts.set(status, (counts.get(status) || 0) + 1)
            }
            return <tr key={code}>
              <td><input type="checkbox" aria-label={`${name} 알림 대상`} disabled={busy} checked={Boolean(row.selected)}
                onChange={event => edit(code, { selected: event.target.checked })}/></td>
              <th scope="row"><strong>{name}</strong><small>{code}</small><small>{afterSymbols.has(code) ? 'KRX 정규장 · 오늘 NXT 대상' : 'KRX 정규장만 지원'}</small></th>
              <td><select aria-label={`${name} 조건 종류`} disabled={busy} value={row.kind}
                onChange={event => edit(code, { kind: event.target.value, threshold: '', dirty: true })}>
                <option value="">조건 선택</option>{Object.entries(ALERT_KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></td>
              <td><AlertValueInput kind={row.kind} label={`${name} 조건값${row.kind === 'price_touch' ? ' · 원' : row.kind ? ' · 퍼센트' : ''}`}
                disabled={busy || !row.kind} value={row.threshold} onChange={threshold => edit(code, { threshold, dirty: true })}/></td>
              <td><AlertFrequencySelect label={`${name} 알림 횟수`} disabled={busy} value={row.frequency}
                onChange={frequency => edit(code, { frequency, dirty: true })}/></td>
              <td><input type="date" min={today} max={addAlertDays(today, 30)} aria-label={`${name} 만료일`} disabled={busy}
                value={row.expires_on} onChange={event => edit(code, { expires_on: event.target.value, dirty: true })}/></td>
              <td><span className="alert-status">{data ? `${saved.length}개` : '—'}</span>
                {[...counts].map(([status, count]) => <small key={status}>{stateLabels[status]} {count}개</small>)}
                {[...new Set(saved.map(rule => reasons[rule.reason]).filter(Boolean))].map(reason => <small key={reason}>{reason}</small>)}
                {saved.length > 0 && <small>최초 1회 {saved.filter(rule => rule.frequency !== 'repeat').length}개 · 반복 {saved.filter(rule => rule.frequency === 'repeat').length}개</small>}
                {row.dirty && <small className="alert-unsaved">저장되지 않은 변경</small>}</td>
              <td><button type="button" aria-label={`${name} 알림 관리`} onClick={event => openManager(event, code)}>관리</button></td>
            </tr>
          })}</tbody>
        </table>
      </div>}
      <div className="alert-save-guide">
        <div className="alert-send-criteria">발송 기준
          <AlertHelp {...help} label="발송 기준 안내">현재가는 첫 관측이 목표가와 같거나 연속 관측 사이에 목표가를 통과하면 충족됩니다. 조회 사이에 도달했다 돌아오는 움직임은 놓칠 수 있습니다. 등락률은 직전 유효 거래일 기준이며, 당일 첫 관측에서 이미 조건을 충족해도 발송될 수 있습니다. 반복은 조건에서 벗어났다가 다시 충족할 때 발송합니다.</AlertHelp>
        </div>
        <p className="alert-caption">등락률이 이미 조건을 충족했다면 첫 유효 시세에서 발송될 수 있습니다.</p>
      </div>
      <div className="alert-actions"><button type="button" disabled={!valid || !canActivate || busy || atLimit} onClick={createSelected}>저장하고 시작</button>
        <span className="alert-selection-summary">새 조건 {selected.length}개 · 관심종목 {rows.length} / 20개</span></div>
      {atLimit && <p className="alert-message">종목당 저장된 조건은 최대 {ALERT_RULES_PER_SYMBOL}개까지 보관할 수 있습니다.</p>}
      {mutationMessage && <p className={mutationMessage.ok ? 'alert-message' : 'alert-error'} role={mutationMessage.ok ? 'status' : 'alert'}>{mutationMessage.message}</p>}
      <section ref={history} id="alert-history" aria-label="발송 이력" className="alert-history">
        <h3>발송 이력</h3>
        {data?.history?.length ? <div className="alert-table-scroll" tabIndex={0} role="region" aria-label="발송 이력 표">
          <table><thead><tr><th scope="col">종목</th><th scope="col">충족 조건</th><th scope="col">관측 시세</th><th scope="col">발송 상태</th></tr></thead>
            <tbody>{data.history.map(item => <tr key={item.id}>
              <th scope="row">{item.name}<small>{item.code}</small></th><td>{alertCondition(item.kind, item.threshold)}<small>{alertFrequencyLabel(item.frequency)}</small></td>
              <td>{Number(item.price).toLocaleString('ko-KR')}원 · {Number(item.change_rate).toFixed(2)}%<small>{toTime.format(new Date(item.observed_at))} · {alertSessionLabel(item.market)}</small>
                {item.base_price && <small>비교 기준 {item.base_day} · {Number(item.base_price).toLocaleString('ko-KR')}원</small>}</td>
              <td>{stateLabels[item.status]}{reasons[item.reason] && <small>{reasons[item.reason]}</small>}</td>
            </tr>)}</tbody>
          </table>
        </div> : data && !loading && <p>조건 충족 또는 발송 이력이 없습니다.</p>}
      </section>
      {manager && <AlertManageDialog rows={rows} byCode={byCode} initialCode={manager.code} initialDraft={manager.draft}
        today={today} afterSymbols={afterSymbols} busy={busy} canActivate={canActivate} available={available} change={change} onClose={closeManager}
        onDraftDone={saved => drafts.clearSaved(saved.roomId, saved)}/>}
    </>}
  </section>
}
