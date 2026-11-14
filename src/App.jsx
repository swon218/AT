import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, Bell, Bot, Building2, ChevronDown, FlaskConical, LayoutDashboard, LineChart,
  LogIn, LogOut, Menu, Newspaper, PanelLeftClose, PanelLeftOpen,
  WalletCards, X, Filter,
} from 'lucide-react'
import { getKiwoomRankings, getKiwoomStockQuote } from './services/kiwoomMarketApi'
import GlobalStockSearch from './components/GlobalStockSearch'
import StockSearch from './components/StockSearch'
import MarketRankings from './components/MarketRankings'
import DashboardWelcome from './components/DashboardWelcome'
import DashboardHoldings from './components/DashboardHoldings'
import RecentOrders from './components/RecentOrders'
import MarketIndexChart from './components/MarketIndexChart'
import MarketSummary from './components/MarketSummary'
import DashboardNews from './components/DashboardNews'
import NewsPage from './components/NewsPage'
import CompanyAnalysisPage from './components/CompanyAnalysisPage'
import './components/Dashboard.css'
import TradingViewChart from './components/TradingViewChart'
import LabChartPanel from './components/LabChartPanel'
import OrderEntryPanel from './components/OrderEntryPanel'
import { BROKERS, getBroker, isBrokerConfigured } from './utils/brokers'
import AuthModal from './components/AuthModal'
import AccountSettingsModal from './components/AccountSettingsModal'
import AssetsPage from './components/AssetsPage'
import ConfirmDialog from './components/ConfirmDialog'
import { initialRecoveryRequest, supabase } from './services/supabaseClient'
import { clearRecoveryUrl, initializePasswordRecovery, RECOVERY_LINK_ERROR } from './services/passwordRecovery'
import { getIntegrationSettings, subscribeIntegrationChanges } from './services/accountSettingsApi'
import { getBrokerAccountSummary } from './services/kiwoomAccountApi'
import useIndicatorDraft from './hooks/useIndicatorDraft'
import useStrategies from './hooks/useStrategies'
import useAgentWorkspace from './hooks/useAgentWorkspace'
import AgentWorkspace, { FloatingAgent } from './components/AgentWorkspace'
import AlertAgentPanel, { AgentModeTabs, TradingAgentPanel } from './components/AlertAgentPanel'
import useAgentAlertDrafts from './hooks/useAgentAlertDrafts'
import SidebarFooter from './components/SidebarFooter'
import ThemeSwitch from './components/ThemeSwitch'
import {describeChartScope} from './utils/chartScope'
import WatchlistStar, { WatchlistFeedback } from './components/WatchlistStar'
import useBrokerConnections from './hooks/useBrokerConnections'
import useWatchlist from './hooks/useWatchlist'
import useWatchlistQuotes from './hooks/useWatchlistQuotes'
import ScreenerWorkspace from './components/ScreenerWorkspace'
import useScreener from './hooks/useScreener'
import useLabWorkspace from './hooks/useLabWorkspace'
import { describeQuery } from './utils/screener'
import useAdminAccess from './hooks/useAdminAccess'
import AdminEvalPanel from './components/AdminEvalPanel'

const won = (value) => new Intl.NumberFormat('ko-KR').format(value)
const defaultStock = {
  code: '005930',
  name: '삼성전자',
  market: 'KRX',
  price: 0,
  change: 0,
  volume: 0,
}
const rankingCategories = [
  { id: 'realtime', label: '실시간조회' },
  { id: 'rising', label: '상승률' },
  { id: 'falling', label: '하락률' },
  { id: 'volume', label: '거래량 상위' },
  { id: 'surge', label: '거래량 급증' },
  { id: 'favorites', label: '관심종목' },
]

function StockChartPanel({ stock, period, onPeriodChange, indicators = [], credentialScope = 'guest', broker = 'kiwoom', watchlist }) {
  const [minuteMenuOpen, setMinuteMenuOpen] = useState(false)
  const [sourceBroker, setSourceBroker] = useState(broker)
  const [provenance,setProvenance]=useState(null)
  const currentScope=JSON.stringify([stock?.code,period,credentialScope,broker])
  const chartInfo=provenance?.key===currentScope?provenance:null
  useEffect(() => setSourceBroker(broker), [broker, credentialScope])
  const minutePeriods = ['1분', '5분', '10분', '15분', '30분', '60분']
  const selectedMinute = minutePeriods.includes(period) ? period : '15분'
  return (
    <article className="panel chart-panel">
      <div className="quote-head">
        <div className="quote-identity order-quote-identity">
          <h2>{stock?.name ?? ''}</h2>
          {stock && <WatchlistStar stock={stock} watchlist={watchlist}/>}
          <small>{stock ? `${stock.code} · ${stock.market ?? 'KRX'}` : ''}</small>
        </div>
        {stock && <div className="quote-price"><strong>{stock.price == null ? '—' : won(stock.price)}<small>원</small></strong>{stock.change != null && <span className={stock.change >= 0 ? 'up' : 'down'}>{stock.change >= 0 ? '▲' : '▼'} {Math.abs(stock.change)}%</span>}{stock.quoteError && <span title={stock.quoteError}>시세 조회 실패</span>}</div>}
      </div>
      <WatchlistFeedback watchlist={watchlist}/>
      <div className="chart-toolbar"><div className="chart-periods"><>
        <div className="minute-period-select" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMinuteMenuOpen(false) }}>
          <button type="button" className={minutePeriods.includes(period) ? 'active minute-trigger' : 'minute-trigger'} aria-haspopup="menu" aria-expanded={minuteMenuOpen} onClick={() => setMinuteMenuOpen((open) => !open)}>{selectedMinute}<ChevronDown/></button>
          {minuteMenuOpen && <div className="minute-period-menu" role="menu">{minutePeriods.map((item) => <button type="button" role="menuitem" className={period === item ? 'selected' : ''} onClick={() => { onPeriodChange(item); setMinuteMenuOpen(false) }} key={item}>{item}</button>)}</div>}
        </div>
        {['일','주','월'].map((item) => <button type="button" className={period === item ? 'active' : ''} onClick={() => { onPeriodChange(item); setMinuteMenuOpen(false) }} key={item}>{item}</button>)}
      </></div><span>{getBroker(sourceBroker).shortName} 캔들 데이터{sourceBroker !== broker ? ' · 대체 시세' : ''}</span></div>
      <p className="chart-data-scope" role="status">{describeChartScope(chartInfo,period)}</p>
      <div className="main-chart tradingview-host"><TradingViewChart stock={stock} period={period} indicators={indicators} credentialScope={credentialScope} broker={broker} onSourceChange={setSourceBroker} onMetadataChange={setProvenance}/></div>
    </article>
  )
}

function ChartWorkspace({ selected, period, onPeriodChange, currentUser, watchlist, integrationStatus = {}, broker, onBrokerChange, accountSummary, accountLoading, accountError, onAccountRefresh, onAccountChange, accountId = '', accountOptions = [], integrationVersion = 0, indicatorsOnly = false, labWorkspace, indicatorConfigs, strategyName, onStrategyNameChange, onAddIndicator, onUpdateIndicator, onRemoveIndicator, onResetIndicators, onDeleteIndicators, backtestSettings, onBacktestSettingsChange, strategyStorage }) {
  const configured = !indicatorsOnly && isBrokerConfigured(integrationStatus, broker)
  const credentialScope = `${broker}:${currentUser?.id || 'guest'}:${configured}:${integrationVersion}`
  return (
    <section className="preview-grid order-preview-grid" aria-label={indicatorsOnly ? '실험실' : '주식 주문'}>
      {indicatorsOnly ? <LabChartPanel workspace={labWorkspace} indicators={indicatorConfigs} strategyName={strategyName} settings={backtestSettings} onSettingsChange={onBacktestSettingsChange}/> : <StockChartPanel stock={selected} period={period} onPeriodChange={onPeriodChange} indicators={indicatorConfigs} credentialScope={credentialScope} broker={broker} watchlist={watchlist}/>}
      <article className="panel preview-order"><OrderEntryPanel userId={currentUser?.id} credentialVersion={integrationVersion} key={`${currentUser?.id || 'guest'}:${broker}:${integrationVersion}`} onAccountChange={onAccountChange} accountId={accountId} accountOptions={accountOptions} indicatorsOnly={indicatorsOnly} stock={selected} authenticated={Boolean(currentUser)} integrationStatus={integrationStatus} broker={broker} onBrokerChange={onBrokerChange} accountSummary={accountSummary} accountLoading={accountLoading} accountError={accountError} onAccountRefresh={onAccountRefresh} indicatorConfigs={indicatorConfigs} strategyName={strategyName} onStrategyNameChange={onStrategyNameChange} onAddIndicator={onAddIndicator} onUpdateIndicator={onUpdateIndicator} onRemoveIndicator={onRemoveIndicator} onResetIndicators={onResetIndicators} onDeleteIndicators={onDeleteIndicators} strategyStorage={strategyStorage}/></article>
    </section>
  )
}

function App() {
  const [activePage, setActivePage] = useState(() => new URLSearchParams(window.location.search).get('page') === 'admin' ? 'admin' : new URLSearchParams(window.location.search).get('agent') === 'alerts' ? 'agent' : 'dashboard')
  const [agentMode, setAgentMode] = useState(() => new URLSearchParams(window.location.search).get('agent') === 'alerts' ? 'alerts' : 'analysis')
  const [alertNotice, setAlertNotice] = useState('')
  const [newsCategory, setNewsCategory] = useState('all')
  const brokerageDataEnabled = !['lab', 'screen', 'agent', 'news', 'company', 'admin'].includes(activePage)
  const showStockSearch = brokerageDataEnabled || activePage === 'company'
  const labWorkspace = useLabWorkspace(activePage === 'lab')
  const [selected, setSelected] = useState(defaultStock)
  const [analysisStock, setAnalysisStock] = useState(null)
  const [orderPeriod, setOrderPeriod] = useState('15분')
  const selectionVersion = useRef(0)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [integrationVersion, setIntegrationVersion] = useState(0)
  const [mobileNav, setMobileNav] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rankingType, setRankingType] = useState('realtime')
  const [rankingList, setRankingList] = useState([])
  const [rankingLoading, setRankingLoading] = useState(false)
  const [rankingAvailable, setRankingAvailable] = useState(false)
  const [rankingError, setRankingError] = useState('')

  const [authModalOpen, setAuthModalOpen] = useState(initialRecoveryRequest.requested)
  const [passwordRecovery, setPasswordRecovery] = useState(initialRecoveryRequest.requested ? { status: 'checking' } : null)
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const isAdmin = useAdminAccess(currentUser?.id)
  const brokerConnections = useBrokerConnections(currentUser?.id)
  const [authReady, setAuthReady] = useState(!supabase)
  const watchlist = useWatchlist(currentUser?.id, { authReady, onLogin: () => setAuthModalOpen(true) })
  const alertDrafts = useAgentAlertDrafts(currentUser?.id)
  const agent = useAgentWorkspace(currentUser?.id, authReady, undefined, {
    editor: alertDrafts.editor,
    onRoomCreated: alertDrafts.move,
    onWatchlistAdded: () => watchlist.refresh({ afterWrite: true }),
    onDraft(roomId, draft) {
      if (!alertDrafts.apply(roomId, draft)) {
        setAlertNotice('응답을 기다리는 동안 수정한 조건을 유지했습니다.')
        return false
      }
      setAlertNotice('')
      openPage('agent')
      setAgentMode('alerts')
      agent.setUI({ robotVisible: true, miniOpen: true, position: { x: 1, y: 1 } })
      return true
    },
  })
  useEffect(() => { setAlertNotice('') }, [currentUser?.id])
  const strategies = useStrategies(currentUser?.id)
  const orderDraft = useIndicatorDraft(currentUser?.id, strategies)
  const labDraft = useIndicatorDraft(currentUser?.id, strategies)
  const screen = useScreener(currentUser?.id)
  const [nickname, setNickname] = useState('')
  const [integrationStatus, setIntegrationStatus] = useState({ kiwoomConfigured: false, tossConfigured: false, nhConfigured: false, kbConfigured: false, telegramConfigured: false })
  const integrationSync = useRef(null)
  const [orderBroker, setOrderBroker] = useState('kiwoom')
  const [orderAccountId, setOrderAccountId] = useState('')
  const [orderAccountSummary, setOrderAccountSummary] = useState(null)
  const [orderAccountLoading, setOrderAccountLoading] = useState(false)
  const [orderAccountError, setOrderAccountError] = useState('')
  const [orderAccountRefreshVersion, setOrderAccountRefreshVersion] = useState(0)
  const [orderAccountOptions, setOrderAccountOptions] = useState(null)
  const orderAccountOwner = `${currentUser?.id || ''}:${orderBroker}:${integrationVersion}`
  const currentOrderAccountOptions = orderAccountOptions?.owner === orderAccountOwner ? orderAccountOptions.accounts : []
  const orderAccountScope = JSON.stringify([currentUser?.id, orderBroker, orderAccountId, selected?.code, integrationVersion, orderAccountRefreshVersion])
  const currentOrderAccountSummary = orderAccountSummary?.requestScope === orderAccountScope ? orderAccountSummary : null
  const [dashboardHoldingsBrokers, setDashboardHoldingsBrokers] = useState(() => BROKERS.map(({ id }) => id))
  const [dashboardOrderBrokers, setDashboardOrderBrokers] = useState(() => BROKERS.map(({ id }) => id))
  const [orderHistoryTarget, setOrderHistoryTarget] = useState(null)

  const searchCredentialScope = `${currentUser?.id || 'guest'}:${integrationStatus.kiwoomConfigured}:${integrationVersion}`
  const watchlistQuotes = useWatchlistQuotes(watchlist.rows, searchCredentialScope, activePage === 'dashboard' && rankingType === 'favorites')

  const onIntegrationStatusChange = (status) => {
    integrationSync.current?.accept(status)
    setIntegrationStatus(status)
    setIntegrationVersion(version => version + 1)
  }

  useEffect(() => {
    const userId=currentUser?.id
    setIntegrationStatus({kiwoomConfigured:false,tossConfigured:false,nhConfigured:false,kbConfigured:false,telegramConfigured:false})
    if(!userId)return undefined
    let active=true,controller=null,sequence=0,knownVersion
    const pending=new Set()
    const resume=()=>{if(pending.size){const done=[...pending];pending.clear();brokerConnections.mutation(done,false)}}
    const sync={accept(status){sequence++;controller?.abort();knownVersion=status.settingsVersion;resume()}}
    integrationSync.current=sync
    const refresh=async(changed,announced=false)=>{
      controller?.abort();controller=new AbortController()
      const signal=controller.signal,requestSequence=++sequence
      const affected=changed?.filter(b=>BROKERS.some(v=>v.id===b))||[]
      affected.forEach(b=>pending.add(b))
      if(pending.size)brokerConnections.mutation([...pending],true)
      try{
        const next=await getIntegrationSettings(userId,signal)
        if(!active||signal.aborted||sequence!==requestSequence)return
        const different=knownVersion!==undefined&&knownVersion!==next.settingsVersion
        if(different&&!pending.size){BROKERS.forEach(b=>pending.add(b.id));brokerConnections.mutation([...pending],true)}
        setIntegrationStatus(next)
        if(announced||different)setIntegrationVersion(v=>v+1)
        knownVersion=next.settingsVersion
      }catch{/* Keep prior saved metadata; private requests still revalidate on the server. */}
      finally{if(active&&!signal.aborted&&sequence===requestSequence)resume()}
    }
    const unsubscribe=subscribeIntegrationChanges(event=>{if(event.userId===userId)void refresh(event.brokers,true)})
    const focus=()=>void refresh()
    window.addEventListener('focus',focus)
    void refresh()
    return()=>{active=false;controller?.abort();resume();if(integrationSync.current===sync)integrationSync.current=null;unsubscribe();window.removeEventListener('focus',focus)}
  },[currentUser?.id,brokerConnections.mutation])

  const openPage = (page, historyTarget = null) => {
    setOrderHistoryTarget(historyTarget)
    setActivePage(page)
    setMobileNav(false)
  }
  const openStockOrder = (stock) => {
    selectionVersion.current += 1
    setSelectionRevision(selectionVersion.current)
    setSelected(stock)
    openPage('order')
    if (activePage !== 'order') window.scrollTo(0, 0)
  }
  const openOrderHistory = target => openPage('assets', { ...target, owner: currentUser?.id, version: integrationVersion })
  const openNews = category => { setNewsCategory(category); openPage('news') }
  const openScreen = query => { if (screen.open(query)) openPage('screen') }
  const askScreenAgent = query => {
    const text = `${describeQuery(query)}인 종목을 검색하고 결과와 데이터 범위를 설명해줘.`
    const draft = [agent.active.draft, text].filter(Boolean).join('\n\n')
    if (draft.length > 6000) return false
    agent.setDraft(draft)
    openPage('agent')
    setAgentMode('analysis')
    return true
  }

  const closeAuthModal = useCallback(() => {
    setAuthModalOpen(false)
    setPasswordRecovery(null)
    window.history.replaceState(window.history.state, '', clearRecoveryUrl(window.location.href))
  }, [])
  const finishPasswordRecovery = useCallback(() => {
    setPasswordRecovery(null)
    window.history.replaceState(window.history.state, '', clearRecoveryUrl(window.location.href))
  }, [])
  const closeAccountSettings = useCallback(() => setAccountSettingsOpen(false), [])

  const loadNickname = useCallback(async (user) => {
    if (!supabase || !user) {
      setNickname('')
      return
    }
    const { data } = await supabase.from('profiles').select('nickname').eq('id', user.id).maybeSingle()
    setNickname(data?.nickname ?? '')
  }, [])

  const openProfileOrLogin = () => {
    if (currentUser) setAccountSettingsOpen(true)
    else setAuthModalOpen(true)
  }

  const openLoginOrLogoutConfirm = () => {
    if (currentUser) setLogoutConfirmOpen(true)
    else setAuthModalOpen(true)
  }

  const confirmLogout = async () => {
    setLoggingOut(true)
    const { error } = await supabase?.auth.signOut() ?? {}
    setLoggingOut(false)
    if (!error) {
      setLogoutConfirmOpen(false)
      setAccountSettingsOpen(false)
    }
  }

  useEffect(() => {
    if (!supabase) {
      if (initialRecoveryRequest.requested) setPasswordRecovery({ status: 'error', message: 'Supabase 환경 설정을 확인해 주세요.' })
      return undefined
    }
    let active = true
    let sessionObserved = false
    initializePasswordRecovery(supabase.auth, initialRecoveryRequest).then(({ session, recovery }) => {
      if (!active) return
      if (!sessionObserved) {
        const user = session?.user ?? null
        setCurrentUser(user)
        loadNickname(user)
      }
      if (recovery) setPasswordRecovery(recovery)
    }).catch(() => {
      if (active && initialRecoveryRequest.requested) setPasswordRecovery({ status: 'error', message: RECOVERY_LINK_ERROR })
    }).finally(() => {
      if (active) setAuthReady(true)
    })
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      sessionObserved = true
      const user = session?.user ?? null
      setCurrentUser(user)
      setAuthReady(true)
      window.setTimeout(() => loadNickname(user), 0)
      if (event === 'PASSWORD_RECOVERY' && session && !initialRecoveryRequest.failed) {
        setPasswordRecovery({ status: 'ready' })
        setAuthModalOpen(true)
      } else if (!session) {
        setPasswordRecovery(current => current ? { status: 'error', message: RECOVERY_LINK_ERROR } : null)
      }
    })
    return () => { active = false; authListener.subscription.unsubscribe() }
  }, [loadNickname])

  useEffect(() => { setOrderBroker('kiwoom') }, [currentUser?.id])

  useEffect(() => { setOrderAccountId('') }, [orderBroker, currentUser?.id, integrationVersion])

  useEffect(() => {
    if (activePage !== 'order' || !selected?.code) return
    const controller = new AbortController()
    const code = selected.code
    const version = selectionVersion.current
    setSelected(stock => ({ ...stock, price: null, change: null, quoteError: '' }))
    getKiwoomStockQuote(code, controller.signal)
      .then(quote => {
        if (!controller.signal.aborted && selectionVersion.current === version) setSelected(stock => stock.code === code ? { ...stock, ...quote } : stock)
      })
      .catch(error => {
        if (!controller.signal.aborted && selectionVersion.current === version) setSelected(stock => stock.code === code ? { ...stock, quoteError: error.message } : stock)
      })
    return () => controller.abort()
  }, [activePage, selected?.code, searchCredentialScope, selectionRevision])

  useEffect(() => {
    let active = true
    const configured = isBrokerConfigured(integrationStatus, orderBroker)
    if (activePage !== 'order' || !currentUser || !configured) {
      setOrderAccountSummary(null)
      setOrderAccountLoading(false)
      setOrderAccountError('')
      return () => { active = false }
    }
    setOrderAccountSummary(null)
    setOrderAccountLoading(true)
    setOrderAccountError('')
    getBrokerAccountSummary(orderBroker, selected?.code || '', orderBroker === 'nh' ? orderAccountId : '')
      .then((summary) => {
        if (!active) return
        setOrderAccountSummary({ ...summary, requestScope: orderAccountScope })
        setOrderAccountOptions({ owner: orderAccountOwner, accounts: summary.accounts || [] })
      })
      .catch((error) => {
        if (!active) return
        setOrderAccountSummary(null)
        setOrderAccountError(error.message)
      })
      .finally(() => active && setOrderAccountLoading(false))
    return () => { active = false }
  }, [activePage, currentUser, integrationStatus.kiwoomConfigured, integrationStatus.tossConfigured, integrationStatus.nhConfigured, integrationStatus.kbConfigured, orderBroker, orderAccountId, selected?.code, orderAccountRefreshVersion, integrationVersion])

  useEffect(() => {
    let active = true
    if (!brokerageDataEnabled || rankingType === 'favorites') {
      setRankingLoading(false)
      return () => { active = false }
    }
    setRankingLoading(true)
    setRankingAvailable(false)
    setRankingError('')
    setRankingList([])
    getKiwoomRankings(rankingType, 20)
      .then((stocks) => {
        if (!active) return
        setRankingList(stocks)
        setRankingAvailable(true)
      })
      .catch((error) => {
        if (!active) return
        setRankingList([])
        setRankingError(error.message)
      })
      .finally(() => active && setRankingLoading(false))

    return () => { active = false }
  }, [brokerageDataEnabled, rankingType, currentUser, integrationStatus.kiwoomConfigured, integrationVersion])

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''} ${activePage === 'lab' ? 'lab-mode' : ''}`}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${mobileNav ? 'open' : ''}`}>
        <div className="brand">
          {sidebarCollapsed
            ? <><button className="brand-mark brand-expand-trigger" title="사이드바 펼치기" aria-label="사이드바 펼치기" onClick={() => setSidebarCollapsed(false)}><Activity className="brand-logo-icon" size={18}/><PanelLeftOpen className="brand-expand-icon" size={18}/></button><div><strong>ATLAS</strong><small>TRADING SYSTEM</small></div></>
            : <button type="button" className="brand-home" aria-label="대시보드로 이동" onClick={() => openPage('dashboard')}><span className="brand-mark"><Activity size={18}/></span><span className="brand-copy"><strong>ATLAS</strong><small>TRADING SYSTEM</small></span></button>}
          {!sidebarCollapsed && <button className="sidebar-toggle" title="사이드바 접기" aria-label="사이드바 접기" onClick={() => setSidebarCollapsed(true)}><PanelLeftClose/></button>}
          <button className="mobile-close" onClick={() => setMobileNav(false)}><X/></button>
        </div>
        <nav>
          <p>WORKSPACE</p>
          <button className={`nav-link ${activePage === 'dashboard' ? 'active' : ''}`} onClick={() => openPage('dashboard')}><LayoutDashboard/><span>대시보드</span></button>
          <button className={`nav-link ${activePage === 'order' ? 'active' : ''}`} onClick={() => openPage('order')}><LineChart/><span>주식 주문</span></button>
          <button className={`nav-link ${activePage === 'lab' ? 'active' : ''}`} onClick={() => openPage('lab')}><FlaskConical/><span>실험실</span></button>
          <button className={`nav-link ${activePage === 'screen' ? 'active' : ''}`} onClick={() => openPage('screen')}><Filter/><span>조건 검색</span></button>
          <button className={`nav-link ${activePage === 'agent' ? 'active' : ''}`} onClick={() => openPage('agent')}><Bot/><span>AI 에이전트</span></button>
          <button className={`nav-link ${activePage === 'assets' ? 'active' : ''}`} onClick={() => openPage('assets')}><WalletCards/><span>자산 현황</span></button>
          {isAdmin && <button className={`nav-link ${activePage === 'admin' ? 'active' : ''}`} onClick={() => openPage('admin')}><FlaskConical/><span>관리자</span></button>}
          <p>MARKET</p>
          <button type="button" className={`nav-link ${activePage === 'news' ? 'active' : ''}`} aria-label="주요 뉴스 · 공시" aria-current={activePage === 'news' ? 'page' : undefined} title="주요 뉴스 · 공시" onClick={() => openPage('news')}><Newspaper/><span>주요 뉴스 · 공시</span></button>
          <button type="button" className={`nav-link ${activePage === 'company' ? 'active' : ''}`} aria-label="기업 분석" aria-current={activePage === 'company' ? 'page' : undefined} title="기업 분석" onClick={() => { openPage('company'); window.scrollTo(0, 0) }}><Building2 aria-hidden="true"/><span>기업 분석</span></button>
        </nav>
        <SidebarFooter user={currentUser} nickname={nickname} connections={brokerConnections.connections} onProfileClick={openProfileOrLogin} onSessionClick={openLoginOrLogoutConfirm}/>
      </aside>

      <main>
        <header>
          <button className="menu-button" onClick={() => setMobileNav(true)}><Menu/></button>
          {activePage === 'lab' ? <StockSearch catalogItems={labWorkspace.catalog?.items} ready={Boolean(labWorkspace.catalog?.ready)}
            error={labWorkspace.catalogError || labWorkspace.catalogMessage}
            onRetry={labWorkspace.refresh} onSelect={labWorkspace.selectStock}/>
            : showStockSearch ? <GlobalStockSearch onSelect={activePage === 'company' ? setAnalysisStock : openStockOrder} credentialScope={searchCredentialScope}/>
              : <div className="lab-workspace-title">{activePage === 'admin' ? <><FlaskConical/><span>관리자 · AI 품질 평가</span></> : activePage === 'news' ? <><Newspaper/><span>주요 뉴스 · 공시</span></> : activePage === 'agent' ? <><Bot/><span>AI 에이전트</span></> : <><Filter/><span>조건 검색</span></>}</div>}
          <div className="header-actions"><ThemeSwitch/><button title="알림"><Bell/></button><button type="button" className="login-button" title={currentUser ? '로그아웃' : '로그인'} aria-label={currentUser ? '로그아웃' : '로그인'} onClick={openLoginOrLogoutConfirm}>{currentUser ? <LogOut/> : <LogIn/>}</button></div>
        </header>

        <div className={`content guest-content ${activePage === 'agent' ? 'agent-content' : ''} ${activePage === 'dashboard' ? 'dashboard-content' : ''} ${activePage === 'order' || activePage === 'lab' ? 'order-content' : ''}`}>
          {activePage === 'admin' && !isAdmin && <section className="panel admin-eval" role="status">관리자 권한 확인이 필요합니다. 로그인한 계정의 권한을 확인해 주세요.</section>}
          {activePage === 'admin' ? (isAdmin && <AdminEvalPanel key={currentUser.id} userId={currentUser.id}/>) : activePage === 'company' ? <CompanyAnalysisPage stock={analysisStock ?? (selectionRevision > 0 ? selected : null)}/> : activePage === 'news' ? <NewsPage category={newsCategory} onCategoryChange={setNewsCategory}/> : activePage === 'screen' ? <ScreenerWorkspace screen={screen} agentReady={agent.ready} onOpenChart={row => openStockOrder({ code: row.code, name: row.name, market: row.market, price: null, change: null, volume: null })} onAskAgent={askScreenAgent}/> : activePage === 'agent' ? <>
            <AgentModeTabs mode={agentMode} onChange={setAgentMode}/>
            <div role="tabpanel" id="agent-mode-panel" aria-labelledby={`agent-tab-${agentMode}`}>
              {agentMode === 'alerts' ? <AlertAgentPanel key={currentUser?.id || 'guest'} userId={currentUser?.id} watchlist={watchlist}
                drafts={alertDrafts} roomId={agent.active.id} notice={alertNotice}
                onLogin={() => setAuthModalOpen(true)} onKakao={() => setAccountSettingsOpen(true)} settingsOpen={accountSettingsOpen}/>
                : agentMode === 'trading' ? <TradingAgentPanel/>
                  : <AgentWorkspace key={currentUser?.id || 'guest'} agent={{ ...agent, openScreen }}
                    onOpenMini={() => { agent.setUI({ robotVisible: true, miniOpen: true }); setAgentMode('alerts') }}/>}
            </div>
          </> : activePage === 'dashboard' ? <>
          <DashboardWelcome/>

          <MarketSummary credentialScope={searchCredentialScope}/>

          <section className="trading-grid dashboard-market-grid">
            <MarketRankings categories={rankingCategories} type={rankingType} onTypeChange={setRankingType} stocks={rankingList} loading={rankingLoading} available={rankingAvailable} error={rankingError} selectedCode={selected?.code} onSelect={openStockOrder} watchlist={watchlist} quotes={watchlistQuotes}/>

            <MarketIndexChart credentialScope={searchCredentialScope}/>
            <DashboardNews onOpenNews={openNews}/>
          </section>

          <section className="lower-grid guest-lower-grid dashboard-account-grid">
            <DashboardHoldings key={currentUser?.id || 'guest'} currentUser={currentUser} integrationStatus={integrationStatus} integrationVersion={integrationVersion} selected={dashboardHoldingsBrokers} onSelectedChange={setDashboardHoldingsBrokers} onOpenAssets={() => openPage('assets')} onOpenStock={openStockOrder}/>
            <RecentOrders key={`recent-orders:${currentUser?.id || 'guest'}`} currentUser={currentUser} integrationStatus={integrationStatus} integrationVersion={integrationVersion} selected={dashboardOrderBrokers} onSelectedChange={setDashboardOrderBrokers} onOpenHistory={openOrderHistory}/>
          </section>
          </> : activePage === 'order' ? <ChartWorkspace key="order" integrationVersion={integrationVersion} onAccountChange={setOrderAccountId} accountId={orderAccountId} accountOptions={currentOrderAccountOptions} selected={selected} period={orderPeriod} onPeriodChange={setOrderPeriod} currentUser={currentUser} watchlist={watchlist} integrationStatus={integrationStatus} broker={orderBroker} onBrokerChange={setOrderBroker} accountSummary={currentOrderAccountSummary} accountLoading={orderAccountLoading} accountError={orderAccountError} onAccountRefresh={() => setOrderAccountRefreshVersion((value) => value + 1)} {...orderDraft}/> : activePage === 'lab' ? <ChartWorkspace key="lab" currentUser={currentUser} labWorkspace={labWorkspace} indicatorsOnly {...labDraft}/> : <AssetsPage key={currentUser?.id || 'guest'} currentUser={currentUser} integrationStatus={integrationStatus} integrationVersion={integrationVersion} orderHistoryTarget={orderHistoryTarget?.owner === currentUser?.id && orderHistoryTarget?.version === integrationVersion ? orderHistoryTarget : null} onOpenStock={openStockOrder}/>}
        </div>
      </main>
      <FloatingAgent agent={{ ...agent, openScreen }} visible={(activePage !== 'agent' || agentMode !== 'analysis') && !mobileNav && !authModalOpen && !accountSettingsOpen && !logoutConfirmOpen}
        onExpand={() => { openPage('agent'); setAgentMode('analysis') }}
        context={activePage === 'agent' ? (agentMode === 'alerts' ? '알림 에이전트' : '매매 에이전트') : activePage === 'company' ? '기업 분석' : activePage === 'news' ? '주요 뉴스 · 공시' : activePage === 'order' ? `${selected?.name || '종목 미선택'} · ${orderPeriod}` : activePage === 'lab' ? '실험실' : activePage === 'screen' ? '조건 검색' : activePage === 'assets' ? '자산 현황' : '대시보드'}/>
      {mobileNav && <button className="overlay" onClick={() => setMobileNav(false)}/>} 
      <AuthModal open={authModalOpen} onClose={closeAuthModal} recovery={passwordRecovery} onRecoveryFinished={finishPasswordRecovery}/>
      <AccountSettingsModal key={currentUser?.id || 'guest'} open={accountSettingsOpen} user={currentUser} onClose={closeAccountSettings} onNicknameSaved={setNickname} onIntegrationStatusChange={onIntegrationStatusChange} onIntegrationMutation={brokerConnections.mutation}/>
      <ConfirmDialog open={logoutConfirmOpen} pending={loggingOut} onCancel={() => setLogoutConfirmOpen(false)} onConfirm={confirmLogout}/>
    </div>
  )
}

export default App
