import { Play } from 'lucide-react'
import { useMemo, useState } from 'react'
import { runBacktest, backtestReadiness } from '../utils/backtest'
import { describeEntryCondition } from '../utils/entryConditions'
import { BACKTEST_ASSUMPTIONS } from '../utils/backtestPresentation'
import BacktestResults from './BacktestResults'

export default function LabBacktestPanel({ candles, quality, symbol, indicators, settings, onSettingsChange, strategyName, disabled, run, fingerprint, onRun }) {
  const [failure, setFailure] = useState(null)
  const update = patch => onSettingsChange(previous => ({ ...previous, ...patch }))
  const problems = useMemo(() => candles.length ? backtestReadiness(candles, indicators, settings) : ['수집된 일봉이 필요합니다.'], [candles, indicators, settings])
  const result = run?.fingerprint === fingerprint ? run.result : null
  const error = failure?.fingerprint === fingerprint ? failure.message : ''
  const conditions = (settings.entryConditions || []).filter(condition => condition.enabled)
  const execute = () => {
    setFailure(null)
    try { onRun({ fingerprint, result: runBacktest(candles, indicators, settings), settings: structuredClone(settings), indicators: structuredClone(indicators), name: strategyName }) }
    catch (error) { onRun(null); setFailure({ fingerprint, message: error.message }) }
  }
  const last = candles.at(-1)
  return <div className="lab-backtest">
    <div className="lab-section-heading"><h3>매매조건과 검증</h3><span>종가 진입 신호 → 다음 거래일 시가 매수</span></div>
    <div className="lab-input-grid">
      <label>시작일<input aria-label="백테스트 시작일" type="date" min={candles[0]?.time} max={last?.time} value={settings.start || candles[0]?.time || ''} onInput={event => update({ start: event.target.value })}/></label>
      <label>종료일<input aria-label="백테스트 종료일" type="date" min={candles[0]?.time} value={settings.end || last?.time || ''} onInput={event => update({ end: event.target.value })}/></label>
      <label>최초 진입 수량 (주)<input aria-label="최초 진입 수량" type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" inputMode="numeric" value={settings.initialQuantity ?? ''} onChange={event => update({ initialQuantity: event.target.value })} placeholder="1 이상의 정수"/></label>
      <label>수량 운용 방식<select aria-label="수량 운용 방식" value={settings.quantityMode || 'fixed'} onChange={event => update({ quantityMode: event.target.value })}><option value="fixed">고정 수량</option><option value="reinvest">보유 현금 재투자</option></select></label>
    </div>
    <p className="lab-help">첫 실제 매수가 × 최초 수량으로 기준금액을 산정합니다. 이후 추가 입금 없이 현금과 주식만 운용하며, 살 수 없는 신호는 건너뜁니다.</p>
    <section className="lab-strategy-summary" aria-label="적용 중인 모의 매매 전략">
      <strong>진입 · {settings.entryMode === 'any' ? '하나 이상 충족 (OR)' : '모두 충족 (AND)'}</strong>
      {conditions.length ? <ul>{conditions.map((condition,index) => <li key={`${condition.indicatorId}-${index}`}>{describeEntryCondition(condition, indicators)}</li>)}</ul> : <p>오른쪽 지표 카드의 ‘진입 조건’에서 사용할 조건을 설정해 주세요.</p>}
      <p>익절 {settings.takeProfitPct === '' || settings.takeProfitPct == null ? '미설정' : `${settings.takeProfitPct}%`} · 손절 {settings.stopLossPct === '' || settings.stopLossPct == null ? '미설정' : `${settings.stopLossPct}%`}</p>
      <small>지표 및 익절·손절 설정은 두 탭의 공통 전략 편집기에서 변경합니다.</small>
    </section>
    {!!problems.length && <div className="lab-readiness" role="status"><strong>실행 전 확인</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
    <div className="lab-run-row"><button type="button" className="lab-run" disabled={disabled || problems.length > 0} onClick={execute}><Play size={15}/>백테스트 실행</button><small>실제 주문 없이 이 브라우저에서 계산합니다.</small></div>
    {error && <p className="lab-error" role="alert">{error}</p>}
    {run && !result && <p className="lab-warning" role="status">조건·설정 또는 데이터가 변경됐습니다. 재실행해야 결과와 마커가 표시됩니다.</p>}
    {result && <BacktestResults run={run} symbol={symbol} quality={quality} candles={candles}/>}
    <details className="lab-method"><summary>데이터와 계산 기준</summary><p>{BACKTEST_ASSUMPTIONS.execution}</p><p>{BACKTEST_ASSUMPTIONS.ambiguous}</p><p>제공처의 수정주가 일봉으로 계산합니다. 분봉·틱·NXT 통합 봉을 새로 수집하지 않습니다. 현재 상장 종목 중심이라 상장폐지 종목이 빠질 수 있고, 배당·호가단위·유동성·가격제한폭에 따른 미체결을 완벽히 재현하지 않습니다.</p><p>거래량 또는 시가가 0인 날은 체결하지 않습니다. 미해결 가격 오류나 지표 준비 구간의 오류를 건너뛰어 계산하지 않습니다. 표시 반올림과 달리 체결·수량·조건은 계산값으로 판단하며, 같은 값 비교에 숨은 허용오차를 적용하지 않습니다.</p><p>거래 달력 근거가 없는 날짜 공백은 휴장으로 단정하지 않습니다. 종료일 평가 범위를 확인할 수 없는 경우 결과의 주의 안내와 실제 평가 일봉 날짜를 확인해 주세요.</p></details>
  </div>
}
