export const evaluationLabels={queued:'대기',running:'실행 중',completed:'완료',failed:'실패',interrupted:'중단',canceled:'취소',partial:'부분 완료',production:'운영 데이터 · 실제 모델',live:'과거 고정 데이터 · 실제 모델',code:'과거 고정 데이터 · 모의 응답'}
export const evaluationErrors={eval_busy:'다른 평가가 진행 중입니다.',eval_conflict:'다른 곳에서 질문을 수정했습니다. 입력은 유지됩니다. 최신 저장 내용을 확인해 주세요.',eval_note_conflict:'다른 곳에서 메모를 수정했습니다. 입력은 유지됩니다. 최신 기록을 확인해 주세요.',eval_limit:'질문은 최대 300개까지 등록할 수 있습니다.',eval_invalid:'입력값을 확인해 주세요.',eval_runtime_not_ready:'운영 AI 서비스와 관리자 API 반영이 필요합니다.',eval_database_unavailable:'관리자 SQL 적용 또는 DB 연결 상태를 확인해 주세요.',admin_forbidden:'관리자 권한이 없습니다.',execution_interrupted:'응답 유실 또는 서버 중단입니다. 유료 호출을 자동 재실행하지 않습니다.',execution_timeout:'실행 시간 한도에 도달했습니다.',cost_limit:'실행 비용 한도에 도달했습니다.',token_limit:'토큰 한도에 도달했습니다.',model_call_limit:'모델 호출 한도에 도달했습니다.',tool_call_limit:'도구 호출 한도에 도달했습니다.'}
export const evaluationMessage=error=>evaluationErrors[error?.code]||error?.message||'요청을 처리하지 못했습니다.'
const graphErrors={token_or_cost_limit:'토큰 또는 추정 비용 한도에 도달했습니다.',model_round_limit:'모델 호출 한도에 도달했습니다.',specialist_round_limit:'담당의 모델 호출 한도에 도달했습니다.',delegation_limit:'전문 담당 위임 한도에 도달했습니다.',tool_recovery_limit:'도구 재시도 한도에 도달했습니다.',specialist_timeout:'전문 담당의 실행 시간 한도에 도달했습니다.',usage_unknown:'공급자 사용량을 확인하지 못해 추가 유료 호출을 중단했습니다.',execution_cancelled:'권한·실행 상태를 확인하지 못해 처리를 중단했습니다.',incomplete_model_response:'모델 응답이 완성되지 않았습니다.'}
export const evaluationError=code=>evaluationErrors[code]||graphErrors[code]||'실행을 완료하지 못했습니다.'
export function usedEvaluationTools(steps=[]) {
  return steps.filter(step=>step.kind==='tool').map(step=>({seq:step.seq,agent:step.agent,name:step.name,status:step.status,code:step.result?.code}))
}
export function questionDraft(previous,row) {
  const text=row.spec.question||''
  return previous&&previous.text!==previous.base?previous:{text,base:text,revision:row.revision}
}
