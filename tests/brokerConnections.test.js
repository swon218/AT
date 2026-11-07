import test from 'node:test'
import assert from 'node:assert/strict'
import { accountAvailability, createConnectionMonitor, CONNECTION_BROKERS } from '../src/utils/brokerConnections.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function setup(read) {
  let clock = 100, state
  const timers = new Map()
  const monitor = createConnectionMonitor({ read, now: () => clock, onChange: value => { state = value },
    setTimer: (fn, delay) => { const id = Symbol(); timers.set(id, { fn, at: clock + delay }); return id }, clearTimer: id => timers.delete(id) })
  return { monitor, state: () => state, tick: async ms => {
    clock += ms
    for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.has(id)) { timers.delete(id); timer.fn() }
    await flush()
  } }
}

test('availability text exactly follows 0, 1–3 and 4 verified connections', () => {
  for (let count = 0; count <= 4; count++) assert.equal(accountAvailability(Object.fromEntries(CONNECTION_BROKERS.map((broker, i) => [broker, i < count]))), count === 4 ? '사용가능' : count ? '일부 사용' : '사용불가')
})

test('guest makes no private calls; independent results persist across unrelated page renders', async () => {
  let reads = 0
  const slow = deferred(), qa = setup(async broker => { reads++; return broker === 'toss' ? slow.promise : { connected: true, expiresAt: 60100 } })
  qa.monitor.setUser(null); await flush(); assert.equal(reads, 0)
  qa.monitor.setUser('alice')
  assert.equal(accountAvailability(qa.state().connections), '사용불가')
  await flush()
  assert.deepEqual(qa.state().connections, { kiwoom: true, toss: false, nh: true, kb: true })
  for (let page = 0; page < 7; page++) assert.equal(accountAvailability(qa.monitor.snapshot()), '일부 사용')
  assert.equal(reads, 4)
  slow.resolve({ connected: false, expiresAt: 60100 }); await flush()
  assert.equal(accountAvailability(qa.state().connections), '일부 사용')
  qa.monitor.dispose()
})

test('expiry hides success before revalidation and revoked credentials cannot stay connected', async () => {
  let valid = true, reads = 0
  const qa = setup(async () => { reads++; return { connected: valid, expiresAt: 60100 } })
  qa.monitor.setUser('alice'); await flush()
  assert.equal(reads, 4); assert.equal(accountAvailability(qa.state().connections), '사용가능')
  valid = false
  await qa.tick(60001)
  assert.equal(reads, 8); assert.equal(accountAvailability(qa.state().connections), '사용불가')
  qa.monitor.dispose()
})

test('a stalled browser request times out independently and cannot revive after the deadline', async () => {
  const gate = deferred(), qa = setup(async broker => broker === 'toss' ? gate.promise : { connected: true, expiresAt: 60100 })
  qa.monitor.setUser('alice'); await flush()
  await qa.tick(18001)
  assert.deepEqual(qa.state().connections, { kiwoom: true, toss: false, nh: true, kb: true })
  gate.resolve({ connected: true, expiresAt: 60100 }); await flush()
  assert.equal(qa.state().connections.toss, false)
  qa.monitor.dispose()
})

test('key replacement/delete invalidates only its broker immediately and ignores late completion', async () => {
  let gate = null, connected = true
  const qa = setup(async broker => broker === 'kiwoom' && gate ? gate.promise : { connected, expiresAt: 60100 })
  qa.monitor.setUser('alice'); await flush()
  qa.monitor.mutation(['kiwoom'], true)
  assert.deepEqual(qa.state().connections, { kiwoom: false, toss: true, nh: true, kb: true })
  gate = deferred(); qa.monitor.mutation(['kiwoom'], false); await flush()
  qa.monitor.mutation(['kiwoom'], true) // deletion before replacement's read finishes
  gate.resolve({ connected: true, expiresAt: 60100 }); await flush()
  assert.equal(qa.state().connections.kiwoom, false)
  gate = null; connected = false; qa.monitor.mutation(['kiwoom'], false); await flush()
  assert.equal(qa.state().connections.kiwoom, false); assert.equal(qa.state().connections.toss, true)
  qa.monitor.dispose()
})

test('logout, user switch and returning user discard old in-flight responses', async () => {
  const alice = deferred(), qa = setup(async (_, user) => user === 'alice' ? alice.promise : { connected: false, expiresAt: 60100 })
  qa.monitor.setUser('alice'); await flush()
  qa.monitor.setUser(null)
  assert.equal(qa.state().owner, null); assert.equal(accountAvailability(qa.state().connections), '사용불가')
  qa.monitor.setUser('bob'); await flush()
  alice.resolve({ connected: true, expiresAt: 60100 }); await flush()
  assert.equal(qa.state().owner, 'bob'); assert.equal(accountAvailability(qa.state().connections), '사용불가')
  qa.monitor.dispose()
})
