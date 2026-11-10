import assert from 'node:assert/strict'
import test from 'node:test'
import {createAgentFundamentalData} from './agentFundamentalData.js'
import {createCompanyDart} from './companyDart.js'
import {DartError} from './dartClient.js'
import {dartFixtureDatabase,fixtureOptions,fixtureTransport,primary} from '../tests/support/companyDartFixture.js'

const finance={code:'005930',scope:'CFS',period_type:'annual',basis:'single_period',year:2025,quarter:null,compare_to_year:2024,metrics:['sales','operating','net']}
const identity={code:'005930',corp_code:'00126380',name:'삼성전자'}
const period=(year,values={sales:'9007199254740993',operating:'0',net:'-5'})=>({year,quarter:null,scope:'CFS',currency:'KRW',end:`${year}-12-31`,filedOn:`${year+1}-03-20`,collectedAt:'2026-04-01T00:00:00Z',receipt:`${year+1}0320000001`,corrected:false,values,accounts:{sales:'revenue',operating:'operating',net:'net'}})
const snapshot=(data,status='ready')=>({status,identity,checkedAt:'2026-10-27T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z',data})
const adapter=(value,extra={})=>createAgentFundamentalData({configured:()=>true,scope:()=> 'fixture',service:{read:async(code,query,options)=>{assert.equal(options.refresh,false);return structuredClone(value)}},...extra})

test('existing SQL snapshots, mappings and normalized amounts are reused with no AI-triggered collection',async t=>{
 const {db,store}=await dartFixtureDatabase();t.after(()=>db.close())
 const {transport,controls}=fixtureTransport()
 const service=createCompanyDart({store,transport,key:'fixture',options:fixtureOptions})
 await service.syncCodes()
 for(const query of [{section:'overview'},{section:'financials',scope:'CFS'},{section:'financials',scope:'OFS'},{section:'business'},{section:'disclosures',start:'2026-01-01',end:'2026-10-27',page:1,type:'all'}]){
  await service.read(primary.symbol,query);await service.drain()
 }
 const api=createAgentFundamentalData({service,configured:()=>true,scope:()=> 'fixture'})
 const before=controls.calls.length
 let calls=0;const permit=()=>{calls++;return calls<=2}
 const profile=await api.read('get_company_profile',{code:primary.symbol},permit)
 assert.equal(profile.status,'success');assert.equal(profile.corp_code,primary.corp_code);assert.equal(calls,2)
 const result=await api.read('get_company_financials',{...finance,code:primary.symbol})
 assert.equal(result.items[0].values.sales,'9007199254740993');assert.equal(result.items[0].values.operating,'0')
 assert.equal(result.items[0].scope,'CFS');assert.equal(result.items[0].url.endsWith(result.items[0].receipt),true)
 const separate=await api.read('get_company_financials',{...finance,code:primary.symbol,scope:'OFS'})
 assert.equal(separate.items[0].values.sales,'450000')
 const business=await api.read('get_company_business',{code:primary.symbol})
 assert.equal(business.sections.length>0,true)
 const missing=await api.read('get_company_disclosures',{code:primary.symbol,start_date:'2025-01-01',end_date:'2025-01-01',type:'all',page:2})
 assert.equal(missing.code,'dart_data_not_collected')
 await service.drain();assert.equal(controls.calls.length,before)
 assert.equal(api.status().fundamental.read_mode,'stored_snapshot')
})

test('exact comparisons preserve zero/negative amounts, reject units/accounts/basis and absent years',async()=>{
 let saved=snapshot({annual:[period(2025),period(2024,{sales:'9007199254740990',operating:'0',net:'-10'})]})
 let value=await adapter(saved).read('get_company_financials',finance)
 assert.equal(value.comparison.items[0].change,'3')
 assert.equal(value.comparison.items[0].percent,'0.00')
 assert.deepEqual(value.comparison.items.slice(1).map(item=>item.reason),['zero_base','negative_base'])
 assert.equal(value.comparison.items[1].percent,null);assert.equal(value.status,'partial')
 saved.data.annual[1].currency='USD'
 value=await adapter(saved).read('get_company_financials',finance)
 assert.ok(value.comparison.items.every(item=>item.reason==='incompatible_scope_currency_or_period'))
 saved.data.annual[1].currency='KRW';saved.data.annual[1].accounts.sales='unmatched'
 value=await adapter(saved).read('get_company_financials',finance)
 assert.equal(value.comparison.items[0].reason,'account_identity_mismatch')
 assert.equal((await adapter(saved).read('get_company_financials',{...finance,year:2015})).code,'financial_period_not_available')
 assert.equal((await adapter(saved).read('get_company_financials',{...finance,basis:'cumulative'})).code,'unsupported_financial_basis')
 assert.equal((await adapter(saved).read('get_company_financials',{...finance,metrics:['margin']})).code,'unsupported_comparison_metric')
 assert.equal((await adapter(saved).read('get_company_financials',{...finance,period_type:'quarterly',quarter:null})).code,'incomparable_periods')
})

test('quarterly single periods, stale/corrected reports and missing cells stay explicit',async()=>{
 const row={...period(2026,{sales:'120',operating:null}),quarter:2,end:'2026-06-30',filedOn:'2026-08-15',receipt:'20260815000001',corrected:true}
 const result=await adapter(snapshot({quarterly:[row]},'stale')).read('get_company_financials',{...finance,year:2026,quarter:2,period_type:'quarterly',compare_to_year:null})
 assert.equal(result.status,'partial');assert.equal(result.stale,true)
 assert.equal(result.items[0].basis,'single_quarter');assert.equal(result.items[0].values.operating,null)
 assert.equal(result.items[0].corrected,true);assert.match(result.correction_policy,/접수번호/)
})

test('filings preserve page/type/date limits and never claim body access; genuine empty distinct from cold/error',async()=>{
 const saved=snapshot({items:[{receipt:'20261020000001',filedOn:'2026-10-20',title:'[기재정정] 사업보고서',type:'periodic',corrected:true}],pages:2,total:31,hasNext:true})
 const args={code:'005930',start_date:'2026-01-01',end_date:'2026-10-27',type:'all',page:1}
 let result=await adapter(saved).read('get_company_disclosures',args)
 assert.equal(result.status,'partial');assert.equal(result.items[0].body_available,false);assert.equal(result.has_next,true)
 saved.data={items:[],pages:0,total:0,hasNext:false}
 assert.equal((await adapter(saved).read('get_company_disclosures',args)).status,'empty')
 assert.equal((await adapter({status:'loading'}).read('get_company_profile',{code:'005930'})).code,'dart_data_not_collected')
 assert.equal((await adapter({status:'unsupported'}).read('get_company_profile',{code:'005930'})).code,'dart_company_mapping_missing')
 for(const patch of [{start_date:'2026-02-30'},{end_date:'2999-01-01'},{page:101},{start_date:'2020-01-01'}])assert.equal((await adapter(saved).read('get_company_disclosures',{...args,...patch})).code,'dart_invalid_query')
 for(const code of ['dart_rate_limit','dart_timeout','dart_database_permission']) {
  const api=createAgentFundamentalData({configured:()=>true,service:{read:async()=>{throw new DartError(code)}}})
  assert.equal((await api.read('get_company_profile',{code:'005930'})).code,code)
 }
})

test('snapshot cache coalesces public reads and separates credentials; budget refusal never starts collection',async()=>{
 let calls=0,version='one',clock=Date.now()
 const service={read:async(code,args,options)=>{calls++;assert.equal(options.refresh,false);if(!options.beforeRead()||!options.beforeRead())throw new DartError('external_request_limit');return snapshot({company:{name:'삼성전자'}})}}
 const api=createAgentFundamentalData({service,scope:()=>version,configured:()=>true,now:()=>clock})
 await Promise.all([api.read('get_company_profile',{code:'005930'}),api.read('get_company_profile',{code:'005930'})]);assert.equal(calls,1)
 version='two';await api.read('get_company_profile',{code:'005930'});assert.equal(calls,2)
 clock+=6000;assert.equal((await api.read('get_company_profile',{code:'005930'},()=>false)).code,'external_request_limit')
 assert.equal(calls,3)
 assert.equal((await api.read('get_company_profile',{code:'005930',url:'http://untrusted'})).code,'invalid_arguments')
 assert.equal((await api.read('sql',{code:'005930'})).code,'invalid_arguments')
})
