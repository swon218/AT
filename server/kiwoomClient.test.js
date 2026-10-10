import assert from 'node:assert/strict'
import test from 'node:test'
import { requestKiwoomWithCredentials, getKiwoomRealtimeAuth } from './kiwoomClient.js'

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
