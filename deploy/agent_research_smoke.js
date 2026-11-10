// Operator-only, read-only source probe. Does not run a model, create a request,
// change member data, warm DART caches, send messages or submit orders.
import {agentResearchData} from '../server/agentResearchData.js'
import {dateInKorea} from '../server/dartData.js'

const [mode,code='005930',start=dateInKorea(-30),end=dateInKorea()]=process.argv.slice(2)
if(!['market','fundamental'].includes(mode)||!/^[0-9][0-9A-Z]{5}$/.test(code))throw new Error('Usage: market|fundamental [code] [start YYYY-MM-DD] [end YYYY-MM-DD]')
const day=dateInKorea()
const queries=mode==='market'?[
 ['get_market_quote',{code,market:'KRX'}],
 ['get_intraday_bars',{code,market:'KRX',kind:'minute',interval:5,start_date:day,end_date:day,limit:24}],
 ['get_intraday_bars',{code,market:'KRX',kind:'tick',interval:1,start_date:day,end_date:day,limit:24}],
]:[
 ['get_company_profile',{code}],
 ['get_company_financials',{code,scope:'CFS',period_type:'annual',basis:'single_period',year:null,quarter:null,compare_to_year:null,metrics:['sales','operating','net']}],
 ['get_company_disclosures',{code,start_date:start,end_date:end,type:'all',page:1}],
 ['get_company_business',{code}],
]
let calls=0
for(const [tool,args]of queries){
 const value=await agentResearchData.read(tool,args,()=>{if(calls>=8)throw Object.assign(new Error(),{safeCode:'external_request_limit'});calls++})
 console.log(JSON.stringify({tool,status:value.status,error_code:value.status==='error'?value.code||'unknown':null,
   symbol_match:(value.code_symbol||value.code)===code,price_contract:tool==='get_market_quote'?Number.isFinite(value.price)&&value.price>0:null,
   corp_mapping:Boolean(value.corp_code),items:value.items?.length??value.sections?.length??null,
   provider_at:value.provider_at??null,collected_at:value.collected_at??null,queried_at:value.queried_at??null,
   stale:value.stale??null,delay:value.delay??null,more_available:value.more_available??value.has_next??null,
   requested_period:value.requested_period??null,returned_period:value.returned_period??null,
   original_links_valid:(value.items||[]).every(item=>!item.receipt||item.url?.startsWith('https://dart.fss.or.kr/')),
   exact_amounts:(value.items||[]).every(item=>!item.values||Object.values(item.values).every(number=>number===null||typeof number==='string'||typeof number==='number')),
   collection_triggered:value.collection_triggered??null}))
}
