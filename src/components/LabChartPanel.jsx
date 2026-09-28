import { useEffect, useMemo, useState } from 'react'
import { FlaskConical, RefreshCw, Search } from 'lucide-react'
import TradingViewChart from './TradingViewChart'
import LabBacktestPanel from './LabBacktestPanel'
import { getLabCandles, getLabSymbols } from '../services/labApi'
import { validateIndicators } from '../utils/backtest'
import '../lab.css'

const EMPTY = []

export default function LabChartPanel({ indicators, strategyName, settings, onSettingsChange }) {
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const [query, setQuery] = useState('')
  const [symbol, setSymbol] = useState(settings.symbol || '005930')
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setCatalogError('')
    getLabSymbols(controller.signal).then(value => {
      setCatalog(value)
      setSymbol(current => value.items.some(s => s.code === current && (s.bars > 0 || s.quarantined)) ? current : value.items.find(s => s.bars > 0 || s.quarantined)?.code || '')
    }).catch(err => { if (err.name !== 'AbortError') { setCatalogError(err.message); setLoading(false) } })
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    const controller = new AbortController()
    setPayload(null); setError(''); setLoading(Boolean(symbol))
    if (symbol) getLabCandles(symbol, controller.signal).then(setPayload)
      .catch(err => { if (err.name !== 'AbortError') setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [symbol, refresh])

  const candles = payload?.items || EMPTY
  const quality = payload?.quality
  const activeSymbol = payload?.symbol
  const indicatorError = useMemo(() => { try { validateIndicators(indicators); return '' } catch (err) { return err.message } }, [indicators])
  const filtered = (catalog?.items || []).filter(s => `${s.code} ${s.name}`.toLowerCase().includes(query.trim().toLowerCase()))
  const last = candles.at(-1)

  return <article className="panel chart-panel lab-chart-panel" aria-label="백테스팅 차트">
    <div className="lab-heading"><div><span className="lab-eyebrow"><FlaskConical/> STRATEGY LAB</span><h2>{activeSymbol?.name || '전략 실험실'} <small>{activeSymbol?.code}</small></h2></div><span className="lab-daily-badge">일봉 · 최대 5년</span></div>
    <div className="lab-symbol-controls"><label className="lab-search"><Search/><input aria-label="실험실 종목 검색" placeholder="저장된 종목명 또는 코드 검색" value={query} onChange={e => setQuery(e.target.value)}/></label><select aria-label="실험실 종목 선택" value={symbol} onChange={e => { const code = e.target.value; setSymbol(code); onSettingsChange(previous => ({ ...previous, symbol: code, start: '', end: '' })) }}>
      {!filtered.some(s => s.code === symbol) && <option value={symbol}>{activeSymbol?.name || '종목 선택'}</option>}
      {filtered.map(s => <option key={s.code} value={s.code} disabled={!s.bars && !s.quarantined}>{s.name} · {s.code}{s.quarantined ? ` (오류 ${s.quarantined}일)` : !s.bars ? ' (미수집)' : ''}</option>)}
    </select><button type="button" title="데이터 다시 확인 (최대 1분 캐시)" aria-label="실험실 데이터 새로고침" onClick={() => setRefresh(v => v + 1)}><RefreshCw size={16}/></button></div>
    {catalogError && <p className="lab-error" role="alert">{catalogError}</p>}
    {!catalogError && catalog && !catalog.ready && <p className="lab-warning">{catalog.message || '수집된 일봉이 없습니다. VPS 초기 수집 결과를 확인하세요.'}</p>}
    {catalog?.run?.failed > 0 && <p className="lab-warning">최근 수집: 성공 {catalog.run.succeeded}개 · 실패/미완료 {catalog.run.failed}개. 기존에 저장된 일봉을 표시합니다.{catalog.run.message && ` ${catalog.run.message}`}</p>}
    {activeSymbol && <div className="lab-data-meta"><span>{activeSymbol.source === 'FDR:NAVER' ? 'FinanceDataReader · 네이버 일봉' : 'FinanceDataReader · KRX 일봉'}</span><span>{candles[0]?.time} ~ {last?.time} · 사용 가능 {candles.filter(c => c.quality !== 'quarantined').length.toLocaleString()}개</span><span>수집 {activeSymbol.updated_at?.replace('T', ' ').slice(0, 19)} KST</span></div>}
    {activeSymbol?.error && !activeSymbol.error.startsWith('OHLC quarantine:') && <p className="lab-warning">최근 갱신 실패: {activeSymbol.error}</p>}
    {!!(quality?.corrected || quality?.quarantined) && <div className="lab-quality">
      <p><strong>1원 보정 {quality.corrected}일 · 오류 격리 {quality.quarantined}일</strong><br/>종가가 범위를 정확히 1원 벗어난 날은 고가·저가 범위를 넓혔습니다. 시가·종가·거래량은 유지하며, 원본과 보정 이력을 별도로 보관합니다.</p>
      {!!quality.quarantined && <p>격리된 날짜는 빈 구간으로 남깁니다. 차트 지표는 이후부터 다시 계산하며, 검증 기간이나 지표 준비 구간에 오류가 있으면 백테스트를 차단합니다.</p>}
      <details><summary>날짜별 원본과 처리 내역 ({quality.issues.length}건)</summary><div className="lab-trades"><table><thead><tr><th>날짜</th><th>처리</th><th>원본 시 / 고 / 저 / 종</th><th>이탈</th><th>처리 후 고 / 저</th></tr></thead><tbody>{quality.issues.map(issue => <tr key={issue.time}><td>{issue.time}</td><td>{issue.status === 'corrected' ? '1원 보정' : '격리'}</td><td>{[issue.raw.open, issue.raw.high, issue.raw.low, issue.raw.close].join(' / ')}</td><td>{issue.delta}원</td><td>{issue.status === 'corrected' ? `${issue.processedHigh} / ${issue.processedLow}` : '사용 안 함'}</td></tr>)}</tbody></table></div></details>
    </div>}
    <div className="main-chart lab-history-chart">
      {loading ? <div className="lab-chart-placeholder" role="status">일봉 데이터를 불러오는 중…</div>
        : error || indicatorError ? <div className="lab-chart-placeholder" role="alert">{error || indicatorError}</div>
          : candles.length ? <TradingViewChart stock={{ code: symbol, name: activeSymbol?.name || symbol }} period="일" indicators={indicators} candles={candles}/>
            : <div className="lab-chart-placeholder"><FlaskConical/><strong>일봉 수집 후 차트가 표시됩니다</strong><p>개인 증권사 API 등록 없이 사용할 수 있습니다.</p></div>}
    </div>
    <LabBacktestPanel candles={candles} quality={quality} symbol={activeSymbol} indicators={indicators} strategyName={strategyName} settings={settings} onSettingsChange={onSettingsChange} disabled={loading || !!indicatorError}/>
  </article>
}
