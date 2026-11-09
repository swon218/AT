import { useId, useRef, useState } from 'react'
import { Building2, Info, Search } from 'lucide-react'
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

export default function CompanyAnalysisPage({ stock }) {
  const [tab, setTab] = useState('overview')
  const [frequency, setFrequency] = useState('annual')
  const [statementScope, setStatementScope] = useState('consolidated')
  const [disclosureFilters, setDisclosureFilters] = useState({ start: '', end: '', type: 'all' })
  const id = useId()
  const tabButtons = useRef([])

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
    overview: <CompanyOverview/>,
    financials: <FinancialResults frequency={frequency} scope={statementScope}
      onFrequencyChange={setFrequency} onScopeChange={setStatementScope}/>,
    business: <BusinessGrowth/>,
    shareholders: <ShareholdersDividends/>,
    disclosures: <DisclosuresRisk filters={disclosureFilters} onFiltersChange={setDisclosureFilters}/>,
    outlook: <CompanyOutlook/>,
  }

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
      <div className="company-connection"><Info size={16} aria-hidden="true"/>기업정보 데이터 연결 준비 중</div>
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
