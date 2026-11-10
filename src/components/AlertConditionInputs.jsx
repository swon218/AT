import { ChevronDown, ChevronUp } from 'lucide-react'
import { ALERT_FREQUENCIES, alertThreshold, priceRule } from '../../shared/alertRules'

export function AlertValueInput({ kind, value, label, disabled, onChange }) {
  const percent = Boolean(kind) && !priceRule(kind)
  const parsed = alertThreshold(kind, value)
  const empty = String(value).trim() === ''
  const step = delta => onChange(String(Math.round(Math.min(100, Math.max(0, (parsed ?? 0) + delta)) * 100) / 100))
  return <div className="alert-value-input">
    <input type="text" inputMode={percent ? 'decimal' : 'numeric'} maxLength={12} aria-label={label}
      aria-invalid={!empty && parsed === null ? true : undefined} disabled={disabled} value={value}
      onChange={event => {
        const next = event.target.value
        if (!percent || !next.includes('-')) onChange(next)
      }}/>
    {kind && <span aria-hidden="true">{percent ? '%' : '원'}</span>}
    {percent && <div className="alert-value-steps">
      <button type="button" aria-label="1퍼센트포인트 증가" disabled={disabled || (!empty && parsed === null) || parsed === 100}
        onClick={() => step(1)}><ChevronUp size={15} aria-hidden="true"/></button>
      <button type="button" aria-label="1퍼센트포인트 감소" disabled={disabled || (!empty && (parsed === null || parsed === 0))}
        onClick={() => step(-1)}><ChevronDown size={15} aria-hidden="true"/></button>
    </div>}
  </div>
}

export function AlertFrequencySelect({ value, label, disabled, onChange }) {
  return <select aria-label={label} value={value || 'once'} disabled={disabled} onChange={event => onChange(event.target.value)}>
    {Object.entries(ALERT_FREQUENCIES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
  </select>
}
