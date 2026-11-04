import { useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical, RefreshCw } from 'lucide-react'
import TradingViewChart from './TradingViewChart'
import LabBacktestPanel from './LabBacktestPanel'
import StockSearch from './StockSearch'
import { getLabCandles, getLabSymbols } from '../services/labApi'
import { getKiwoomRankings } from '../services/kiwoomMarketApi'
import { validateIndicators } from '../utils/backtest'
import '../lab.css'

const EMPTY = []
const sources = {
  'FDR:NAVER': 'FinanceDataReader · 네이버 일봉',
  'FDR:KRX': 'FinanceDataReader · KRX 일봉',
  'KIWOOM:KA10081:ADJUSTED:KRX': '키움 수정 일봉 · KRX',
  'KIWOOM:KA10081:ADJUSTED:SOR': '키움 수정 일봉 · KRX+NXT',
}
const statuses = {
  pending: '미처리', not_reflected: '원천 미반영', fetch_failed: '외부 조회 실패',
  save_failed: '저장 실패', quality_failed: '품질 검증 미완료', nontrade: '확인된 비거래',
}
const countRemaining = counts => Object.entries(counts || {}).reduce((sum, [key, value]) =>
  key === 'complete' || key === 'nontrade' ? sum : sum + value, 0)
const stamp = value => value ? value.slice(0, 16).replace('T', ' ') + ' KST' : '진행 중'

export default function LabChartPanel({ indicators, strategyName, settings, onSettingsChange }) {
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const [selection, setSelection] = useState(null)
  const symbol = selection?.code || ''
  const manualSelection = useRef(false)
  const [initialError, setInitialError] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)
  const [initialRetry, setInitialRetry] = useState(0)
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const publication = catalog?.publication
  const version = publication?.version

  useEffect(() => {
    const controller = new AbortController()
    setInitialError(''); setInitialLoading(true)
    // Kiwoom chooses the initial identity only. All chart candles stay in SQLite.
    getKiwoomRankings('realtime', 1, controller.signal).then(stocks => {
      if (controller.signal.aborted || manualSelection.current) return
      if (!stocks[0]?.code) throw new Error('실시간조회 순위에 종목이 없습니다. 종목을 검색해 선택해 주세요.')
      setSelection(stocks[0])
    }).catch(err => {
      if (!controller.signal.aborted && !manualSelection.current) setInitialError(`첫 종목을 불러오지 못했습니다. 종목을 검색해 선택해 주세요. (${err.message})`)
    }).finally(() => { if (!controller.signal.aborted) setInitialLoading(false) })
    return () => controller.abort()
  }, [initialRetry])

  useEffect(() => {
    if (symbol) onSettingsChange(previous => previous.symbol === symbol ? previous : { ...previous, symbol, start: '', end: '' })
  }, [symbol])

  useEffect(() => {
    const controller = new AbortController()
    const load = () => getLabSymbols(controller.signal).then(value => {
      if (!controller.signal.aborted) { setCatalog(value); setCatalogError('') }
    }).catch(err => { if (!controller.signal.aborted) setCatalogError(err.message) })
    load()
    const poll = setInterval(load, 60_000)
    return () => { clearInterval(poll); controller.abort() }
  }, [refresh])

  useEffect(() => {
    const controller = new AbortController()
    setPayload(null); setError(''); setLoading(Boolean(symbol))
    if (symbol) getLabCandles(symbol, controller.signal).then(value => { if (!controller.signal.aborted) setPayload(value) })
      .catch(err => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [symbol, refresh, version])

  const candles = payload?.items || EMPTY
  const quality = payload?.quality
  const activeSymbol = payload?.symbol
  const collection = payload?.collection
  const indicatorError = useMemo(() => { try { validateIndicators(indicators); return '' } catch (err) { return err.message } }, [indicators])
  const last = candles.findLast(c => c.quality !== 'quarantined')
  const selectSymbol = stock => {
    manualSelection.current = true
    setInitialError(''); setInitialLoading(false)
    setPayload(null); setError(''); setLoading(true)
    setSelection(stock)
    if (stock.code === symbol) setRefresh(value => value + 1)
  }
  const refreshData = () => {
    setRefresh(value => value + 1)
    if (!symbol) setInitialRetry(value => value + 1)
  }

  return <article className="panel chart-panel lab-chart-panel" aria-label="백테스팅 차트">
    <div className="lab-heading"><div><span className="lab-eyebrow"><FlaskConical/> STRATEGY LAB</span><h2>{selection?.name || '전략 실험실'} <small>{symbol}</small></h2></div><span className="lab-daily-badge">일봉 · 최대 5년</span></div>
    <div className="lab-symbol-controls"><StockSearch className="lab-stock-search" inputLabel="실험실 종목 검색" listLabel="실험실 종목 검색 결과" placeholder="종목명 또는 종목코드 검색"
      catalogItems={catalog?.items || EMPTY} ready={Boolean(catalog)} error={catalogError} onRetry={() => setRefresh(value => value + 1)}
      onSelect={selectSymbol}/>
      <button type="button" title="공개 일봉 다시 확인" aria-label="실험실 데이터 새로고침" onClick={refreshData}><RefreshCw size={16}/></button></div>
    {initialError && <p className="lab-warning" role="status">{initialError}</p>}
    {catalogError && <p className="lab-error" role="alert">{catalogError}</p>}
    {!catalogError && catalog && !catalog.ready && <p className="lab-warning">{catalog.message || '검색용 종목 목록이 없습니다. VPS 수집 상태를 확인하세요.'}</p>}
    {!publication && catalog?.run?.failed > 0 && <p className="lab-warning">최근 수집: 성공 {catalog.run.succeeded}개 · 실패/미완료 {catalog.run.failed}개.</p>}
    {publication?.primary && <p className="lab-warning">21시 1차 · {publication.primary.day} · 검증 {publication.primary.counts.complete || 0}개 · 비거래 {publication.primary.counts.nontrade || 0}개 · 실패/미완료 {countRemaining(publication.primary.counts)}개 · {stamp(publication.primary.finished_at)}</p>}
    {publication?.summary?.data_day && !publication.target && <p className="lab-warning">마지막 공개 일봉 {publication.summary.data_day}</p>}
    {publication?.confirmation && !publication.confirmation.finished_at && <p className="lab-warning">03시 확인 진행 중 · 대상 {publication.confirmation.day} · 시작 {stamp(publication.confirmation.started_at)}</p>}
    {publication?.target && <p className="lab-warning">마지막 공개 일봉 {publication.summary.data_day || '없음'} · 03시 확인 대상 {publication.target} · 완료 {stamp(publication.published_at)}<br/>최신 반영 {publication.summary.counts.complete || 0}개 · 비거래 {publication.summary.counts.nontrade || 0}개 · 실패/미완료 {countRemaining(publication.summary.counts)}개 · 미해결 격리 {publication.summary.unresolved}봉 · 복구 적용 {publication.summary.recovered}봉</p>}
    {activeSymbol && <div className="lab-data-meta"><span>{sources[activeSymbol.source] || activeSymbol.source}</span><span>{last ? `${candles[0].time} ~ ${last.time}` : '공개 일봉 없음'} · 사용 가능 {candles.filter(c => c.quality !== 'quarantined').length.toLocaleString()}개</span><span>수집 {activeSymbol.updated_at ? stamp(activeSymbol.updated_at) : '기록 없음'}</span></div>}
    {collection && collection.status !== 'complete' && <p className="lab-warning" role="status">{collection.target} · {statuses[collection.status] || collection.status} · 마지막 사용 가능 일봉 {last?.time || '없음'}</p>}
    {!collection && activeSymbol?.error && !activeSymbol.error.startsWith('OHLC quarantine:') && <p className="lab-warning">최근 갱신 실패: {activeSymbol.error}</p>}
    {!!(quality?.corrected || quality?.quarantined || quality?.recovered) && <div className="lab-quality">
      <p><strong>복구 적용 {quality.recovered || 0}일 · 오류 격리 {quality.quarantined}일{quality.corrected ? ` · 기존 보정 ${quality.corrected}일` : ''}</strong></p>
      {!!quality.quarantined && <p>격리된 날짜는 빈 구간으로 남깁니다. 차트 지표는 이후부터 다시 계산하며, 검증 기간이나 지표 준비 구간에 오류가 있으면 백테스트를 차단합니다.</p>}
      <details><summary>날짜별 원본과 처리 내역 ({quality.issues.length}건)</summary><div className="lab-trades"><table><thead><tr><th>날짜</th><th>처리</th><th>원본 시 / 고 / 저 / 종</th><th>처리 기준</th></tr></thead><tbody>{quality.issues.map(issue => <tr key={issue.time}><td>{issue.time}</td><td>{issue.recovery ? '복구' : issue.status === 'corrected' ? '기존 보정' : '격리'}</td><td>{[issue.raw.open, issue.raw.high, issue.raw.low, issue.raw.close].join(' / ')}</td><td>{issue.recovery ? sources[issue.recovery.source] || issue.recovery.source : issue.reason}</td></tr>)}</tbody></table></div></details>
    </div>}
    <div className="main-chart lab-history-chart">
      {(loading || (initialLoading && !symbol)) ? <div className="lab-chart-placeholder" role="status">{symbol ? '일봉 데이터를 불러오는 중…' : '실시간조회 1위 종목을 확인하는 중…'}</div>
        : error || indicatorError ? <div className="lab-chart-placeholder" role="alert">{error || indicatorError}</div>
          : candles.length ? <TradingViewChart stock={{ code: symbol, name: activeSymbol?.name || symbol }} period="일" indicators={indicators} candles={candles}/>
            : <div className="lab-chart-placeholder"><FlaskConical/><strong>종목을 검색해 선택해 주세요</strong><p>야간에 수집한 일봉 데이터를 표시합니다.</p></div>}
    </div>
    <LabBacktestPanel candles={candles} quality={quality} symbol={activeSymbol} publication={payload?.publication} basis={payload?.basis} indicators={indicators} strategyName={strategyName} settings={settings} onSettingsChange={onSettingsChange} disabled={loading || !!indicatorError}/>
  </article>
}
