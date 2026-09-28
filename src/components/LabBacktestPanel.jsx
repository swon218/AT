import { Download, Play } from 'lucide-react'
import { useMemo, useState } from 'react'
import { RULES, runBacktest, validateIndicators } from '../utils/backtest'
import { backtestWindow } from '../utils/dataQuality'

const won = n => Math.round(n).toLocaleString('ko-KR')
const pct = n => n == null ? '—' : `${n.toFixed(2)}%`

function Conditions({ title, side, rules, settings, update }) {
  const selected = settings[side]
  return <fieldset className="lab-conditions">
    <legend>{title}</legend>
    <select aria-label={`${title} 조합 방식`} value={settings[`${side}Mode`]} onChange={e => update({ [`${side}Mode`]: e.target.value })}>
      <option value="all">선택한 조건 모두 충족 (AND)</option><option value="any">하나 이상 충족 (OR)</option>
    </select>
    <div className="lab-condition-options">
      {rules.map(rule => <label key={rule.id}><input type="checkbox" checked={selected.includes(rule.id)} onChange={e => update({ [side]: e.target.checked ? [...selected, rule.id] : selected.filter(id => id !== rule.id) })}/><span>{rule.label}</span></label>)}
      {!rules.length && <p>오른쪽에서 지표를 추가하면 조건이 표시됩니다.</p>}
    </div>
    {selected.some(id => !rules.some(r => r.id === id)) && <p className="lab-warning">제거한 지표의 조건이 남아 있습니다. <button type="button" onClick={() => update({ [side]: selected.filter(id => rules.some(r => r.id === id)) })}>사용할 수 없는 조건 삭제</button></p>}
  </fieldset>
}

function EquityCurve({ points }) {
  const low = Math.min(...points.map(p => p.value)), high = Math.max(...points.map(p => p.value))
  const range = high - low || Math.max(1, high * .01)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${20 + i / Math.max(1, points.length - 1) * 760},${125 - (p.value - low) / range * 100}`).join(' ')
  return <div className="lab-equity"><div><span>일별 평가자산</span><span>{won(low)} ~ {won(high)}원</span></div><svg viewBox="0 0 800 145" role="img" aria-label="백테스트 일별 평가자산 추이"><path d={path} fill="none" stroke="#8d99ff" strokeWidth="2.5"/></svg><div><small>{points[0].time}</small><small>{points.at(-1).time}</small></div></div>
}

export default function LabBacktestPanel({ candles, quality, symbol, indicators, settings, onSettingsChange, strategyName, disabled }) {
  const [run, setRun] = useState(null)
  const [error, setError] = useState('')
  const update = patch => onSettingsChange(previous => ({ ...previous, ...patch }))
  const rules = RULES.filter(rule => indicators.some(c => c.id === rule.indicator))
  const fingerprint = useMemo(() => JSON.stringify([symbol, candles, quality, indicators, settings]), [symbol, candles, quality, indicators, settings])
  const qualityError = useMemo(() => {
    if (!candles.length) return ''
    try { validateIndicators(indicators); backtestWindow(candles, indicators, settings); return '' }
    catch (err) { return err.message }
  }, [candles, indicators, settings])
  const result = run?.fingerprint === fingerprint ? run.result : null
  const last = candles.at(-1)
  const execute = () => {
    setError('')
    try { setRun({ fingerprint, result: runBacktest(candles, indicators, settings), settings: structuredClone(settings), indicators: structuredClone(indicators), name: strategyName }) }
    catch (err) { setRun(null); setError(err.message) }
  }
  const exportResult = () => {
    const blob = new Blob([JSON.stringify({ engineVersion: 2, exportedAt: new Date().toISOString(), symbol, quality: quality || null, strategyName: run.name, indicators: run.indicators, settings: run.settings, result, candles }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = `atlas-lab-${symbol.code}-${result.end}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="lab-backtest">
    <div className="lab-section-heading"><h3>매매 조건과 검증</h3><span>종가 신호 → 다음 봉 시가 체결</span></div>
    <div className="lab-input-grid">
      <label>시작일<input type="date" min={candles[0]?.time} max={last?.time} value={settings.start || candles[0]?.time || ''} onChange={e => update({ start: e.target.value })}/></label>
      <label>종료일<input type="date" min={candles[0]?.time} max={last?.time} value={settings.end || last?.time || ''} onChange={e => update({ end: e.target.value })}/></label>
      <label>초기 자금 (원)<input type="number" min="1000" max="10000000000" step="1000" value={settings.initialCapital} onChange={e => update({ initialCapital: e.target.value === '' ? '' : Number(e.target.value) })}/></label>
      <label>편도 수수료 (%)<input type="number" min="0" max="5" step="0.001" value={settings.feePct} onChange={e => update({ feePct: e.target.value === '' ? '' : Number(e.target.value) })}/></label>
      <label>매도세 (%)<input type="number" min="0" max="5" step="0.01" value={settings.taxPct} onChange={e => update({ taxPct: e.target.value === '' ? '' : Number(e.target.value) })}/></label>
      <label>편도 슬리피지 (%)<input type="number" min="0" max="5" step="0.01" value={settings.slippagePct} onChange={e => update({ slippagePct: e.target.value === '' ? '' : Number(e.target.value) })}/></label>
    </div>
    <p className="lab-help">비용은 예시값입니다. 검증할 기간과 계좌에 맞게 변경하세요. 한 종목에 가용 현금으로 정수 주식을 매수하며, 추가 매수·공매도는 하지 않습니다.</p>
    <div className="lab-condition-grid"><Conditions title="매수 조건" side="entry" rules={rules} settings={settings} update={update}/><Conditions title="매도 조건" side="exit" rules={rules} settings={settings} update={update}/></div>
    {qualityError && <p className="lab-error" role="alert">{qualityError}</p>}
    <div className="lab-run-row"><button className="lab-run" disabled={disabled || !candles.length || !!qualityError} onClick={execute}><Play size={15}/> 백테스트 실행</button><small>실제 주문 없이 이 브라우저에서 계산합니다.</small></div>
    {error && <p className="lab-error" role="alert">{error}</p>}
    {run && !result && <p className="lab-warning">조건 또는 데이터가 변경됐습니다. 다시 실행하면 결과가 갱신됩니다.</p>}
    {result && <section className="lab-results" aria-label="백테스트 결과">
      <div className="lab-section-heading"><h3>검증 결과</h3><button className="lab-export" onClick={exportResult}><Download size={14}/> 결과 JSON</button></div>
      {!!result.quality.correctedBarsUsed && <p className="lab-warning">지표 준비 구간을 포함해 1원 보정 일봉 {result.quality.correctedBarsUsed}개를 사용한 결과입니다. 결과 JSON에 보정 기준과 오류 일봉의 원본·처리 내역을 포함합니다.</p>}
      <div className="lab-metrics">{[['평가 수익률', pct(result.returnPct)], ['최대 낙폭', pct(result.maxDrawdownPct)], ['청산 거래', `${result.closedTrades}건`], ['승률', pct(result.winRate)], ['최종 평가자산', `${won(result.finalEquity)}원`], ['수수료·세금', `${won(result.costs)}원`]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <EquityCurve points={result.equity}/>
      <p className="lab-help">검증 {result.start} ~ {result.end} · 지표 준비 완료 {result.firstSignalDate}. 종료일 보유분은 마지막 종가로 평가하며 미래 청산 비용은 포함하지 않습니다. 슬리피지는 체결가격에 반영됩니다.</p>
      {!result.closedTrades && <p className="lab-warning">청산된 거래가 없습니다. 승률을 계산하지 않습니다.</p>}
      {result.openPosition && <p className="lab-warning">미청산 보유: {result.openPosition.quantity}주 · 매수 {result.openPosition.entryDate} · 평가손익 {won(result.openPosition.unrealizedPnl)}원</p>}
      {result.unfilledSignal && <p className="lab-help">마지막 봉의 {result.unfilledSignal.side === 'buy' ? '매수' : '매도'} 신호는 다음 봉이 없어 체결하지 않았습니다.</p>}
      {!!result.trades.length && <div className="lab-trades"><table><thead><tr><th>매수일</th><th>매도일</th><th>수량</th><th>매수 → 매도 가격</th><th>비용 후 손익</th></tr></thead><tbody>{result.trades.map((t, i) => <tr key={i}><td title={`신호: ${t.entrySignal}`}>{t.entryDate}</td><td title={`신호: ${t.exitSignal}`}>{t.exitDate}</td><td>{t.quantity}</td><td>{won(t.entryPrice)} → {won(t.exitPrice)}</td><td className={t.pnl >= 0 ? 'lab-positive' : 'lab-negative'}>{won(t.pnl)}원 ({pct(t.returnPct)})</td></tr>)}</tbody></table></div>}
    </section>}
    <details className="lab-method"><summary>데이터와 계산 기준</summary><p>제공처 일봉과 수정주가 기준의 연구용 모의 계산입니다. NXT 전용·통합 시세를 별도로 수집하지 않습니다. 네이버 경로의 시장·수정주가 처리 기준은 제공처 정책에 따릅니다. 1원 보정은 원본 오류의 원인이 반올림이라고 확정한 것이 아니라 명시적인 가공 정책입니다.</p><p>현재 상장 종목 중심이므로 상장폐지 종목이 빠질 수 있습니다. 배당 현금흐름·호가 잔량·가격제한폭에 따른 미체결은 반영하지 않습니다. 거래량 0 또는 시가 0인 날은 체결하지 않습니다. 오류로 격리한 일봉은 보간하거나 건너뛰어 체결하지 않습니다. 일봉으로 분봉 전략의 성과를 검증할 수 없습니다.</p><p>시작일 이전 봉은 지표 준비에만 사용합니다. SMA·볼린저·거래량 평균은 필요한 과거 구간을 사용하고, EMA·RSI·MACD 백테스트는 저장된 이전 이력 전체를 사용하므로 그 안의 오류도 해결되어야 합니다. 필요한 지표가 준비된 뒤 신호를 평가하며 같은 시가에 재진입하지 않습니다. 결과 JSON은 데이터·처리 내역·조건·비용을 포함하며 Supabase 전략 저장과는 별개입니다.</p></details>
  </div>
}
