import { useId, useRef, useState } from 'react'
import { Building2, Info, Search } from 'lucide-react'
import useCompanyAnalysis, { companyErrorMessage } from '../hooks/useCompanyAnalysis'
import { koreanOrderDay } from '../utils/orderPeriod'
import {
  BusinessGrowth, CompanyOutlook, CompanyOverview, DisclosuresRisk, FinancialResults, ShareholdersDividends,
} from './CompanyAnalysisSections'
import './CompanyAnalysisPage.css'

const sections = [
  { id: 'overview', title: '개요' },
  { id: 'financials', title: '실적·재무' },
  { id: 'business', title: '사업·성장' },
  { id: 'shareholders', title: '주주·배당' },
  { id: 'disclosures', title: '공시·리스크' },
  { id: 'outlook', title: '전망·IR' },
]
const marketNames = { KOSPI: '코스피', KOSDAQ: '코스닥', KONEX: '코넥스' }
const defaultDisclosures = () => ({ start: koreanOrderDay(Date.now() - 30 * 86_400_000), end: koreanOrderDay(), type: 'all' })
const checkedTime = value => value && new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

export default function CompanyAnalysisPage({ stock }) {
  const [tab, setTab] = useState('overview')
  const [frequency, setFrequency] = useState('annual')
  const [statementScope, setStatementScope] = useState('consolidated')
  const [disclosureFilters, setDisclosureFilters] = useState(defaultDisclosures)
  const [disclosureQuery, setDisclosureQuery] = useState(() => ({ ...defaultDisclosures(), page: 1 }))
  const [filterError, setFilterError] = useState('')
  const id = useId()
  const tabButtons = useRef([])
  const params = tab === 'financials' ? { section: tab, scope: statementScope === 'consolidated' ? 'CFS' : 'OFS' }
    : tab === 'disclosures' ? { section: tab, ...disclosureQuery } : { section: tab }
  const analysis = useCompanyAnalysis(stock?.code, params)
  const overview = useCompanyAnalysis(stock?.code, ['disclosures', 'outlook'].includes(tab) ? { section: 'overview' } : null)
  const data = analysis.data

  function applyDisclosureQuery(event) {
    event.preventDefault()
    const { start, end } = disclosureFilters
    if (!start || !end || start > end || end > koreanOrderDay() || start < '1999-01-01' ||
      (Date.parse(end) - Date.parse(start)) / 86_400_000 > 365) {
      setFilterError('1999년 이후의 날짜를 선택해 주세요. 시작일은 종료일보다 늦을 수 없고, 조회 범위는 최대 366일입니다.')
      return
    }
    setFilterError('')
    setDisclosureQuery({ ...disclosureFilters, page: 1 })
    if (disclosureQuery.page === 1 && Object.keys(disclosureFilters).every(key => disclosureFilters[key] === disclosureQuery[key])) analysis.retry?.()
  }

  function onTabKeyDown(event, index) {
    let next
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % sections.length; break
      case 'ArrowLeft': next = (index - 1 + sections.length) % sections.length; break
      case 'Home': next = 0; break
      case 'End': next = sections.length - 1; break
      default: return
    }
    event.preventDefault()
    setTab(sections[next].id)
    tabButtons.current[next]?.focus()
  }

  const panels = {
    overview: <CompanyOverview data={data}/>,
    financials: <FinancialResults frequency={frequency} scope={statementScope}
      onFrequencyChange={setFrequency} onScopeChange={setStatementScope} data={data}/>,
    business: <BusinessGrowth data={data} checkedAt={analysis.checkedAt}/>,
    shareholders: <ShareholdersDividends data={data}/>,
    disclosures: <DisclosuresRisk filters={disclosureFilters} onFiltersChange={setDisclosureFilters}
      query={disclosureQuery} onQuery={applyDisclosureQuery} queryError={filterError} data={data} risk={overview.data}
      disabled={!stock || analysis.status === 'unsupported'} onPage={page => setDisclosureQuery(previous => ({ ...previous, page }))}/>,
    outlook: <CompanyOutlook data={data} latest={overview.data?.latest}/>,
  }
  let status = '출처 · 금융감독원 전자공시'
  if (analysis.status === 'unsupported') status = 'Open DART에서 기업 매핑을 확인할 수 없는 종목입니다.'
  if (analysis.status === 'loading') status = analysis.waiting ? '아직 자료를 수집하고 있습니다. 잠시 뒤 다시 확인해 주세요.' : '기업정보를 수집하고 있습니다.'
  if (analysis.status === 'error') status = companyErrorMessage(analysis.error)
  if (analysis.status === 'stale') status = analysis.refreshing ? '저장된 자료 · 갱신 중' : '저장된 자료 · 갱신 대기'

  return <section className="company-analysis" aria-labelledby={`${id}-title`}>
    <h1 className="company-title" id={`${id}-title`}><Building2 size={22} aria-hidden="true"/>기업 분석</h1>
    <div className="panel company-identity">
      <div className="company-identity-main">
        <div className="company-identity-icon" aria-hidden="true">{stock ? <Building2 size={26}/> : <Search size={25}/>}</div>
        <div aria-live="polite">
          <h2>{stock?.name || '분석할 기업을 검색해 주세요'}</h2>
          {stock ? <div className="company-tags">
            <span>{stock.code}</span>
            <span>{marketNames[stock.market] ?? (stock.market || '—')}</span>
          </div> : <p>상단 검색창에 종목명이나 종목코드를 입력하세요.</p>}
        </div>
      </div>
      <div className="company-status">
        <div className="company-connection" role="status"><Info size={16} aria-hidden="true"/>{status}</div>
        {analysis.checkedAt && <small>마지막 확인 {checkedTime(analysis.checkedAt)} KST</small>}
        {analysis.status === 'stale' && analysis.error && <small>{companyErrorMessage(analysis.error)}</small>}
        {analysis.retryAt && <small>재시도 가능 시각 {checkedTime(analysis.retryAt)} KST</small>}
        {(analysis.status === 'error' || analysis.waiting) && <button type="button" onClick={analysis.retry}>다시 확인</button>}
      </div>
    </div>

    <div className="company-tabs" role="tablist" aria-label="기업 분석 메뉴">
      {sections.map((section, index) => <button type="button" role="tab" key={section.id}
        id={`${id}-tab-${section.id}`} aria-controls={`${id}-panel-${section.id}`}
        aria-selected={tab === section.id} tabIndex={tab === section.id ? 0 : -1}
        ref={button => { tabButtons.current[index] = button }}
        onClick={() => setTab(section.id)} onKeyDown={event => onTabKeyDown(event, index)}>
        {section.title}
      </button>)}
    </div>

    {sections.map(section => <div className="company-tabpanel" key={section.id} role="tabpanel"
      id={`${id}-panel-${section.id}`} aria-labelledby={`${id}-tab-${section.id}`} hidden={tab !== section.id}
      tabIndex={tab === section.id ? 0 : -1}>
      {tab === section.id && panels[section.id]}
    </div>)}
  </section>
}
