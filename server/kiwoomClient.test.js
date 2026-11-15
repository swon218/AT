import assert from 'node:assert/strict'
import test from 'node:test'
import { requestKiwoomWithCredentials, getKiwoomRealtimeAuth } from './kiwoomClient.js'
import { kiwoomFlow } from './kiwoomFlow.js'

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

test('전체 종목 연속조회 헤더와 응답 메타데이터를 인증 재시도에서도 보존한다', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let requests = 0
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/oauth2/token')) return jsonResponse({ token: `page-token-${requests}`, expires_dt: '20991231235959' })
    assert.equal(options.headers['cont-yn'], 'Y')
    assert.equal(options.headers['next-key'], 'second-page')
    if (++requests === 1) return jsonResponse({ return_code: 8005 }, 401)
    return new Response(JSON.stringify({ list: [{ code: '005930' }] }), { headers: { 'cont-yn': 'Y', 'next-key': 'third-page' } })
  }
  const page = await requestKiwoomWithCredentials({ appKey: 'pagination-key', secretKey: 'pagination-secret', apiId: 'ka10099', endpoint: '/api/dostk/stkinfo', body: { mrkt_tp: '0' }, contYn: 'Y', nextKey: 'second-page', returnPage: true })
  assert.equal(requests, 2)
  assert.equal(page.body.list[0].code, '005930')
  assert.equal(page.contYn, 'Y')
  assert.equal(page.nextKey, 'third-page')
})

test('8005 응답이면 토큰을 한 번 재발급하고 원래 요청을 재시도한다', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let tokenRequests = 0
  let apiRequests = 0
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/oauth2/token')) {
      tokenRequests += 1
      return jsonResponse({ token: `token-${tokenRequests}`, expires_dt: '20991231235959', return_code: 0 })
    }

    apiRequests += 1
    if (apiRequests === 1) {
      return jsonResponse({ return_code: 3, return_msg: '인증에 실패했습니다[8005:Token이 유효하지 않습니다]' })
    }
    return jsonResponse({ return_code: 0, items: ['ok'] })
  }

  const result = await requestKiwoomWithCredentials({
    appKey: 'retry-app-key',
    secretKey: 'retry-secret-key',
    apiId: 'test-api',
    endpoint: '/test',
    body: {},
  })

  assert.deepEqual(result.items, ['ok'])
  assert.equal(tokenRequests, 2)
  assert.equal(apiRequests, 2)
})

test('동시에 요청해도 같은 자격 증명의 토큰은 한 번만 발급한다', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let tokenRequests = 0
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/oauth2/token')) {
      tokenRequests += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return jsonResponse({ token: 'shared-token', expires_dt: '20991231235959', return_code: 0 })
    }
    return jsonResponse({ return_code: 0, value: 'ok' })
  }

  await Promise.all([
    requestKiwoomWithCredentials({ appKey: 'shared-app-key', secretKey: 'shared-secret-key', apiId: 'a', endpoint: '/a', body: {} }),
    requestKiwoomWithCredentials({ appKey: 'shared-app-key', secretKey: 'shared-secret-key', apiId: 'b', endpoint: '/b', body: {} }),
  ])

  assert.equal(tokenRequests, 1)
})

test('실시간 인증이 REST 토큰을 재사용하고 이전 연결의 무효화가 새 토큰을 지우지 않는다', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let tokenRequests = 0
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/oauth2/token')) {
      assert.equal(JSON.parse(options.body).appkey, 'ws-personal-key')
      return jsonResponse({ token: `ws-token-${++tokenRequests}`, expires_dt: '20991231235959' })
    }
    assert.equal(options.headers.authorization, 'Bearer ws-token-1')
    return jsonResponse({ return_code: 0 })
  }
  const credentials = { appKey: 'ws-personal-key', secretKey: 'ws-personal-secret' }
  const first = await getKiwoomRealtimeAuth(credentials)
  await requestKiwoomWithCredentials({ ...credentials, apiId: 'test', endpoint: '/test', body: {} })
  assert.equal(tokenRequests, 1)
  first.invalidate()
  const second = await getKiwoomRealtimeAuth(credentials)
  assert.equal(second.token, 'ws-token-2')
  first.invalidate()
  assert.equal((await getKiwoomRealtimeAuth(credentials)).token, second.token)
  assert.equal(tokenRequests, 2)
})

test('자동 주문 fence는 토큰·유량 대기 후 실제 fetch 직전에 정확히 한 번 실행된다', async t => {
  const previousFetch = globalThis.fetch, previousWait = kiwoomFlow.wait, events = []
  t.after(() => { globalThis.fetch = previousFetch; kiwoomFlow.wait = previousWait })
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth2/token')) { events.push('token'); return jsonResponse({ token: 'fixture-fenced-token', expires_dt: '20991231235959' }) }
    events.push('order-http'); return jsonResponse({ return_code: 0, ord_no: '0000101', dmst_stex_tp: 'KRX' })
  }
  kiwoomFlow.wait = async () => { events.push('flow-start'); await Promise.resolve(); events.push('flow-complete') }
  const result = await requestKiwoomWithCredentials({ appKey: 'fixture-fenced-order-key', secretKey: 'fixture-fenced-order-secret', apiId: 'kt10000', endpoint: '/api/dostk/ordr', body: {}, retry: false,
    beforeWrite: async () => { events.push('fenced-permit'); assert.equal(events.at(-2), 'flow-complete'); return true } })
  assert.equal(result.ord_no, '0000101')
  assert.deepEqual(events, ['token', 'flow-start', 'flow-complete', 'fenced-permit', 'order-http'])
})

test('유량 대기 중 정지·권한 만료 시 broker fetch는 없으며 오류 원문 없이 불명확 여부를 보존한다', async t => {
  const previousFetch = globalThis.fetch, previousWait = kiwoomFlow.wait
  t.after(() => { globalThis.fetch = previousFetch; kiwoomFlow.wait = previousWait })
  let orders = 0, flowComplete = false, guards = 0
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth2/token')) return jsonResponse({ token: 'fixture-stop-token', expires_dt: '20991231235959' })
    orders++; assert.fail('blocked fence reached broker order HTTP')
  }
  kiwoomFlow.wait = async () => { await Promise.resolve(); flowComplete = true }
  for (const [index, callback] of [async () => false, async () => { throw Object.assign(new Error('PRIVATE failed SQL original'), { writeGateUnknown: true }) }].entries()) {
    await assert.rejects(requestKiwoomWithCredentials({ appKey: `fixture-stopped-key-${index}`, secretKey: `fixture-stopped-secret-${index}`, apiId: 'kt10003', endpoint: '/api/dostk/ordr', body: {}, retry: false,
      beforeWrite: async () => { guards++; assert.equal(flowComplete, true); return callback() } }), error => {
      assert.ok(!error.message.includes('PRIVATE'))
      assert.equal(error.notTransmitted, index === 0)
      assert.equal(error.writeGateUnknown, index === 1)
      return true
    })
  }
  assert.equal(orders, 0); assert.equal(guards, 2)
})

test('선택 fence를 제공하지 않은 기존 수동 주문과 읽기 요청의 동작은 유지한다', async t => {
  const previousFetch = globalThis.fetch, previousWait = kiwoomFlow.wait
  t.after(() => { globalThis.fetch = previousFetch; kiwoomFlow.wait = previousWait })
  const paths = []
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth2/token')) return jsonResponse({ token: 'fixture-manual-token', expires_dt: '20991231235959' })
    paths.push(new URL(url).pathname); return jsonResponse({ return_code: 0, ord_no: '0000200' })
  }
  kiwoomFlow.wait = async () => {}
  const credentials = { appKey: 'fixture-unmodified-manual-key', secretKey: 'fixture-unmodified-manual-secret' }
  await requestKiwoomWithCredentials({ ...credentials, apiId: 'kt10000', endpoint: '/api/dostk/ordr', body: {} })
  await requestKiwoomWithCredentials({ ...credentials, apiId: 'ka10001', endpoint: '/api/dostk/stkinfo', body: {}, beforeWrite: async () => assert.fail('read invoked an order fence') })
  assert.deepEqual(paths, ['/api/dostk/ordr', '/api/dostk/stkinfo'])
})
