import assert from 'node:assert/strict'
import test from 'node:test'
import { createWatchlistRepository, watchlistCode, WATCHLIST_LIMIT_MESSAGE } from '../src/services/watchlistRepository.js'
import { createWatchlistQuoteLoader } from '../src/services/watchlistQuotes.js'

test('watchlist repository normalizes codes and sends an explicit, session-scoped desired state', async () => {
  let user = 'a'
  let result = { data: [] }
  const requests = []
  const query = {
    select: () => query,
    eq: (column, value) => { requests.push([column, value]); return query },
    order: () => query,
    then: resolve => resolve(result),
  }
  const repo = createWatchlistRepository({
    auth: { getSession: async () => ({ data: { session: { user: { id: user } } } }) },
    from: name => { requests.push(name); return query },
    rpc: async (name, args) => { requests.push([name, args]); return result },
  })
  assert.equal(watchlistCode(' a005930 '), '005930')
  assert.equal(watchlistCode('0a12b3'), '0A12B3')
  assert.equal(watchlistCode(5930), '')
  assert.deepEqual(await repo.list('a'), [])
  assert.deepEqual(requests.splice(0), ['watchlist_items', ['user_id', 'a']])
  await repo.setSaved('a', { code: 'a005930', name: ' 삼성전자 ' }, true)
  assert.deepEqual(requests.shift(), ['set_watchlist_item', {
    p_expected_user: 'a', p_code: '005930', p_saved: true, p_name: '삼성전자',
  }])
  result = { error: { code: 'P0001', message: 'watchlist_limit' } }
  await assert.rejects(repo.setSaved('a', { code: '005930', name: '삼성전자' }, true), { message: WATCHLIST_LIMIT_MESSAGE })
  result = { error: { code: 'PGRST205' } }
  await assert.rejects(repo.list('a'), /SQL을 적용/)
  result = { error: { code: '42501' } }
  await assert.rejects(repo.list('a'), /접근 권한/)
  const requestCount = requests.length
  user = 'b'
  await assert.rejects(repo.setSaved('a', { code: '005930' }, false), /로그인 정보/)
  assert.equal(requests.length, requestCount)
})

test('quotes share in-flight work, preserve missing fields, and retry failed quotes after a cooldown', async () => {
  let clock = 0
  const calls = []
  const quote = createWatchlistQuoteLoader(async code => {
    calls.push(code)
    if (code === '000660') throw new Error('unavailable')
    return { code, price: 70000, change: null, volume: 0 }
  }, () => clock)
  const first = quote('005930')
  assert.equal(first, quote('005930'))
  assert.deepEqual(await first, { price: 70000, change: null, volume: 0 })
  assert.equal(await quote('000660'), null)
  assert.equal(await quote('000660'), null)
  clock = 31_000
  assert.equal(await quote('000660'), null)
  await quote('005930')
  assert.deepEqual(calls, ['005930', '000660', '000660'])
})
