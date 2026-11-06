import { createHash } from 'node:crypto'
import { httpError } from './brokerHttp.js'

const stages = new Set(['lookup', 'token', 'accounts', 'kt00007', 'kt00009', 'orders_open', 'orders_closed', 'dailyOrderExecution', 'ssqm2341'])
const abortError = () => Object.assign(new Error('Request cancelled'), { name: 'AbortError' })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Explicit, bounded fields only. Never log the Error, message, request, URL or response.
export function safeOrderFailure(broker, error) {
  const http = Number(error.upstreamStatus ?? error.statusCode)
  const code = String(error.brokerCode ?? error.returnCode ?? '')
  const timeout = error.name === 'TimeoutError' || error.statusCode === 504
  return { broker, stage: stages.has(error.orderStage) ? error.orderStage : 'lookup',
    category: http === 429 ? 'rate_limited' : timeout ? 'timeout' : 'broker_unavailable', timeout,
    ...(Number.isInteger(http) && http >= 100 && http <= 599 ? { upstreamStatus: http } : {}),
    ...(/^-?\d{1,6}$/.test(code) ? { brokerCode: code } : {}) }
}

// Only unsettled work is shared, and only after each caller authenticates. Results
// are removed on settlement; no personal response cache is kept here.
export function createOrderReadCoordinator({ readBroker, timeoutMs = 25_000, cancelGraceMs = 750,
  now = Date.now, onBrokerError = () => {}, maxJobs = 200 } = {}) {
  const jobs = new Map(), cooldowns = new Map()
  return async function read(broker, account, days, accountRef, signal) {
    signal?.throwIfAborted()
    const credentials = broker === 'toss'
      ? [account.credentials.tossApiKey, account.credentials.tossSecretKey]
      : [account.credentials[`${broker}AppKey`], account.credentials[`${broker}SecretKey`]]
    const owner = hash([account.user.id, broker, credentials])
    const key = hash([owner, days, accountRef])
    for (const [id, until] of cooldowns) if (until <= now()) cooldowns.delete(id)
    const until = cooldowns.get(owner)
    if (until > now()) throw Object.assign(httpError('요청 한도 초과', 429), { retryAfterSeconds: Math.ceil((until - now()) / 1000) })
    let job = jobs.get(key)
    if (!job) {
      if (jobs.size >= maxJobs) throw httpError('조회가 많습니다. 잠시 후 다시 시도해 주세요.', 503)
      job = { controller: new AbortController(), waiters: 0 }
      jobs.set(key, job)
      job.promise = (async () => {
        let timer
        try {
          return await Promise.race([
            Promise.resolve().then(() => readBroker(broker, account, days, accountRef, job.controller.signal)),
            new Promise((_, reject) => {
              job.stop = () => reject(abortError())
              job.controller.signal.addEventListener('abort', job.stop, { once: true })
              timer = setTimeout(() => {
                reject(httpError('조회 시간 초과', 504))
                job.controller.abort()
              }, timeoutMs)
            }),
          ])
        } catch (error) {
          if (error.name !== 'AbortError' || !job.controller.signal.aborted) {
            const diagnostic = safeOrderFailure(broker, error)
            if (diagnostic.category === 'rate_limited') {
              error.statusCode = 429
              const seconds = /^\d+(?:\.\d+)?$/.test(String(error.retryAfter || ''))
                ? Number(error.retryAfter) : (Date.parse(error.retryAfter) - now()) / 1000
              error.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.min(300, Math.max(1, Math.ceil(seconds))) : 30
              if (cooldowns.size >= 500) cooldowns.delete(cooldowns.keys().next().value)
              cooldowns.set(owner, now() + error.retryAfterSeconds * 1000)
            }
            try { onBrokerError(diagnostic) } catch { /* Diagnostics must not alter the result. */ }
          }
          throw error
        } finally {
          clearTimeout(timer); clearTimeout(job.cancelTimer)
          job.controller.signal.removeEventListener('abort', job.stop)
          job.controller.abort()
          jobs.delete(key)
        }
      })()
    }
    clearTimeout(job.cancelTimer)
    job.waiters++
    return new Promise((resolve, reject) => {
      let finished = false
      const done = (callback, value) => {
        if (finished) return
        finished = true; signal?.removeEventListener('abort', cancelled)
        job.waiters--
        if (!job.waiters && jobs.get(key) === job) job.cancelTimer = setTimeout(() => job.controller.abort(), cancelGraceMs)
        callback(value)
      }
      const cancelled = () => done(reject, abortError())
      signal?.addEventListener('abort', cancelled, { once: true })
      job.promise.then(value => done(resolve, value), error => done(reject, error))
      if (signal?.aborted) cancelled()
    })
  }
}
