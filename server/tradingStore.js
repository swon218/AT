import {createClient} from '@supabase/supabase-js'
import {config} from './config.js'

const explanations={
 trading_auth_required:'로그인 후 사용할 수 있습니다.',trading_not_found:'설정 또는 실행을 찾을 수 없습니다.',
 trading_watchlist_required:'관심종목에 등록한 종목만 설정하고 실행할 수 있습니다.',
 trading_revision_conflict:'다른 화면에서 변경되었습니다. 최신 상태를 다시 불러와 주세요.',
 trading_request_conflict:'같은 실행 요청 식별자로 다른 실행을 시작할 수 없습니다.',
 trading_intent_conflict:'저장된 주문 작업과 요청 내용이 일치하지 않습니다.',
 trading_invalid_config:'종목·증권사·계좌·수량 설정을 확인해 주세요.',
 trading_strategy_conflict:'전략이 변경되었거나 삭제되었습니다. 전략을 다시 선택해 저장해 주세요.',
 trading_strategy_invalid:'유효한 전략 V2와 익절·손절 설정이 필요합니다.',
 trading_entry_action:'전략에 맞는 최초 실행 방식을 선택해 주세요.',
 trading_run_active:'같은 계좌와 종목의 실행이 이미 진행 중입니다.',
 trading_run_limit:'진행 중인 실행은 최대 20개입니다. 기존 실행 상태를 확인해 주세요.',
 trading_preview_limit:'실행 확인 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
 trading_confirmation_expired:'실행 확인이 만료되었습니다. 다시 확인해 주세요.',
 trading_insufficient_cash:'예약 금액을 제외한 주문가능 현금이 부족합니다.',
 trading_account_uncertain:'이 계좌의 주문 접수 결과를 먼저 확인해야 합니다.',
 trading_intent_active:'기존 주문을 확인한 후 다음 주문을 처리합니다.',
 trading_lease_lost:'실행 관리 권한이 만료되어 이번 처리를 중단했습니다.',
 trading_entry_blocked:'신규 진입이 중단된 실행입니다.',
 trading_fill_conflict:'체결 정보가 일치하지 않아 확인이 필요합니다.',
 trading_order_conflict:'주문 연결 정보가 일치하지 않아 확인이 필요합니다.',
 trading_unresolved_intent:'미확정 주문이 있어 정지 완료로 변경할 수 없습니다.',
}
export function tradingStoreError(code='trading_store_unavailable'){
 const safe=Object.hasOwn(explanations,code)?code:'trading_store_unavailable'
 return Object.assign(new Error(explanations[safe]||'매매 저장소를 사용할 수 없습니다. SQL 적용과 권한을 확인해 주세요.'),{code:safe,statusCode:safe==='trading_auth_required'?401:safe==='trading_not_found'?404:safe==='trading_store_unavailable'?503:safe.startsWith('trading_invalid_')?400:409,safeTradingError:true})
}
export function createTradingStore({client,timeoutMs=10000}={}){
 let db=client
 return {async call(action,actor=null,payload={}){
  try{
   if(!db){if(!config.supabaseUrl||!config.supabaseSecretKey)throw Error();db=createClient(config.supabaseUrl,config.supabaseSecretKey,{auth:{persistSession:false,autoRefreshToken:false}})}
   let request=db.rpc('atlas_trading_rpc',{p_action:action,p_actor:actor,p_payload:payload})
   if(typeof request.abortSignal==='function')request=request.abortSignal(AbortSignal.timeout(timeoutMs))
   const {data,error}=await request
   if(error){const code=/\b(trading_[a-z_]+)\b/.exec(error.message||'')?.[1];throw tradingStoreError(code)}
   return data
  }catch(error){if(error.safeTradingError)throw error;throw tradingStoreError()}
 }}
}
