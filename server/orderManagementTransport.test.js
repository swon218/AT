import test from 'node:test'
import assert from 'node:assert/strict'
import {requestKiwoomWithCredentials} from './kiwoomClient.js'
import {requestTossWithCredentials} from './tossClient.js'
test('Kiwoom write 401/HTTP200 error never retries; reads retry one rate limit and preserve continuation',async()=>{
  const old=global.fetch;let calls=[],mode='write'
  global.fetch=async(url,options)=>{
    if(String(url).endsWith('/oauth2/token'))return new Response(JSON.stringify({token:'fixture-token',expires_dt:'20991231235959'}))
    calls.push(options)
    if(mode==='write')return new Response(JSON.stringify({return_code:8005,return_msg:'Token이 유효하지 않습니다'}),{status:401})
    if(mode==='business')return new Response(JSON.stringify({return_code:10,return_msg:'요청 거절'}),{status:200})
    return calls.length===1?new Response(JSON.stringify({return_code:429,return_msg:'유량 제한'}),{status:200}):new Response(JSON.stringify({return_code:0,oso:[]}),{headers:{'cont-yn':'N','next-key':''}})
  }
  try{
    const base={appKey:'fixture-management-key',secretKey:'fixture-management-secret',apiId:'kt10003',endpoint:'/api/dostk/ordr',body:{}}
    await assert.rejects(requestKiwoomWithCredentials(base));assert.equal(calls.length,1)
    mode='business';calls=[];await assert.rejects(requestKiwoomWithCredentials(base));assert.equal(calls.length,1)
    mode='read';calls=[];const result=await requestKiwoomWithCredentials({...base,apiId:'ka10075',endpoint:'/api/dostk/acnt',nextKey:'cursor',contYn:'Y',returnPage:true,timeoutMs:6000})
    assert.equal(calls.length,2);assert.equal(result.body.return_code,0);for(const call of calls){assert.equal(call.headers['next-key'],'cursor');assert.equal(call.headers['cont-yn'],'Y')}
  }finally{global.fetch=old}
})
test('Toss modify 401 is never refreshed/replayed automatically',async()=>{
  const old=global.fetch;let writes=0
  global.fetch=async(url)=>{
    if(String(url).includes('/oauth2/token'))return new Response(JSON.stringify({access_token:'fixture-token',expires_in:86400}))
    writes++;return new Response(JSON.stringify({error:{code:'unauthorized'}}),{status:401})
  }
  try{await assert.rejects(requestTossWithCredentials({apiKey:'fixture-modify',secretKey:'fixture-secret',path:'/api/v1/orders/original/modify',method:'POST',accountSeq:1,body:{}}));assert.equal(writes,1)}finally{global.fetch=old}
})
