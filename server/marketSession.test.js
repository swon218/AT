import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createMarketSessions, readSessionEvent, sessionSnapshot } from './marketSession.js'

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
