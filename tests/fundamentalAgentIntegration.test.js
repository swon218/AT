import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as wait} from 'node:timers/promises'
import {startHarness} from './support/agentHarness.js'
import {dartFixtureDatabase,fixtureOptions,fixtureTransport,primary} from './support/companyDartFixture.js'
import {createCompanyDart} from '../server/companyDart.js'
import {createAgentFundamentalData} from '../server/agentFundamentalData.js'
import {createAgentResearchData} from '../server/agentResearchData.js'

test('Node → Python production graph → authenticated Node → existing DART SQL cache, exact amounts and budget',async()=>{
 const {db,store}=await dartFixtureDatabase()
 const {transport,controls}=fixtureTransport()
 const service=createCompanyDart({store,transport,key:'fixture',options:fixtureOptions})
 let h
 try {
  await service.syncCodes()
  for(const section of ['overview','financials']) {await service.read(primary.symbol,{section,scope:'CFS'});await service.drain()}
  const before=controls.calls.length
  const dataService=createAgentResearchData({fundamental:createAgentFundamentalData({service,scope:()=> 'fixture',configured:()=>true})})
  h=await startHarness({port:13010,pythonPort:18020,dataService})
  const initial=await fetch(h.base+'/api/agent/status')
  const headers={'Content-Type':'application/json',cookie:initial.headers.get('set-cookie').split(';')[0]}
  const room=await(await fetch(h.base+'/api/agent/rooms',{method:'POST',headers,body:'{}'})).json()
  const id=randomUUID()
  assert.equal((await fetch(`${h.base}/api/agent/rooms/${room.id}/requests`,{method:'POST',headers,body:JSON.stringify({request_id:id,question:'삼성전자 연결 연간 재무를 알려줘'})})).status,202)
  let result
  for(let i=0;i<120;i++) {
   result=await(await fetch(`${h.base}/api/agent/requests/${id}`,{headers})).json()
   if(result.status!=='running')break
   await wait(100)
  }
  assert.equal(result.status,'completed',JSON.stringify(result))
  assert.equal(result.answer.execution.architecture,'atlas-langgraph-research-v1')
  assert.ok(result.steps.some(step=>step.agent==='fundamental'&&step.name==='get_company_financials'))
  const sales=result.answer.sources.find(source=>source.metric==='sales')
  assert.equal(sales.amount,'9007199254740993');assert.equal(sales.financial_scope,'CFS')
  assert.equal(sales.currency,'KRW');assert.match(sales.url,/^https:\/\/dart\.fss\.or\.kr\//)
  assert.equal(controls.calls.length,before)
  assert.equal(result.usage.external_requests,4)
  assert.equal((await fetch(h.base+'/api/internal/agent/data',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401)
 }finally {if(h)await h.close();await db.close()}
})
