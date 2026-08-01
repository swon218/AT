import { useEffect, useMemo, useState } from 'react'
import {
  Activity, BarChart3, Bell, ChevronDown, CircleDollarSign, LayoutDashboard, LineChart,
  LockKeyhole, LogIn, Menu, Newspaper, PanelLeftClose, PanelLeftOpen, Radio,
  Search, ShieldCheck, Star, TrendingDown, TrendingUp, WalletCards, X, Zap,
} from 'lucide-react'
import { getKiwoomRankings } from './services/kiwoomMarketApi'
import { getPublicNews } from './services/newsApi'
import TradingViewChart from './components/TradingViewChart'
import OrderEntryPanel from './components/OrderEntryPanel'
import { createIndicatorConfig } from './utils/indicators'

const won = (value) => new Intl.NumberFormat('ko-KR').format(value)
const today = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' }).format(new Date())
const rankingCategories = [
  { id: 'realtime', label: '실시간조회', icon: Radio },
  { id: 'rising', label: '상승률', icon: TrendingUp },
  { id: 'falling', label: '하락률', icon: TrendingDown },
  { id: 'volume', label: '거래량 상위', icon: BarChart3 },
  { id: 'surge', label: '거래량 급증', icon: Zap },
  { id: 'favorites', label: '관심종목', icon: Star },
]

function LoginNotice({ text }) {
  return <div className="login-preview-note"><LogIn/><span>{text}</span></div>
}

function StockChartPanel({ stock, period, onPeriodChange, indicators = [], orderMode = false }) {
  const [minuteMenuOpen, setMinuteMenuOpen] = useState(false)
  const minutePeriods = ['1분', '5분', '10분', '15분', '30분', '60분']
  const selectedMinute = minutePeriods.includes(period) ? period : '15분'
  return (
    <article className="panel chart-panel">
      <div className="quote-head">
        <div className={`quote-identity${orderMode ? ' order-quote-identity' : ''}`}><h2>{stock?.name ?? ''}{stock && !orderMode && <button aria-label="관심종목 추가"><Star size={17}/></button>}</h2><small>{stock ? `${stock.code} · ${stock.market ?? 'KRX'}` : ''}</small>{stock && orderMode && <button className="order-favorite" aria-label="관심종목 추가"><Star size={17}/></button>}</div>
        {stock && <div className="quote-price"><strong>{won(stock.price)}<small>원</small></strong><span className={stock.change >= 0 ? 'up' : 'down'}>{stock.change >= 0 ? '▲' : '▼'} {Math.abs(stock.change)}%</span></div>}
      </div>
      <div className="chart-toolbar"><div className="chart-periods"><>
        <div className="minute-period-select" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMinuteMenuOpen(false) }}>
          <button type="button" className={minutePeriods.includes(period) ? 'active minute-trigger' : 'minute-trigger'} aria-haspopup="menu" aria-expanded={minuteMenuOpen} onClick={() => setMinuteMenuOpen((open) => !open)}>{selectedMinute}<ChevronDown/></button>
          {minuteMenuOpen && <div className="minute-period-menu" role="menu">{minutePeriods.map((item) => <button type="button" role="menuitem" className={period === item ? 'selected' : ''} onClick={() => { onPeriodChange(item); setMinuteMenuOpen(false) }} key={item}>{item}</button>)}</div>}
        </div>
        {['일','주','월'].map((item) => <button type="button" className={period === item ? 'active' : ''} onClick={() => { onPeriodChange(item); setMinuteMenuOpen(false) }} key={item}>{item}</button>)}
      </></div><span>키움 캔들 데이터</span></div>
      <div className="main-chart tradingview-host"><TradingViewChart stock={stock} period={period} indicators={indicators}/></div>
    </article>
  )
}

function OrderPreview({ selected, period, onPeriodChange, indicatorConfigs, strategyName, onStrategyNameChange, onAddIndicator, onUpdateIndicator, onRemoveIndicator, onResetIndicators, onDeleteIndicators }) {
  return (
    <section className="preview-grid order-preview-grid">
      <StockChartPanel stock={selected} period={period} onPeriodChange={onPeriodChange} indicators={indicatorConfigs} orderMode/>
      <article className="panel preview-order"><OrderEntryPanel indicatorConfigs={indicatorConfigs} strategyName={strategyName} onStrategyNameChange={onStrategyNameChange} onAddIndicator={onAddIndicator} onUpdateIndicator={onUpdateIndicator} onRemoveIndicator={onRemoveIndicator} onResetIndicators={onResetIndicators} onDeleteIndicators={onDeleteIndicators}/></article>
    </section>
  )
}

function AssetsPreview() {
  return (
    <>
      <section className="welcome preview-welcome"><div><p>GUEST PREVIEW</p><h1>자산 현황</h1><span>자산 화면의 구성을 미리 확인할 수 있습니다.</span></div><LoginNotice text="로그인 후 내 자산을 확인할 수 있습니다."/></section>
      <section className="asset-summary-preview">
        {['총 자산', '평가손익', '주문가능금액'].map((label) => <article className="panel" key={label}><small>{label}</small><div className="masked-value"/></article>)}
      </section>
      <section className="preview-grid asset-preview-grid">
        <article className="panel"><div className="panel-head"><div><h2>보유종목</h2></div></div><div className="preview-table-head asset-table-head"><span>종목</span><span>보유수량</span><span>평균단가</span><span>평가금액</span><span>수익률</span></div><div className="preview-empty-space"/></article>
        <article className="panel"><div className="panel-head"><div><h2>자산 구성</h2></div></div><div className="preview-chart-space"><LoginNotice text="로그인 시 표시됩니다."/></div></article>
        <article className="panel preview-wide"><div className="panel-head"><div><h2>거래 내역</h2></div></div><div className="preview-table-head"><span>일자</span><span>종목</span><span>구분</span><span>수량</span><span>금액</span></div><div className="preview-empty-space"/></article>
      </section>
    </>
  )
}

function App() {
  const [activePage, setActivePage] = useState('dashboard')
  const [selected, setSelected] = useState(null)
  const [period, setPeriod] = useState('15분')
  const [orderPeriod, setOrderPeriod] = useState('15분')
  const [search, setSearch] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rankingType, setRankingType] = useState('realtime')
  const [rankingList, setRankingList] = useState([])
  const [rankingLoading, setRankingLoading] = useState(false)
  const [rankingAvailable, setRankingAvailable] = useState(false)
  const [rankingError, setRankingError] = useState('')
  const [news, setNews] = useState([])
  const [newsLoading, setNewsLoading] = useState(true)
  const [newsError, setNewsError] = useState('')
  const [indicatorConfigs, setIndicatorConfigs] = useState([])
  const [strategyName, setStrategyName] = useState('')

  const visibleStocks = useMemo(
    () => rankingList.filter((stock) => `${stock.name}${stock.code}`.toLowerCase().includes(search.toLowerCase())),
    [rankingList, search],
  )

  const chooseStock = (stock) => {
    setSelected(stock)
    setSearch('')
  }

  const openPage = (page) => {
    setActivePage(page)
    setMobileNav(false)
  }

  const addIndicator = (id) => setIndicatorConfigs((items) => items.some((item) => item.id === id) ? items : [...items, createIndicatorConfig(id)])
  const updateIndicator = (id, patch) => setIndicatorConfigs((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  const removeIndicator = (id) => setIndicatorConfigs((items) => items.filter((item) => item.id !== id))
  const resetIndicators = () => setIndicatorConfigs((items) => items.map((item) => createIndicatorConfig(item.id)))
  const deleteIndicators = () => { setIndicatorConfigs([]); setStrategyName('') }

  useEffect(() => {
    if (activePage !== 'order') {
      setIndicatorConfigs([])
      setStrategyName('')
    }
  }, [activePage])

  useEffect(() => {
    let active = true
    setRankingLoading(true)
    setRankingAvailable(false)
    setRankingError('')
    setRankingList([])
    setSelected(null)

    getKiwoomRankings(rankingType, 20)
      .then((stocks) => {
        if (!active) return
        setRankingList(stocks)
        setRankingAvailable(true)
        if (stocks.length > 0) setSelected(stocks[0])
      })
      .catch((error) => {
        if (!active) return
        setRankingList([])
        setSelected(null)
        setRankingError(error.message)
      })
      .finally(() => active && setRankingLoading(false))

    return () => { active = false }
  }, [rankingType])

  useEffect(() => {
    let active = true
    getPublicNews('국내 증시', 6)
      .then((items) => active && setNews(items))
      .catch((error) => active && setNewsError(error.message))
      .finally(() => active && setNewsLoading(false))
    return () => { active = false }
  }, [])

  const selectedCategory = rankingCategories.find((item) => item.id === rankingType)

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${mobileNav ? 'open' : ''}`}>
        <div className="brand">
          {sidebarCollapsed ? <button className="brand-mark brand-expand-trigger" title="사이드바 펼치기" aria-label="사이드바 펼치기" onClick={() => setSidebarCollapsed(false)}><Activity className="brand-logo-icon" size={18}/><PanelLeftOpen className="brand-expand-icon" size={18}/></button> : <span className="brand-mark"><Activity size={18}/></span>}
          <div><strong>ATLAS</strong><small>TRADING SYSTEM</small></div>
          {!sidebarCollapsed && <button className="sidebar-toggle" title="사이드바 접기" aria-label="사이드바 접기" onClick={() => setSidebarCollapsed(true)}><PanelLeftClose/></button>}
          <button className="mobile-close" onClick={() => setMobileNav(false)}><X/></button>
        </div>
        <nav>
          <p>WORKSPACE</p>
          <button className={`nav-link ${activePage === 'dashboard' ? 'active' : ''}`} onClick={() => openPage('dashboard')}><LayoutDashboard/><span>대시보드</span></button>
          <button className={`nav-link ${activePage === 'order' ? 'active' : ''}`} onClick={() => openPage('order')}><LineChart/><span>주식 주문</span></button>
          <button className="nav-link" onClick={() => { openPage('dashboard'); setRankingType('favorites') }}><Star/><span>관심종목</span></button>
          <button className={`nav-link ${activePage === 'assets' ? 'active' : ''}`} onClick={() => openPage('assets')}><WalletCards/><span>자산 현황</span></button>
          <p>MARKET</p>
          <a><Newspaper/><span>마켓 뉴스</span></a>
          <a><CircleDollarSign/><span>시세 분석</span></a>
        </nav>
        <div className="connection-card guest-connection">
          <div className="connection-title"><ShieldCheck/><span>게스트 API 범위</span></div>
          <div><span><i className="dot kiwoom"/>키움 공개시세</span><b>읽기전용</b></div>
          <div><span><LockKeyhole/>주문·계좌</span><b className="blocked">차단</b></div>
        </div>
        <button className="guest-profile"><span>G</span><div><strong>게스트</strong><small>로그인 후 개인 기능 사용</small></div><LogIn/></button>
      </aside>

      <main>
        <header>
          <button className="menu-button" onClick={() => setMobileNav(true)}><Menu/></button>
          <div className="global-search">
            <Search/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="현재 목록에서 종목 검색"/><kbd>⌘ K</kbd>
            {search && rankingList.length > 0 && <div className="search-results">{visibleStocks.map((stock) => <button key={stock.code} onClick={() => chooseStock(stock)}><span><strong>{stock.name}</strong><small>{stock.code}</small></span><b>{won(stock.price)}원</b></button>)}</div>}
          </div>
          <div className="header-actions"><span className="market-open"><i/>시장 조회</span><button title="알림"><Bell/></button><button className="login-button" title="로그인"><LogIn/></button></div>
        </header>

        <div className={`content guest-content ${activePage === 'order' ? 'order-content' : ''}`}>
          {activePage === 'dashboard' ? <>
          <section className="welcome guest-welcome">
            <div><p>{today}</p><h1>실시간 시장을 확인하세요</h1><span>비로그인 상태에서는 공개 시세만 제공되며 주문과 계좌 조회는 차단됩니다.</span></div>
            <div className="guest-access-badge"><ShieldCheck/><div><strong>읽기 전용 모드</strong><small>운영자 키는 VPS에서만 사용</small></div></div>
          </section>

          <section className="trading-grid">
            <article className="panel ranking-menu">
              <div className="ranking-source"><i className="dot kiwoom"/><span>키움증권 API</span><b>READ</b></div>
              <div className="ranking-buttons">{rankingCategories.map(({ id, label, icon: Icon }) => <button className={rankingType === id ? 'active' : ''} key={id} onClick={() => setRankingType(id)}><Icon/><span>{label}</span></button>)}</div>
              <p>VPS의 공개 시장조회 API만 호출합니다.</p>
            </article>

            <article className="panel watch-panel">
              <div className="panel-head ranking-list-head"><div><h2>{selectedCategory?.label}</h2></div><small className={rankingLoading ? 'ranking-updating loading' : 'ranking-updating'}>{rankingLoading ? '조회 중' : rankingAvailable ? `${rankingList.length}개` : ''}</small></div>
              <div className="stock-table">
                <div className="stock-row table-head"><span>종목</span><span>현재가</span><span>{rankingType === 'surge' ? '급증률' : '등락률'}</span></div>
                <div className="ranking-stock-scroll">
                  {rankingList.map((stock, index) => <button className={`stock-row ${selected?.code === stock.code ? 'selected' : ''}`} key={stock.code} onClick={() => chooseStock(stock)}><span><strong><em>{String(index + 1).padStart(2, '0')}</em><span className="ranking-stock-name">{stock.name}</span><small className="ranking-stock-code">{stock.code}</small></strong><small className="ranking-stock-volume">거래량 {stock.volume}</small></span><span>{won(stock.price)}</span><span className={rankingType === 'surge' || stock.change >= 0 ? 'up' : 'down'}>{rankingType === 'surge' ? `+${stock.surge}%` : `${stock.change >= 0 ? '+' : ''}${stock.change}%`}</span></button>)}
                  {!rankingLoading && rankingError && <div className="data-message error">{rankingError}</div>}
                  {!rankingLoading && !rankingError && rankingList.length === 0 && <div className="data-message">표시할 종목이 없습니다.</div>}
                </div>
              </div>
            </article>

            <StockChartPanel stock={selected} period={period} onPeriodChange={setPeriod}/>
          </section>

          <section className="lower-grid guest-lower-grid">
            <article className="panel holdings"><div className="panel-head"><div><h2>보유종목</h2></div></div><div className="empty-panel-body"><LoginNotice text="로그인 시 보유종목이 표시됩니다."/></div></article>
            <article className="panel news-panel">
              <div className="panel-head"><div><h2>주요 뉴스</h2></div><small>NAVER</small></div>
              <div className="news-list">
                {news.map((item, index) => <a className="news-item" href={item.link || item.naverLink} target="_blank" rel="noreferrer" key={`${item.link}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{item.title}</strong><small>{item.source} · {new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(item.publishedAt))}</small></div></a>)}
                {newsLoading && <div className="data-message"><span className="loading-ring"/></div>}
                {!newsLoading && newsError && <div className="data-message error">{newsError}</div>}
                {!newsLoading && !newsError && news.length === 0 && <div className="data-message">표시할 뉴스가 없습니다.</div>}
              </div>
            </article>
          </section>
          </> : activePage === 'order' ? <OrderPreview selected={selected} period={orderPeriod} onPeriodChange={setOrderPeriod} indicatorConfigs={indicatorConfigs} strategyName={strategyName} onStrategyNameChange={setStrategyName} onAddIndicator={addIndicator} onUpdateIndicator={updateIndicator} onRemoveIndicator={removeIndicator} onResetIndicators={resetIndicators} onDeleteIndicators={deleteIndicators}/> : <AssetsPreview/>}
        </div>
      </main>
      {mobileNav && <button className="overlay" onClick={() => setMobileNav(false)}/>} 
    </div>
  )
}

export default App
