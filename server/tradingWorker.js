import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The worker can only ask the loopback API for a fenced tick. It has no broker
// credentials, DB role, browser session, or order body of its own.
export function createTradingWorker({origin=process.env.ATLAS_TRADING_API_ORIGIN || 'http://127.0.0.1:3000',secret=process.env.ATLAS_TRADING_INTERNAL_SECRET || '',fetcher=fetch}={}) {
  const base=new URL(origin)
  if(base.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(base.hostname) || base.pathname!=='/' || base.username || base.password || base.search || base.hash) throw new Error('trading_loopback_required')
  return async () => {
    if(secret.length<32) return {status:'disabled',reason:'internal_secret_missing'}
    const response=await fetcher(new URL('/api/internal/trading/tick',base),{method:'POST',headers:{'X-Atlas-Trading':secret,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(180000),redirect:'error'})
    if(!response.ok) throw new Error('trading_tick_unavailable')
    const result=await response.json()
    // Never forward session ids, account details or broker responses to journald.
    return {status:typeof result.status==='string'?result.status:'ok',processed:Number(result.processed)||0}
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let closing=false
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{closing=true})
  const tick=createTradingWorker()
  do {
    try { console.info(JSON.stringify(await tick())) } catch { console.warn(JSON.stringify({status:'unavailable'})) }
    if(!process.argv.includes('--loop') || closing)break
    await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timeout);for(const signal of ['SIGTERM','SIGINT'])process.off(signal,finish);resolve()}
      const timeout=setTimeout(finish,10000)
      for(const signal of ['SIGTERM','SIGINT'])process.once(signal,finish)
    })
  }while(!closing)
}
