import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from 'lucide-react'
import { INDICATOR_CATALOG, INDICATOR_LIMIT } from '../utils/indicators'
import { defaultEntryCondition, describeEntryCondition, getConditionFields, normalizeRiskSettings, OPERATORS, validateEntryConditions } from '../utils/entryConditions'

function StrategyDialog({ title, children, onClose }) {
  const titleId = useId(), panel = useRef(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const controls = () => [...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')]
    ;(panel.current.querySelector('[data-dialog-autofocus]') || controls()[0] || panel.current)?.focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current() }
      if (event.key !== 'Tab') return
      const items = controls(), first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); panel.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown, true); if (opener?.isConnected) opener.focus() }
  }, [])
  return createPortal(<div className="strategy-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={panel} className="strategy-editor-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="strategy-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" onClick={onClose} aria-label={`${title} 닫기`}><X aria-hidden="true"/></button></div>
      {children}
    </section>
  </div>, document.body)
}

export function IndicatorPickerDialog({ configs, onAdd, onRemove, onClose }) {
  const [query, setQuery] = useState(''), resultsRef = useRef(null)
  const keyword = query.trim().toLowerCase()
  const filtered = INDICATOR_CATALOG.filter(item => !keyword || `${item.name} ${item.shortName}`.toLowerCase().includes(keyword))
  const choose = item => { configs.some(c => c.id === item.id) ? onRemove(item.id) : onAdd(item.id); onClose() }
  return <StrategyDialog title="지표 추가" onClose={onClose}>
    <label className="strategy-picker-search"><Search aria-hidden="true"/><span className="sr-only">보조지표 검색</span><input data-dialog-autofocus type="search" value={query} placeholder="보조지표 검색" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); resultsRef.current?.querySelector('button:not(:disabled)')?.focus() }
      if (event.key === 'Enter') { event.preventDefault(); const item = filtered.find(item => !configs.some(c => c.id === item.id)); if (item && configs.length < INDICATOR_LIMIT) choose(item) }
    }}/></label>
    <p className="strategy-dialog-note">지표는 최대 {INDICATOR_LIMIT}개까지 추가할 수 있습니다. 추가된 지표를 다시 선택하면 제거합니다.</p>
    <div ref={resultsRef} className="indicator-catalog-list strategy-picker-results" onKeyDown={event => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return
      const items = [...resultsRef.current.querySelectorAll('button:not(:disabled)')], current = items.indexOf(document.activeElement)
      if (!items.length) return
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[index]?.focus()
    }}>
      {filtered.map(item => { const added = configs.some(c => c.id === item.id); return <button type="button" key={item.id} className={added ? 'added' : ''} aria-pressed={added} disabled={!added && configs.length >= INDICATOR_LIMIT} onClick={() => choose(item)}><span><strong>{item.name}</strong><small>{item.shortName}</small></span><b>{added ? '추가됨' : '추가'}</b></button> })}
      {!filtered.length && <p className="indicator-no-result">검색 결과가 없습니다.</p>}
    </div>
  </StrategyDialog>
}

const indicatorName = id => INDICATOR_CATALOG.find(item => item.id === id)?.name || id
const unitLabel = unit => ({price:'원',percent:'%',volume:'주',index:'지수',state:'상태'}[unit] || unit)
export function EntryConditionDialog({ config, indicators, settings, onApply, onClose }) {
  const savedRules = settings.entryConditions?.filter(condition => condition.indicatorId === config.id) || []
  const saved = savedRules[0]
  const [draft, setDraft] = useState(() => structuredClone(saved || { ...defaultEntryCondition(config), enabled:false }))
  const [error, setError] = useState('')
  const fields = getConditionFields(config), left = fields.find(field => field.id === draft.left) || fields[0]
  const state = left?.unit === 'state'
  const targetFields = indicators.flatMap(indicator => getConditionFields(indicator).filter(field => field.unit === left?.unit && field.unit !== 'state').map(field => ({ ...field, indicatorId:indicator.id })))
  const targetValue = draft.right.type === 'series' ? `${draft.right.indicatorId || config.id}:${draft.right.field}` : ''
  const update = patch => { setDraft(previous => ({...previous,...patch})); setError('') }
  const setLeft = value => {
    const field = fields.find(field => field.id === value)
    update({left:value, ...(field?.unit === 'state' ? {operator:'eq',right:{type:'constant',value:field.stateValues?.[0] ?? 1}} : {right:{type:'constant',value:field?.min ?? 0}})})
  }
  const submit = event => {
    event.preventDefault()
    try {
      const all = [...(settings.entryConditions || []).filter(condition => condition.indicatorId !== config.id), ...(draft.enabled ? [draft] : [])]
      const normalized = validateEntryConditions(indicators,{...settings,entryConditions:all})
      onApply(Array.isArray(normalized) ? normalized : all); onClose()
    } catch (failure) { setError(failure.message) }
  }
  let summary = ''
  try { summary = describeEntryCondition(draft,indicators) } catch { summary = '조건을 완성해 주세요.' }
  return <StrategyDialog title={`${indicatorName(config.id)} 진입 조건`} onClose={onClose}>
    <form onSubmit={submit}>
      <label className="strategy-condition-toggle"><input data-dialog-autofocus type="checkbox" checked={Boolean(draft.enabled)} onChange={event => update({enabled:event.target.checked})}/>진입 판단에 사용</label>
      <p className="strategy-dialog-note">과거 일봉의 진입 조건을 편집합니다. 이 창에서 실제 주문을 실행하지 않습니다. 계산 기간과 방식은 지표 카드의 설정을 사용합니다.</p>
      {savedRules.length > 1 && <p className="strategy-feedback warning" role="status">이 지표의 기존 조건 {savedRules.length}개가 보존되어 있습니다. 적용하면 아래 조건 하나로 변경합니다. 취소하면 기존 조건을 유지합니다.</p>}
      <fieldset disabled={!draft.enabled} className="strategy-condition-fields"><legend>조건 비교</legend>
        <label>판단 값<select value={draft.left} onChange={event => setLeft(event.target.value)}>{fields.map(field => <option key={field.id} value={field.id}>{field.label}{field.unit === 'state' ? '' : ` (${unitLabel(field.unit)})`}</option>)}</select></label>
        <label>비교 방식<select value={draft.operator} onChange={event => update({operator:event.target.value})}>{OPERATORS.filter(item => !state || item.id === 'eq').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        {!state && <label>비교 대상<select value={draft.right.type} onChange={event => update({right:event.target.value === 'series' ? {type:'series',field:targetFields[0]?.id,indicatorId:targetFields[0]?.indicatorId} : {type:'constant',value:left?.min ?? 0}})}><option value="constant">기준값 직접 입력</option><option value="series" disabled={!targetFields.length}>지표·가격 값</option></select></label>}
        {draft.right.type === 'series' && !state ? <label>비교 지표<select value={targetValue} onChange={event => { const [indicatorId,field] = event.target.value.split(':'); update({right:{type:'series',field,indicatorId}}) }}>{targetFields.map(field => <option key={`${field.indicatorId}:${field.id}`} value={`${field.indicatorId}:${field.id}`}>{indicatorName(field.indicatorId)} · {field.label}</option>)}</select></label>
          : state ? <label>상태<select value={draft.right.value} onChange={event => update({right:{type:'constant',value:Number(event.target.value)}})}>{(left?.stateValues || [-1,1]).map(value => <option key={value} value={value}>{value === 1 ? '상승 (1)' : value === -1 ? '하락 (-1)' : '전환 없음 (0)'}</option>)}</select></label>
            : <label>기준값{left?.unit ? ` (${unitLabel(left.unit)})` : ''}<input type="number" step="any" min={left?.min} max={left?.max} value={draft.right.value ?? ''} onChange={event => update({right:{type:'constant',value:event.target.value}})}/></label>}
      </fieldset>
      <p className="strategy-condition-preview">{draft.enabled ? summary : '참고용 지표 · 진입 판단에 사용하지 않습니다.'}</p>
      {draft.enabled && draft.operator === 'eq' && !state && <p className="strategy-dialog-note">정확히 같음은 반올림 전 계산값으로 판단합니다. 표시값이 같아도 실제 계산값은 다를 수 있으며 허용오차를 더하지 않습니다.</p>}
      {draft.enabled && draft.operator.startsWith('cross') && <p className="strategy-dialog-note">이전 봉과 현재 확정 봉의 교차를 판단합니다. 이미 기준 위·아래인 상태만으로는 새 돌파 신호가 생기지 않습니다.</p>}
      {config.id === 'bollinger' && <p className="strategy-dialog-note">상단·하단 터치의 기준은 ‘판단 값’에서 선택한 고가·저가·종가입니다. 밴드값은 같은 일봉까지의 지표 설정으로 계산합니다.</p>}
      {error && <p className="strategy-feedback error" role="alert">{error}</p>}
      <div className="strategy-dialog-actions"><button type="button" onClick={onClose}>취소</button><button type="submit" className="primary">적용</button></div>
    </form>
  </StrategyDialog>
}

export function RiskSettingsDialog({ settings, onApply, onClose }) {
  const [takeProfitPct,setTakeProfit] = useState(settings.takeProfitPct ?? ''), [stopLossPct,setStopLoss] = useState(settings.stopLossPct ?? ''), [error,setError] = useState('')
  const submit = event => {
    event.preventDefault()
    try { onApply(normalizeRiskSettings({takeProfitPct,stopLossPct},{allowIncomplete:true})); onClose() }
    catch (failure) { setError(failure.message) }
  }
  return <StrategyDialog title="익절·손절 설정" onClose={onClose}><form onSubmit={submit}>
    <p className="strategy-dialog-note">매번 실제 모의 매수가를 기준으로 계산하며, 익절 또는 손절 도달 시 보유 수량 전부를 청산합니다. 실제 주문은 실행하지 않습니다.</p>
    <div className="strategy-condition-fields"><label>익절 비율 (%)<input data-dialog-autofocus type="number" min="0" max="10000" step="any" value={takeProfitPct} onChange={event => {setTakeProfit(event.target.value);setError('')}}/></label><label>손절 비율 (%)<input type="number" min="0" max="100" step="any" value={stopLossPct} onChange={event => {setStopLoss(event.target.value);setError('')}}/></label></div>
    <p className="strategy-dialog-note">손절도 양수로 입력하며 100% 미만이어야 합니다. 0%는 사용할 수 없습니다. 비운 항목은 미설정으로 저장할 수 있지만, 백테스트에는 두 비율이 모두 필요합니다.</p>
    {error && <p className="strategy-feedback error" role="alert">{error}</p>}
    <div className="strategy-dialog-actions"><button type="button" onClick={onClose}>취소</button><button type="submit" className="primary">적용</button></div>
  </form></StrategyDialog>
}
