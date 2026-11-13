// Fixed authenticated order-management routes only. No cookies or arbitrary proxy target.
export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store')
  const error=(status,code,message)=>res.status(status).json({code,error:message})
  if(!['GET','POST'].includes(req.method))return error(405,'method_not_allowed','지원하지 않는 요청입니다.')
  if(!/^Bearer\s+\S+$/i.test(req.headers.authorization||''))return error(401,'unauthorized','로그인이 필요합니다.')
  const broker=req.method==='GET'?req.query?.broker:req.body?.broker
  if(!['kiwoom','toss','nh','kb'].includes(broker))return error(400,'invalid_broker','증권사를 확인해 주세요.')
  let origin
  try{origin=new URL(process.env.ATLAS_API_ORIGIN)}catch{return error(503,'proxy_unavailable','주문 API 연결 설정을 확인해 주세요.')}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)return error(503,'proxy_unavailable','주문 API 연결 설정을 확인해 주세요.')
  const target=new URL(req.method==='GET'?'/api/account/orders/open':`/api/orders/${broker}/manage`,origin)
  if(req.method==='GET'){
    const ref=req.query?.accountRef||''
    if(typeof ref!=='string'||ref&&!/^[a-f0-9]{32}$/.test(ref))return error(400,'invalid_account','계좌를 다시 선택해 주세요.')
    target.search=new URLSearchParams({broker,accountRef:ref}).toString()
  }
  const body=req.method==='POST'?JSON.stringify(req.body):undefined
  if(body&&Buffer.byteLength(body)>16000)return error(413,'invalid_request','요청 크기를 확인해 주세요.')
  try{
    const headers={Authorization:req.headers.authorization,...(body?{'Content-Type':'application/json'}:{})}
    // Keep the API's existing Origin allowlist in force.
    if(typeof req.headers.origin==='string')headers.Origin=req.headers.origin
    const upstream=await fetch(target,{method:req.method,headers,body,redirect:'error',signal:AbortSignal.timeout(38000)})
    const output=await upstream.text()
    if(Buffer.byteLength(output)>1000000)throw Error()
    const value=JSON.parse(output)
    if(!value||typeof value!=='object'||upstream.status===404)throw Error()
    return res.status(upstream.status).json(value)
  }catch{return error(502,req.method==='POST'?'outcome_uncertain':'proxy_unavailable',req.method==='POST'?'결과 확인 필요 · 재전송하지 말고 증권사 앱과 미체결 목록을 확인해 주세요.':'미체결 API에 연결하지 못했습니다.')}
}
