import {useState} from 'react'
import catalog from '../../shared/agentToolCatalog.json'
import verification from '../../shared/agentToolVerification.json'
import architecture from '../../shared/agentArchitecture.json'
import AlertHelp from './AlertHelp'

const roles={news:['News Research Agent','뉴스 제목·검색 요약에서 근거를 조사합니다.'],technical:['Technical Analysis Agent','확정 일봉·보조지표·조건검색을 담당합니다.'],market:['Market Data Agent','최신 조회 시세와 제한된 분봉·틱을 조회합니다.'],fundamental:['Fundamental Research Agent','저장된 공식 기업·공시·재무 자료를 조사합니다.'],alert:['Alert Planning Agent','관심종목·알림 상태를 읽고 확인 카드·미저장 초안을 제안합니다.']}
const descriptions=new Map(catalog.groups.flatMap(group=>group.tools.map(tool=>[tool.name,{...tool,dataType:group.title}])))

export default function AdminToolCatalog({runtime}) {
  const [active,setActive]=useState(null)
  const agents=architecture.agents.filter(agent=>agent.id!=='orchestrator').map(agent=>({...agent,tools:runtime?.execution?.role_manifest?.[agent.id]||agent.tools}))
  const total=new Set(agents.flatMap(agent=>agent.tools)).size
  return <section className="eval-tool-catalog" aria-label="분석 AI 사용가능 도구">
    <p className="eval-tool-note">전문 담당 {agents.length}개 · 도구 {total}개 · 공통 도구는 허용된 담당에만 표시합니다.</p>
    <div className="eval-agent-grid">{agents.map(agent=><section className="eval-agent-card" key={agent.id} aria-labelledby={`tools-${agent.id}`}>
      <h3 id={`tools-${agent.id}`}>{roles[agent.id]?.[0]||agent.name}</h3><p>{roles[agent.id]?.[1]}</p>
      <p className="eval-tool-readiness">코드 등록 · {runtime?.agents?.includes(agent.id)?'운영 담당 등록':'운영 등록 미확인'}
        {['market','fundamental'].includes(agent.id)&&<> · {runtime?.providers?.[agent.id]?.configured?'설정 준비됨':'설정 미확인'} · {agent.id==='fundamental'?'DB 조회':'수신'} {runtime?.providers?.[agent.id]?.last_success_at||'확인 기록 없음'}</>}</p>
      {!['market','fundamental'].includes(agent.id)&&<p className="eval-tool-readiness">{runtime?.preparation?.[agent.id]?({news:'뉴스 설정 확인',technical:'DB 경로 존재',alert:'초안 도구 등록'})[agent.id]:'설정 준비 미확인'} · 현재 동작 수신 기록 미확인</p>}
      <ul>{agent.tools.map(name=>{const tool=descriptions.get(name),shared=agents.filter(candidate=>candidate.tools.includes(name));return <li key={name}>
        <div className="eval-tool-name"><span>{tool?.title||name}<code>{name}</code></span>
          <AlertHelp persistent symbol="!" active={active} setActive={setActive} label={`${tool?.title||name} 도구 설명`} triggerClassName="eval-tool-info" contentClassName="eval-tool-help">
            <strong>{tool?.title||name}</strong><p>{tool?.description||'설명 정보가 아직 등록되지 않았습니다.'}</p>
            <dl><dt>데이터 종류</dt><dd>{tool?.dataType||'확인 필요'}</dd><dt>API · DB / 출처</dt><dd>{tool?.source||'확인 필요'}</dd>
              <dt>조회 범위 · 조건 · 한계</dt><dd>{tool?.requirement||'확인 필요'}</dd>{tool?.example&&<><dt>질문 예시</dt><dd>{tool.example}</dd></>}
              {shared.length>1&&<><dt>호출 허용 담당</dt><dd>{shared.map(row=>roles[row.id]?.[0]||row.name).join(' · ')}</dd></>}
            </dl>
          </AlertHelp>
        </div>{shared.length>1&&<small>공통 도구 · 허용 담당 {shared.length}개</small>}
      </li>})}</ul>
    </section>)}</div>
    <p className="eval-tool-note">등록·설정 준비는 실제 동작 확인과 다릅니다. 총괄은 <code>delegate_research</code>로 위임합니다. {architecture.version}</p>
    <details className="eval-tool-verification"><summary>과거 운영 확인 · {verification.checkedAtLabel} · 실시간 검사 아님</summary>
      <p>{verification.source}. {verification.summary}</p><p>점검 대상 <code>{verification.codeSha}</code></p>
      {verification.items.map(item=><p key={item.title}><strong>{item.title} · {item.status}</strong><br/>{item.detail} {item.limit}</p>)}
    </details>
    <details><summary>미지원·미연결 범위</summary>{catalog.unavailable.map(item=><p key={item.title}><strong>{item.title}</strong><br/>{item.description}</p>)}</details>
  </section>
}
