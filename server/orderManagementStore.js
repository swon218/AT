import {createClient} from '@supabase/supabase-js'
import {config} from './config.js'
export function createOrderManagementStore({client}={}){
  let db=client
  return {async call(op,actor,p){
    try{
      if(!db){if(!config.supabaseUrl||!config.supabaseSecretKey)throw Error();db=createClient(config.supabaseUrl,config.supabaseSecretKey,{auth:{persistSession:false,autoRefreshToken:false}})}
      const {data,error}=await db.rpc('atlas_order_management_rpc',{op,actor,p}).abortSignal(AbortSignal.timeout(8000))
      if(error){const conflict=/request_conflict|order_locked/.exec(error.message||'');if(conflict)throw Object.assign(Error(conflict[0]==='order_locked'?'이 원주문의 변경 요청이 이미 처리 중이거나 결과 확인이 필요합니다.':'같은 요청 식별자로 다른 내용을 보낼 수 없습니다.'),{code:conflict[0],statusCode:409,safeOrderError:true});throw Error()}
      return data
    }catch(e){if(e.statusCode===409)throw e;throw Object.assign(Error('주문 관리 저장소를 사용할 수 없습니다. SQL 적용과 권한을 확인해 주세요.'),{code:'management_store_unavailable',statusCode:503,safeOrderError:true})}
  }}
}
