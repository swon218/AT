import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'

const auth=fileURLToPath(new URL('./purchasePriceAuth.js',import.meta.url))
const orders=fileURLToPath(new URL('./orderLayoutApi.js',import.meta.url))
const charts=fileURLToPath(new URL('./purchasePriceCharts.js',import.meta.url))
const accounts=[{id:'a'.repeat(32),label:'모의 계좌 1'},{id:'b'.repeat(32),label:'모의 계좌 2'}]
const log=[]
function respond(res,status,payload){if(!res.destroyed){res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(payload))}}
function candles(symbol,interval){
 const minute=interval.endsWith('분'),step=minute?Number(interval.replace('분','')):1
 return Array.from({length:80},(_,index)=>{
  const close=195000+Math.round(Math.sin(index/7)*7000)+index*100+(symbol==='000660'?50000:0)
  const date=new Date(Date.UTC(2026,7,20+index))
  return {time:minute?Date.UTC(2026,10,13,0,0)/1000+index*step*60:date.toISOString().slice(0,10),open:close-300,high:close+900,low:close-1200,close,volume:1000+index*10}
 })
}
function summary(broker,user,scenario,accountId){
 const accountRequired=broker==='nh'&&!accounts.some(account=>account.id===accountId)
 const price=scenario==='outside'?800000:scenario==='updated'?210000:broker==='nh'&&accountId===accounts[1].id?250000:user==='b'?300000:200000
 const quantity=['sold','pendingBuy'].includes(scenario)?0:scenario==='partial'?5:scenario==='missingQuantity'?null:10
 let holdings=scenario==='notHeld'||accountRequired?[]:[{code:'005930',name:'삼성전자',quantity,averagePrice:scenario==='missingAverage'?null:price,tradableQuantity:0,purchaseAmount:quantity==null?null:price*quantity,currentPrice:205000,evaluationAmount:quantity==null?null:205000*quantity,evaluationProfit:0,profitRate:0}]
 if(scenario==='duplicate')holdings.push({...holdings[0],quantity:3,averagePrice:220000})
 if(broker==='kb')holdings=holdings.map(row=>({...row,purchasePriceQuantity:row.quantity,purchasePriceQuantityStatus:row.quantity==null||scenario==='kbUnsettled'?'unconfirmed':'verified'}))
 return {broker,holdings,accounts:broker==='nh'?accounts:[],selectedAccountId:broker==='nh'&&!accountRequired?accountId:'',accountRequired,orderableAmount:1000000,cash:1000000,updatedAt:new Date().toISOString()}
}

export default defineConfig({
 envDir:false,define:{'import.meta.env.VITE_API_BASE_URL':JSON.stringify('')},
 plugins:[react(),{name:'isolated-purchase-price-fixture',enforce:'pre',resolveId(id){if(/\/supabaseClient(?:\.js)?$/.test(id))return auth},configureServer(server){
  server.middlewares.use((req,res,next)=>{
   const url=new URL(req.url,'http://127.0.0.1:5184')
   if(url.pathname==='/__purchase_fixture/log'){respond(res,200,{account:log.filter(row=>row.kind==='account').length,candles:log.filter(row=>row.kind==='candles').length,labCandles:log.filter(row=>row.kind==='labCandles').length,requests:log});return}
   if(!url.pathname.startsWith('/api/')){next();return}
   const account=/^\/api\/account\/(kiwoom|toss|nh|kb)\/summary$/.exec(url.pathname)
   const chart=/^\/api\/public\/market\/(kiwoom|toss|nh|kb)\/candles$/.exec(url.pathname)
   if(req.method==='GET'&&url.pathname==='/api/public/lab/candles'){
    const symbol=url.searchParams.get('symbol')||'005930',items=candles(symbol,'일')
    log.push({kind:'labCandles',user:'public-fixture',symbol,at:Date.now()})
    respond(res,200,{items,quality:{corrected:0,quarantined:0,issues:[]},symbol:{code:symbol,name:symbol==='005930'?'삼성전자':'SK하이닉스',market:'KRX',source:'fixture:synthetic',updated_at:'2026-11-13T18:00:00+09:00',bar_count:items.length}})
    return
   }
   if(req.method!=='GET'||(!account&&!chart)){respond(res,403,{error:'격리 검증에서는 허용한 모의 읽기 경로만 사용할 수 있습니다.'});return}
   const token=/^Bearer purchase-fixture:(a|b):(\w+)$/.exec(req.headers.authorization||'')
   if(account&&!token){respond(res,401,{error:'로그인이 필요합니다.'});return}
   const [,user='guest',scenario='holding']=token||[]
   const broker=(account||chart)[1],symbol=url.searchParams.get('symbol')||'',accountId=url.searchParams.get('accountId')||''
   log.push({kind:account?'account':'candles',user,scenario,broker,symbol,account:accountId?accounts.findIndex(value=>value.id===accountId)+1:null,interval:url.searchParams.get('interval'),at:Date.now()})
   const send=()=>{
    if(account){respond(res,scenario==='error'?503:200,scenario==='error'?{error:'모의 보유정보 조회 실패'}:summary(broker,user,scenario,accountId));return}
    const interval=url.searchParams.get('interval')||'일',items=candles(symbol,interval)
    respond(res,200,{items,sourceBroker:broker==='kb'?'kiwoom':broker,fallback:broker==='kb',meta:{market:'KRX',requestedInterval:interval,requestedLimit:200,returnedCount:items.length,fullDay:false,partial:false,timestampMeaning:'start',sessionCoverage:'regular-requested'}})
   }
   if(scenario==='slow')setTimeout(send,3000);else send()
  })
 }}],
 resolve:{alias:[{find:'lightweight-charts',replacement:charts},{find:'../services/openOrdersApi',replacement:orders},{find:'../services/orderApi',replacement:orders}]},
 server:{host:'127.0.0.1',port:5184,strictPort:true},
})
