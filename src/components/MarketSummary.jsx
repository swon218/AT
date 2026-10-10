import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getKiwoomMarketSummary, getKiwoomMarketSession } from '../services/kiwoomMarketApi'

function useMarketData(scope, fetchData, interval) {
  const [state, setState] = useState({})
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer, running = false
    setState({ scope, loading: true })
    const refresh = async () => {
      if (running || controller.signal.aborted) return
      clearTimeout(timer)
      running = true
      try {
        const data = await fetchData(controller.signal)
        if (!controller.signal.aborted) setState({ scope, data, loading: false })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, scope, loading: false, error: error.message }))
      } finally {
        running = false
        if (!controller.signal.aborted) timer = setTimeout(() => { if (!document.hidden) refresh() }, interval)
      }
    }
    const visible = () => { if (!document.hidden) refresh() }
    refresh()
    document.addEventListener('visibilitychange', visible)
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [scope, fetchData, interval, revision])
  return { ...(state.scope === scope ? state : { loading: true }), retry: () => setRevision(value => value + 1) }
}

const digits = value => value == null ? '—' : value.toLocaleString('ko-KR')
const tone = value => value > 0 ? 'up' : value < 0 ? 'down' : ''
const money = (value, signed = false) => {
  if (value == null) return '—'
  const prefix = signed && value > 0 ? '+' : value < 0 ? '−' : ''
  const absolute = Math.abs(value)
  // Flow values originate in 100 million KRW; use that unit consistently.
  if (signed) return `${prefix}${(absolute / 100_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}억`
  return absolute >= 1_000_000_000_000 ? `${(absolute / 1_000_000_000_000).toFixed(2)}조` : `${(absolute / 100_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}억`
}
const time = value => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) : ''
const emptyMarkets = [{ symbol: 'kospi', name: '코스피' }, { symbol: 'kosdaq', name: '코스닥' }]

function DataFooter({ state, markets, errorKey }) {
  const dates = [...new Set(markets.map(market => market.asOf).filter(Boolean))]
  const missing = markets.some(market => market[errorKey])
  return <div className={`summary-card-footer${state.error || missing ? ' summary-warning' : ''}`}>
    <span>{state.loading ? '불러오는 중' : state.error ? '갱신 실패 · 재시도' : missing ? '일부 조회 실패' : dates.length === 1 ? `${dates[0].slice(5).replace('-', '/')} 기준 · KRX` : '시장별 기준일 확인'}</span>
    {(state.error || missing) && <button type="button" onClick={state.retry} aria-label="시장 주요 데이터 다시 조회"><RefreshCw size={12}/></button>}
  </div>
}

function Breadth({ market }) {
  const breadth = market.breadth
  const valid = breadth && [breadth.rising, breadth.unchanged, breadth.falling].every(value => value !== null)
  const total = valid ? breadth.rising + breadth.unchanged + breadth.falling : 0
  return <div className="summary-breadth-market" title={valid ? `${market.name} 상승 ${breadth.rising} (상한 ${breadth.upperLimit ?? '—'} 포함), 보합 ${breadth.unchanged}, 하락 ${breadth.falling} (하한 ${breadth.lowerLimit ?? '—'} 포함)` : `${market.name} 등락 종목 수 조회 대기`}>
    <div className="summary-breadth-label"><span>{market.name}</span><span><b className="up">{digits(breadth?.rising)}</b><i> / </i><b>{digits(breadth?.unchanged)}</b><i> / </i><b className="down">{digits(breadth?.falling)}</b></span></div>
    <div className="summary-breadth-bar" role="img" aria-label={valid ? `${market.name} 상승 ${breadth.rising}, 보합 ${breadth.unchanged}, 하락 ${breadth.falling}종목` : `${market.name} 등락 정보 없음`}>
      {total > 0 && <><span className="rising" style={{ width: `${breadth.rising / total * 100}%` }}/><span className="unchanged" style={{ width: `${breadth.unchanged / total * 100}%` }}/><span className="falling" style={{ width: `${breadth.falling / total * 100}%` }}/></>}
    </div>
  </div>
}

export default function MarketSummary({ credentialScope }) {
  const summary = useMarketData(credentialScope, getKiwoomMarketSummary, 30_000)
  const session = useMarketData(credentialScope, getKiwoomMarketSession, 10_000)
  const markets = summary.data?.markets || emptyMarkets
  const status = session.data
  const stale = session.error || status?.stale
  const connection = status?.connection === 'connected' ? '실시간 연결' : status?.connection === 'reconnecting' ? '재연결 중' : '연결 중'
  return <section className="dashboard-market-summary" aria-label="시장 주요 데이터">
    <article className="panel dashboard-summary-card summary-session" aria-busy={session.loading}>
      <div className="summary-card-heading"><h2>장 상태</h2><small>KRX</small></div>
      <div className={`summary-session-state ${stale ? 'stale' : status?.phase || 'unknown'}`}><span className="session-dot"/><strong>{status?.label || (session.error ? '조회 실패' : '연결 중')}</strong></div>
      <p className="summary-session-detail">{stale ? '마지막 상태 · 현재 상태 확인 필요' : status?.expectedOpenAt ? `${time(status.expectedOpenAt)} 개장 예상` : status?.source === 'calendar' ? '한국시간 주말 기준' : status?.source === 'kiwoom' ? `${time(status.marketTime)} 장 상태 수신` : '키움 장운영 신호 수신 대기'}</p>
      <div className={`summary-card-footer${stale ? ' summary-warning' : ''}`}><span>{session.error ? '상태 조회 실패' : `키움 · ${connection}`}</span>{session.error && <button type="button" onClick={session.retry} aria-label="장 상태 다시 조회"><RefreshCw size={12}/></button>}</div>
    </article>
    <article className="panel dashboard-summary-card summary-fx"><div className="summary-card-heading"><h2>원/달러</h2></div><strong className="summary-fx-value">—</strong><div className="summary-card-footer">연결 예정</div></article>
    <article className="panel dashboard-summary-card" aria-busy={summary.loading}>
      <div className="summary-card-heading"><h2>시장 거래대금</h2><small>누적</small></div>
      <div className="summary-market-values">{markets.map(market => <div key={market.symbol}><span>{market.name}</span><strong title={market.turnoverWon == null ? '' : `${digits(market.turnoverWon)}원`}>{money(market.turnoverWon)}<small>{market.turnoverWon == null ? '' : ' 원'}</small></strong></div>)}</div>
      <DataFooter state={summary} markets={markets} errorKey="quoteError"/>
    </article>
    <article className="panel dashboard-summary-card" aria-busy={summary.loading}>
      <div className="summary-card-heading"><h2>상승·하락 분포</h2></div>
      <div className="summary-breadth-legend"><span className="up">상승</span><span>보합</span><span className="down">하락</span></div>
      <div className="summary-breadth-values">{markets.map(market => <Breadth key={market.symbol} market={market}/>)}</div>
      <DataFooter state={summary} markets={markets} errorKey="quoteError"/>
    </article>
    {[['외국인 순매수', 'foreignNetBuyWon'], ['기관 순매수', 'institutionNetBuyWon']].map(([label, field]) => <article className="panel dashboard-summary-card" key={field} aria-busy={summary.loading}>
      <div className="summary-card-heading"><h2>{label}</h2><small>금액</small></div>
      <div className="summary-market-values">{markets.map(market => <div key={market.symbol}><span>{market.name}</span><strong className={tone(market[field])} title={market[field] == null ? '' : `${digits(market[field])}원`}>{money(market[field], true)}<small>{market[field] == null ? '' : ' 원'}</small></strong></div>)}</div>
      <DataFooter state={summary} markets={markets} errorKey="flowError"/>
    </article>)}
  </section>
}
