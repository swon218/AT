import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeNewsItems, safeNewsUrl, publishedTime, isoTime } from '../src/utils/news.js'

test('프런트엔드도 잘못된 기사 URL을 차단하고 안전한 네이버 링크로 대체한다', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///private', '/relative', 'https://user:secret@news.example/a']) assert.equal(safeNewsUrl(url), '')
  const items = mergeNewsItems([], [{ title: '기사', link: 'javascript:alert(1)', naverLink: 'https://n.news.naver.com/article/001/1' }, { title: '제외', link: 'ftp://news.example/a' }])
  assert.equal(items.length, 1)
  assert.equal(items[0].link, 'https://n.news.naver.com/article/001/1')
})

test('다음 구간의 원문·네이버 URL 중복을 제거하고 기존 기사 순서를 보존한다', () => {
  const previous = [{ title: '첫 기사', link: 'https://press.example/1', naverLink: 'https://n.news.naver.com/article/001/1' }]
  const merged = mergeNewsItems(previous, [{ ...previous[0], title: '중복 원문' }, { title: '네이버 중복', link: 'https://another.example/1', naverLink: previous[0].naverLink }, { title: '다음 기사', link: 'https://press.example/2' }])
  assert.deepEqual(merged.map(item => item.title), ['첫 기사', '다음 기사'])
  assert.deepEqual(previous[0].title, '첫 기사')
})

test('제공된 시각만 KST로 표시하고 없거나 잘못된 시각은 생성하지 않는다', () => {
  assert.match(publishedTime('2026-11-03T15:04:00Z'), /11\. 04\. 00:04/)
  for (const value of [null, undefined, '', 'invalid']) {
    assert.equal(publishedTime(value), '')
    assert.equal(!!isoTime(value), false)
  }
})
