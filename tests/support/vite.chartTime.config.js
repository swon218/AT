import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
const calls=[]
function candles(interval,symbol){
  const minute=interval.endsWith('분'),step=Number.parseInt(interval)||1
  const result=[]
  if(minute){
    for(const date of ['2026-11-13','2026-11-16'])for(let m=480;m<=1200;m+=step){
      const time=Date.parse(`${date}T00:00:00+09:00`)/1000+m*60
      const n=result.length,open=10000+n*2+(symbol==='000002'?1000:0)
      result.push({time,open,high:open+20,low:open-15,close:open+5,volume:100+n})
    }
  }else for(let n=0;n<80;n++){
    const date=new Date(Date.UTC(2026,5,n+1)).toISOString().slice(0,10),open=10000+n*2
    result.push({time:date,open,high:open+20,low:open-15,close:open+5,volume:100+n})
  }
  return result
}
export default defineConfig({envDir:false,plugins:[react(),{name:'chart-time-fixture-only',configureServer(server){server.middlewares.use((req,res,next)=>{
  if(!req.url.startsWith('/api/'))return next()
  const url=new URL(req.url,'http://localhost'),match=url.pathname.match(/^\/api\/public\/market\/(kiwoom|toss|nh|kb)\/candles$/)
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
  if(url.pathname==='/api/fixture/requests'){res.end(JSON.stringify(calls));return}
  if(!match){res.statusCode=403;res.end('{"error":"Fixture blocks all other APIs"}');return}
  const q=Object.fromEntries(url.searchParams);calls.push({broker:match[1],...q,aborted:false})
  const call=calls.at(-1);res.on('close',()=>{if(!res.writableEnded)call.aborted=true})
  const respond=()=>{
    if(res.destroyed)return
    if(q.symbol==='000004'){res.statusCode=502;res.end('{"error":"모의 통신 실패 · 빈 결과와 구분"}');return}
    const items=q.symbol==='000003'?[]:candles(q.interval,q.symbol)
    // 1-minute synthetic scope retains specific boundary examples; this is not a full-day claim.
    const selected=q.interval==='1분'?items.filter((_,i)=>i%10===0):items.slice(-Number(q.limit))
    res.end(JSON.stringify({sourceBroker:match[1],items:selected,meta:{market:q.market||'PROVIDER',sessionCoverage:q.includeExtended==='true'?'all-requested':'provider-defined-unverified',timestampMeaning:match[1]==='toss'?'end':match[1]==='kiwoom'?'start':'provider',requestedLimit:Number(q.limit),returnedCount:selected.length,requestedInterval:q.interval,partial:q.symbol==='000005',fullDay:false,rangeMode:'recent',aggregation:match[1]==='toss'&&q.interval!=='1분'?'resampled':'direct'}}))
  }
  if(q.symbol==='000006')setTimeout(respond,2000);else respond()
})}}],resolve:{alias:[{find:'lightweight-charts',replacement:fileURLToPath(new URL('./chartTimeCharts.js',import.meta.url))}]},server:{host:'127.0.0.1',port:5183,strictPort:true}})
