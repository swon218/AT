export function agentSourceLabel(source) {
  if(source.scope==='title_and_snippet')return '뉴스 제목·요약'
  if(source.scope==='quote')return '최신 조회 시세 · 공급자 시각 확인 불가'
  if(source.scope==='intraday')return '분봉·틱 · 봉 확정 여부 확인 불가'
  if(source.scope==='fundamental') {
    if(source.data_kind==='financials')return `공식 재무 · ${source.financial_scope==='CFS'?'연결':'별도'} · ${source.basis==='annual'?'연간':'단일분기/기말'} · ${source.currency||'통화 미확인'} 기본 단위`
    return source.body_available?'사업보고서 일부 추출 문단':source.data_kind==='disclosures'?'공식 공시 제목·목록':'기업 기본 정보'
  }
  return /^[rfi]_/.test(source.id||'')?'확정 일봉':'자료 범위 확인 필요'
}

export function agentSourceTime(source) {
  if(source.scope==='quote'||source.scope==='intraday')return `기준 ${source.provider_at||'확인 불가'} · 조회 ${source.queried_at||'확인 불가'}`
  if(source.scope==='fundamental')return [source.end&&`보고기간 말 ${source.end}`,source.filed_on&&`공시 ${source.filed_on}`,`저장 갱신 ${source.collected_at||'확인 불가'}`,`조회 ${source.queried_at||'확인 불가'}`,source.stale&&'만료 자료'].filter(Boolean).join(' · ')
  return source.published_at||source.as_of||'기준시각 확인 불가'
}
