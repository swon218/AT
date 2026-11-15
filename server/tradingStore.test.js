import assert from 'node:assert/strict'
import test from 'node:test'
import {createTradingStore} from './tradingStore.js'

test('trading store sends only service RPC contract and returns safe error codes without DB details',async()=>{
 let args
 const store=createTradingStore({client:{rpc(name,payload){args={name,payload};return Promise.resolve({data:{ok:true},error:null})}}})
 assert.deepEqual(await store.call('context','owner',{safe:'value'}),{ok:true})
 assert.deepEqual(args,{name:'atlas_trading_rpc',payload:{p_action:'context',p_actor:'owner',p_payload:{safe:'value'}}})
 const failure=message=>createTradingStore({client:{rpc(){return Promise.resolve({data:null,error:{message}})}}}).call('context','owner')
 await assert.rejects(failure('internal diagnostic secret body trading_revision_conflict'),error=>error.code==='trading_revision_conflict'&&!error.message.includes('secret'))
 await assert.rejects(failure('unknown SQL internal secret'),error=>error.code==='trading_store_unavailable'&&error.statusCode===503&&!error.message.includes('secret'))
 await assert.rejects(createTradingStore({client:{rpc(){throw Error('private transport credentials')}}}).call('context','owner'),error=>error.code==='trading_store_unavailable'&&!error.message.includes('credentials'))
})
