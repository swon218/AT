import assert from 'node:assert/strict'
import test from 'node:test'
import { createStockCatalogCache } from '../src/utils/stockCatalogCache.js'
import { indexStockCatalog, nextStockSearchIndex, searchStockCatalog, STOCK_CATALOG_MAX_AGE } from '../src/utils/stockSearch.js'

const stocks = [
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI' },
  { code: '005930', name: '삼성전자', market: 'KOSPI' },
  { code: '000001', name: '테스트S', market: 'KOSDAQ' },
  { code: '000002', name: 'SK', market: 'KOSPI' },
  { code: '000003', name: 'S', market: 'KOSDAQ' },
]
const memoryStorage = () => {
  const entries = new Map()
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }
}

test('one Latin character, case/width/space normalization, partial names and codes search locally', () => {
  const index = indexStockCatalog(stocks)
  assert.deepEqual(searchStockCatalog(index, 's').items.map(s => s.name), ['S', 'SK', 'SK하이닉스', '테스트S'])
  assert.equal(searchStockCatalog(index, ' ｓｋ 하이 ').items[0].code, '000660')
  assert.equal(searchStockCatalog(index, '하이닉스').items[0].code, '000660')
  assert.equal(searchStockCatalog(index, '005930').items[0].name, '삼성전자')
  assert.equal(searchStockCatalog(index, '삼').items[0].name, '삼성전자')
  assert.deepEqual(searchStockCatalog(index, ''), { items: [], total: 0 })
  assert.equal(searchStockCatalog(index, '없는종목').total, 0)
})

test('all matches remain searchable past the initial 50 results', () => {
  const index = indexStockCatalog(Array.from({ length: 150 }, (_, i) => ({ code: String(i).padStart(6, '0'), name: `S종목${String(i).padStart(3, '0')}`, market: 'KOSPI' })))
  assert.equal(searchStockCatalog(index, 's').items.length, 50)
  assert.equal(searchStockCatalog(index, 's').total, 150)
  assert.equal(searchStockCatalog(index, 's', 100).items.length, 100)
  assert.equal(searchStockCatalog(index, 'S종목149').items[0].code, '000149')
})

test('laboratory keyboard navigation skips uncollected stocks and keeps quarantined histories selectable', () => {
  const items = [{ bars: 0 }, { bars: 1200 }, { bars: 0 }, { bars: 0, quarantined: 2 }]
  const selectable = stock => stock.bars > 0 || stock.quarantined > 0
  assert.equal(nextStockSearchIndex(items, -1, 1, selectable), 1)
  assert.equal(nextStockSearchIndex(items, 1, 1, selectable), 3)
  assert.equal(nextStockSearchIndex(items, 3, 1, selectable), 1)
  assert.equal(nextStockSearchIndex(items, 1, -1, selectable), 3)
  assert.equal(nextStockSearchIndex([{ bars: 0 }], -1, 1, selectable), -1)
  assert.equal(nextStockSearchIndex([], -1, 1, selectable), -1)
  const many = Array.from({ length: 120 }, () => ({ bars: 1 }))
  assert.equal(nextStockSearchIndex(many, 49, 1, selectable), 50)
})

test('prefetch is deduplicated and repeated typing needs no network requests', async () => {
  let calls = 0
  const cache = createStockCatalogCache({ now: () => 1000, storage: memoryStorage, fetchCatalog: async () => { calls++; return { items: stocks, updatedAt: 1000 } } })
  const [a, b] = await Promise.all([cache.load('guest'), cache.load('guest')])
  assert.equal(a, b)
  const index = indexStockCatalog(a.items)
  for (const term of ['s', 'sk', 'sk하이닉스', 's', '삼', '005930']) searchStockCatalog(index, term)
  await cache.load('guest')
  assert.equal(calls, 1)
})

test('reload restores a same-scope catalog, including when the network later fails', async () => {
  let time = 1000
  const storage = memoryStorage()
  const options = { now: () => time, ttl: 100, storage: () => storage }
  const first = createStockCatalogCache({ ...options, fetchCatalog: async () => ({ items: stocks, updatedAt: time }) })
  await first.load('user:a:key1')
  const reloaded = createStockCatalogCache({ ...options, fetchCatalog: async () => { throw new Error('offline') } })
  assert.equal(reloaded.read('user:a:key1').items.length, stocks.length)
  assert.equal(reloaded.read('guest'), null)
  assert.equal(reloaded.read('user:a:key2'), null)
  assert.equal(reloaded.read('user:b:key1'), null)
  time += 101
  await assert.rejects(reloaded.load('user:a:key1'), /offline/)
  assert.equal(reloaded.read('user:a:key1').items[0].code, '000660')
  time += STOCK_CATALOG_MAX_AGE
  assert.equal(reloaded.read('user:a:key1'), null)
})

test('blocked storage and malformed responses do not erase the last valid catalog', async () => {
  let time = 1000
  let response = { items: stocks, updatedAt: time }
  const cache = createStockCatalogCache({ now: () => time, ttl: 10, storage: () => { throw new Error('blocked') }, fetchCatalog: async () => response })
  await cache.load('guest')
  time += 11
  response = { items: [], updatedAt: time }
  await assert.rejects(cache.load('guest'), /목록/)
  assert.equal(cache.read('guest').items.length, stocks.length)
})

test('a stale server snapshot is retried rather than marked fresh for 30 minutes', async () => {
  let calls = 0
  const cache = createStockCatalogCache({ now: () => 1000, storage: memoryStorage, fetchCatalog: async () => { calls++; return { items: stocks, updatedAt: 1000, stale: calls === 1 } } })
  assert.equal((await cache.load('guest')).stale, true)
  assert.equal((await cache.load('guest')).stale, false)
  assert.equal(calls, 2)
})
