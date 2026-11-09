import { ChartNoAxesCombined } from 'lucide-react'
import { CompanyCard, CompanyDataStatus, CompanyDataTable, CompanyMetadata, CompanyTableRegion, CompanyValues } from './CompanyAnalysisDisplay'

const incomeMetrics = ['매출액', '영업이익', '순이익']
const revenueMix = ['사업부별 매출 구성', '지역별 매출 구성']
const financialGroups = [
  { title: '손익 및 성장', metrics: ['sales', 'operating', 'net'].flatMap((metric, index) =>
    [[metric, incomeMetrics[index]], [`${metric}Growth`, `${incomeMetrics[index]} 전년 동기 대비`]]) },
  { title: '수익성', metrics: [['margin', '영업이익률'], ['roe', 'ROE']] },
  { title: '재무상태', metrics: [['assets', '자산'], ['liabilities', '부채'], ['equity', '자본'], ['cash', '현금성자산'], ['borrowings', '차입금']] },
  { title: '현금흐름', metrics: [['operatingCash', '영업현금흐름'], ['capex', '설비투자'], ['freeCash', '잉여현금흐름']] },
]
const disclosureTypes = { all: '전체', periodic: '정기보고서', results: '실적', finance: '증자·사채', ownership: '지분', treasury: '자사주', other: '기타' }
const businessTopics = [
  ['summary', '사업의 개요'], ['products', '주요 제품·서비스'], [null, revenueMix[0]], [null, revenueMix[1]],
  ['orders', '매출 및 수주 상황'], ['research', '주요 계약과 연구개발'], [null, '생산능력'], [null, '설비투자'], [null, '신규 사업'],
]

function amount(value) {
  if (value == null) return '—'
  const [whole, fraction] = String(value).split('.')
  const formatted = BigInt(whole.replace(/^-/, '')).toLocaleString('ko-KR')
  return (whole.startsWith('-') ? '−' : '') + formatted + (fraction ? `.${fraction}` : '')
}
const ratio = value => value == null ? '—' : `${value}%`
const relativeMetric = key => /Growth$|^(margin|roe)$/.test(key)
const shown = value => value ?? '—'
const incomeValues = period => Object.fromEntries(['sales', 'operating', 'net'].map((key, index) =>
  [incomeMetrics[index], amount(period?.values[key])]))

function Source({ receipt, label = 'DART 원문' }) {
  if (!/^\d{14}$/.test(receipt ?? '')) return '—'
  return <a href={`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`} target="_blank" rel="noreferrer">{label}</a>
}

function Rows({ label, columns, items, render, emptyMessage = '확인된 자료가 없습니다.' }) {
  const status = items === undefined ? 'disconnected' : items.length ? 'ready' : 'empty'
  return <CompanyDataTable label={label} columns={columns} status={status}
    message={status === 'empty' ? emptyMessage : '조회 결과가 준비되면 표시합니다.'}>
    {items?.map(render)}
  </CompanyDataTable>
}

function DisclosureTable({ label, items, emptyMessage }) {
  return <Rows label={label} items={items} emptyMessage={emptyMessage}
    columns={['공시일', '제목', '유형', '정정 여부', '원문']} render={row => <tr key={row.receipt}>
      <td>{row.filedOn}</td><td>{row.title}</td><td>{disclosureTypes[row.type]}</td>
      <td>{row.corrected ? '정정' : '—'}</td><td><Source receipt={row.receipt}/></td>
    </tr>}/>
}

function PeriodSource({ period }) {
  return period && <CompanyMetadata fields={{ 보고기간: period.end, 공시일: period.filedOn, 구분: period.scope === 'CFS' ? '연결' : '별도',
    통화: period.currency, '금액 단위': period.unit, '수집 시각': period.collectedAt &&
      new Date(period.collectedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), 출처: <Source receipt={period.receipt}/> }}/>
}

export function CompanyOverview({ data }) {
  const profile = data?.company
  const latest = data?.latest
  return <div className="company-section">
    <div className="company-grid company-grid-two">
      <CompanyCard title="기업 소개">
        <CompanyValues labels={['정식 명칭', '영문 명칭', '대표자', '설립일', '시장', '결산월']} values={{
          '정식 명칭': profile?.name, '영문 명칭': profile?.englishName, 대표자: profile?.ceo,
          설립일: profile?.established, 시장: profile?.market, 결산월: profile?.fiscalMonth && `${profile.fiscalMonth}월`,
        }}/>
        {data?.annualReport && <p className="company-copy">사업과 주요 제품은 <Source receipt={data.annualReport.receipt} label="사업보고서"/>에서 확인할 수 있습니다.</p>}
      </CompanyCard>
      <CompanyCard title="최근 주요 공시"><DisclosureTable label="최근 주요 공시" items={data?.recent}/></CompanyCard>
    </div>
    <div className="company-grid company-grid-three">
      <CompanyCard title="핵심 실적"><PeriodSource period={latest}/><CompanyValues labels={incomeMetrics} values={incomeValues(latest)}/></CompanyCard>
      <CompanyCard title="재무 요약"><PeriodSource period={latest}/><CompanyValues labels={['현금성자산', '차입금', '영업현금흐름']} values={{
        현금성자산: amount(latest?.values.cash), 차입금: amount(latest?.values.borrowings), 영업현금흐름: amount(latest?.values.operatingCash),
      }}/></CompanyCard>
      <CompanyCard title="가치평가">
        <CompanyValues labels={['시가총액', 'PER', 'PBR', '배당수익률']}/>
        <p className="company-copy">현재 주가 및 종목별 주식 수 등 별도 데이터 연결이 필요합니다.</p>
      </CompanyCard>
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

function FinancialTable({ periodLabel, periods }) {
  return <CompanyTableRegion label={`${periodLabel} 재무 지표`}>
    <thead><tr><th scope="col">항목</th>{periods.map((period, index) => <th key={period?.end ?? index} scope="col">
      {period ? <>{period.year}{period.quarter ? ` Q${period.quarter}` : ''}<small>{period.end} · {shown(period.currency)}</small>
        <Source receipt={period.receipt} label={period.corrected ? '정정 공시' : '공시'}/>
        <small>{period.collectedAt ? new Date(period.collectedAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—'} 수집</small></> : '미제공'}
    </th>)}</tr></thead>
    {financialGroups.map(({ title, metrics }) => <tbody key={title}>
      <tr className="company-table-group"><th scope="rowgroup" colSpan={periods.length + 1}>{title}</th></tr>
      {metrics.map(([key, label]) => <tr key={key}>
        <th scope="row">{label}</th>{periods.map((period, index) => <td key={period?.end ?? index}
          title={period?.reasons[key] ?? period?.accounts[key]}>
          {relativeMetric(key) ? ratio(period?.values[key]) : amount(period?.values[key])}
        </td>)}
      </tr>)}
    </tbody>)}
  </CompanyTableRegion>
}

function FinancialTrend({ periods, periodLabel, scopeLabel, ready }) {
  const keys = ['sales', 'operating', 'net']
  const currencies = new Set(periods.filter(period => period?.currency).map(period => period.currency))
  const values = periods.flatMap(period => keys.flatMap(key => period?.values[key] == null ? [] : [Number(period.values[key])]))
  if (!values.length || currencies.size !== 1 || values.some(value => !Number.isFinite(value))) return (
    <div className="company-chart-placeholder" aria-label="실적 추이 차트 영역">
      <ChartNoAxesCombined size={28} aria-hidden="true"/>
      <strong>{periodLabel} · {scopeLabel}</strong>
      <CompanyDataStatus status={ready ? 'empty' : 'disconnected'} message={ready ? '동일 통화로 확인할 수 있는 실적이 없습니다.' : '조회 결과가 준비되면 표시합니다.'}/>
    </div>
  )
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const x = index => 36 + 544 * index / Math.max(1, periods.length - 1)
  const y = value => 145 - 120 * (value - min) / (max - min || 1)
  return <figure className="company-trend">
    <figcaption>{periodLabel} · {scopeLabel} · {[...currencies][0]}</figcaption>
    <svg viewBox="0 0 620 175" role="img" aria-label="매출액, 영업이익, 순이익 추이. 정확한 금액과 출처는 아래 표에서 확인할 수 있습니다.">
      <line className="company-zero-axis" x1="36" x2="580" y1={y(0)} y2={y(0)}/>
      {keys.map(key => {
        let connected = false
        const path = periods.map((period, index) => {
          const value = period?.values[key]
          if (value == null) { connected = false; return '' }
          const command = connected ? 'L' : 'M'
          connected = true
          return `${command}${x(index)},${y(Number(value))}`
        }).join(' ')
        return <g key={key} className={`company-series ${key}`}>
          <path d={path}/>
          {periods.map((period, index) => period?.values[key] != null && <circle key={period.end} cx={x(index)} cy={y(Number(period.values[key]))} r="3.5">
            <title>{period.end} {amount(period.values[key])}</title>
          </circle>)}
        </g>
      })}
      {periods.map((period, index) => period && <text key={period.end} x={x(index)} y="166" textAnchor="middle">{period.year}{period.quarter ? ` Q${period.quarter}` : ''}</text>)}
    </svg>
    <div className="company-trend-legend">{keys.map((key, index) => <span key={key} className={`company-series ${key}`}>{incomeMetrics[index]}</span>)}</div>
  </figure>
}

export function FinancialResults({ frequency, scope, onFrequencyChange, onScopeChange, data }) {
  const annual = frequency === 'annual'
  const periodLabel = annual ? '최근 5년' : '최근 8개 분기'
  const scopeLabel = scope === 'consolidated' ? '연결' : '별도'
  const reported = data?.[frequency] ?? []
  const chronological = [...Array((annual ? 5 : 8) - reported.length).fill(null), ...reported.slice().reverse()]
  return <div className="company-section">
    <CompanyCard title="실적 추이">
      <div className="company-filters">
        <FinancialChoice label="기간" name="company-financial-frequency" value={frequency} onChange={onFrequencyChange}
          options={[[ 'annual', '연간' ], [ 'quarterly', '분기' ]]}/>
        <FinancialChoice label="재무제표" name="company-financial-scope" value={scope} onChange={onScopeChange}
          options={[[ 'consolidated', '연결' ], [ 'separate', '별도' ]]}/>
      </div>
      <FinancialTrend periods={chronological} periodLabel={periodLabel} scopeLabel={scopeLabel} ready={Boolean(data)}/>
    </CompanyCard>
    <CompanyCard title="재무 지표">
      <CompanyMetadata fields={{ '보기 범위': periodLabel, 구분: scopeLabel, '금액 단위': '표시 통화의 기본 단위', 출처: 'Open DART' }}/>
      <p className="company-copy">영업이익률은 영업이익 ÷ 매출액, 연간 ROE는 전체 순이익 ÷ 기초·기말 평균 총자본입니다. 설비투자는 유형자산 취득 현금 유출, 잉여현금흐름은 영업현금흐름에서 이를 차감한 값입니다.</p>
      <p className="company-copy">전년 동기 금액이 0 이하이거나 비교 기준이 확인되지 않으면 증가율을 비웁니다. 누적 차감의 회계기준을 확인하지 못한 4분기 손익과 분기 현금흐름은 미제공입니다.</p>
      <FinancialTable periodLabel={periodLabel} periods={chronological}/>
    </CompanyCard>
  </div>
}

export function BusinessGrowth({ data, checkedAt }) {
  return <CompanyCard title="사업 구성과 성장 활동">
    <p className="company-copy">사업별 매출 비중과 주요 활동을 기준일 및 근거 보고서와 함께 확인하는 영역입니다.</p>
    {data?.report && <CompanyMetadata fields={{ 보고기간: data.report.periodEnd, 공시일: data.report.filedOn,
      '수집 시각': checkedAt && new Date(checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), 출처: <Source receipt={data.report.receipt}/> }}/>}
    <CompanyTableRegion label="사업·성장 항목">
      <thead><tr>{['항목', '내용', '기준일', '근거 보고서'].map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{businessTopics.map(([id, topic]) => <tr key={topic}><th scope="row">{topic}</th>
        <td className="company-excerpt">{data?.sections[id]?.excerpt ?? '미확인'}</td>
        <td>{shown(data?.report?.periodEnd)}</td><td><Source receipt={data?.report?.receipt}/></td>
      </tr>)}</tbody>
    </CompanyTableRegion>
  </CompanyCard>
}

export function ShareholdersDividends({ data }) {
  return <div className="company-section">
    <div className="company-grid company-grid-two">
      <CompanyCard title="최대주주 및 특수관계인">
        <Rows label="최대주주 및 특수관계인" columns={['보고기간', '이름', '관계', '주식 종류', '기초 지분율', '기말 지분율', '출처']}
          items={data?.holders} render={(row, index) => <tr key={`${row.receipt}:${row.name}:${index}`}>
            <td>{row.periodEnd}</td><td>{row.name}</td><td>{row.relation}</td><td>{shown(row.shareClass)}</td>
            <td>{ratio(row.beginning)}</td><td>{ratio(row.ending)}</td><td><Source receipt={row.receipt}/></td>
          </tr>}/>
      </CompanyCard>
      <CompanyCard title="주요 지분 공시">
        <p className="company-copy">공시된 보유비율 변동에는 거래 외 사유도 포함될 수 있습니다.</p>
        <Rows label="대량보유 상황보고" columns={['공시일', '대표보고자', '보유비율', '증감(%p)', '보고 사유', '출처']}
          items={data?.ownership} render={row => <tr key={row.receipt}>
            <td>{row.filedOn}</td><td>{shown(row.name)}</td><td>{ratio(row.ratio)}</td>
            <td>{shown(row.change)}</td><td>{shown(row.reason)}</td><td><Source receipt={row.receipt}/></td>
          </tr>}/>
      </CompanyCard>
      <CompanyCard title="연간 현금배당 이력">
        <p className="company-copy">주식 종류별 공시 금액입니다. 실제 배당 기준일은 원문에서 확인할 수 있습니다. 현재 배당수익률은 주가와 주가 기준일이 필요합니다.</p>
        <Rows label="배당 이력" columns={['보고기간', '주식 종류', '주당 현금배당금(원)', '결산기준일', '출처']}
          items={data?.dividends} render={(row, index) => <tr key={`${row.receipt}:${row.shareClass}:${index}`}>
            <td>{row.periodEnd}</td><td>{row.shareClass}</td><td>{amount(row.amount)}</td>
            <td>{shown(row.settlementOn)}</td><td><Source receipt={row.receipt}/></td>
          </tr>}/>
      </CompanyCard>
      <CompanyCard title="자사주 관련 공시">
        <p className="company-copy">결정과 이행 결과는 공시 제목과 원문으로 구분합니다.</p>
        <DisclosureTable label="자사주 취득·처분·소각" items={data?.treasury}/>
      </CompanyCard>
    </div>
  </div>
}

function openDatePicker(event) {
  try { event.currentTarget.showPicker?.() } catch { /* The native date input remains usable. */ }
}

export function DisclosuresRisk({ filters, onFiltersChange, query, onQuery, queryError, data, risk, disabled, onPage }) {
  const update = (field, value) => onFiltersChange(previous => ({ ...previous, [field]: value }))
  return <div className="company-section">
    <CompanyCard title="공시 목록">
      <form className="company-filters" onSubmit={onQuery}>
        <label>시작일<input type="date" value={filters.start} max={filters.end || undefined} onInput={event => update('start', event.currentTarget.value)} onClick={openDatePicker}/></label>
        <label>종료일<input type="date" value={filters.end} min={filters.start || undefined} onInput={event => update('end', event.currentTarget.value)} onClick={openDatePicker}/></label>
        <label>공시 유형<select value={filters.type} onChange={event => update('type', event.target.value)}>
          {Object.entries(disclosureTypes).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select></label>
        <button className="company-query" type="submit" disabled={disabled}>조회</button>
      </form>
      {queryError && <p className="company-data-status error" role="alert">{queryError}</p>}
      <p className="company-copy">적용 범위 {query.start} ~ {query.end} · {disclosureTypes[query.type]} · {query.page}페이지</p>
      <p className="company-copy">DART의 최종 공시를 30건씩 가져옵니다. 유형은 각 페이지의 제목을 기준으로 분류합니다.</p>
      <DisclosureTable label="선택 기업 공시 목록" items={data?.items}
        emptyMessage={data?.hasNext || query.page > 1 ? '이 페이지에 조건과 일치하는 공시가 없습니다.' : '선택 조건에 해당하는 공시가 없습니다.'}/>
      {(data || query.page > 1) && <div className="company-page-buttons">
        <button className="company-query" type="button" disabled={query.page === 1} onClick={() => onPage(query.page - 1)}>이전 페이지</button>
        <button className="company-query" type="button" disabled={!data?.hasNext} onClick={() => onPage(query.page + 1)}>다음 페이지</button>
        {data && <span>전체 유형 {data.total.toLocaleString('ko-KR')}건 · {query.page} / {Math.min(data.pages || 1, 100)}페이지</span>}
        {data?.pageLimitReached && <span>100페이지까지 볼 수 있습니다. 기간을 좁혀 나머지를 검색해 주세요.</span>}
      </div>}
    </CompanyCard>
    <CompanyCard title="주요 확인 사항">
      <Rows label="감사의견" columns={['보고기간', '감사인', '감사의견', '출처']} items={risk?.auditor}
        render={(row, index) => <tr key={`${row.receipt}:${index}`}><td>{row.periodEnd}</td><td>{shown(row.name)}</td><td>{row.opinion}</td><td><Source receipt={row.receipt}/></td></tr>}/>
      <p className="company-copy company-risk-caption">최근 소송·자금조달 관련 공시</p>
      <DisclosureTable label="소송·자금조달 관련 공시" items={risk?.risk}/>
    </CompanyCard>
  </div>
}

export function CompanyOutlook({ data, latest }) {
  return <div className="company-section">
    <div className="company-grid company-grid-two">
      <CompanyCard title="확정 실적">
        <PeriodSource period={latest}/>
        <CompanyValues labels={incomeMetrics} values={incomeValues(latest)}/>
      </CompanyCard>
      <CompanyCard title="외부 실적 추정치 · 컨센서스">
        <p className="company-copy">컨센서스와 목표주가는 별도 데이터 연결이 필요합니다.</p>
      </CompanyCard>
    </div>
    <CompanyCard title="회사 전망 공시">
      <p className="company-copy">회사 공식 전망의 발표일과 원문입니다. {data?.coverage}</p>
      <DisclosureTable label="회사 전망 공시" items={data?.forecasts}/>
    </CompanyCard>
    <CompanyCard title="기업 IR 공시">
      <p className="company-copy">DART에서 확인한 기업설명회 공시입니다. 기업의 전체 IR 자료는 별도 연결이 필요합니다.</p>
      <DisclosureTable label="기업 IR 공시" items={data?.ir}/>
    </CompanyCard>
  </div>
}
