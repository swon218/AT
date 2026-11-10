import { supabase } from './supabaseClient'

export const agentErrors = {
  api_key_missing: 'OpenAI API 키가 아직 설정되지 않았습니다. 이용 횟수는 차감되지 않았습니다.',
  database_not_configured: 'AI 대화 DB가 아직 설정되지 않았습니다.', database_unavailable: 'AI DB 연결 또는 SQL 적용 상태를 확인해 주세요.',
  internal_secret_missing: 'AI 서버 간 인증이 아직 설정되지 않았습니다.', guest_cookie_not_configured: '방문자 인증 설정이 필요합니다.',
  guest_cookie_invalid: '방문자 쿠키를 확인할 수 없습니다. 자동으로 새 방문자를 발급하지 않습니다.',
  guest_cookie_required: '방문자 쿠키가 필요합니다. 브라우저 쿠키 차단과 동일 출처 프록시 설정을 확인해 주세요.',
  guest_invalid: '방문자 인증이 만료되었거나 유효하지 않습니다. 로그인해 이용할 수 있습니다.',
  invalid_authentication: '로그인 인증이 만료되었습니다. 다시 로그인해 주세요.',
  daily_limit: '비로그인 이용은 한국시간 하루 2회입니다. 로그인하면 일일 횟수 제한 없이 이용할 수 있습니다.',
  concurrency_limit: '앞선 질문이 처리 중입니다. 완료 후 다시 보내 주세요.', minute_limit: '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
  connection_failed: 'AI 내부 서버에 연결하지 못했습니다.', agent_unavailable: 'AI 서버에 연결하지 못했습니다.',
  agent_proxy_not_configured: '프런트엔드의 AI 서버 프록시가 아직 설정되지 않았습니다.',
  agent_proxy_unavailable: 'AI 서버 프록시에 연결하지 못했습니다.', agent_disabled: '관리자가 AI 신규 요청을 비활성화했습니다.',
  execution_interrupted: '처리가 중단되었습니다. 확인되지 않은 공급자 사용량은 unknown으로 기록됩니다.',
  interrupted: '서버 재시작 또는 응답 유실로 처리가 중단되었습니다. 같은 작업을 자동 재실행하지 않습니다.',
  authentication_error: 'OpenAI API 키 인증 오류입니다.', permission_error: 'OpenAI 모델 사용 권한 오류입니다.',
  alert_unavailable: '알림 설정을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.',
  alert_disabled: '알림 감시를 준비 중입니다.',
  alert_kakao_required: '카카오 계정 연결과 메시지 전송 동의를 확인해 주세요.',
  alert_kakao_unavailable: '카카오 메시지 전송 권한을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  alert_watchlist_required: '현재 관심종목에 있는 종목만 감시할 수 있습니다.',
  alert_expired: '만료일을 확인해 주세요. 오늘부터 30일 이내로 지정할 수 있습니다.',
  alert_invalid: '알림 조건과 선택한 종목을 확인해 주세요.',
  alert_dispatch_in_progress: '발송 요청을 마치는 중입니다. 잠시 후 다시 시도해 주세요.',
  alert_version_conflict: '다른 곳에서 조건이 변경되었습니다. 최신 상태를 확인해 주세요.',
  alert_request_conflict: '이전에 처리한 요청과 내용이 다릅니다. 최신 상태를 확인해 주세요.',
  alert_invalid_state: '조건의 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.',
  alert_duplicate_condition: '같은 종목에 동일한 감시 조건이 이미 있습니다.',
  alert_rule_limit: '종목마다 저장된 조건을 최대 10개까지 보관할 수 있습니다.',
  billing_error: 'OpenAI 결제 오류입니다.', billing_or_rate_limit: 'OpenAI 결제 한도 또는 요청 제한 오류입니다.',
}
export async function agentApi(path, { method = 'GET', body, userId, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const { data } = supabase ? await supabase.auth.getSession() : { data: { session: null } }
  if (userId) {
    if (data.session?.user?.id !== userId) throw new Error(agentErrors.invalid_authentication)
    headers.Authorization = `Bearer ${data.session.access_token}`
  } else if (data.session) throw new Error('계정 전환 중입니다.')
  let response
  try { response = await fetch(`/api/agent${path}`, { method, headers, credentials: 'same-origin', ...(body ? { body: JSON.stringify(body) } : {}), signal }) }
  catch (exc) { if (exc.name === 'AbortError') throw exc; throw new Error('AI 서버에 연결하지 못했습니다. 같은 질문을 재전송하면 요청 ID로 중복 실행을 방지합니다.') }
  const result = await response.json().catch(() => ({ error: 'agent_unavailable' }))
  if (!response.ok) throw Object.assign(new Error(agentErrors[result.error] || `AI 요청 실패: ${result.error || response.status}`), { code: result.error })
  return result
}
export function safeAgentLink(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
