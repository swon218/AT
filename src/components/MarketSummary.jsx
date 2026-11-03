import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getKiwoomMarketSummary } from '../services/kiwoomMarketApi'
import ExchangeRateCard from './ExchangeRateCard'
import MarketSessionCard from './MarketSessionCard'

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
  const markets = summary.data?.markets || emptyMarkets
  return <section className="dashboard-market-summary" aria-label="시장 주요 데이터">
    <MarketSessionCard/>
    <ExchangeRateCard/>
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
