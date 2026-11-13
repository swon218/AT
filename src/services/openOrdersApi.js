import {supabase} from './supabaseClient'
export async function openOrdersRequest(broker,{accountRef='',input,signal}={}){
  if(!supabase)throw Error('로그인 환경을 확인해 주세요.')
  const {data}=await supabase.auth.getSession()
  const token=data.session?.access_token
  if(!token)throw Error('로그인이 필요합니다.')
  const response=await fetch(`/api/order-management${input?'':`?${new URLSearchParams({broker,accountRef})}`}`,{
    method:input?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(input?{'Content-Type':'application/json'}:{})},
    ...(input?{body:JSON.stringify({...input,broker})}:{}),signal})
  let value
  try{value=await response.json()}catch{throw Object.assign(Error(input?'결과 확인 필요 · 재전송하지 말고 증권사 앱에서 확인해 주세요.':'미체결 응답을 확인하지 못했습니다.'),{code:input?'outcome_uncertain':'invalid_response'})}
  if(!response.ok)throw Object.assign(Error(value.error||'요청을 처리하지 못했습니다.'),{code:value.code})
  return value
}
