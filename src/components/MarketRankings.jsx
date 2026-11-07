import { useRef } from 'react'
import WatchlistStar, { WatchlistFeedback } from './WatchlistStar'
import { WATCHLIST_LIMIT } from '../services/watchlistRepository'
import './MarketRankings.css'

const formatPrice = value => value == null ? '—' : new Intl.NumberFormat('ko-KR').format(value)

export default function MarketRankings({ categories, type, onTypeChange, stocks, loading, available, error, selectedCode, onSelect, watchlist, quotes }) {
  const tabs = useRef([])
  const category = categories.find(item => item.id === type)
  const favorites = type === 'favorites'
  const visibleStocks = favorites ? watchlist.rows.map(stock => ({ ...stock, ...quotes[stock.code] })) : stocks
  const pending = favorites ? watchlist.loading : loading
  const count = favorites
    ? watchlist.ready ? `${visibleStocks.length} / ${WATCHLIST_LIMIT}` : ''
    : available ? `${stocks.length}개` : ''
  const emptyMessage = favorites
    ? watchlist.authenticated ? '등록한 관심종목이 없습니다.' : '로그인하면 관심종목을 저장할 수 있습니다.'
    : '표시할 종목이 없습니다.'
  const moveTab = (event, index) => {
    let next
    if (event.key === 'ArrowRight') next = (index + 1) % categories.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + categories.length) % categories.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = categories.length - 1
    else return
    event.preventDefault()
    onTypeChange(categories[next].id)
    tabs.current[next]?.focus()
  }
  return <article className="panel market-rankings" aria-labelledby="market-rankings-title">
    <div className="market-rankings-heading">
      <h2 id="market-rankings-title">시장 순위 / 관심종목</h2>
      <span role="status">{count || (pending ? '조회 중' : '')}</span>
    </div>
    <div className="market-ranking-tabs" role="tablist" aria-label="시장 순위 종류">
      {categories.map(({ id, label }, index) => <button type="button" role="tab" key={id} id={`ranking-tab-${id}`} aria-selected={type === id} aria-controls="market-ranking-results" tabIndex={type === id ? 0 : -1} ref={element => { tabs.current[index] = element }} onKeyDown={event => moveTab(event, index)} onClick={() => onTypeChange(id)}>{label}</button>)}
    </div>
    <WatchlistFeedback watchlist={watchlist}/>
    <div className="market-ranking-results" id="market-ranking-results" role="tabpanel" aria-labelledby={`ranking-tab-${type}`} aria-busy={pending} tabIndex={0}>
      <div className="market-ranking-columns" aria-hidden="true"><span>#</span><span>종목명</span><span>현재가</span><span>{type === 'surge' ? '급증률' : '등락률'}</span><span>거래량</span></div>
      <div className="market-ranking-list" aria-label={`${category?.label || ''} 종목 목록`}>
        {visibleStocks.map((stock, index) => <div className={`market-ranking-row${selectedCode === stock.code ? ' selected' : ''}`} key={stock.code}>
          <button type="button" className="market-ranking-select" aria-pressed={selectedCode === stock.code} onClick={() => onSelect(stock)}>
            <span className="market-ranking-number">{index + 1}</span>
            <span className="market-ranking-identity"><span className="market-ranking-name" title={stock.name}>{stock.name}</span><small>{stock.code}</small></span>
            <span>{formatPrice(stock.price)}</span>
            <span className={stock.change == null && type !== 'surge' ? '' : type === 'surge' || stock.change >= 0 ? 'up' : 'down'}>{type === 'surge' ? `+${stock.surge}%` : stock.change == null ? '—' : `${stock.change >= 0 ? '+' : ''}${stock.change}%`}</span>
            <span>{typeof stock.volume === 'number' ? formatPrice(stock.volume) : stock.volume ?? '—'}</span>
          </button>
          <WatchlistStar stock={stock} watchlist={watchlist}/>
        </div>)}
        {pending && !visibleStocks.length && <div className="data-message" role="status"><span className="loading-ring"/><span>{favorites ? '관심종목을 불러오고 있습니다.' : '종목을 불러오고 있습니다.'}</span></div>}
        {!favorites && !pending && error && <div className="data-message error" role="alert">{error}</div>}
        {!pending && !(favorites ? watchlist.readError : error) && !visibleStocks.length && <div className="data-message">{emptyMessage}</div>}
      </div>
    </div>
  </article>
}
