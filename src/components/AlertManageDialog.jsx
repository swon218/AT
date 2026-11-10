import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ALERT_KINDS, ALERT_RULES_PER_SYMBOL, addAlertDays, alertCondition, alertExpiry, alertFrequencyLabel, alertThreshold, legacyAlertKind, priceRule } from '../../shared/alertRules'
import { displayAlertStatus, reasons, stateLabels } from '../utils/alertPresentation'
import { AlertFrequencySelect, AlertValueInput } from './AlertConditionInputs'

const running = status => status === 'active' || status === 'queued'
const valuesOf = (rule, today) => ({ kind: legacyAlertKind(rule?.kind) ? 'price_touch' : rule?.kind || 'price_touch',
  threshold: String(rule?.threshold ?? ''), frequency: rule?.frequency || 'once',
  expires_on: alertExpiry(rule?.expires_on, today) ? rule.expires_on : addAlertDays(today, 7) })

export default function AlertManageDialog({ rows, byCode, initialCode, initialDraft, today, afterSymbols, busy, canActivate,
  available, change, onDraftDone, onClose }) {
  const dialog = useRef(null)
  const close = useRef(null)
  const filter = useRef(null)
  const editorFirst = useRef(null)
  const confirmFirst = useRef(null)
  const origin = useRef(null)
  const [code, setCode] = useState(initialCode || '')
  const [addCode, setAddCode] = useState(initialCode || rows[0]?.code || '')
  const [editor, setEditor] = useState(() => {
    if (!initialDraft) return null
    const rule = byCode.get(initialCode)?.find(item => item.rule_id === initialDraft.rule_id && item.version === initialDraft.version)
    if (!rule || rule.status === 'sending') return null
    const baseline = valuesOf(rule, today)
    return { rule, action: running(displayAlertStatus(rule, today)) ? 'update' : 'restart', baseline,
      values: valuesOf(initialDraft, today), draft: initialDraft, code: initialCode }
  })
  const [confirmation, setConfirmation] = useState(null)
  const [error, setError] = useState(initialDraft && !editor ? '이 초안의 저장 조건을 다시 확인해 주세요. 기존 버전이 변경되었거나 발송 요청 중입니다.' : '')
  const [notice, setNotice] = useState('')
  const dirty = editor && (editor.draft || Object.keys(editor.values).some(key => editor.values[key] !== editor.baseline[key]))
  const target = editor?.rule && byCode.get(editor.code)?.find(rule => rule.rule_id === editor.rule.rule_id)
  const stale = editor?.rule && (target?.version !== editor.rule.version || target.status === 'sending'
    || running(displayAlertStatus(target, today)) !== (editor.action === 'update'))
  const threshold = editor ? alertThreshold(editor.values.kind, editor.values.threshold) : null
  const canAdd = stockCode => available && canActivate && !busy && rows.some(row => row.code === stockCode)
    && (byCode.get(stockCode)?.length || 0) < ALERT_RULES_PER_SYMBOL

  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])
  useEffect(() => {
    if (editor) editorFirst.current?.focus()
    else if (!origin.current) close.current?.focus()
  }, [editor?.rule?.rule_id, editor?.action])
  useEffect(() => { if (confirmation) confirmFirst.current?.focus() }, [confirmation])

  function restoreFocus() {
    requestAnimationFrame(() => (origin.current?.isConnected && !origin.current.disabled ? origin.current : filter.current)?.focus())
  }

  function discard(destination) {
    if (busy) return
    if (dirty) setConfirmation({ type: 'discard', destination })
    else if (destination === 'dialog') onClose()
    else { setEditor(null); setError(''); restoreFocus() }
  }

  function escape() {
    if (busy) return
    if (confirmation) {
      setConfirmation(null)
      if (editor) editorFirst.current?.focus()
      else restoreFocus()
    } else discard('dialog')
  }

  function keepFocus(event) {
    if (event.key !== 'Tab') return
    const controls = [...dialog.current.querySelectorAll('button, input, select')].filter(control => !control.matches(':disabled'))
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey ? document.activeElement !== first : document.activeElement !== last) return
    event.preventDefault()
    const next = event.shiftKey ? last : first
    next.focus()
  }

  function openEditor(event, stockCode, rule, action) {
    origin.current = event.currentTarget
    const baseline = valuesOf(rule, today)
    setError(''); setNotice('')
    setEditor({ code: stockCode, rule, action, baseline, values: baseline })
  }

  async function mutate(body, message) {
    setError(''); setNotice('')
    const result = await change(body)
    if (!result.ok) { setError(result.message); setConfirmation(null); return }
    if (editor?.draft) onDraftDone(editor.draft)
    setEditor(null); setConfirmation(null); setNotice(message); restoreFocus()
  }

  function submit(event) {
    event.preventDefault()
    if (!editor || !available || !canActivate || busy || stale || threshold === null
      || !alertExpiry(editor.values.expires_on, today)) return
    const rule = { ...editor.values, code: editor.code, threshold }
    if (editor.action === 'create') {
      if (canAdd(editor.code)) void mutate({ action: 'create', rules: [rule] }, '새 조건을 저장했습니다.')
      return
    }
    void mutate({ action: editor.action, rule_id: editor.rule.rule_id, version: editor.rule.version, rule },
      editor.action === 'restart' ? '이 조건의 감시를 다시 시작했습니다.' : '조건 변경을 저장했습니다.')
  }

  const visible = code ? rows.filter(row => row.code === code) : rows
  return <dialog ref={dialog} className="account-modal alert-manage" aria-labelledby="alert-manage-title"
    onCancel={event => { event.preventDefault(); escape() }} onKeyDown={keepFocus}>
    <button ref={close} type="button" className="auth-close alert-manage-close" aria-label="알림 관리 닫기"
      disabled={busy} onClick={() => discard('dialog')}><X size={18}/></button>
    <div className="account-heading"><h2 id="alert-manage-title">알림 관리</h2>
      <p>관심종목 {rows.length}개 · 종목당 조건 {ALERT_RULES_PER_SYMBOL}개까지</p></div>
    {!available && <p role="status">알림 관리 서버 연결을 기다리는 중입니다.</p>}
    {available && !canActivate && <p role="status">조건을 시작하거나 수정하려면 알림 감시 상태와 카카오 메시지 동의를 확인해 주세요.</p>}
    <div className="alert-manage-tools">
      <label className="account-field"><span>조건 표시</span><select ref={filter} value={code} disabled={busy || Boolean(editor || confirmation)} onChange={event => {
        const next = event.target.value
        setCode(next)
        if (next) setAddCode(next)
      }}><option value="">모든 관심종목</option>{rows.map(row => <option key={row.code} value={row.code}>{row.name} · {row.code}</option>)}</select></label>
      {rows.length > 0 && !code && <label className="account-field"><span>추가할 종목</span><select value={addCode} disabled={busy || Boolean(editor || confirmation)}
        onChange={event => setAddCode(event.target.value)}>{rows.map(row => <option key={row.code} value={row.code}>{row.name} · {row.code}</option>)}</select></label>}
      {rows.length > 0 && <button type="button" disabled={Boolean(editor || confirmation) || !canAdd(addCode)}
        onClick={event => openEditor(event, addCode, null, 'create')}>조건 추가</button>}
    </div>
    {error && <p className="alert-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {editor && <form className="account-section alert-manage-editor" onSubmit={submit}>
      <h3>{editor.action === 'create' ? '새 조건' : editor.action === 'update' ? '조건 수정' : '조건 다시 설정'} · {rows.find(row => row.code === editor.code)?.name} ({editor.code})</h3>
      {editor.rule && <p>저장된 조건 · {alertCondition(editor.rule.kind, editor.rule.threshold)} · {alertFrequencyLabel(editor.rule.frequency)} · {editor.rule.expires_on}까지</p>}
      {editor.action === 'update' && <p>변경을 저장하기 전까지 기존 조건이 유지됩니다.</p>}
      {legacyAlertKind(editor.rule?.kind) && <p>기존 이상·이하 조건입니다. 현재가로 저장하면 양방향 목표가 도달 방식으로 전환됩니다.</p>}
      <p>{priceRule(editor.values.kind) ? '첫 관측이 목표가와 같거나, 연속 관측 사이에 목표가를 지나면 충족됩니다.'
        : '당일 첫 유효 시세가 이미 등락률 조건을 충족하면 발송될 수 있습니다.'}</p>
      {editor.draft && <p className="alert-unsaved">미저장 대화 초안</p>}
      {stale && <p className="alert-error" role="status">저장된 상태가 바뀌었거나 발송 요청 중입니다. 편집을 닫고 최신 상태를 확인해 주세요.</p>}
      <fieldset className="alert-manage-fields" disabled={busy || Boolean(confirmation)}>
        <label className="account-field"><span>조건 종류</span><select ref={editorFirst} value={editor.values.kind}
          onChange={event => setEditor({ ...editor, values: { ...editor.values, kind: event.target.value, threshold: '' } })}>
          {Object.entries(ALERT_KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <div className="account-field"><span>조건값 · {priceRule(editor.values.kind) ? '목표가' : '전일 기준가 대비'}</span>
          <AlertValueInput kind={editor.values.kind} value={editor.values.threshold}
            label={priceRule(editor.values.kind) ? '조건값 · 원' : '조건값 · 퍼센트'} disabled={busy || Boolean(confirmation)}
            onChange={threshold => setEditor({ ...editor, values: { ...editor.values, threshold } })}/></div>
        <div className="account-field"><span>알림 횟수</span><AlertFrequencySelect label="알림 횟수" value={editor.values.frequency}
          onChange={frequency => setEditor({ ...editor, values: { ...editor.values, frequency } })}/></div>
        <label className="account-field"><span>만료일</span><input type="date" min={today} max={addAlertDays(today, 30)} value={editor.values.expires_on}
          onChange={event => setEditor({ ...editor, values: { ...editor.values, expires_on: event.target.value } })}/></label>
      </fieldset>
      <div className="alert-actions">
        <button type="submit" disabled={!available || !canActivate || busy || Boolean(confirmation) || stale || threshold === null
          || !alertExpiry(editor.values.expires_on, today)}>{editor.action === 'create' ? '저장하고 시작' : editor.action === 'update' ? '변경 저장' : '저장하고 다시 시작'}</button>
        <button type="button" disabled={busy || Boolean(confirmation)} onClick={() => discard('editor')}>편집 취소</button>
      </div>
    </form>}
    {confirmation && <section className="account-section alert-manage-confirm" aria-label="작업 확인">
      {confirmation.type === 'discard' ? <><p role="alert">저장하지 않은 변경 내용을 버릴까요?</p><div className="alert-actions">
        <button ref={confirmFirst} type="button" onClick={() => { setConfirmation(null); requestAnimationFrame(() => editorFirst.current?.focus()) }}>계속 편집</button>
        <button type="button" onClick={() => {
          if (confirmation.destination === 'dialog') onClose()
          else { setConfirmation(null); setEditor(null); setError(''); restoreFocus() }
        }}>변경 버리기</button>
      </div></> : <><p role="alert">{confirmation.name} · {alertCondition(confirmation.rule.kind, confirmation.rule.threshold)} 알림을 취소할까요?</p>
        <p>아직 전송을 시작하지 않은 알림을 중단합니다. 이미 전달한 메시지는 남습니다.</p><div className="alert-actions">
          <button ref={confirmFirst} type="button" disabled={busy} onClick={() => { setConfirmation(null); restoreFocus() }}>유지</button>
          <button type="button" disabled={busy} onClick={() => mutate({ action: 'cancel', rule_id: confirmation.rule.rule_id,
            version: confirmation.rule.version }, '이 조건의 알림을 취소했습니다.')}>알림 취소 확인</button>
        </div></>}
    </section>}
    {visible.length === 0 && <p>관리할 관심종목이 없습니다.</p>}
    <div className="alert-manage-list">{visible.map(row => {
      const rules = byCode.get(row.code) || []
      return <section key={row.code} className="account-section">
        <h3>{row.name} <small>{row.code} · {rules.length} / {ALERT_RULES_PER_SYMBOL}개</small></h3>
        {rules.length ? <ul>{rules.map(rule => {
          const status = displayAlertStatus(rule, today)
          const blocked = !available || busy || Boolean(editor || confirmation) || status === 'sending'
          return <li key={rule.rule_id || rule.version || row.code}>
            <div><strong>{alertCondition(rule.kind, rule.threshold)}</strong>{legacyAlertKind(rule.kind) && <small>기존 조건 · KRX 정규장</small>}
              {!legacyAlertKind(rule.kind) && <small>{afterSymbols.has(row.code) ? 'KRX 정규장 · 오늘 NXT 대상' : 'KRX 정규장만 지원'}</small>}
              <small>{rule.expires_on}까지 · {alertFrequencyLabel(rule.frequency)} · {stateLabels[status]}</small>
              {reasons[rule.reason] && <small>{reasons[rule.reason]}</small>}</div>
            <div className="alert-actions">
              {running(status) ? <><button type="button" disabled={blocked || !canActivate}
                onClick={event => openEditor(event, row.code, rule, 'update')}>수정</button>
                <button type="button" disabled={blocked} onClick={event => {
                  origin.current = event.currentTarget; setError(''); setNotice(''); setConfirmation({ type: 'cancel', name: row.name, rule })
                }}>알림 취소</button></> : status === 'sending' ? null : <button type="button" disabled={blocked || !canActivate}
                onClick={event => openEditor(event, row.code, rule, 'restart')}>다시 설정</button>}
            </div>
          </li>
        })}</ul> : <p>저장된 조건이 없습니다.</p>}
      </section>
    })}</div>
  </dialog>
}
