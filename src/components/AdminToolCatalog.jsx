import { useState } from 'react'
import catalog from '../../shared/agentToolCatalog.json'
import verification from '../../shared/agentToolVerification.json'
import architecture from '../../shared/agentArchitecture.json'

export default function AdminToolCatalog({ runtime }) {
  const [filter, setFilter] = useState('all')
  const count = catalog.groups.reduce((sum, group) => sum + group.tools.length, 0)
  const groups = catalog.groups.filter(group => filter === 'all' || group.id === filter)
  return <section className="eval-tool-catalog" aria-label="분석 AI 사용가능 도구">
    <div className="eval-toolbar"><h3>분석 AI에 등록된 도구 {count}개</h3><span className="eval-badge">코드 등록 기준</span></div>
    <p className="eval-tool-note">모델이 질문에 따라 선택할 수 있는 도구와 데이터 출처입니다. 코드 등록 여부와 운영 API의 실제 수신 성공은 별개이며, 인증 설정·데이터 최신성·회원 로그인 상태에 따라 사용이 제한될 수 있습니다.</p>
    <p className="eval-tool-note">{architecture.version} · 총괄이 필요한 전문 담당을 선택하고 결과를 검토합니다. 독립적인 조사는 최대 2개 담당이 병렬로 수행하며, 알림은 별도의 확인·미저장 초안 흐름을 사용합니다. 모든 담당은 같은 운영 모델을 사용합니다.</p>
    <p className="eval-tool-note">총괄 조정 도구 <code>delegate_research</code> · 검증된 조사 목표·종목·기간·제약을 전문 담당에게 전달합니다.</p>
    {!!architecture.future.length && <p className="eval-tool-note">{architecture.future.join(' · ')}는 향후 도구 연결 후 추가 예정입니다.</p>}
    <details className="eval-tool-verification">
      <summary>운영 확인 기록 · {verification.checkedAtLabel} · 실시간 상태 아님</summary>
      <p>{verification.source}. {verification.summary}</p>
      <p className="eval-tool-note">아래는 해당 시점의 수동 점검 기록입니다. 새로고침으로 재검사되지 않으며 현재 연결 상태와 데이터 범위는 달라질 수 있습니다.</p>
      <div className="eval-tool-grid">{verification.items.map(item=><article className="eval-tool-card" key={item.title}>
        <h4>{item.title}</h4><span className="eval-badge">{item.status}</span><p>{item.detail}</p><p className="eval-tool-note">{item.limit}</p>
      </article>)}</div>
      <p className="eval-tool-note">점검 대상 코드: <code>{verification.codeSha}</code></p>
    </details>
    <div className="eval-tool-filters" aria-label="데이터 종류">
      {[{id:'all',title:'전체'},...catalog.groups,{id:'unavailable',title:'AI 미연결 데이터'}].map(group =>
        <button key={group.id} aria-pressed={filter===group.id} className={filter===group.id?'active':''} onClick={()=>setFilter(group.id)}>{group.title}</button>)}
    </div>
    {groups.map(group=><section key={group.id} className="eval-tool-group" aria-labelledby={`tool-group-${group.id}`}>
      <h3 id={`tool-group-${group.id}`}>{group.title} <span className="eval-badge">{group.tools.length}개</span></h3><p>{group.description}</p>
      {group.agent && <p className="eval-tool-note">{!runtime?.agents?.includes(group.agent) ? '운영 서버 담당 준비 미확인' : runtime.providers?.[group.agent]?.configured ? '운영 담당 등록 · 데이터 설정됨' : '운영 담당 등록 · 데이터 설정 필요'} · {group.agent==='fundamental'?'최근 DB 정상 조회':'최근 정상 수신'} {runtime?.providers?.[group.agent]?.last_success_at || '확인 기록 없음'}</p>}
      <div className="eval-tool-grid">{group.tools.map(tool=><article className="eval-tool-card" key={tool.name}>
        <h4>{tool.title}</h4><code>{tool.name}</code><p>{tool.description}</p>
        <dl><dt>담당 에이전트</dt><dd>{architecture.agents.filter(agent=>agent.tools.includes(tool.name)).map(agent=>agent.name).join(' · ')}</dd><dt>API · DB / 데이터 출처</dt><dd>{tool.source}</dd><dt>사용 조건 · 범위</dt><dd>{tool.requirement}</dd><dt>질문 예시</dt><dd>{tool.example}</dd></dl>
      </article>)}</div>
    </section>)}
    {(filter==='all'||filter==='unavailable')&&<section className="eval-tool-group" aria-label="분석 AI에 연결되지 않은 데이터">
      <h3>웹 기능에 있지만 분석 AI에는 미연결</h3><p>아래 데이터는 현재 분석 AI의 호출 가능 도구 수에 포함되지 않습니다.</p>
      <div className="eval-tool-grid">{catalog.unavailable.map(item=><article className="eval-tool-card unavailable" key={item.title}>
        <h4>{item.title}</h4><span className="eval-badge">AI 도구 미등록</span><p>{item.description}</p><dl><dt>관련 데이터 출처</dt><dd>{item.source}</dd></dl>
      </article>)}</div>
    </section>}
    <p className="eval-tool-note">평가 실행기의 고정 합성 데이터는 운영 API 수신 확인용이 아닙니다. 이 목록을 열거나 분류를 선택하는 동작은 모델 평가를 실행하지 않습니다.</p>
  </section>
}
