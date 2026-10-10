import assert from 'node:assert/strict'
import test from 'node:test'
import { decorateNews, getDashboardNews } from './news.js'

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
