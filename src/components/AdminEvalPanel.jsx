import { useEffect, useRef, useState } from 'react'
import { agentApi } from '../services/agentApi'
import { compareRuns, summarize, verdict } from '../utils/evalResults'
import './AdminEvalPanel.css'

const labels={pass:'통과',fail:'실패',review:'검토 필요',hold:'보류',na:'해당 없음',pending:'진행 대기',queued:'대기',running:'실행 중',completed:'완료',failed:'실행 실패',interrupted:'중단',canceled:'취소',code:'코드 검증',live:'실제 모델 평가'}
const categories=['질문 해석','도구 선택','도구 입력','데이터·계산','근거 없는 답변','미지원 안내','사용자 승인·상태 변경','화면 연결','처리 시간·비용','외부 서비스 장애']
const errors={admin_forbidden:'관리자 권한이 없습니다.',eval_conflict:'내용이 변경됐거나 같은 실행 ID의 요청이 다릅니다. 새로고침해 주세요.',eval_busy:'다른 평가가 진행 중입니다.',eval_case_not_ready:'고정 데이터가 준비된 활성 사례만 실행할 수 있습니다.',eval_invalid:'입력값과 검사 규칙을 확인해 주세요.',eval_database_unavailable:'평가 DB의 SQL 적용·권한을 확인해 주세요.',eval_not_found:'접근 가능한 기록을 찾지 못했습니다.',eval_limit:'평가 질문은 최대 300개입니다.'}
const fresh=()=>({id:crypto.randomUUID(),revision:0,spec:{title:'',category:'지표 조회·조건검색',question:'',context:[],dataset:'unprepared',scenario:'base',success:'',failure:'',rubric:'질문 의도를 충족하고 근거·기준일·한계를 정확히 설명하는지 검토한다.',checks:[{type:'no_mutation'}],split:'dev',status:'active'}})
const pretty=x=>JSON.stringify(x,null,2)
function Help({children}){return <details className="eval-help"><summary aria-label="도움말">?</summary><div>{children}</div></details>}
function Json({title,value}){return <details><summary>{title}</summary><pre>{pretty(value)}</pre></details>}
function Badge({value}){return <span className={`eval-badge ${value}`}>{labels[value]||value||'미확인'}</span>}
function download(value,name){const url=URL.createObjectURL(new Blob([pretty(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}

export default function AdminEvalPanel({userId,importRequest,onImported}) {
  const [tab,setTab]=useState('평가 질문'),[catalog,setCatalog]=useState(null),[cases,setCases]=useState([]),[runs,setRuns]=useState([])
  const [selected,setSelected]=useState([]),[edit,setEdit]=useState(null),[contextText,setContextText]=useState('[]'),[checkText,setCheckText]=useState('[]')
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  const [mode,setMode]=useState('code'),[repeats,setRepeats]=useState(1),[budget,setBudget]=useState(1),[paid,setPaid]=useState(false)
  const [run,setRun]=useState(null),[item,setItem]=useState(null),[review,setReview]=useState({status:'hold',category:categories[0],note:''})
  const [left,setLeft]=useState(''),[right,setRight]=useState(''),[comparison,setComparison]=useState(null)
  const pending=useRef(null), mounted=useRef(true)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  const api=(path,options)=>agentApi('/admin'+path,{...options,userId})
  const message=e=>errors[e.code]||e.message
  async function task(fn){setError('');setNotice('');setBusy(true);try{return await fn()}catch(e){if(mounted.current)setError(message(e))}finally{if(mounted.current)setBusy(false)}}
  async function refresh(){const [c,r,k]=await Promise.all([api('/cases'),api('/runs'),api('/catalog')]);if(mounted.current){setCases(c);setRuns(r);setCatalog(k)}}
  useEffect(()=>{task(refresh)},[userId])
  useEffect(()=>{
    if(!run)return
    let active=true
    const timer=setInterval(async()=>{try{const data=await api('/runs/'+run.run.id);if(active){setRun(data);setRuns(await api('/runs'))}}catch(e){if(active)setError(message(e))}},4000)
    return()=>{active=false;clearInterval(timer)}
  },[run?.run.id,userId])
  function editor(row){setEdit(structuredClone(row));setContextText(pretty(row.spec.context));setCheckText(pretty(row.spec.checks));setTab('평가 질문')}
  useEffect(()=>{
    if(!importRequest)return
    task(async()=>{
      const source=await api('/import/'+importRequest),row=fresh()
      Object.assign(row.spec,{title:'실제 대화에서 추가한 평가',question:source.question,context:source.context,source:source.source})
      editor(row);setNotice('필요한 맥락을 선택하고 성공 기준과 고정 데이터를 지정해 주세요. 실행 기록은 아래에서 검토할 수 있습니다.');setItem({imported:source})
      onImported?.()
    })
  },[importRequest])
  async function save(){await task(async()=>{
    const spec={...edit.spec,context:JSON.parse(contextText),checks:JSON.parse(checkText)}
    await api('/cases/'+edit.id,{method:'PUT',body:{revision:edit.revision,spec}})
    setEdit(null);await refresh();setNotice('평가 사례 버전을 저장했습니다.')
  })}
  async function seed(){await task(async()=>{
    const existing=new Set(cases.map(c=>c.spec.source?.seed_id))
    for(const c of catalog.seeds)if(!existing.has(c.id))await api('/cases/'+crypto.randomUUID(),{method:'PUT',body:{revision:0,spec:{...c.spec,source:{seed_id:c.id}}}})
    await refresh();setNotice('초기 30개 사례를 등록했습니다. 설명·성공 기준은 프로젝트 요구에 맞게 검토해 주세요.')
  })}
  async function start(){await task(async()=>{
    const payload={mode,repeats,budget:mode==='live'?budget:0,paidConfirmed:mode==='live'&&paid,cases:cases.filter(c=>selected.includes(c.id)).map(c=>({id:c.id,revision:c.revision}))}
    const signature=pretty(payload)
    if(pending.current?.signature!==signature)pending.current={signature,id:crypto.randomUUID()}
    const r=await api('/runs',{method:'POST',body:{id:pending.current.id,...payload}})
    setRun(await api('/runs/'+r.id));setTab('실행 결과');await refresh()
  })}
  async function openItem(id){await task(async()=>{const r=await api('/items/'+id);setItem(r);setReview(r.review?{status:r.review.status,category:r.review.category,note:r.review.note}:{status:'hold',category:categories[0],note:''})})}
  const stats=run&&summarize(run.items)
  return <section className="admin-eval panel" aria-label="AI 품질 평가">
    <div className="eval-heading"><div><h2>AI 품질 평가</h2><p>질문을 기록하고, 같은 조건으로 실행하고, 개선 결과를 비교합니다.</p></div><button disabled={busy} onClick={()=>task(refresh)}>새로고침</button></div>
    <nav className="eval-tabs" aria-label="평가 화면">{['평가 질문','평가 실행','실행 결과','버전 비교'].map(t=><button aria-current={tab===t?'page':undefined} className={tab===t?'active':''} onClick={()=>setTab(t)} key={t}>{t}</button>)}</nav>
    {error&&<p role="alert" className="eval-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {busy&&<p role="status">처리 중…</p>}
    {tab==='평가 질문'&&<>
      <div className="eval-toolbar"><button disabled={busy} onClick={()=>editor(fresh())}>새 평가 질문</button><button disabled={busy||!catalog} onClick={seed}>초기 30개 등록</button><span>{cases.length}개 · 개선용 / 별도 확인용</span><Help>별도 확인용 사례는 수정 방향을 정하는 데 사용하지 않고 마지막 검증에 사용하세요. 사례를 수정하면 새 버전으로 저장됩니다.</Help></div>
      {edit&&<div className="eval-editor">
        <h3>{edit.revision?'평가 질문 수정':'평가 질문 등록'} · 버전 {edit.revision+1}</h3>
        {['title','category','question','success','failure','rubric'].map((key,n)=><label key={key}>{['제목','분류','질문','성공 기준','실패 기준','수동 검토 기준'][n]}{n<2?<input value={edit.spec[key]} onChange={e=>setEdit({...edit,spec:{...edit.spec,[key]:e.target.value}})}/>:<textarea rows={3} value={edit.spec[key]} onChange={e=>setEdit({...edit,spec:{...edit.spec,[key]:e.target.value}})}/>}</label>)}
        <div className="eval-form-row">
          <label>고정 데이터<select value={edit.spec.dataset} onChange={e=>setEdit({...edit,spec:{...edit.spec,dataset:e.target.value}})}><option value="unprepared">데이터 준비 필요</option><option value="atlas-fixed-v1">합성 일봉·뉴스 v1 / 2026-10-28 08:00 KST</option></select></label>
          <label>초기 상태<select value={edit.spec.scenario} onChange={e=>setEdit({...edit,spec:{...edit.spec,scenario:e.target.value}})}>{(catalog?.scenarios||[]).map(s=><option key={s}>{s}</option>)}</select></label>
          <label>용도<select value={edit.spec.split} onChange={e=>setEdit({...edit,spec:{...edit.spec,split:e.target.value}})}><option value="dev">개선용</option><option value="holdout">별도 확인용</option></select></label>
          <label>상태<select value={edit.spec.status} onChange={e=>setEdit({...edit,spec:{...edit.spec,status:e.target.value}})}><option value="active">활성</option><option value="archived">보관</option></select></label>
        </div>
        <details><summary>이전 대화 선택·편집</summary>{(()=>{try{return JSON.parse(contextText).map((m,n)=><div key={n} className="eval-context"><span>{m.role}: {m.content}</span><button onClick={()=>setContextText(pretty(JSON.parse(contextText).filter((_,i)=>i!==n)))}>제외</button></div>)}catch{return null}})()}<label>대화 JSON<textarea rows={5} value={contextText} onChange={e=>setContextText(e.target.value)}/></label></details>
        <details><summary>자동 검사 설정</summary><p>tool / no_tools / action / rule / kind / numeric / empty / error / no_mutation만 허용합니다. 실행 코드 입력은 지원하지 않습니다.</p><label>검사 JSON<textarea rows={6} value={checkText} onChange={e=>setCheckText(e.target.value)}/></label></details>
        {edit.spec.source&&<Json title="원본 기록 (검토 후 필요한 정보만 유지)" value={edit.spec.source}/>}
        {item?.imported&&<Json title="가져온 실행 기록" value={item.imported.steps}/>}
        <div className="eval-toolbar"><button disabled={busy} onClick={save}>사례 저장</button><button onClick={()=>setEdit(null)}>닫기</button></div>
      </div>}
      <div className="eval-table"><table><thead><tr><th>제목</th><th>분류</th><th>용도</th><th>준비 상태</th><th>버전</th><th>관리</th></tr></thead><tbody>{cases.map(c=><tr key={c.id}><td>{c.spec.title}</td><td>{c.spec.category}</td><td>{c.spec.split==='dev'?'개선용':'별도 확인용'}</td><td>{c.spec.status==='archived'?'보관':c.spec.dataset==='unprepared'?'데이터 준비 필요':'준비됨'}</td><td>{c.revision}</td><td><button onClick={()=>editor(c)}>수정</button></td></tr>)}</tbody></table></div>
    </>}
    {tab==='평가 실행'&&<>
      <p>실제 모델 평가는 OpenAI 유료 호출입니다. 고정 데이터만 사용하며 운영 관심종목·알림·카카오를 변경하지 않습니다.</p>
      <div className="eval-form-row"><label>평가 모드<select value={mode} onChange={e=>{setMode(e.target.value);setPaid(false)}}><option value="code">코드 검증 · 모의 응답 / 품질 평가 아님</option><option value="live">실제 모델 평가 · 유료</option></select></label><label>반복 횟수<input type="number" min="1" max="3" value={repeats} onChange={e=>setRepeats(Number(e.target.value))}/></label>{mode==='live'&&<label>전체 추정 예산 상한 (USD)<input type="number" min="0.25" max="25" step="0.25" value={budget} onChange={e=>setBudget(Number(e.target.value))}/></label>}</div>
      <p>실행기: {catalog?.worker?`${catalog.worker.model} · ${catalog.worker.code_sha?.slice(0,8)||'SHA 미확인'}${catalog.worker.dirty?' / 수정된 작업 트리':''}`:'연결 미확인 · 운영자가 평가 worker를 시작해야 합니다.'}</p>
      {catalog?.worker&&<Json title="실제 실행기 설정·버전" value={catalog.worker}/>}
      <p>선택 {selected.length}개 × {repeats}회 = {selected.length*repeats}건 · {mode==='live'?`전부 실행하려면 최대 예약 예산 $${(selected.length*repeats*0.25).toFixed(2)}. 실제 요금은 별도이며 토큰 기반 추정 한도를 사용합니다.`:'모델 호출 비용 없음. 공통 실행 경로만 검사하고 질문 품질은 해당 없음으로 표시합니다.'}</p>
      <div className="eval-toolbar"><button onClick={()=>setSelected(cases.filter(c=>c.spec.status==='active'&&c.spec.dataset==='atlas-fixed-v1').slice(0,30).map(c=>c.id))}>준비된 사례 선택 (최대 30)</button><button onClick={()=>setSelected([])}>선택 해제</button></div>
      <div className="eval-case-picks">{cases.map(c=><label key={c.id}><input type="checkbox" disabled={c.spec.dataset==='unprepared'||c.spec.status!=='active'} checked={selected.includes(c.id)} onChange={e=>setSelected(e.target.checked?[...selected,c.id]:selected.filter(id=>id!==c.id))}/>{c.spec.title} <small>{c.spec.split==='holdout'?'별도 확인용':'개선용'}</small></label>)}</div>
      {mode==='live'&&<label className="eval-consent"><input type="checkbox" checked={paid} onChange={e=>setPaid(e.target.checked)}/>유료 모델 호출과 표시된 예산을 확인했습니다.</label>}
      <div className="eval-toolbar"><button disabled={busy||!selected.length||selected.length>30||(mode==='live'&&(!paid||!catalog?.worker?.key_configured))} onClick={start}>선택한 질문 평가 시작</button><button disabled={busy} onClick={()=>{pending.current=null;setNotice('다음 실행은 새로운 실행 ID로 시작합니다. 기존 실행은 결과에서 확인하세요.')}}>새 실행 ID 준비</button></div>
    </>}
    {tab==='실행 결과'&&<>
      <label>저장된 실행<select value={run?.run.id||''} onChange={e=>e.target.value&&task(async()=>{setRun(await api('/runs/'+e.target.value));setItem(null)})}><option value="">실행 선택</option>{runs.map(r=><option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString()} · {labels[r.mode]} · {r.id.slice(0,8)}</option>)}</select></label>
      {run&&<>
        <div className="eval-toolbar"><Badge value={run.run.mode}/><span>전체 {stats.total}건 · 통과 {stats.pass}/{stats.total} ({stats.total?Math.round(100*stats.pass/stats.total):0}%) · 실패 {stats.fail} · 검토 {stats.review} · 대기 {stats.pending} · 취소 {stats.canceled}</span><Help>실패·취소도 전체 분모에 포함합니다. 수동 통과로 자동 검사 실패를 덮어쓸 수 없습니다. 코드 검증 결과는 모델 품질 성공률이 아닙니다.</Help></div>
        <p>중대한 실패 {stats.critical} · 평균 응답 {stats.timed?(stats.ms/stats.timed/1000).toFixed(1):'—'}초 · 모델 호출 {stats.calls}회 · 토큰 {stats.input+stats.output} · 추정 ${stats.usd.toFixed(4)} · 사용량 미확인 {stats.unknown}건</p>
        {stats.fail>0&&<p>실패 유형: {Object.entries(stats.categories).map(([name,count])=>`${name} ${count}건`).join(' · ')}</p>}
        <div className="eval-toolbar"><button disabled={busy} onClick={()=>task(async()=>{await api('/runs/'+run.run.id+'/cancel',{method:'POST',body:{}});setRun(await api('/runs/'+run.run.id));setNotice('대기 항목을 취소했습니다. 진행 중인 호출은 완료될 수 있습니다.');})}>대기 항목 취소</button><button onClick={()=>download(run,'atlas-evaluation-'+run.run.id+'.json')}>요약 JSON 내보내기</button></div>
        <div className="eval-table"><table><thead><tr><th>질문</th><th>회차</th><th>실행</th><th>판정</th><th>상세</th></tr></thead><tbody>{run.items.map(i=><tr key={i.id}><td>{i.title}</td><td>{i.repetition}</td><td><Badge value={i.state}/></td><td><Badge value={verdict(i)}/></td><td><button disabled={busy} onClick={()=>openItem(i.id)}>보기</button></td></tr>)}</tbody></table></div>
      </>}
      {item&&!item.imported&&<div className="eval-editor"><h3>{item.specimen.spec.title} · 결과 상세</h3><p>{item.specimen.spec.question}</p><p>성공 기준: {item.specimen.spec.success}</p><p>실패 기준: {item.specimen.spec.failure}</p><p>검토 기준: {item.specimen.spec.rubric}</p><p>웹 통합 검증: 별도 확인 필요</p>
        <div className="eval-answer">{item.result?.presentation?.content||item.result?.answer?.content||item.result?.error||'결과 대기 중'}</div>
        <ul>{item.result?.checks?.map((c,n)=><li key={n}><Badge value={c.status}/> {c.critical?'[중요] ':''}{c.name}</li>)}</ul>
        <Json title="도구 호출과 근거" value={item.result?.tool_outputs}/><Json title="실행 단계·오류" value={item.result?.steps}/><Json title="초안·확인 카드" value={item.result?.presentation||item.result?.alert_action}/><Json title="실행 버전과 고정 데이터" value={item.metadata}/><Json title="당시 사례·대화" value={item.specimen}/>
        <div className="eval-form-row"><label>내 평가<select value={review.status} onChange={e=>setReview({...review,status:e.target.value})}><option value="hold">보류</option><option value="pass">통과</option><option value="fail">실패</option></select></label><label>실패 유형<select value={review.category} onChange={e=>setReview({...review,category:e.target.value})}>{categories.map(c=><option key={c}>{c}</option>)}</select></label></div><label>평가 메모<textarea rows={3} value={review.note} maxLength={2000} onChange={e=>setReview({...review,note:e.target.value})}/></label>
        <div className="eval-toolbar"><button disabled={busy||['running','queued'].includes(item.state)} onClick={()=>task(async()=>{setItem(await api('/items/'+item.id+'/review',{method:'POST',body:review}));if(run)setRun(await api('/runs/'+run.run.id));setNotice('수동 평가를 저장했습니다.')})}>내 평가 저장</button><button onClick={()=>download(item,'atlas-eval-item-'+item.id+'.json')}>상세 JSON 내보내기</button></div>{item.review&&<p>평가자 {item.review.by} · {item.review.at}</p>}
      </div>}
    </>}
    {tab==='버전 비교'&&<>
      <p>같은 사례 버전·데이터·모델 설정의 실행을 비교합니다. 프롬프트와 코드 변경 내용은 아래 버전 기록으로 확인하세요.</p>
      <div className="eval-form-row">{[['이전 실행',left,setLeft],['현재 실행',right,setRight]].map(([title,value,set])=><label key={title}>{title}<select value={value} onChange={e=>set(e.target.value)}><option value="">선택</option>{runs.map(r=><option key={r.id} value={r.id}>{r.created_at} · {labels[r.mode]} · {r.id.slice(0,8)}</option>)}</select></label>)}<button disabled={busy||!left||!right||left===right} onClick={()=>task(async()=>{const [a,b]=await Promise.all([api('/runs/'+left),api('/runs/'+right)]);setComparison({a,b,rows:compareRuns(a,b)})})}>비교</button></div>
      {comparison&&<><Json title="이전 실행기 버전" value={comparison.a.items[0]?.metadata}/><Json title="현재 실행기 버전" value={comparison.b.items[0]?.metadata}/><div className="eval-table"><table><thead><tr><th>질문</th><th>이전</th><th>현재</th><th>변화</th></tr></thead><tbody>{comparison.rows.map(r=><tr key={r.key}><td>{r.title}</td><td><Badge value={r.first}/></td><td><Badge value={r.last}/></td><td>{r.change}</td></tr>)}</tbody></table></div></>}
    </>}
  </section>
}
