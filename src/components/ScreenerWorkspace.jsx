import { useEffect, useState } from 'react'
import { ArrowRight, Bot, ChevronLeft, ChevronRight, Database, Filter, Plus, RotateCcw, Search } from 'lucide-react'
import { condition, defaultQuery, describeQuery, metricValue, presets, queryProblem, ratioComparison, factorToPercent, screenNumber } from '../utils/screener'
import ScreenerCondition from './ScreenerCondition'
import './ScreenerWorkspace.css'

const reasons = { quarantined_ohlc: '품질 격리', insufficient_warmup: '계산 이력 부족', missing_sessions: '거래일 누락', stale_data: '최신 일봉 미수집', quality_records_missing: '품질 이력 누락', quality_unavailable: '품질 검증 불가', unsupported_source: '지원하지 않는 출처', indicator_unavailable: '지표 계산 불가', invalid_ohlc: 'OHLC 오류', invalid_volume: '거래량 오류' }
const number = screenNumber

function CheckDetails({row,result}){
  return <div className="screen-checks"><strong>{row.name} · 조건별 실제 값</strong>{row.checks.map((check,i)=>{
    const c=result.query.conditions[i],relative=c.right.kind==='metric',ratio=relative&&ratioComparison(c.left.name,c.right.metric.name)
    const field=(title,value,name)=> <div><dt>{title}</dt><dd title={Number.isFinite(value)?String(value):undefined}>{metricValue(name,value)}</dd></div>
    return <section key={i}><p><span className={check.matched?'screen-pass':''}>{check.matched?'충족':'미충족'}</span>{check.label}</p>
      <dl className="screen-check-grid">{field('실제 지표값',check.left,c.left.name)}
        {relative&&<>{field('비교 지표 원래 값',check.right_base,c.right.metric.name)}<div><dt>{ratio?'적용 비율':'적용 배수 (고급)'}</dt><dd>{ratio?`${number(check.ratio_percent??factorToPercent(c.right.factor))}%`:`${number(c.right.factor)}배`}</dd></div></>}
        {field(relative?'최종 비교 기준값':'직접 입력 기준값',check.right,c.left.name)}
        {c.operator.startsWith('crosses_')&&<>{field('이전 봉 실제 값',check.previous_left,c.left.name)}{relative&&field('이전 봉 비교 원래 값',check.previous_right_base,c.right.metric.name)}{field('이전 봉 비교 기준값',check.previous_right,c.left.name)}</>}
      </dl><details><summary>반올림 전 계산값</summary><dl className="screen-check-grid">{Object.entries({실제값:check.left,비교원래값:check.right_base,적용배수:c.right.factor,최종기준:check.right,...(c.operator.startsWith('crosses_')?{이전실제값:check.previous_left,이전비교원래값:check.previous_right_base,이전최종기준:check.previous_right}:{})}).filter(([,value])=>Number.isFinite(value)).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></details></section>
    })}<small>표시는 반올림하며 조건 판정은 원래 정밀도로 수행합니다.</small></div>
}

export default function ScreenerWorkspace({ screen, onOpenChart, onAskAgent, agentReady }) {
  const { query: q, edit, result, meta, busy, error, search, stop, loadMeta } = screen
  const [expanded, setExpanded] = useState(null)
  const [handoffError, setHandoffError] = useState('')
  const [activeHelp,setActiveHelp]=useState(null)
  const problem=queryProblem(q)
  useEffect(() => { void loadMeta() }, [])
  const update = (patch,options) => edit({ ...q, ...patch },options)
  const change = (i, patch) => update({ conditions: q.conditions.map((c, index) => index === i ? { ...c, ...patch } : c) })
  const cov = result?.coverage
  const excluded = cov ? Object.values(cov.excluded).reduce((a, b) => a + b, 0) : 0
  const pages = cov ? Math.max(1, Math.ceil(cov.matches / cov.page_size)) : 1
  return <section className="screen-workspace" aria-label="조건 검색">
    <header className="screen-heading"><div><span className="screen-eyebrow"><Filter size={14}/> STOCK SCREENER</span><h1>조건 검색 <span>일봉</span></h1><p>조건을 조합해 종목을 찾고, 같은 조건을 AI와 살펴보세요.</p></div><div className="screen-data-badge"><Database size={18}/><span>실험실 공통 데이터<small>{meta?.universe !== undefined ? `${number(meta.universe)}종목 · 최근 수집 일봉 ${meta.latest_bar || '없음'}` : meta?.unavailable ? '서버 연결 확인 필요' : '수집 상태 확인 중'}</small></span><button type="button" aria-label="데이터 상태 새로고침" onClick={loadMeta}><RotateCcw size={14}/></button></div></header>
    <div className="screen-layout"><form className="screen-builder" noValidate onSubmit={e => { e.preventDefault(); setExpanded(null); if(!problem)void search() }}>
      <div className="screen-panel-title"><h2>검색 조건</h2><button type="button" className="screen-text-button" onClick={() => edit(defaultQuery(),{resetEditors:true})}><RotateCcw size={13}/>초기화</button></div>
      <label className="screen-field-label">시장<select aria-label="검색 시장" value={q.market} onChange={e => update({ market: e.target.value })}><option value="ALL">코스피 + 코스닥</option><option value="KOSPI">코스피</option><option value="KOSDAQ">코스닥</option></select></label>
      <div className="screen-presets"><span>빠르게 시작 · 비율 예시는 편의 설정입니다</span><div>{presets.filter(p=>!p.reference).map(p => <button type="button" key={p.label} onClick={() => update({ conditions: [p.condition()] },{resetEditors:true})}>{p.label}</button>)}</div>
        <details><summary>지표별 통상 참고 조건</summary><div>{presets.filter(p=>p.reference).map(p=><button type="button" key={p.label} onClick={()=>update({conditions:[p.condition()]},{resetEditors:true})}>{p.label}</button>)}</div><p>일반적으로 쓰이는 참고값이며 유일한 정답이나 수익 보장 조건이 아닙니다.</p></details>
      </div>
      <div className="screen-match"><strong>조건 연결</strong><div>{[['all', '모두 충족 (AND)'], ['any', '하나 이상 (OR)']].map(([id, label]) => <button type="button" aria-pressed={q.match === id} key={id} onClick={() => update({ match: id })}>{label}</button>)}</div></div>
      <div className="screen-conditions">{q.conditions.map((c,i)=><ScreenerCondition key={`${screen.formVersion}:${i}`} value={c} index={i} help={{active:activeHelp,setActive:setActiveHelp}} onChange={next=>change(i,next)} canRemove={q.conditions.length>1} onRemove={()=>update({conditions:q.conditions.filter((_,n)=>n!==i)},{resetEditors:true})}/>)}</div>
      <button type="button" className="screen-add" disabled={q.conditions.length >= 8} onClick={() => update({ conditions: [...q.conditions, condition()] })}><Plus size={15}/>조건 추가 <small>{q.conditions.length}/8</small></button>
      {problem&&<p className="screen-condition-error" role="alert">수정 필요 · {problem}</p>}
      <div className="screen-search-actions"><button type="submit" className="screen-primary" disabled={busy||!!problem}><Search size={17}/>{busy ? '종목 확인 중…' : '조건 검색'}</button>{busy && <button type="button" onClick={stop}>중지</button>}</div>
      <p className="screen-builder-note">기간은 거래일 기준 봉 수이며 현재 확정 봉을 포함합니다. 돌파는 이전·현재 봉 각각의 비교 기준에 같은 비율을 적용합니다.</p>
    </form>
    <div className="screen-results"><div className="screen-panel-title"><h2>검색 결과 {cov && <span>{number(cov.matches)}종목</span>}</h2><label className="screen-sort">정렬<select aria-label="결과 정렬" value={q.sort} onChange={e => update({ sort: e.target.value })}><option value="code_asc">종목코드 순</option><option value="close_desc">종가 높은 순</option></select></label></div>
      {error && <p className="screen-error" role="alert">{error}</p>}
      {meta && !meta.unavailable && (!meta.quality_ready || meta.latest_bar !== meta.cutoff) && <p className="screen-notice">{!meta.quality_ready ? '품질 검증 데이터가 준비되지 않았습니다.' : `검색 기준일 ${meta.cutoff} · 최근 수집 ${meta.latest_bar || '없음'}. 최신 일봉이 없는 종목은 제외됩니다.`}</p>}
      {result ? <>
        <div className="screen-result-summary"><span className="screen-result-date">{result.as_of} 확정 일봉</span><p>{describeQuery(result.query)}</p><div><span>{number(cov.scanned)} / {number(cov.universe)}종목 확인</span><span>계산 가능 {number(cov.valid)} · 제외 {number(excluded)}</span></div><progress aria-label="종목 확인 진행률" value={cov.scanned} max={cov.universe || 1}/>
          {!!cov.not_scanned && <p className="screen-notice">아직 {number(cov.not_scanned)}종목을 확인하지 못했습니다. 현재 결과는 일부 범위입니다.{!busy && <button type="button" onClick={() => search(result.query)}>이어서 검색</button>}</p>}
          {excluded > 0 && <details><summary>제외 사유 보기</summary>{Object.entries(cov.excluded).map(([reason, count]) => <p key={reason}>{reasons[reason] || reason} · {number(count)}종목</p>)}</details>}
        </div>
        <div className="screen-table-wrap"><table className="screen-table"><thead><tr><th>종목</th>{result.columns.map(c => <th key={c.key}>{c.label}{c.unit && ` (${c.unit})`}</th>)}<th>확인</th></tr></thead><tbody>{result.items.map(row => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.code} · {row.market}</small></td>{result.columns.map(c => <td key={c.key} title={Number.isFinite(row.values[c.key])?String(row.values[c.key]):undefined}>{metricValue(c.name||c.key.split(':')[0],row.values[c.key],false)}</td>)}<td><button type="button" aria-expanded={expanded === row.code} onClick={() => setExpanded(expanded === row.code ? null : row.code)}>조건 값</button><button type="button" onClick={() => onOpenChart(row)}>차트 <ArrowRight size={12}/></button></td></tr>)}</tbody></table></div>
        {!result.items.length && <div className="screen-empty"><Search size={28}/><h3>{cov.not_scanned ? '확인한 범위에 일치 종목이 없습니다' : cov.valid === 0 ? '조건을 계산할 수 있는 종목이 없습니다' : '조건을 충족하는 종목이 없습니다'}</h3><p>{cov.valid === 0 ? '최신 일봉과 품질 제외 사유를 확인해 주세요.' : '기준값이나 조건의 연결 방식을 조정해 보세요.'}</p></div>}
        {expanded && result.items.filter(r => r.code === expanded).map(row => <CheckDetails key={row.code} row={row} result={result}/>)}
        <div className="screen-pagination"><span>{cov.page} / {pages}페이지</span><button type="button" aria-label="이전 결과" disabled={busy || !!cov.not_scanned || cov.page <= 1} onClick={() => search({ ...result.query, page: cov.page - 1 })}><ChevronLeft size={16}/></button><button type="button" aria-label="다음 결과" disabled={busy || !!cov.not_scanned || cov.page >= pages} onClick={() => search({ ...result.query, page: cov.page + 1 })}><ChevronRight size={16}/></button></div>
        <p className="screen-source">출처: {result.source} · 계산: {cov.calculation_version}<br/>조회 {cov.data_read_at} · 지표 수치는 표시할 때만 반올림합니다.</p>
      </> : <div className="screen-empty screen-start"><span className="screen-empty-icon"><Filter size={30}/></span><h3>어떤 조건의 종목을 찾으시나요?</h3><p>왼쪽에서 지표와 기준값을 선택해 검색하세요.<br/>RSI, 볼린저밴드, 이동평균선과 거래량을 함께 비교할 수 있습니다.</p><div className="screen-example">예시 <span>RSI(14) ≤ 30</span><span>AND</span><span>종가 &lt; SMA(20)</span></div></div>}
      <div className="screen-ai-card"><span className="screen-ai-icon"><Bot size={23}/></span><div><strong>찾은 조건을 AI와 이어서 살펴보세요</strong><p>같은 검색 엔진을 사용합니다. 질문을 작성한 뒤 직접 전송할 수 있습니다.</p></div><button type="button" disabled={!agentReady || busy||!!problem} onClick={() => { if (onAskAgent(q) === false) setHandoffError('AI 채팅의 작성 중인 글과 합치면 6,000자를 초과합니다. 초안을 정리한 뒤 다시 이어가 주세요.') }}><span>AI로 이어가기</span><ArrowRight size={15}/></button></div>
      {handoffError && <p className="screen-notice" role="status">{handoffError}</p>}
      <p className="screen-footnote">실시간 시세가 아닌 수집된 일봉 기준입니다. 조건 충족은 매수·매도 추천을 의미하지 않습니다.</p>
    </div></div>
  </section>
}
