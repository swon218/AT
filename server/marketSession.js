import WebSocket from 'ws'
import { config } from './config.js'

const states = {
  '0': ['장 시작 전', 'waiting'], '3': ['정규장 거래 중', 'open'], '2': ['마감 동시호가', 'auction'],
  '4': ['정규장 마감', 'closed'], '8': ['정규장 마감', 'closed'], '9': ['전체 장 마감', 'closed'],
  a: ['시간외 종가매매', 'after-hours'], b: ['시간외 종가 종료', 'closed'],
  c: ['시간외 단일가', 'after-hours'], d: ['시간외 거래 종료', 'closed'],
}
const seoulDate = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))

export function readSessionEvent(message, now) {
  if (message.trnm !== 'REAL' || !Array.isArray(message.data)) return null
  let result = null
  for (const item of message.data) {
    if (item.type !== '0s') continue
    const code = String(item.values?.['215'] ?? '')
    // NXT and derivatives status must never overwrite the KRX cash-market card.
    if (!Object.hasOwn(states, code)) continue
    const time = String(item.values?.['20'] ?? '')
    if (!/^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(time)) continue
    const receivedAt = new Date(now).toISOString()
    const marketTime = `${seoulDate(now)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`
    // Reject replayed transition messages from a previous time of day.
    if (Math.abs(Date.parse(marketTime) - now) > 5 * 60_000) continue
    const remaining = String(item.values?.['214'] ?? '')
    const seconds = /^(?:[01]\d|2[0-3])[0-5]\d[0-5]\d$/.test(remaining) ? Number(remaining.slice(0, 2)) * 3600 + Number(remaining.slice(2, 4)) * 60 + Number(remaining.slice(4, 6)) : null
    result = { code, label: states[code][0], phase: states[code][1], marketTime, receivedAt, date: seoulDate(now), expectedOpenAt: code === '0' && seconds > 0 ? new Date(now + seconds * 1000).toISOString() : null }
  }
  return result
}

export function sessionSnapshot(entry, now) {
  const current = entry.event?.date === seoulDate(now) ? entry.event : null
  const connected = entry.connection === 'connected'
  const weekday = new Date(`${seoulDate(now)}T12:00:00Z`).getUTCDay()
  if (current) return { ...current, exchange: 'KRX', source: 'kiwoom', connection: entry.connection, stale: !connected || !entry.verified }
  return {
    exchange: 'KRX', source: [0, 6].includes(weekday) ? 'calendar' : 'pending', connection: entry.connection, stale: false,
    label: [0, 6].includes(weekday) ? '주말 휴장' : '장 상태 수신 대기', phase: [0, 6].includes(weekday) ? 'closed' : 'unknown',
    receivedAt: null, expectedOpenAt: null,
  }
}

export function createMarketSessions({ now = Date.now, makeSocket = url => new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 64 * 1024 }), idleMs = 120_000, maxConnections = 50 } = {}) {
  const entries = new Map()
  let closed = false
  const disconnect = entry => {
    entry.version++
    clearTimeout(entry.timeout)
    entry.socket?.terminate()
    entry.socket = null
    entry.starting = false
  }
  const prune = () => {
    for (const [key, entry] of entries) if (now() - entry.touched > idleMs) { disconnect(entry); entries.delete(key) }
  }
  const timer = setInterval(() => {
    prune()
    for (const entry of entries.values()) {
      if (entry.socket && now() - entry.lastMessage > 90_000) fail(entry)
      if (!entry.socket && !entry.starting && now() >= entry.retryAt) void connect(entry)
    }
  }, 5_000)
  timer.unref()
  function fail(entry, invalidate = false) {
    if (invalidate) entry.auth?.invalidate()
    disconnect(entry)
    entry.connection = 'reconnecting'
    entry.verified = false
    entry.retryAt = now() + Math.min(60_000, 5_000 * 2 ** Math.min(entry.failures++, 4))
  }
  async function connect(entry) {
    if (closed || entry.starting || entry.socket || now() < entry.retryAt) return
    entry.starting = true
    entry.connection = 'connecting'
    const version = entry.version
    try {
      const auth = await entry.getAuth()
      if (closed || version !== entry.version) return
      entry.auth = auth
      const host = new URL(config.kiwoomHost).hostname
      const socket = makeSocket(`wss://${host}:10000/api/dostk/websocket`)
      entry.socket = socket
      entry.lastMessage = now()
      const active = () => !closed && entry.socket === socket && entry.version === version
      entry.timeout = setTimeout(() => { if (active()) fail(entry) }, 15_000)
      entry.timeout.unref?.()
      socket.on('open', () => { if (active()) socket.send(JSON.stringify({ trnm: 'LOGIN', token: auth.token })) })
      socket.on('message', bytes => {
        if (!active()) return
        let packet
        try { packet = JSON.parse(String(bytes)) } catch { return }
        entry.lastMessage = now()
        if (packet.trnm === 'PING') { socket.send(JSON.stringify(packet)); return }
        if (packet.trnm === 'LOGIN') {
          if (Number(packet.return_code) !== 0) { fail(entry, true); return }
          socket.send(JSON.stringify({ trnm: 'REG', grp_no: '1', refresh: '1', data: [{ item: [], type: ['0s'] }] }))
        } else if (packet.trnm === 'REG') {
          if (Number(packet.return_code) !== 0) { fail(entry); return }
          clearTimeout(entry.timeout)
          entry.connection = 'connected'
          entry.failures = 0
        } else if (packet.trnm === 'REAL') {
          const event = readSessionEvent(packet, now())
          if (event && (!entry.event || event.marketTime >= entry.event.marketTime)) { entry.event = event; entry.verified = true }
        }
      })
      socket.on('error', () => { if (active()) fail(entry) })
      socket.on('close', () => { if (active()) fail(entry) })
    } catch { if (version === entry.version && !closed) fail(entry) }
    finally { if (version === entry.version) entry.starting = false }
  }
  return {
    get(auth) {
      if (closed) throw new Error('장 상태 서비스가 종료되었습니다.')
      prune()
      let entry = entries.get(auth.cacheScope)
      if (!entry) {
        if (entries.size >= maxConnections) {
          const oldest = [...entries].sort((a, b) => a[1].touched - b[1].touched)[0]
          disconnect(oldest[1]); entries.delete(oldest[0])
        }
        entry = { touched: now(), lastMessage: now(), connection: 'connecting', socket: null, event: null, version: 0, failures: 0, retryAt: 0, getAuth: auth.getRealtimeAuth }
        entries.set(auth.cacheScope, entry)
      }
      entry.touched = now()
      void connect(entry)
      return sessionSnapshot(entry, now())
    },
    close() { closed = true; clearInterval(timer); for (const entry of entries.values()) disconnect(entry); entries.clear() },
  }
}
