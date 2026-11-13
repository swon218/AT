import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

let moduleId = 0
async function fixture(t, session, fetcher) {
  const previousFetch = globalThis.fetch
  globalThis.__atlasCredentialApiSession = session
  globalThis.fetch = fetcher
  t.after(() => { globalThis.fetch = previousFetch; delete globalThis.__atlasCredentialApiSession })
  // Load the production request code, replacing only the browser environment
  // and Supabase dependency. No alternative mutation implementation is tested.
  const source = (await readFile(new URL('../src/services/accountSettingsApi.js',import.meta.url),'utf8'))
    .replace("import { supabase } from './supabaseClient'", 'const supabase = {auth:{getSession:()=>globalThis.__atlasCredentialApiSession()}}')
    .replace("import.meta.env.VITE_API_BASE_URL ?? ''", "''")
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// fixture ${++moduleId}`).toString('base64')}`)
}
const owner = 'fixture-owner'
const sessionValue = {data:{session:{user:{id:owner},access_token:'fixture-token'}}}
const version = '11111111-1111-4111-8111-111111111111'
const flush = () => new Promise(resolve => setImmediate(resolve))

test('settings read deadline also bounds stalled session restoration and prevents a late fetch',async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  let release, calls = 0
  const session = new Promise(resolve => { release = resolve })
  const api = await fixture(t,()=>session,async()=>{calls++;throw Error('must not fetch')})
  const pending = assert.rejects(api.getIntegrationSettings(owner),{code:'settings_read_timeout'})
  t.mock.timers.tick(12_000)
  await pending
  release(sessionValue); await flush()
  assert.equal(calls,0)
})

test('delete deadline marks an unknown result without retrying even if authentication stalls',async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  let release, calls = 0
  const session = new Promise(resolve => { release = resolve })
  const api = await fixture(t,()=>session,async()=>{calls++;throw Error('must not fetch')})
  const pending = assert.rejects(api.deleteIntegrationSettings('kiwoom',version,owner),error => error.code === 'settings_mutation_timeout' && error.resultUnknown === true)
  t.mock.timers.tick(15_000)
  await pending
  release(sessionValue); await flush()
  assert.equal(calls,0)
})

test('caller cancellation rejects a pending save and a late session cannot send it',async t => {
  let release, calls = 0
  const session = new Promise(resolve => { release = resolve })
  const api = await fixture(t,()=>session,async()=>{calls++;throw Error('must not fetch')})
  const controller = new AbortController()
  const pending = assert.rejects(api.saveIntegrationSettings({expectedVersion:version,nhAppKey:'fixture',nhSecretKey:'fixture'},owner,{signal:controller.signal}),error => error.message === 'fixture canceled' && error.resultUnknown === true)
  controller.abort(new Error('fixture canceled'))
  await pending
  release(sessionValue); await flush()
  assert.equal(calls,0)
})

test('HTTP conflict remains a definitive safe error and DELETE carries only its expected version once',async t => {
  const calls=[]
  const api=await fixture(t,async()=>sessionValue,async(path,options)=>{
    calls.push({path,...options})
    return new Response(JSON.stringify({code:'settings_conflict',error:'저장 상태를 다시 확인해 주세요.'}),{status:409})
  })
  await assert.rejects(api.deleteIntegrationSettings('nh',version,owner),error => error.status === 409 && error.code === 'settings_conflict' && error.resultUnknown === false)
  assert.equal(calls.length,1)
  assert.equal(calls[0].path,'/api/account/settings/nh')
  assert.equal(calls[0].method,'DELETE')
  assert.deepEqual(JSON.parse(calls[0].body),{expectedVersion:version})
  assert.throws(()=>api.deleteIntegrationSettings('other',version,owner),/증권사/)
  assert.equal(calls.length,1)
})
