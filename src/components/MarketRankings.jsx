import { useRef } from 'react'
import { Star } from 'lucide-react'
import './MarketRankings.css'

const formatPrice = value => value == null ? '—' : new Intl.NumberFormat('ko-KR').format(value)

export default function MarketRankings({ categories, type, onTypeChange, stocks, loading, available, error, selectedCode, onSelect }) {
  const tabs = useRef([])
  const category = categories.find(item => item.id === type)
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
      <span role="status">{loading ? '조회 중' : available ? `${stocks.length}개` : ''}</span>
    </div>
    <div className="market-ranking-tabs" role="tablist" aria-label="시장 순위 종류">
      {categories.map(({ id, label }, index) => <button type="button" role="tab" key={id} id={`ranking-tab-${id}`} aria-selected={type === id} aria-controls="market-ranking-results" tabIndex={type === id ? 0 : -1} ref={element => { tabs.current[index] = element }} onKeyDown={event => moveTab(event, index)} onClick={() => onTypeChange(id)}>{label}</button>)}
    </div>
    <div className="market-ranking-results" id="market-ranking-results" role="tabpanel" aria-labelledby={`ranking-tab-${type}`} aria-busy={loading} tabIndex={0}>
      <div className="market-ranking-columns" aria-hidden="true"><span>#</span><span>종목명</span><span>현재가</span><span>{type === 'surge' ? '급증률' : '등락률'}</span><span>거래량</span></div>
      <div className="market-ranking-list" aria-label={`${category?.label || ''} 종목 목록`}>
        {stocks.map((stock, index) => <button type="button" className={`market-ranking-row${selectedCode === stock.code ? ' selected' : ''}`} key={stock.code} aria-pressed={selectedCode === stock.code} onClick={() => onSelect(stock)}>
          <span className="market-ranking-number">{index + 1}</span>
          <span className="market-ranking-identity"><Star aria-hidden="true"/><span className="market-ranking-name" title={stock.name}>{stock.name}</span><small>{stock.code}</small></span>
          <span>{formatPrice(stock.price)}</span>
          <span className={type === 'surge' || stock.change >= 0 ? 'up' : 'down'}>{type === 'surge' ? `+${stock.surge}%` : stock.change == null ? '—' : `${stock.change >= 0 ? '+' : ''}${stock.change}%`}</span>
          <span>{stock.volume ?? '—'}</span>
        </button>)}
        {loading && !stocks.length && <div className="data-message" role="status"><span className="loading-ring"/><span>종목을 불러오고 있습니다.</span></div>}
        {!loading && error && <div className="data-message error" role="alert">{error}</div>}
        {!loading && !error && !stocks.length && <div className="data-message">표시할 종목이 없습니다.</div>}
      </div>
    </div>
  </article>
}
