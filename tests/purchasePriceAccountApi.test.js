import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let sequence = 0
async function fixture(t, session, fetcher) {
  globalThis.__purchaseSession = session
  t.after(() => { delete globalThis.__purchaseSession })
  t.mock.method(globalThis, 'fetch', fetcher)
  const source = (await readFile(new URL('../src/services/kiwoomAccountApi.js', import.meta.url), 'utf8'))
    .replace("import { supabase } from './supabaseClient'", 'const supabase={auth:{getSession:()=>globalThis.__purchaseSession()}}')
    .replace("'../utils/brokers'", JSON.stringify(new URL('../src/utils/brokers.js', import.meta.url).href))
    .replace("import.meta.env.VITE_API_BASE_URL ?? ''", "''")
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${++sequence}`).toString('base64')}`)
}
const session = id => ({ data: { session: id ? { user: { id }, access_token: 'fixture-only' } : null } })

test('account read requires the expected signed-in user and forwards only selected broker/account/symbol', async t => {
  const api = await fixture(t, async () => session('user-a'), async (url, options) => {
    assert.equal(url, '/api/account/nh/summary?symbol=005930&accountId=opaque-ref')
    assert.equal(options.headers.Authorization, 'Bearer fixture-only')
    assert.ok(options.signal instanceof AbortSignal)
    return new Response(JSON.stringify({ broker: 'nh', selectedAccountId: 'opaque-ref', holdings: [] }))
  })
  await assert.rejects(api.getBrokerAccountSummary('toss', '005930', '', { userId: 'user-b' }), /계정이 변경/)
  assert.deepEqual(await api.getBrokerAccountSummary('nh', '005930', 'opaque-ref', { userId: 'user-a' }), { broker: 'nh', selectedAccountId: 'opaque-ref', holdings: [] })
})

test('logout and cancelled late authentication never start a personal account request', async t => {
  let release, calls = 0
  const pending = new Promise(resolve => { release = resolve })
  const api = await fixture(t, () => pending, async () => { calls++; throw Error('unexpected') })
  const controller = new AbortController()
  const read = api.getBrokerAccountSummary('toss', '005930', '', { userId: 'user-a', signal: controller.signal })
  controller.abort(); release(session('user-a'))
  await assert.rejects(read, { name: 'AbortError' })
  globalThis.__purchaseSession = async () => session(null)
  await assert.rejects(api.getBrokerAccountSummary('toss', '005930'), /로그인/)
  assert.equal(calls, 0)
})

test('bounded account timeout is a failure and does not retry or return an empty holding', async t => {
  const deadline = new AbortController(); let calls = 0
  t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 25_000); return deadline.signal })
  const api = await fixture(t, async () => session('user-a'), async (url, { signal }) => {
    calls++
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const read = api.getBrokerAccountSummary('toss', '005930')
  await new Promise(resolve => setImmediate(resolve)); deadline.abort()
  await assert.rejects(read, /조회 시간이 초과/)
  assert.equal(calls, 1)
})

test('business errors and invalid JSON remain errors rather than successful zero-valued holdings', async t => {
  let mode = 'business'
  const api = await fixture(t, async () => session('user-a'), async () => mode === 'business'
    ? new Response(JSON.stringify({ error: '모의 계좌 조회 실패' }), { status: 502 })
    : new Response('<not-json>'))
  await assert.rejects(api.getBrokerAccountSummary('kiwoom', '005930'), /모의 계좌 조회 실패/)
  mode = 'parse'
  await assert.rejects(api.getBrokerAccountSummary('kiwoom', '005930'), /API 응답/)
})

test('legacy Kiwoom route metadata is compatible without relabelling another explicit provider', async t => {
  let payload = { holdings: [{ code: '005930', quantity: 10, averagePrice: 200000 }] }
  const api = await fixture(t, async () => session('user-a'), async () => new Response(JSON.stringify(payload)))
  assert.deepEqual(await api.getBrokerAccountSummary('kiwoom'), { ...payload, broker: 'kiwoom' })
  payload = { ...payload, broker: 'toss' }
  assert.equal((await api.getBrokerAccountSummary('kiwoom')).broker, 'toss')
})
