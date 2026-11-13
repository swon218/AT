import { accountConnectionCache } from './accountConnectionCache.js'

const brokers = new Set(['kiwoom', 'toss', 'nh', 'kb'])
const listeners = new Set()

// Only identity and broker IDs cross this boundary. Keys, tokens, encrypted rows
// and brokerage responses must never be sent to a lifecycle listener or log.
export function subscribeCredentialInvalidation(listener) {
  if (typeof listener !== 'function') throw new TypeError('Invalid credential lifecycle listener')
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Invoke after a commit, or conservatively when transport left its outcome
// unknown. A known stale CAS conflict does not invalidate a newer connection.
export function invalidateCredentials(userId, changedBrokers) {
  if (typeof userId !== 'string' || !userId) return
  const selected = [...new Set(Array.isArray(changedBrokers) ? changedBrokers : [])].filter(value => brokers.has(value))
  if (!selected.length) return
  accountConnectionCache.invalidate(userId, selected)
  const event = Object.freeze({ userId, brokers: Object.freeze(selected) })
  for (const listener of listeners) {
    try { listener(event) } catch { /* The database commit already succeeded. Never expose listener errors. */ }
  }
}
