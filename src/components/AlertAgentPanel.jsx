import { useEffect, useRef, useState } from 'react'
import { Bell, Bot, ChartNoAxesCombined, LockKeyhole } from 'lucide-react'
import { ALERT_KINDS, addAlertDays, alertCondition, alertExpiry, alertThreshold, koreanAlertDay, priceRule } from '../../shared/alertRules'
import { agentApi } from '../services/agentApi'
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

const stateLabels = {
  active: '감시 중', stopped: '중지', expired: '만료', queued: '조건 충족 · 발송 대기',
  sending: '카카오 발송 요청 중', sent: '카카오 전송 성공', failed: '발송 실패',
  unknown: '발송 결과 확인 불가', canceled: '발송 취소',
}
const reasons = {
  quote_unavailable: '시세 확인 불가', kakao_required: '카카오 재연결 또는 메시지 동의 필요',
  watchlist_removed: '관심종목 삭제', event_stale: '관측 시각 만료', expired: '만료일 경과',
  quota: '카카오 발송 한도', market_closed: '정규장 종료',
}
const toTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' })
const editable = (row, rule) => ({ kind: rule?.kind || '', threshold: rule?.threshold ?? '',
  expires_on: rule?.expires_on || '', ...row })

export default function AlertAgentPanel({ userId, watchlist, drafts, roomId, notice, onLogin, onKakao, settingsOpen }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(Boolean(userId))
  const updateRef = useRef(0)
  const mounted = useRef(false)
  const history = useRef(null)
  const draft = drafts.room(roomId)
  const today = koreanAlertDay()

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
  const byCode = new Map((data?.rules || []).map(rule => [rule.code, rule]))
  const selected = rows.filter(({ code }) => draft.rows[code]?.selected)
  const rules = selected.map(({ code }) => {
    const row = editable(draft.rows[code], byCode.get(code))
    return { code, kind: row.kind, threshold: alertThreshold(row.kind, row.threshold), expires_on: row.expires_on }
  })
  const valid = rules.length > 0 && rules.every(rule => rule.threshold !== null && alertExpiry(rule.expires_on, today))
  const canActivate = !busy && data?.enabled && data.kakao === 'ready'
  const edit = (code, patch) => {
    const row = editable(draft.rows[code], byCode.get(code))
    drafts.edit(roomId, code, { ...row, ...patch })
  }
  async function change(body) {
    setBusy(true)
    setError('')
    ++updateRef.current
    try {
      const result = await agentApi('/alerts', { method: 'POST', body, userId })
      if (!mounted.current) return
      ++updateRef.current
      setData(result)
      if (body.action === 'save') drafts.clear(roomId, body.rules.map(rule => rule.code), draft.revision)
    } catch (cause) {
      if (mounted.current) setError(cause.message)
    } finally {
      if (mounted.current) { setBusy(false); setLoading(false) }
    }
  }

  return <section className="agent-mode-card alert-agent" aria-label="관심종목 알림 설정">
    <div className="alert-heading"><div><h2>관심종목 알림</h2><p>KRX 정규장에 등록한 조건이 충족되면 종목별로 한 번 발송합니다.</p></div>
      {userId ? <button type="button" onClick={onKakao}>카카오 연결 설정</button> : <button type="button" onClick={onLogin}>로그인</button>}
    </div>
    <p>카카오톡 나와의 채팅에 메시지를 남깁니다. 푸시 알림이나 알림음은 발생하지 않습니다.</p>
    <p>저장할 때 조건이 이미 충족됐다면 첫 유효 시세 확인에서 바로 발송될 수 있습니다. 조회 사이에 잠깐 도달한 가격은 놓칠 수 있습니다.</p>
    {!userId ? <p role="status">로그인하면 관심종목의 알림 조건을 설정할 수 있습니다.</p> : <>
      {loading && <p role="status">알림 설정을 불러오는 중입니다.</p>}
      {data && <p role="status">{data.kakao === 'ready' ? '카카오 메시지 전송 동의 완료'
        : data.kakao === 'consent_required' ? '카카오 연결됨 · 메시지 전송 동의 필요'
        : data.kakao === 'unavailable' ? '카카오 연결 상태 확인 불가'
        : data.kakao === 'reconnect' ? '카카오 재연결 필요' : '카카오 연결 필요'}
        {!data.enabled && ' · 알림 감시 준비 중'}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p className="alert-error" role="alert">{error}</p>}
      {!loading && rows.length === 0 && <p>관심종목을 등록하면 이 표에서 조건을 선택할 수 있습니다.</p>}
      {rows.length > 0 && <div className="alert-table-scroll" tabIndex={0} role="region" aria-label="종목별 알림 조건 표">
        <table><thead><tr><th scope="col">대상</th><th scope="col">종목</th><th scope="col">조건 종류</th><th scope="col">조건값 · 기준</th>
          <th scope="col">만료일</th><th scope="col">저장된 상태</th><th scope="col">관리</th></tr></thead>
          <tbody>{rows.map(({ code, name }) => {
            const rule = byCode.get(code)
            const row = editable(draft.rows[code], rule)
            const status = rule && (rule.expires_on < today && ['active', 'stopped', 'queued'].includes(rule.status) ? 'expired' : rule.status)
            return <tr key={code}>
              <td><input type="checkbox" aria-label={`${name} 알림 대상`} disabled={busy} checked={Boolean(row.selected)}
                onChange={event => edit(code, { selected: event.target.checked })}/></td>
              <th scope="row"><strong>{name}</strong><small>{code}</small></th>
              <td><select aria-label={`${name} 조건 종류`} disabled={busy} value={row.kind}
                onChange={event => edit(code, { kind: event.target.value, threshold: '', dirty: true })}>
                <option value="">조건 선택</option>{Object.entries(ALERT_KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></td>
              <td><input type="text" inputMode={priceRule(row.kind) ? 'numeric' : 'decimal'} maxLength={12} aria-label={`${name} 조건값`}
                disabled={busy || !row.kind} value={row.threshold} onChange={event => edit(code, { threshold: event.target.value, dirty: true })}/>
                {row.kind && <small>{priceRule(row.kind) ? '원 · 현재가' : row.kind === 'fall_lte' ? '% 하락 · 전일 종가 대비' : '% 상승 · 전일 종가 대비'}</small>}</td>
              <td><input type="date" min={today} max={addAlertDays(today, 30)} aria-label={`${name} 만료일`} disabled={busy}
                value={row.expires_on} onChange={event => edit(code, { expires_on: event.target.value, dirty: true })}/></td>
              <td><span className="alert-status" data-status={status}>{stateLabels[status] || '미설정'}</span>
                {reasons[rule?.reason] && <small>{reasons[rule.reason]}</small>}
                {row.dirty && <small className="alert-unsaved">저장되지 않은 변경</small>}</td>
              <td>{['active', 'queued'].includes(status) && <button type="button" disabled={busy}
                onClick={() => change({ action: 'stop', code })}>중지</button>}
                {status === 'stopped' && <button type="button" disabled={!canActivate}
                  onClick={() => change({ action: 'resume', code })}>재개</button>}</td>
            </tr>
          })}</tbody>
        </table>
      </div>}
      <div className="alert-actions"><button type="button" disabled={!valid || !canActivate} onClick={() => change({ action: 'save', rules })}>저장하고 시작</button>
        <span>선택한 {selected.length}개 · 만료일 한국 시간 기준</span></div>
      <section ref={history} id="alert-history" aria-label="발송 이력" className="alert-history">
        <h3>발송 이력</h3>
        {data?.history?.length ? <div className="alert-table-scroll" tabIndex={0} role="region" aria-label="발송 이력 표">
          <table><thead><tr><th scope="col">종목</th><th scope="col">충족 조건</th><th scope="col">관측 시세</th><th scope="col">발송 상태</th></tr></thead>
            <tbody>{data.history.map(item => <tr key={item.id}>
              <th scope="row">{item.name}<small>{item.code}</small></th><td>{alertCondition(item.kind, item.threshold)}</td>
              <td>{Number(item.price).toLocaleString('ko-KR')}원 · {Number(item.change_rate).toFixed(2)}%<small>{toTime.format(new Date(item.observed_at))} · KRX</small></td>
              <td>{stateLabels[item.status]}{reasons[item.reason] && <small>{reasons[item.reason]}</small>}</td>
            </tr>)}</tbody>
          </table>
        </div> : data && !loading && <p>조건 충족 또는 발송 이력이 없습니다.</p>}
      </section>
    </>}
  </section>
}
