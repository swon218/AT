import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { config } from './config.js'
import { decorateNews, getDashboardNews, getNews, getNewsFeed, registerNewsRoutes, NEWS_CACHE_MS } from './news.js'

test('기사에 있는 주제만 태그로 표시하고 원문 도메인으로 출처를 정한다', () => {
  const item = decorateNews({ title: '코스피 반도체 주도 상승', description: '코스닥도 강세', link: 'https://www.hankyung.com/article/123' })
  assert.equal(item.category, 'market')
  assert.equal(item.source, '한국경제')
  assert.deepEqual(item.tags, ['코스피', '코스닥', '반도체'])
  assert.equal(item.breaking, false)
  assert.equal('price' in item, false)
  assert.equal(decorateNews({ title: '나스닥 상승', description: '', link: 'https://hankyung.com.evil.example/a' }).source, 'hankyung.com.evil.example')
})

test('속보는 기사 제목에 표시된 경우에만 사용하고 공시 기사는 공시 보도로 분류한다', () => {
  const breaking = decorateNews({ title: '[속보] 기준금리 인하', description: '', link: 'https://www.yna.co.kr/view/123' })
  assert.equal(breaking.breaking, true)
  assert.equal(breaking.category, 'economy')
  const disclosure = decorateNews({ title: '기업 실적 공시', description: '영업이익 발표', link: 'https://news.example/a' })
  assert.equal(disclosure.category, 'disclosure')
  assert.equal(disclosure.breaking, false)
  assert.equal(decorateNews({ title: '나스닥 강세', description: '', link: 'https://news.example/a' }).category, 'overseas')
})

test('허용하지 않은 뉴스 분류는 외부 API 호출 전에 거절한다', async () => {
  await assert.rejects(getDashboardNews('unknown'), { statusCode: 400 })
})

test('제목의 국내 시장 주제를 본문의 해외 증시 언급보다 우선한다', () => {
  const article = decorateNews({ title: '코스피 6600선 후퇴', description: '미국 증시와 금리 영향을 받았다.', link: 'https://news.example/a' })
  assert.equal(article.category, 'market')
})

test('뉴스 조회의 원본 위치, 캐시, URL과 공개 라우트 호환성', async t => {
  const originalFetch = global.fetch, originalNow = Date.now
  const credentials = [config.naverClientId, config.naverClientSecret]
  config.naverClientId = 'test-id'
  config.naverClientSecret = 'test-secret'
  const calls = []
  const raw = (id, title = `코스피 뉴스 ${id}`, extra = {}) => ({ title, description: '<b>제공된</b> 요약 &amp; 내용', originallink: `https://publisher.example/${id}`, link: `https://n.news.naver.com/article/001/${id}`, pubDate: 'Wed, 04 Nov 2026 00:00:00 +0900', ...extra })
  let response = url => ({ total: 2000, items: Array.from({ length: Number(url.searchParams.get('display')) }, (_, i) => raw(Number(url.searchParams.get('start')) + i)) })
  global.fetch = async input => {
    const url = new URL(input)
    calls.push(url)
    const payload = await response(url)
    return new Response(JSON.stringify(payload), { status: payload.errorMessage ? 503 : 200 })
  }
  const app = Fastify()
  registerNewsRoutes(app)
  try {
    await t.test('필터·중복·잘못된 URL로 줄어든 표시 건수와 무관하게 다음 50행으로 이동한다', async () => {
      response = url => ({ total: 112, items: Number(url.searchParams.get('start')) === 1
        ? Array.from({ length: 50 }, (_, i) => i < 2 ? raw(1) : i === 2 ? raw(3, '코스피 유효 기사') : i === 3 ? raw(4, '코스피 다른 원문', { link: raw(3).link }) : i === 4 ? raw(5, '코스피 원문 없음', { originallink: 'javascript:alert(1)' }) : i === 5 ? raw(6, '코스피 안전하지 않은 링크', { originallink: 'file:///private', link: 'data:text/html,foo' }) : raw(i, '연준 금리 발표'))
        : Array.from({ length: Math.min(50, 113 - Number(url.searchParams.get('start'))) }, (_, i) => raw(Number(url.searchParams.get('start')) + i)) })
      const first = await getNewsFeed('market')
      assert.equal(first.items.length, 3)
      assert.equal(first.scanned, 50)
      assert.equal(first.nextStart, 51)
      assert.equal(first.items[2].link, raw(5).link)
      assert.equal(first.items[0].description, '제공된 요약 & 내용')
      const second = await getNewsFeed('market', first.nextStart)
      assert.equal(second.items[0].link, raw(51).originallink)
      assert.equal(second.nextStart, 101)
      const last = await getNewsFeed('market', second.nextStart)
      assert.equal(last.items.length, 12)
      assert.equal(last.nextStart, null)
      assert.equal(last.endReason, 'end')
    })
    await t.test('조회 위치·개수·검색어별 캐시를 구분하고 5분 뒤 다시 조회한다', async () => {
      const count = calls.length
      await getNewsFeed('market', 51)
      assert.equal(calls.length, count)
      await getNewsFeed('market', 51, 20)
      await getNewsFeed('stock', 51, 20)
      assert.equal(calls.length, count + 2)
      Date.now = () => originalNow() + NEWS_CACHE_MS + 1
      await getNewsFeed('market', 51)
      assert.equal(calls.length, count + 3)
      Date.now = originalNow
    })
    await t.test('표시할 기사가 없는 구간도 다음 위치를 반환하고 공시 무관 기사를 제외한다', async () => {
      response = () => ({ total: 500, items: Array.from({ length: 50 }, (_, i) => raw(i, '공시가격·공시지원금 안내')) })
      const page = await getNewsFeed('disclosure')
      assert.equal(page.items.length, 0)
      assert.equal(page.scanned, 50)
      assert.equal(page.nextStart, 51)
    })
    await t.test('1000개 검색 결과 경계에서 요청 범위를 줄이고 정확히 종료한다', async () => {
      response = url => ({ total: 2000, items: Array.from({ length: Number(url.searchParams.get('display')) }, (_, i) => raw(i, '나스닥 소식')) })
      const page = await getNewsFeed('overseas', 980, 50)
      assert.equal(calls.at(-1).searchParams.get('display'), '21')
      assert.equal(calls.at(-1).searchParams.get('start'), '980')
      assert.equal(calls.at(-1).searchParams.get('sort'), 'date')
      assert.equal(page.nextStart, null)
      assert.equal(page.endReason, 'limit')
      assert.equal(page.maxResults, 1000)
      const final = await getNewsFeed('overseas', 1000, 100)
      assert.equal(calls.at(-1).searchParams.get('display'), '1')
      assert.equal(final.nextStart, null)
    })
    await t.test('서버 함수와 라우트는 잘못된 분류·조회 범위를 외부 호출 전에 거부한다', async () => {
      const count = calls.length
      for (const [category, start, display] of [['bad', 1, 50], ['all', 0, 50], ['all', 1001, 50], ['all', 1.5, 50], ['all', 1, 101], ['all', 1, 0], ['all', NaN, 50]]) {
        await assert.rejects(getNewsFeed(category, start, display), { statusCode: 400 })
      }
      for (const query of ['category=bad', 'start=0', 'start=1001', 'start=1.5', 'display=101', 'display=0', 'start=NaN']) {
        assert.equal((await app.inject(`/api/public/news/feed?${query}`)).statusCode, 400)
      }
      assert.equal((await app.inject('/api/public/news/dashboard?category=bad')).statusCode, 400)
      assert.equal(calls.length, count)
    })
    await t.test('동일 구간 동시 조회를 공유하며 대시보드 20건·기존 items 응답을 유지한다', async () => {
      response = url => ({ total: 2000, items: Array.from({ length: Number(url.searchParams.get('display')) }, (_, i) => raw(i)) })
      const count = calls.length
      await Promise.all([getNewsFeed('all'), getNewsFeed('all')])
      assert.equal(calls.length, count + 1)
      const dashboard = await app.inject('/api/public/news/dashboard')
      assert.equal(dashboard.statusCode, 200)
      assert.equal(dashboard.json().items.length, 20)
      assert.match(dashboard.json().searchUrl, /^https:\/\/search.naver.com\//)
      const legacy = await app.inject('/api/public/news?display=100')
      assert.equal(legacy.statusCode, 200)
      assert.equal(legacy.json().items.length, 10)
      const feed = await app.inject('/api/public/news/feed?category=all&start=51')
      assert.equal(feed.statusCode, 200)
      assert.equal(feed.json().nextStart, 101)
    })
    await t.test('빈 결과는 정상 종료하고 외부 오류는 캐시하지 않아 재시도할 수 있다', async () => {
      response = () => ({ total: 0, items: [] })
      const page = await getNewsFeed('economy')
      assert.deepEqual(page.items, [])
      assert.equal(page.nextStart, null)
      assert.equal(page.endReason, 'end')
      response = () => ({ errorMessage: 'upstream unavailable' })
      assert.equal((await app.inject('/api/public/news/feed?category=economy&start=51')).statusCode, 502)
      response = () => ({ total: 51, items: [raw(51, '기준금리 뉴스')] })
      const retry = await app.inject('/api/public/news/feed?category=economy&start=51')
      assert.equal(retry.statusCode, 200)
      assert.equal(retry.json().items.length, 1)
    })
    await t.test('http/https만 허용하며 원문을 우선하고 없으면 제공된 네이버 링크를 쓴다', async () => {
      response = () => ({ total: 4, items: [raw(1), raw(2, '원문 없는 기사', { originallink: 'javascript:alert(1)' }), raw(3, '잘못된 링크', { originallink: 'file:///x', link: 'ftp://example/a' }), raw(4, '자격증명 포함 링크', { originallink: 'https://user:pass@publisher.example/a' })] })
      const items = await getNews('url-test', 4)
      assert.equal(items.length, 3)
      assert.equal(items[0].link, raw(1).originallink)
      assert.equal(items[1].link, raw(2).link)
      assert.equal(items[2].link, raw(4).link)
    })
  } finally {
    await app.close()
    global.fetch = originalFetch
    Date.now = originalNow
    ;[config.naverClientId, config.naverClientSecret] = credentials
  }
})
