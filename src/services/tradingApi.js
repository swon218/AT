import { supabase } from './supabaseClient'

export const tradingMessages = {
  trading_worker_unavailable:'실행 worker의 정상 동작을 확인하지 못했습니다. 운영자가 worker 상태를 확인한 뒤 다시 시도해 주세요.',
  trading_toss_order_id_missing:'토스 접수 응답의 주문번호를 확인할 수 없어 자동 재전송하지 않습니다. 증권사에서 주문 상태를 확인해 주세요.',
  trading_toss_cancel_rejected:'토스에서 취소를 거부했습니다. 원주문의 미체결·부분체결 상태를 확인해 주세요.',
  trading_account_required:'사용할 본인 계좌를 선택해 주세요.',trading_account_scope_changed:'계좌 선택 상태가 바뀌었습니다. 본인 계좌를 다시 선택해 주세요.',
  trading_schema_upgrade_required:'자동매매 V2 SQL과 서버 반영이 필요합니다. 설정 저장과 실행 상태를 확인해 주세요.',
  trading_policy_mismatch:'저장된 실행의 거래소 정책과 현재 어댑터가 일치하지 않습니다. 자동으로 다른 정책을 적용하지 않습니다.',
  trading_policy_unsupported:'이 증권사의 실행 정책을 지원하지 않습니다.',
  trading_toss_read_unavailable:'토스 개인 API 조회를 완료하지 못했습니다. 연결과 선택 계좌를 다시 확인해 주세요.',
  trading_nh_recovery_contract_unverified:'NH 주문번호 연결과 재시작 후 체결 복구 계약이 확인되지 않아 자동매매 실행을 제한합니다.',
  trading_revision_conflict:'다른 화면에서 변경되었습니다. 최신 상태를 다시 불러온 뒤 확인해 주세요.',
  trading_strategy_conflict:'전략이 변경되거나 삭제되었습니다. 전략을 다시 선택해 저장해 주세요.',
  trading_run_active:'같은 계좌와 종목의 실행이 진행 중입니다. 먼저 해당 실행의 상태를 확인해 주세요.',
  trading_confirmation_expired:'시작 확인이 만료되었습니다. 계좌 상태를 다시 확인해 주세요.',
  trading_broker_orders_disabled:'선택한 증권사의 주문 기능이 비활성입니다. 계좌 연결과 주문 권한은 별개입니다.',
  trading_store_unavailable:'매매 저장소를 사용할 수 없습니다. 서버와 SQL 적용·권한을 확인해 주세요.',
  authentication_required:'로그인 후 사용할 수 있습니다.',trading_disabled:'운영자가 자동매매 실행을 활성화하지 않았습니다. 저장만으로 주문은 시작되지 않습니다.',
  trading_unavailable:'매매 상태를 불러오지 못했습니다. 서버와 SQL 적용 상태를 확인한 뒤 다시 시도해 주세요.',
  trading_watchlist_required:'현재 관심종목만 설정·시작할 수 있습니다.',trading_strategy_changed:'전략이 변경되거나 삭제되었습니다. 최신 전략으로 다시 저장해 주세요.',
  trading_config_changed:'저장 설정이 변경되었습니다. 최신 상태를 불러와 주세요.',trading_conflict:'다른 화면에서 상태가 변경되었습니다. 다시 확인해 주세요.',
  trading_broker_unsupported:'선택한 증권사의 필요한 주문·복구 기능을 지원하지 않습니다.',trading_account_unavailable:'본인 계좌와 주문 권한을 확인하지 못했습니다.',
  trading_credentials_changed:'개인 API가 변경되었습니다. 연결을 다시 확인해 주세요.',trading_external_order_conflict:'같은 종목에 기존 미체결 주문이 있어 시작할 수 없습니다.',
  trading_external_holding_conflict:'기존 보유분이 있습니다. 임의로 합산하지 않습니다. 보유분 관리를 명시적으로 선택해 주세요.',
  trading_holding_invalid:'선택한 보유수량과 평균 매입가를 확인할 수 없습니다.',trading_preview_changed:'확인 중 계좌 상태가 바뀌었습니다. 시작 정보를 다시 확인해 주세요.',
  trading_preview_expired:'시작 확인 시간이 만료되었습니다. 계좌 상태를 다시 확인해 주세요.',trading_invalid_strategy:'전략과 수량·최초 실행 방식을 확인해 주세요.',
  trading_not_found:'이 실행을 찾을 수 없습니다.',trading_active_conflict:'같은 계좌·종목이 이미 실행 중입니다.',
}
export async function tradingApi(path='',{userId,body,signal}={}) {
  const {data}=supabase?await supabase.auth.getSession():{data:{session:null}}
  if(!userId || data.session?.user?.id!==userId)throw new Error(tradingMessages.authentication_required)
  const response=await fetch(`/api/agent/trading${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.session.access_token}`},credentials:'same-origin',...(body?{body:JSON.stringify(body)}:{}),signal})
  const result=await response.json().catch(()=>({error:'trading_unavailable'}))
  if(!response.ok)throw Object.assign(new Error(tradingMessages[result.error] || '요청 결과를 확인하지 못했습니다. 최신 상태를 다시 조회해 주세요.'),{code:result.error})
  return result
}
