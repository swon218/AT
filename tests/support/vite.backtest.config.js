import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// Synthetic public candles only. No environment file, SQLite, broker, AI or
// Supabase client is used by this fixture. Every other API route is blocked.
const items=[]
for(let day=new Date('2025-01-02T00:00:00Z');items.length<80;day.setUTCDate(day.getUTCDate()+1)){
  if([0,6].includes(day.getUTCDay()))continue
  const i=items.length,open=100+(i%12)*3,close=open+(i%3-1)*2
  items.push({time:day.toISOString().slice(0,10),open,high:Math.max(open,close)+10,low:Math.min(open,close)-10,close,volume:10000+i,tradable:1,quality:'raw'})
}
const calls=[]
export default defineConfig({
  envDir:false,
  define:{'import.meta.env.VITE_API_BASE_URL':'""','import.meta.env.VITE_SUPABASE_URL':'""','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'""'},
  plugins:[react(),{name:'backtest-v2-isolated-api',configureServer(server){
    server.middlewares.use((req,res,next)=>{
      const url=new URL(req.url,'http://localhost')
      if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/__fixture/'))return next()
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
      if(url.pathname==='/__fixture/backtest/report'&&req.method==='GET'){res.end(JSON.stringify({requests:calls,synthetic:true,realApiCalls:0}));return}
      calls.push({method:req.method,path:url.pathname,symbol:url.searchParams.get('symbol')})
      if(url.pathname==='/api/public/lab/candles'&&req.method==='GET'&&url.searchParams.get('symbol')==='999999'){
        res.end(JSON.stringify({items,symbol:{code:'999999',name:'모의 검증 종목',market:'모의',source:'fixture',updated_at:'2025-04-23T00:00:00Z'},quality:{corrected:0,quarantined:0,issues:[]}}));return
      }
      res.statusCode=403;res.end(JSON.stringify({error:'모의 검증 환경에서는 이 API를 호출할 수 없습니다.',code:'fixture_only'}))
    })
  }}],server:{host:'127.0.0.1',port:5185,strictPort:true},
})
