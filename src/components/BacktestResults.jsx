import { Download } from 'lucide-react'
import { BACKTEST_ASSUMPTIONS, backtestEventLabel, backtestExport } from '../utils/backtestPresentation'

const won = value => Number.isFinite(value) ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(value) : '—'
const money = value => Number.isFinite(value) ? `${won(value)}원` : '—'
const pct = value => Number.isFinite(value) ? `${value.toFixed(2)}%` : '—'

function EquityCurve({ points }) {
  const valid = points.filter(point => Number.isFinite(point.value))
  if (!valid.length) return null
  const low = Math.min(...valid.map(point => point.value)), high = Math.max(...valid.map(point => point.value))
  const range = high - low || Math.max(1, high * .01)
  const path = valid.map((point, i) => `${i ? 'L' : 'M'}${20 + i / Math.max(1, valid.length - 1) * 760},${125 - (point.value - low) / range * 100}`).join(' ')
  return <div className="lab-equity"><div><span>일별 평가자산 · 첫 진입 이후</span><span>{money(low)} ~ {money(high)}</span></div><svg viewBox="0 0 800 145" role="img" aria-label="백테스트 일별 평가자산 추이"><path d={path} fill="none" stroke="var(--tone-purple, #8d99ff)" strokeWidth="2.5"/></svg><div><small>{valid[0].time}</small><small>{valid.at(-1).time}</small></div></div>
}

function ScrollTable({ label, headings, children }) {
  return <div className="lab-trades" tabIndex={0} role="region" aria-label={label}><table><thead><tr>{headings.map(heading => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
}

export default function BacktestResults({ run, symbol, quality, candles }) {
  const { result } = run
  const exportResult = () => {
    const blob = new Blob([JSON.stringify(backtestExport({run,symbol,quality,candles}), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = `atlas-lab-${symbol?.code || run.settings.symbol || 'stock'}-${result.end}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const metrics = [
    ['초기 기준금액', money(result.initialCapital)], ['최종 평가자산', money(result.finalEquity)], ['전체 평가수익률', pct(result.returnPct)],
    ['실현손익', money(result.realizedPnl)], ['미실현 평가손익', money(result.unrealizedPnl)], ['잔여 현금', money(result.cash)],
    ['진입 횟수', `${result.entryCount || 0}회`], ['완료 거래', `${result.closedTrades}건`], ['완료 거래 승률', pct(result.winRate)],
    ['익절 / 손절', `${result.takeProfitCount || 0} / ${result.stopLossCount || 0}건`], ['모호한 청산', `${result.ambiguousCount || 0}건`], ['자금 부족 신호', `${result.insufficientCashCount || 0}건`],
  ]
  return <section className="lab-results" aria-label="백테스트 결과">
    <div className="lab-section-heading"><h3>검증 결과</h3><button type="button" className="lab-export" onClick={exportResult}><Download size={14}/>결과 JSON</button></div>
    <p className="lab-warning">{BACKTEST_ASSUMPTIONS.costs}</p>
    {!!result.quality?.correctedBarsUsed && <p className="lab-warning">지표 준비 구간을 포함해 1원 보정 일봉 {result.quality.correctedBarsUsed}개를 사용했습니다. 결과 JSON에 원본·처리 내역이 포함됩니다.</p>}
    {(result.coverageWarnings || []).map(warning => <p key={warning} className="lab-warning">{warning}</p>)}
    {result.coverage?.warning && !result.coverageWarnings?.includes(result.coverage.warning) && <p className="lab-warning">{result.coverage.warning}</p>}
    {result.initialCapital == null && <p className="lab-warning">거래 없음 · 초기 기준금액 미산정 · 수익률 계산 불가</p>}
    <div className="lab-metrics">{metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <EquityCurve points={result.equity || []}/>
    <p className="lab-help">요청 기간 {result.requestedStart || result.start} ~ {result.requestedEnd || result.end} · 실제 일봉 {result.start} ~ {result.end} · 평가에 사용한 마지막 일봉 {result.valuationDate || result.end}. 날짜만 있는 일봉이며 장중 체결 시각을 복원하지 않습니다.</p>
    {result.openPosition && <section className="lab-open-position" aria-label="종료 시 보유 포지션"><strong>보유 중 · 강제 매도하지 않음</strong><dl><div><dt>보유 수량</dt><dd>{result.openPosition.quantity}주</dd></div><div><dt>진입일 / 진입가</dt><dd>{result.openPosition.entryDate} / {money(result.openPosition.entryPrice)}</dd></div><div><dt>평가가격</dt><dd>{money(result.openPosition.markPrice)}</dd></div><div><dt>평가손익 / 수익률</dt><dd>{money(result.openPosition.unrealizedPnl)} / {pct(result.openPosition.returnPct)}</dd></div></dl></section>}
    {!result.closedTrades && <p className="lab-help">완료된 거래가 없습니다. 승률에 보유 중인 포지션을 포함하지 않습니다.</p>}
    {!!result.trades.length && <ScrollTable label="완료 거래 목록" headings={['거래', '매수일', '청산일', '수량', '매수 → 청산가', '청산 사유', '모의 손익']}>{result.trades.map((trade, index) => <tr key={trade.tradeId || index}><td>{trade.tradeId || index + 1}</td><td>{trade.entryDate}</td><td>{trade.exitDate}</td><td>{trade.quantity}주</td><td>{won(trade.entryPrice)} → {won(trade.exitPrice)}</td><td>{backtestEventLabel({ type: trade.exitType })}{trade.ambiguous && <span className="lab-ambiguous">일봉 내 순서 불명확 · 손절 우선 가정</span>}</td><td className={trade.pnl >= 0 ? 'lab-positive' : 'lab-negative'}>{money(trade.pnl)} ({pct(trade.returnPct)})</td></tr>)}</ScrollTable>}
    {!!result.events?.length && <details className="lab-event-details"><summary>차트 진입·청산 상세 ({result.events.length}건)</summary><ScrollTable label="차트 이벤트 상세" headings={['거래', '날짜', '구분', '가격', '수량', '사유·가정']}>{result.events.map(event => <tr key={event.id}><td>{event.tradeId}</td><td>{event.date}</td><td>{backtestEventLabel(event)}</td><td>{money(event.price)}</td><td>{event.quantity}주</td><td>{event.reason}{event.ambiguous && !event.reason?.includes('순서 불명확') && <span className="lab-ambiguous">일봉 내 순서 불명확 · 손절 우선 가정</span>}</td></tr>)}</ScrollTable></details>}
    {!!result.skippedSignals?.length && <details className="lab-event-details"><summary>건너뛴 진입 신호 ({result.skippedSignals.length}건)</summary><ScrollTable label="건너뛴 신호 목록" headings={['신호일', '판단일', '사유']}>{result.skippedSignals.map((signal, index) => <tr key={index}><td>{signal.signalDate || signal.date}</td><td>{signal.date || signal.executionDate}</td><td>{signal.message || signal.reason}</td></tr>)}</ScrollTable></details>}
  </section>
}
