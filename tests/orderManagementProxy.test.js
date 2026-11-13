import test from 'node:test'
import assert from 'node:assert/strict'
import proxy from '../api/order-management.js'
function response(){return {code:0,headers:{},setHeader(k,v){this.headers[k]=v},status(v){this.code=v;return this},json(value){this.value=value;return this}}}
test('fixed proxy authenticates, whitelists broker/ref, forwards only bearer and fixed path; POST failure remains unknown',async()=>{
  const old=global.fetch,origin=process.env.ATLAS_API_ORIGIN;process.env.ATLAS_API_ORIGIN='https://api.example.test'
  const calls=[];global.fetch=async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify({items:[],status:'success'}),{status:200})}
  try{
    let res=response();await proxy({method:'GET',headers:{},query:{broker:'kiwoom'}},res);assert.equal(res.code,401);assert.equal(calls.length,0)
    res=response();await proxy({method:'GET',headers:{authorization:'Bearer fixture',cookie:'private'},query:{broker:'kiwoom',accountRef:'a'.repeat(32),url:'https://evil.test'}},res)
    assert.equal(res.code,200);assert.equal(calls[0].url,`https://api.example.test/api/account/orders/open?broker=kiwoom&accountRef=${'a'.repeat(32)}`);assert.equal(calls[0].options.headers.cookie,undefined)
    res=response();await proxy({method:'POST',headers:{authorization:'Bearer fixture'},body:{broker:'../bad'}},res);assert.equal(res.code,400);assert.equal(calls.length,1)
    global.fetch=async()=>{throw Error('secret account raw response')}
    res=response();await proxy({method:'POST',headers:{authorization:'Bearer fixture'},body:{broker:'toss',action:'cancel'}},res)
    assert.equal(res.code,502);assert.equal(res.value.code,'outcome_uncertain');assert.equal(JSON.stringify(res.value).includes('secret'),false)
  }finally{global.fetch=old;if(origin===undefined)delete process.env.ATLAS_API_ORIGIN;else process.env.ATLAS_API_ORIGIN=origin}
})
