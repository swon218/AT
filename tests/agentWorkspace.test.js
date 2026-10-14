import test from 'node:test'
import assert from 'node:assert/strict'
import { agentStorageKey, changeAgentWorkspace, decodeAgentWorkspace, emptyAgentWorkspace, MAX_CONVERSATIONS,
  MAX_MESSAGES, readAgentWorkspace, robotCoordinates, robotPosition, saveAgentWorkspace } from '../src/utils/agentWorkspace.js'

const memoryStorage = () => {
  const items = new Map()
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) }
}
const ask = (data, text) => changeAgentWorkspace(changeAgentWorkspace(data, { type: 'draft', value: text }), { type: 'submit' })

test('refresh restores questions, unfinished draft, active conversation and hidden robot', () => {
  const storage = memoryStorage()
  let data = ask(emptyAgentWorkspace(), '삼성전자 밤사이 뉴스는 어때?')
  data = changeAgentWorkspace(data, { type: 'draft', value: '이어서 작성 중인 질문' })
  data = changeAgentWorkspace(data, { type: 'ui', patch: { robotVisible: false, miniOpen: false, position: { x: .3, y: .7 } } })
  saveAgentWorkspace(storage, 'user-a', data)
  assert.deepEqual(readAgentWorkspace(storage, 'user-a'), data)
})

test('guest and two signed-in users have independent saved conversations', () => {
  const storage = memoryStorage()
  const guest = ask(emptyAgentWorkspace(), '게스트 질문')
  const a = ask(emptyAgentWorkspace(), '사용자 A 질문')
  const b = ask(emptyAgentWorkspace(), '사용자 B 질문')
  saveAgentWorkspace(storage, null, guest)
  saveAgentWorkspace(storage, 'user-a', a)
  saveAgentWorkspace(storage, 'user-b', b)
  assert.deepEqual(readAgentWorkspace(storage, null), guest)
  assert.deepEqual(readAgentWorkspace(storage, 'user-a'), a)
  assert.deepEqual(readAgentWorkspace(storage, 'user-b'), b)
  assert.equal(readAgentWorkspace(storage, 'new-user').conversations[0].messages.length, 0)
  assert.notEqual(agentStorageKey(null), agentStorageKey('guest'))
})

test('switching conversations preserves each draft and submission records only user text', () => {
  let data = ask(emptyAgentWorkspace(), '첫 번째 질문')
  const first = data.activeId
  data = changeAgentWorkspace(data, { type: 'draft', value: '첫 대화 초안' })
  data = changeAgentWorkspace(data, { type: 'new' })
  data = changeAgentWorkspace(data, { type: 'draft', value: '둘째 대화 초안' })
  const second = data.activeId
  data = changeAgentWorkspace(data, { type: 'select', id: first })
  assert.equal(data.conversations.find(item => item.id === first).draft, '첫 대화 초안')
  assert.equal(data.conversations.find(item => item.id === second).draft, '둘째 대화 초안')
  assert.deepEqual(data.conversations.flatMap(item => item.messages).map(item => item.role), ['user'])
})

test('deleting active conversation selects another without changing its questions', () => {
  let data = ask(emptyAgentWorkspace(), '보존할 질문')
  const first = data.conversations[0]
  data = changeAgentWorkspace(data, { type: 'new' })
  data = ask(data, '삭제할 질문')
  data = changeAgentWorkspace(data, { type: 'delete', id: data.activeId })
  assert.equal(data.activeId, first.id)
  assert.deepEqual(data.conversations[0], first)
  data = changeAgentWorkspace(data, { type: 'delete', id: first.id })
  assert.equal(data.conversations.length, 1)
  assert.equal(data.conversations[0].messages.length, 0)
})

test('full conversation refuses a new question and retains existing messages and draft', () => {
  let data = emptyAgentWorkspace()
  for (let i = 0; i < MAX_MESSAGES; i++) data = ask(data, `질문 ${i}`)
  data = changeAgentWorkspace(data, { type: 'draft', value: '보관 한도를 넘긴 초안' })
  const before = JSON.stringify(data)
  assert.throws(() => changeAgentWorkspace(data, { type: 'submit' }), /새 대화/)
  assert.equal(JSON.stringify(data), before)
})

test('full workspace refuses new conversations without silently dropping older ones', () => {
  let data = ask(emptyAgentWorkspace(), '첫 대화')
  for (let i = 1; i < MAX_CONVERSATIONS; i++) data = ask(changeAgentWorkspace(data, { type: 'new' }), `대화 ${i}`)
  const before = JSON.stringify(data)
  assert.throws(() => changeAgentWorkspace(data, { type: 'new' }), /50개/)
  assert.equal(JSON.stringify(data), before)
})

test('malformed or foreign cached reply roles are rejected rather than displayed as AI replies', () => {
  assert.throws(() => decodeAgentWorkspace('{bad json'))
  const data = ask(emptyAgentWorkspace(), '<script>literal text</script>')
  assert.equal(decodeAgentWorkspace(JSON.stringify(data)).conversations[0].messages[0].content, '<script>literal text</script>')
  data.conversations[0].messages[0].role = 'assistant'
  assert.throws(() => decodeAgentWorkspace(JSON.stringify(data)), /Invalid message/)
})

test('robot remains inside both desktop and mobile viewport after extreme drag and resize', () => {
  const position = robotPosition({ x: -10000, y: 10000 }, { width: 1440, height: 900 })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 300 }]) {
    const coordinates = robotCoordinates(position, viewport)
    assert.ok(coordinates.x >= 16 && coordinates.x + 88 <= viewport.width - 16)
    assert.ok(coordinates.y >= 16 && coordinates.y + 88 <= viewport.height - 16)
  }
})
