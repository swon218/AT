import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createMarketSessions, readSessionEvent, sessionSnapshot } from './marketSession.js'
import { invalidateCredentials } from './credentialInvalidation.js'
import { createMarketRequestContext } from './marketContext.js'

const at = text => Date.parse(`2026-10-12T${text}+09:00`)
const packet = (code, time = '090000', remaining = '000000') => ({ trnm: 'REAL', data: [{ type: '0s', values: { '215': code, '20': time, '214': remaining } }] })
const flush = () => new Promise(resolve => setImmediate(resolve))
class Socket extends EventEmitter {
  sent = []
  terminated = false
  send(value) { this.sent.push(JSON.parse(value)) }
  terminate() { this.terminated = true; this.emit('close') }
  message(value) { this.emit('message', JSON.stringify(value)) }
  ready() { this.emit('open'); this.message({ trnm: 'LOGIN', return_code: 0 }); this.message({ trnm: 'REG', return_code: 0 }) }
}

test('공식 KRX 장 상태와 예상 시간을 해석하고 NXT, 선옵, 과거 재전송을 무시한다', () => {
  assert.equal(readSessionEvent(packet('3'), at('09:00:00')).label, '정규장 거래 중')
  assert.equal(readSessionEvent(packet('0', '085000', '001000'), at('08:50:00')).expectedOpenAt, new Date(at('09:00:00')).toISOString())
  for (const code of ['P', 'R', 'T', 'o', 's', 'bad']) assert.equal(readSessionEvent(packet(code), at('09:00:00')), null)
  assert.equal(readSessionEvent(packet('3'), at('12:00:00')), null)
  assert.equal(readSessionEvent(packet('3', '999999'), at('09:00:00')), null)
})

test('주말은 달력 근거를 명시하고 평일 미수신을 거래 중으로 꾸미지 않는다', () => {
  const entry = { connection: 'connected', verified: true, event: readSessionEvent(packet('3'), at('09:00:00')) }
  assert.equal(sessionSnapshot(entry, at('10:00:00')).source, 'kiwoom')
  assert.equal(sessionSnapshot(entry, Date.parse('2026-10-13T10:00:00+09:00')).source, 'pending')
  assert.equal(sessionSnapshot(entry, Date.parse('2026-10-17T10:00:00+09:00')).source, 'calendar')
  assert.equal(sessionSnapshot({ ...entry, connection: 'reconnecting' }, at('10:00:00')).stale, true)
})

test('LOGIN/REG/PING 처리 및 동일 자격 증명 연결 공유, 끊긴 상태와 재연결을 구분한다', async t => {
  let clock = at('09:00:00'), sockets = [], invalidated = 0
  const hub = createMarketSessions({ now: () => clock, makeSocket: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  t.after(() => hub.close())
  const auth = { cacheScope: 'user:1:key1', getRealtimeAuth: async () => ({ token: 'private-token', invalidate: () => invalidated++ }) }
  hub.get(auth); hub.get(auth)
  await flush()
  assert.equal(sockets.length, 1)
  sockets[0].ready()
  assert.deepEqual(sockets[0].sent[0], { trnm: 'LOGIN', token: 'private-token' })
  assert.deepEqual(sockets[0].sent[1].data, [{ item: [], type: ['0s'] }])
  sockets[0].message({ trnm: 'PING' })
  assert.deepEqual(sockets[0].sent.at(-1), { trnm: 'PING' })
  sockets[0].message(packet('3'))
  assert.equal(hub.get(auth).label, '정규장 거래 중')
  assert.equal(hub.get(auth).stale, false)
  assert.ok(!JSON.stringify(hub.get(auth)).includes('private-token'))
  sockets[0].emit('error', new Error('network'))
  assert.equal(hub.get(auth).stale, true)
  clock += 5001
  hub.get(auth); await flush()
  sockets[1].ready()
  assert.equal(hub.get(auth).stale, true) // A reconnect alone cannot verify a missed transition.
  sockets[1].message(packet('3', '090005'))
  assert.equal(hub.get(auth).stale, false)
  sockets[1].emit('close'); clock += 5001; hub.get(auth); await flush()
  sockets[2].emit('open'); sockets[2].message({ trnm: 'LOGIN', return_code: 8005 })
  assert.equal(invalidated, 1)
})

test('사용자 및 키 변경 연결을 분리하고 비활성 연결과 종료 중 인증을 정리한다', async () => {
  let clock = at('09:00:00'), sockets = []
  const hub = createMarketSessions({ now: () => clock, idleMs: 1000, makeSocket: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  const auth = key => ({ cacheScope: key, getRealtimeAuth: async () => ({ token: key }) })
  hub.get(auth('user:1:key1')); hub.get(auth('user:1:key2')); await flush()
  assert.equal(sockets.length, 2)
  sockets.forEach(socket => socket.ready())
  clock += 1001; hub.get(auth('user:2:key')); await flush()
  assert.ok(sockets[0].terminated && sockets[1].terminated)
  hub.close()
  assert.ok(sockets[2].terminated)
  let resolve
  const late = createMarketSessions({ makeSocket: () => { throw new Error('must not create after close') } })
  late.get({ cacheScope: 'late', getRealtimeAuth: () => new Promise(r => { resolve = r }) })
  late.close(); resolve({ token: 'late' }); await flush()
})

test('키움 키 삭제는 해당 회원의 장 상태 연결과 재연결 자격증명만 제거한다', async t => {
  const sockets = []
  const hub = createMarketSessions({ now: () => at('09:00:00'), makeSocket: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  t.after(() => hub.close())
  const auth = scope => ({ cacheScope: scope, getRealtimeAuth: async () => ({ token: `fixture-${scope}` }) })
  hub.get(auth('user:one:old')); hub.get(auth('user:two:old')); hub.get(auth('operator'))
  await flush(); sockets.forEach(socket => socket.ready())
  invalidateCredentials('one', ['toss'])
  assert.ok(sockets.every(socket => !socket.terminated))
  invalidateCredentials('one', ['kiwoom'])
  assert.equal(sockets[0].terminated, true)
  assert.equal(sockets[1].terminated, false)
  assert.equal(sockets[2].terminated, false)
  let freshAuthCalls = 0
  hub.get({ cacheScope: 'user:one:old', getRealtimeAuth: async () => { freshAuthCalls++; return { token: 'fixture-new-registration' } } })
  await flush(); sockets[3].ready()
  assert.equal(freshAuthCalls, 1, 'the removed entry cannot reuse its old getRealtimeAuth closure')
  assert.equal(sockets[3].sent[0].token, 'fixture-new-registration')
})

test('삭제 직전 시작한 토큰 발급이 늦게 끝나도 장 상태 연결을 되살리지 않는다', async t => {
  let finish, sockets = 0
  const hub = createMarketSessions({ makeSocket: () => { sockets++; return new Socket() } })
  t.after(() => hub.close())
  hub.get({ cacheScope: 'user:late-owner:old', getRealtimeAuth: () => new Promise(resolve => { finish = resolve }) })
  invalidateCredentials('late-owner', ['kiwoom'])
  finish({ token: 'fixture-late-token' })
  await flush()
  assert.equal(sockets, 0)
})

test('동일 키의 새 인증 요청은 재연결에 만료된 이전 회원 세션을 사용하지 않는다', async t => {
  let clock = at('09:00:00'), oldCalls = 0, newCalls = 0
  const sockets = [], scope = 'user:refresh-owner:same-key'
  const hub = createMarketSessions({ now: () => clock, makeSocket: () => { const socket = new Socket(); sockets.push(socket); return socket } })
  t.after(() => hub.close())
  hub.get({ cacheScope: scope, getRealtimeAuth: async () => { oldCalls++; return { token: 'fixture-old-session' } } })
  await flush(); sockets[0].ready()
  hub.get({ cacheScope: scope, getRealtimeAuth: async () => { newCalls++; return { token: 'fixture-refreshed-session' } } })
  sockets[0].emit('close'); clock += 5001
  hub.get({ cacheScope: scope, getRealtimeAuth: async () => { newCalls++; return { token: 'fixture-refreshed-session' } } })
  await flush(); sockets[1].ready()
  assert.equal(oldCalls, 1)
  assert.equal(newCalls, 1)
  assert.equal(sockets[1].sent[0].token, 'fixture-refreshed-session')
})

test('삭제 이벤트보다 늦게 도착한 과거 HTTP 문맥도 삭제된 키로 소켓을 만들 수 없다', async t => {
  let current = { user: { id: 'late-context-owner' }, status: { kiwoomConfigured: true }, credentials: { kiwoomAppKey: 'fixture-key', kiwoomSecretKey: 'fixture-secret' } }
  let tokenCalls = 0, sockets = 0, clock = at('09:00:00')
  const context = createMarketRequestContext({ authenticate: async () => current, realtime: async () => { tokenCalls++; return { token: 'fixture-token' } } })
  const oldContext = await context({ headers: { authorization: 'Bearer fixture-session' } })
  const hub = createMarketSessions({ now: () => clock, makeSocket: () => { sockets++; return new Socket() } })
  t.after(() => hub.close())
  current = { ...current, status: { kiwoomConfigured: false }, credentials: {} }
  invalidateCredentials('late-context-owner', ['kiwoom'])
  hub.get(oldContext)
  await flush()
  assert.equal(sockets, 0)
  assert.equal(tokenCalls, 0)
  current = { ...current, status: { kiwoomConfigured: true }, credentials: { kiwoomAppKey: 'fixture-rotated-key', kiwoomSecretKey: 'fixture-rotated-secret' } }
  clock += 5001
  hub.get(oldContext)
  await flush()
  assert.equal(sockets, 0)
  assert.equal(tokenCalls, 0)
  hub.get(await context({ headers: { authorization: 'Bearer fixture-refreshed-session' } }))
  await flush()
  assert.equal(sockets, 1)
  assert.equal(tokenCalls, 1)
})
