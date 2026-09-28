import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { createMarketRequestContext } from './marketContext.js'
import { createStockSearch, getStockQuote, registerStockSearchRoutes } from './stockSearch.js'

test('검색 권한: 게스트와 키움 키 없는 사용자(토스 키 포함)는 관리자, 개인 키움 키는 사용자 API', async () => {
  let authCalls = 0
  let account = { user: { id: 'u1' }, credentials: {}, status: {} }
  const operator = async () => 'operator'
  const calls = []
  const resolve = createMarketRequestContext({ operator, authenticate: async () => { authCalls++; return account }, personal: async input => { calls.push(input); return 'personal' } })
  assert.equal((await resolve({ headers: {} })).requester, operator)
  assert.equal(authCalls, 0)
  const request = { headers: { authorization: 'Bearer session' } }
  assert.equal((await resolve(request)).requester, operator)
  account = { ...account, credentials: { tossApiKey: 'toss', tossSecretKey: 'secret' }, status: { tossConfigured: true } }
  assert.equal((await resolve(request)).requester, operator)
  account.credentials.kiwoomAppKey = 'personal-key'
  account.credentials.kiwoomSecretKey = 'personal-secret'
  account.status.kiwoomConfigured = true
  const personal = await resolve(request)
  assert.equal(await personal.requester({ apiId: 'ka10099' }), 'personal')
  assert.equal(calls[0].appKey, 'personal-key')
  assert.equal(calls[0].secretKey, 'personal-secret')
  assert.match(personal.cacheScope, /^user:u1:/)
  account.credentials.kiwoomSecretKey = 'new-secret'
  assert.notEqual((await resolve(request)).cacheScope, personal.cacheScope)
})

test('잘못된 세션 및 개인 키 인증 실패는 관리자 키로 대체하지 않는다', async () => {
  const operator = async () => assert.fail('operator must not be called')
  const failure = Object.assign(new Error('expired'), { statusCode: 401 })
  const rejected = createMarketRequestContext({ operator, authenticate: async () => { throw failure } })
  await assert.rejects(rejected({ headers: { authorization: 'Bearer expired' } }), { statusCode: 401 })
  const resolve = createMarketRequestContext({ operator, authenticate: async () => ({ user: { id: 'u' }, status: { kiwoomConfigured: true }, credentials: { kiwoomAppKey: 'invalid', kiwoomSecretKey: 'invalid' } }), personal: async () => { throw failure } })
  const context = await resolve({ headers: { authorization: 'Bearer valid-session' } })
  await assert.rejects(context.requester({}), { statusCode: 401 })
})

const rows = [
  { code: '005935', name: '삼성전자우' }, { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' }, { code: '123456', name: '테스트삼성' },
]

test('전체 목록 연속 조회, 코스닥 포함, 종목명 부분일치·코드 검색 및 정확한 일치 우선', async () => {
  const calls = []
  const search = createStockSearch({ pause: async () => {} })
  const context = { cacheScope: 'operator', requester: async request => {
    calls.push(request)
    if (request.body.mrkt_tp === '10') return { body: { list: [{ code: '123450', name: '삼성테스트' }] }, contYn: 'N' }
    if (!request.nextKey) return { body: { list: rows.slice(0, 2) }, contYn: 'Y', nextKey: 'page2' }
    return { body: { list: rows.slice(2) }, contYn: 'N' }
  } }
  const result = await search('삼성', context)
  assert.equal(result.total, 4)
  assert.equal(result.items.at(-1).name, '테스트삼성')
  assert.equal(result.items.find(s => s.code === '123450').market, 'KOSDAQ')
  assert.equal(calls.length, 3)
  assert.equal(calls[1].contYn, 'Y')
  assert.equal(calls[1].nextKey, 'page2')
  assert.equal((await search('005930', context)).items[0].name, '삼성전자')
  assert.equal((await search(' 삼성 전자 ', context)).items[0].code, '005930')
  assert.equal((await search('없는종목', context)).total, 0)
  assert.equal(calls.length, 3)
})

test('동일 권한 동시 검색은 한 목록을 공유하지만 사용자별 캐시와 갱신은 분리된다', async () => {
  let time = 0
  let calls = 0
  const search = createStockSearch({ now: () => time, ttl: 10, pause: async () => {} })
  const requester = async () => { calls++; return { body: { list: rows }, contYn: 'N' } }
  await Promise.all(['삼성', '005930'].map(q => search(q, { requester, cacheScope: 'operator' })))
  assert.equal(calls, 2)
  await search('삼성', { requester, cacheScope: 'user:1:key' })
  assert.equal(calls, 4)
  time = 11
  await search('삼성', { requester, cacheScope: 'operator' })
  assert.equal(calls, 6)
})

test('부분 목록이나 잘못된 연속조회는 성공으로 캐시하지 않는다', async () => {
  const search = createStockSearch({ pause: async () => {} })
  let calls = 0
  const context = { cacheScope: 'bad', requester: async () => { calls++; return { body: { list: rows }, contYn: 'Y', nextKey: 'repeat' } } }
  await assert.rejects(search('삼성', context), /연속 조회/)
  assert.equal(calls, 2)
  context.requester = async () => ({ body: { list: rows }, contYn: 'N' })
  assert.equal((await search('삼성', context)).total, 3)
})

test('검색/시세 경로는 인증 문맥을 공유하고 잘못된 입력 및 인증 실패를 처리한다', async t => {
  const app = Fastify()
  t.after(() => app.close())
  const context = { cacheScope: 'user', requester: async () => {} }
  const queries = []
  registerStockSearchRoutes(app, { context: async request => {
    if (request.headers.authorization === 'Bearer expired') throw Object.assign(new Error('expired'), { statusCode: 401 })
    return context
  }, search: async (q, resolved) => { assert.equal(resolved, context); queries.push(q); return { items: rows, total: 4 } }, quote: async (code, resolved) => { assert.equal(resolved, context); return { code } } })
  const response = await app.inject({ url: '/api/public/market/kiwoom/search?q=' + encodeURIComponent('삼성') })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(queries, ['삼성'])
  assert.equal(response.headers['cache-control'], 'private, no-store')
  assert.equal((await app.inject({ url: '/api/public/market/kiwoom/search?q=' })).statusCode, 400)
  assert.equal((await app.inject({ url: '/api/public/market/kiwoom/search?q=삼성', headers: { authorization: 'Bearer expired' } })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/public/market/kiwoom/quote?symbol=005930' })).statusCode, 200)
  assert.equal((await app.inject({ url: '/api/public/market/kiwoom/quote?symbol=invalid' })).statusCode, 400)
})

test('선택 종목 시세는 정확한 코드로 조회하고 등락 부호와 빈 가격을 보존한다', async () => {
  const quote = await getStockQuote('005930', { requester: async definition => {
    assert.equal(definition.apiId, 'ka10001')
    assert.equal(definition.body.stk_cd, '005930')
    return { stk_cd: '005930', stk_nm: '삼성전자', cur_prc: '-70000', flu_rt: '-1.25' }
  } })
  assert.equal(quote.price, 70000)
  assert.equal(quote.change, -1.25)
  await assert.rejects(getStockQuote('005930', { requester: async () => ({ stk_cd: '000660', stk_nm: '다른종목' }) }), /시세 응답/)
})
