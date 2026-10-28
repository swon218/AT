import { useEffect, useState } from 'react'
import { ArrowRight, Bot, ChevronLeft, ChevronRight, Database, Filter, Plus, RotateCcw, Search, Trash2 } from 'lucide-react'
import { condition, constant, defaultQuery, describeQuery, isPrice, metric, metricNames, operators, presets, relative } from '../utils/screener'
import './ScreenerWorkspace.css'

function MetricEditor({ value, onChange, label }) {
  const update = (name, v) => onChange({ ...value, [name]: Number(v) })
  return <div className="screen-metric"><label>{label}<select aria-label={label} value={value.name} onChange={e => onChange(metric(e.target.value))}>{Object.entries(metricNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
    {!isPrice(value.name) && <div className="screen-params"><label>{value.name.startsWith('macd') ? '단기' : '기간'}<input aria-label={`${label} 기간`} type="number" min="1" max="500" required value={value.period} onChange={e => update('period', e.target.value)}/></label>
      {value.name.startsWith('macd') && <><label>장기<input aria-label={`${label} 장기`} type="number" min="2" max="500" required value={value.slow} onChange={e => update('slow', e.target.value)}/></label><label>시그널<input aria-label={`${label} 시그널`} type="number" min="1" max="100" required value={value.signal} onChange={e => update('signal', e.target.value)}/></label></>}
      {value.name.startsWith('bb_') && <label>표준편차 배수<input aria-label={`${label} 표준편차 배수`} type="number" min="0.1" max="10" step="0.1" required value={value.multiplier} onChange={e => update('multiplier', e.target.value)}/></label>}
    </div>}
  </div>
}
const reasons = { quarantined_ohlc: '품질 격리', insufficient_warmup: '계산 이력 부족', missing_sessions: '거래일 누락', stale_data: '최신 일봉 미수집', quality_records_missing: '품질 이력 누락', quality_unavailable: '품질 검증 불가', unsupported_source: '지원하지 않는 출처', indicator_unavailable: '지표 계산 불가', invalid_ohlc: 'OHLC 오류', invalid_volume: '거래량 오류' }
const number = n => Number.isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) : '—'

export default function ScreenerWorkspace({ screen, onOpenLab, onAskAgent, agentReady }) {
  const { query: q, edit, result, meta, busy, error, search, stop, loadMeta } = screen
  const [expanded, setExpanded] = useState(null)
  const [handoffError, setHandoffError] = useState('')
  useEffect(() => { void loadMeta() }, [])
  const update = patch => edit({ ...q, ...patch })
  const change = (i, patch) => update({ conditions: q.conditions.map((c, index) => index === i ? { ...c, ...patch } : c) })
  const cov = result?.coverage
  const excluded = cov ? Object.values(cov.excluded).reduce((a, b) => a + b, 0) : 0
  const pages = cov ? Math.max(1, Math.ceil(cov.matches / cov.page_size)) : 1
  return <section className="screen-workspace" aria-label="조건 검색">
    <header className="screen-heading"><div><span className="screen-eyebrow"><Filter size={14}/> STOCK SCREENER</span><h1>조건 검색 <span>일봉</span></h1><p>조건을 조합해 종목을 찾고, 같은 조건을 AI와 살펴보세요.</p></div><div className="screen-data-badge"><Database size={18}/><span>실험실 공통 데이터<small>{meta?.universe !== undefined ? `${number(meta.universe)}종목 · 최근 수집 일봉 ${meta.latest_bar || '없음'}` : meta?.unavailable ? '서버 연결 확인 필요' : '수집 상태 확인 중'}</small></span><button type="button" aria-label="데이터 상태 새로고침" onClick={loadMeta}><RotateCcw size={14}/></button></div></header>
    <div className="screen-layout"><form className="screen-builder" onSubmit={e => { e.preventDefault(); setExpanded(null); void search() }}>
      <div className="screen-panel-title"><h2>검색 조건</h2><button type="button" className="screen-text-button" onClick={() => edit(defaultQuery())}><RotateCcw size={13}/>초기화</button></div>
      <label className="screen-field-label">시장<select aria-label="검색 시장" value={q.market} onChange={e => update({ market: e.target.value })}><option value="ALL">코스피 + 코스닥</option><option value="KOSPI">코스피</option><option value="KOSDAQ">코스닥</option></select></label>
      <div className="screen-presets"><span>빠르게 시작</span><div>{presets.map(p => <button type="button" key={p.label} onClick={() => update({ conditions: [p.condition()] })}>{p.label}</button>)}</div></div>
      <div className="screen-match"><strong>조건 연결</strong><div>{[['all', '모두 충족 (AND)'], ['any', '하나 이상 (OR)']].map(([id, label]) => <button type="button" aria-pressed={q.match === id} key={id} onClick={() => update({ match: id })}>{label}</button>)}</div></div>
      <div className="screen-conditions">{q.conditions.map((c, i) => <fieldset className="screen-condition" key={i}><legend>조건 {i + 1}</legend><button type="button" className="screen-remove" disabled={q.conditions.length === 1} aria-label={`조건 ${i + 1} 삭제`} onClick={() => update({ conditions: q.conditions.filter((_, n) => n !== i) })}><Trash2 size={14}/></button>
        <MetricEditor value={c.left} label={`조건 ${i + 1} 지표`} onChange={left => change(i, { left })}/>
        <label className="screen-field-label">비교<select aria-label={`조건 ${i + 1} 비교`} value={c.operator} onChange={e => change(i, { operator: e.target.value })}>{Object.entries(operators).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
        <div className="screen-operand-toggle">{[['constant', '숫자와 비교'], ['metric', '지표와 비교']].map(([id, label]) => <button type="button" aria-pressed={c.right.kind === id} key={id} onClick={() => change(i, { right: id === 'constant' ? constant(0) : relative() })}>{label}</button>)}</div>
        {c.right.kind === 'constant' ? <label className="screen-field-label">기준값<input aria-label={`조건 ${i + 1} 기준값`} type="number" min="-1000000000000" max="1000000000000" step="any" required value={c.right.value} onChange={e => change(i, { right: constant(Number(e.target.value)) })}/></label> : <><MetricEditor value={c.right.metric} label={`조건 ${i + 1} 비교 지표`} onChange={m => change(i, { right: { ...c.right, metric: m } })}/><label className="screen-scale">비교 지표의 배수<input aria-label={`조건 ${i + 1} 배수`} type="number" min="0.01" max="1000" step="any" required value={c.right.factor} onChange={e => change(i, { right: { ...c.right, factor: Number(e.target.value) } })}/><small>1 = 같은 값 · 2 = 2배</small></label></>}
      </fieldset>)}</div>
      <button type="button" className="screen-add" disabled={q.conditions.length >= 8} onClick={() => update({ conditions: [...q.conditions, condition()] })}><Plus size={15}/>조건 추가 <small>{q.conditions.length}/8</small></button>
      <div className="screen-search-actions"><button type="submit" className="screen-primary" disabled={busy}><Search size={17}/>{busy ? '종목 확인 중…' : '조건 검색'}</button>{busy && <button type="button" onClick={stop}>중지</button>}</div>
      <p className="screen-builder-note">확정 일봉으로 계산합니다. 하단 터치는 해당 일봉의 저가 ≤ 하단 밴드, 돌파는 이전·최근 일봉의 교차를 뜻합니다.</p>
    </form>
    <div className="screen-results"><div className="screen-panel-title"><h2>검색 결과 {cov && <span>{number(cov.matches)}종목</span>}</h2><label className="screen-sort">정렬<select aria-label="결과 정렬" value={q.sort} onChange={e => update({ sort: e.target.value })}><option value="code_asc">종목코드 순</option><option value="close_desc">종가 높은 순</option></select></label></div>
      {error && <p className="screen-error" role="alert">{error}</p>}
      {meta && !meta.unavailable && (!meta.quality_ready || meta.latest_bar !== meta.cutoff) && <p className="screen-notice">{!meta.quality_ready ? '품질 검증 데이터가 준비되지 않았습니다.' : `검색 기준일 ${meta.cutoff} · 최근 수집 ${meta.latest_bar || '없음'}. 최신 일봉이 없는 종목은 제외됩니다.`}</p>}
      {result ? <>
        <div className="screen-result-summary"><span className="screen-result-date">{result.as_of} 확정 일봉</span><p>{describeQuery(result.query)}</p><div><span>{number(cov.scanned)} / {number(cov.universe)}종목 확인</span><span>계산 가능 {number(cov.valid)} · 제외 {number(excluded)}</span></div><progress aria-label="종목 확인 진행률" value={cov.scanned} max={cov.universe || 1}/>
          {!!cov.not_scanned && <p className="screen-notice">아직 {number(cov.not_scanned)}종목을 확인하지 못했습니다. 현재 결과는 일부 범위입니다.{!busy && <button type="button" onClick={() => search(result.query)}>이어서 검색</button>}</p>}
          {excluded > 0 && <details><summary>제외 사유 보기</summary>{Object.entries(cov.excluded).map(([reason, count]) => <p key={reason}>{reasons[reason] || reason} · {number(count)}종목</p>)}</details>}
        </div>
        <div className="screen-table-wrap"><table className="screen-table"><thead><tr><th>종목</th>{result.columns.map(c => <th key={c.key}>{c.label}</th>)}<th>확인</th></tr></thead><tbody>{result.items.map(row => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.code} · {row.market}</small></td>{result.columns.map(c => <td key={c.key}>{number(row.values[c.key])}</td>)}<td><button type="button" aria-expanded={expanded === row.code} onClick={() => setExpanded(expanded === row.code ? null : row.code)}>조건 값</button><button type="button" onClick={() => onOpenLab(row)}>차트 <ArrowRight size={12}/></button></td></tr>)}</tbody></table></div>
        {!result.items.length && <div className="screen-empty"><Search size={28}/><h3>{cov.not_scanned ? '확인한 범위에 일치 종목이 없습니다' : cov.valid === 0 ? '조건을 계산할 수 있는 종목이 없습니다' : '조건을 충족하는 종목이 없습니다'}</h3><p>{cov.valid === 0 ? '최신 일봉과 품질 제외 사유를 확인해 주세요.' : '기준값이나 조건의 연결 방식을 조정해 보세요.'}</p></div>}
        {expanded && result.items.filter(r => r.code === expanded).map(row => <div className="screen-checks" key={row.code}><strong>{row.name} · 조건별 실제 값</strong>{row.checks.map((check, i) => <p key={i}><span className={check.matched ? 'screen-pass' : ''}>{check.matched ? '충족' : '미충족'}</span>{check.label}<small>최근 {number(check.left)} / 기준 {number(check.right)}{result.query.conditions[i].operator.startsWith('crosses_') ? ` · 이전 ${number(check.previous_left)} / ${number(check.previous_right)}` : ''}</small></p>)}</div>)}
        <div className="screen-pagination"><span>{cov.page} / {pages}페이지</span><button type="button" aria-label="이전 결과" disabled={busy || !!cov.not_scanned || cov.page <= 1} onClick={() => search({ ...result.query, page: cov.page - 1 })}><ChevronLeft size={16}/></button><button type="button" aria-label="다음 결과" disabled={busy || !!cov.not_scanned || cov.page >= pages} onClick={() => search({ ...result.query, page: cov.page + 1 })}><ChevronRight size={16}/></button></div>
        <p className="screen-source">출처: {result.source} · 계산: {cov.calculation_version}<br/>조회 {cov.data_read_at} · 지표 수치는 표시할 때만 반올림합니다.</p>
      </> : <div className="screen-empty screen-start"><span className="screen-empty-icon"><Filter size={30}/></span><h3>어떤 조건의 종목을 찾으시나요?</h3><p>왼쪽에서 지표와 기준값을 선택해 검색하세요.<br/>RSI, 볼린저밴드, 이동평균선과 거래량을 함께 비교할 수 있습니다.</p><div className="screen-example">예시 <span>RSI(14) ≤ 30</span><span>AND</span><span>종가 &lt; SMA(20)</span></div></div>}
      <div className="screen-ai-card"><span className="screen-ai-icon"><Bot size={23}/></span><div><strong>찾은 조건을 AI와 이어서 살펴보세요</strong><p>같은 검색 엔진을 사용합니다. 질문을 작성한 뒤 직접 전송할 수 있습니다.</p></div><button type="button" disabled={!agentReady || busy} onClick={() => { if (onAskAgent(q) === false) setHandoffError('AI 채팅의 작성 중인 글과 합치면 6,000자를 초과합니다. 초안을 정리한 뒤 다시 이어가 주세요.') }}><span>AI로 이어가기</span><ArrowRight size={15}/></button></div>
      {handoffError && <p className="screen-notice" role="status">{handoffError}</p>}
      <p className="screen-footnote">실시간 시세가 아닌 수집된 일봉 기준입니다. 조건 충족은 매수·매도 추천을 의미하지 않습니다.</p>
    </div></div>
  </section>
}
