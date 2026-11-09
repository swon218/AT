import { ChartNoAxesCombined } from 'lucide-react'
import { CompanyCard, CompanyDataStatus, CompanyDataTable, CompanyMetadata, CompanyTableRegion, CompanyValues } from './CompanyAnalysisDisplay'

const incomeMetrics = ['매출액', '영업이익', '순이익']
const revenueMix = ['사업부별 매출 구성', '지역별 매출 구성']
const financialGroups = [
  { title: '손익 및 성장', metrics: incomeMetrics.flatMap(label => [label, `${label} 전년 동기 대비`]) },
  { title: '수익성', metrics: ['영업이익률', 'ROE'] },
  { title: '재무상태', metrics: ['자산', '부채', '자본', '현금성자산', '차입금'] },
  { title: '현금흐름', metrics: ['영업현금흐름', '설비투자', '잉여현금흐름'] },
]
const disclosureTypes = ['전체', '정기보고서', '실적', '증자·사채', '지분', '자사주', '기타']
const businessTopics = [
  '주요 사업과 제품', ...revenueMix, '수주잔고', '주요 계약',
  '생산능력', '설비투자', '연구개발비', '신규 사업',
]

function DisclosureTable({ label }) {
  return <CompanyDataTable label={label} columns={['공시일', '제목', '유형', '정정 여부', '원문']}
    message="공시 데이터 연결 준비 중"/>
}

export function CompanyOverview() {
  return <div className="company-section">
    <div className="company-grid company-grid-two">
      <CompanyCard title="기업 소개">
        <CompanyValues labels={['기업 소개', '주요 제품·서비스', ...revenueMix]}/>
      </CompanyCard>
      <CompanyCard title="최근 주요 공시"><DisclosureTable label="최근 주요 공시"/></CompanyCard>
    </div>
    <div className="company-grid company-grid-three">
      <CompanyCard title="핵심 실적"><CompanyValues labels={incomeMetrics}/></CompanyCard>
      <CompanyCard title="재무 요약"><CompanyValues labels={['현금성자산', '차입금', '영업현금흐름']}/></CompanyCard>
      <CompanyCard title="가치평가"><CompanyValues labels={['시가총액', 'PER', 'PBR', '배당수익률']}/></CompanyCard>
    </div>
  </div>
}

function FinancialChoice({ label, name, options, value, onChange }) {
  return <fieldset className="company-choice">
    <legend>{label}</legend>
    <div>{options.map(([id, text]) => <label key={id}>
      <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)}/>
      <span>{text}</span>
    </label>)}</div>
  </fieldset>
}

function FinancialTable({ periodLabel, annual }) {
  const count = annual ? 5 : 8
  const unit = annual ? '년' : '분기'
  const periods = Array.from({ length: count }, (_, index) => {
    const offset = count - index - 1
    return offset ? `${offset}${unit} 전` : annual ? '최근 연도' : '최근 분기'
  })
  return <CompanyTableRegion label={`${periodLabel} 재무 지표`}>
    <thead><tr><th scope="col">항목</th>{periods.map(period => <th key={period} scope="col">{period}</th>)}</tr></thead>
    {financialGroups.map(({ title, metrics }) => <tbody key={title}>
      <tr className="company-table-group"><th scope="rowgroup" colSpan={count + 1}>{title}</th></tr>
      {metrics.map(metric => <tr key={metric}>
        <th scope="row">{metric}</th>{periods.map(period => <td key={period}>—</td>)}
      </tr>)}
    </tbody>)}
  </CompanyTableRegion>
}

export function FinancialResults({ frequency, scope, onFrequencyChange, onScopeChange }) {
  const annual = frequency === 'annual'
  const periodLabel = annual ? '최근 5년' : '최근 8개 분기'
  const scopeLabel = scope === 'consolidated' ? '연결' : '별도'
  return <div className="company-section">
    <CompanyCard title="실적 추이">
      <div className="company-filters">
        <FinancialChoice label="기간" name="company-financial-frequency" value={frequency} onChange={onFrequencyChange}
          options={[[ 'annual', '연간' ], [ 'quarterly', '분기' ]]}/>
        <FinancialChoice label="재무제표" name="company-financial-scope" value={scope} onChange={onScopeChange}
          options={[[ 'consolidated', '연결' ], [ 'separate', '별도' ]]}/>
      </div>
      <div className="company-chart-placeholder" aria-label="실적 추이 차트 영역">
        <ChartNoAxesCombined size={28} aria-hidden="true"/>
        <strong>{periodLabel} · {scopeLabel}</strong>
        <CompanyDataStatus message="데이터 연결 후 실적 추이를 확인할 수 있습니다."/>
      </div>
    </CompanyCard>
    <CompanyCard title="재무 지표">
      <CompanyMetadata fields={{ '보기 범위': periodLabel, 구분: scopeLabel, 보고기간: null, 통화: null, '금액 단위': null, '수집 시각': null, 출처: null }}/>
      <FinancialTable periodLabel={periodLabel} annual={annual}/>
    </CompanyCard>
  </div>
}

export function BusinessGrowth() {
  return <CompanyCard title="사업 구성과 성장 활동">
    <p className="company-copy">사업별 매출 비중과 주요 활동을 기준일 및 근거 보고서와 함께 확인하는 영역입니다.</p>
    <CompanyTableRegion label="사업·성장 항목">
      <thead><tr>{['항목', '내용', '기준일', '근거 보고서'].map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{businessTopics.map(topic => <tr key={topic}><th scope="row">{topic}</th><td>—</td><td>—</td><td>—</td></tr>)}</tbody>
    </CompanyTableRegion>
  </CompanyCard>
}

export function ShareholdersDividends() {
  return <div className="company-section">
    <div className="company-grid company-grid-two">
      <CompanyCard title="주주 구성"><CompanyValues labels={['최대주주', '주요 주주', '지분 변동']}/></CompanyCard>
      <CompanyCard title="배당 요약">
        <CompanyValues labels={['주당배당금', '배당수익률']}/>
        <CompanyMetadata fields={{ '배당 기준일': null, '주가 기준일': null }}/>
      </CompanyCard>
      <CompanyCard title="배당 이력">
        <CompanyDataTable label="배당 이력" columns={['보고기간', '주당배당금', '배당 기준일', '출처']}/>
      </CompanyCard>
      <CompanyCard title="자사주 변동">
        <CompanyDataTable label="자사주 취득·처분·소각" columns={['공시일', '취득·처분·소각', '주식 수', '출처']}/>
      </CompanyCard>
    </div>
  </div>
}

function openDatePicker(event) {
  try { event.currentTarget.showPicker?.() } catch { /* The native date input remains usable. */ }
}

export function DisclosuresRisk({ filters, onFiltersChange }) {
  const update = (field, value) => onFiltersChange(previous => ({ ...previous, [field]: value }))
  return <div className="company-section">
    <CompanyCard title="공시 목록">
      <div className="company-filters">
        <label>시작일<input type="date" value={filters.start} max={filters.end || undefined} onInput={event => update('start', event.currentTarget.value)} onClick={openDatePicker}/></label>
        <label>종료일<input type="date" value={filters.end} min={filters.start || undefined} onInput={event => update('end', event.currentTarget.value)} onClick={openDatePicker}/></label>
        <label>공시 유형<select value={filters.type} onChange={event => update('type', event.target.value)}>
          {disclosureTypes.map(type => <option key={type} value={type === '전체' ? 'all' : type}>{type}</option>)}
        </select></label>
        <button className="company-query" type="button" aria-describedby="company-disclosure-help" disabled>조회</button>
      </div>
      <p className="company-copy" id="company-disclosure-help">공시 데이터가 연결되면 선택한 조건으로 조회할 수 있습니다.</p>
      <DisclosureTable label="선택 기업 공시 목록"/>
    </CompanyCard>
    <CompanyCard title="주요 확인 사항"><CompanyValues labels={['감사의견', '소송', '자금조달']}/></CompanyCard>
  </div>
}

export function CompanyOutlook() {
  return <div className="company-section">
    <div className="company-grid company-grid-three">
      <CompanyCard title="확정 실적">
        <p className="company-copy">발표된 실적</p>
        <CompanyValues labels={incomeMetrics}/>
      </CompanyCard>
      <CompanyCard title="회사 전망">
        <p className="company-copy">기업이 공식적으로 발표한 계획과 전망</p>
        <CompanyValues labels={['공식 사업계획', '공식 실적 전망']}/>
      </CompanyCard>
      <CompanyCard title="외부 실적 추정치 · 컨센서스">
        <p className="company-copy">외부 기관의 추정치</p>
        <CompanyValues labels={['실적 추정치', '컨센서스 기준일']}/>
      </CompanyCard>
    </div>
    <CompanyCard title="기업 IR 자료">
      <CompanyDataTable label="기업 IR 자료" columns={['발표일', '자료명', '보고기간', '수집 시각', '출처']}/>
    </CompanyCard>
  </div>
}
