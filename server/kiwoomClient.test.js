import assert from 'node:assert/strict'
import test from 'node:test'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
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
