import test from 'node:test'
import assert from 'node:assert/strict'
import { createMarketRequestContext } from './marketContext.js'

const account = (id = 'fixture-owner', key = 'fixture-key', secret = 'fixture-secret') => ({
  user: { id }, status: { kiwoomConfigured: Boolean(key && secret) },
  credentials: { ...(key ? { kiwoomAppKey: key } : {}), ...(secret ? { kiwoomSecretKey: secret } : {}) },
})

test('personal realtime token use revalidates the authenticated owner and current saved key before every connect', async () => {
  let current = account(), reads = 0
  const calls = []
  const context = await createMarketRequestContext({ authenticate: async request => {
    reads++
    assert.equal(request.headers.authorization, 'Bearer fixture-session')
    return current
  }, realtime: async auth => { calls.push(auth); return { token: 'fixture-realtime-token' } } })({ headers: { authorization: 'Bearer fixture-session' } })
  assert.deepEqual(await context.getRealtimeAuth(), { token: 'fixture-realtime-token' })
  assert.equal(reads, 2)
  assert.deepEqual(calls, [{ appKey: 'fixture-key', secretKey: 'fixture-secret' }])
  for (const changed of [account('fixture-owner', '', ''), account('fixture-owner', 'fixture-rotated', 'fixture-secret'), account('different-owner')]) {
    current = changed
    await assert.rejects(context.getRealtimeAuth(), { statusCode: 403 })
  }
  assert.equal(calls.length, 1, 'deleted or replaced credentials never reach token issuance')
  current = account()
  await context.getRealtimeAuth()
  assert.equal(calls.length, 2)
})

test('an expired personal session cannot fall back to operator realtime credentials; public operator use is unchanged', async () => {
  let expired = false, reads = 0, realtimeCalls = 0
  const factory = createMarketRequestContext({ authenticate: async () => {
    reads++
    if (expired) throw Object.assign(new Error('fixture expired session'), { statusCode: 401 })
    return account()
  }, realtime: async auth => { realtimeCalls++; return { personal: Boolean(auth) } } })
  const personal = await factory({ headers: { authorization: 'Bearer fixture-session' } })
  expired = true
  await assert.rejects(personal.getRealtimeAuth(), { statusCode: 401 })
  assert.equal(realtimeCalls, 0)
  const publicContext = await factory({ headers: {} })
  assert.deepEqual(await publicContext.getRealtimeAuth(), { personal: false })
  assert.equal(reads, 2, 'operator public flow does not authenticate a member')
})
