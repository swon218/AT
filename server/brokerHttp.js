import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export const httpError = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode })
export const fingerprint = ({ appKey, secretKey }) => createHash('sha256').update(`${appKey}\0${secretKey}`).digest('hex')
export const numeric = value => {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const result = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(result) ? result : null
}
export const stockCode = value => String(value || '').trim().replace(/^A(?=[0-9][0-9A-Z]{5}$)/, '')
export const validSymbol = symbol => /^[0-9][0-9A-Z]{5}$/.test(symbol)

// Never propagate transport errors containing a token URL or credentials.
export async function fetchJson(fetcher, url, options, label) {
  let response
  try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(20_000) }) }
  catch { throw httpError(`${label} 응답을 확인할 수 없습니다. 잠시 후 다시 조회해 주세요.`, 504) }
  let body
  try { body = await response.json() }
  catch { throw httpError(`${label} 응답 형식을 확인할 수 없습니다.`) }
  if (!response.ok) throw httpError(`${label} 요청이 거절되었습니다. (HTTP ${response.status})`, response.status === 401 ? 401 : 502)
  return { body, response }
}

export function createTokenCache(issue) {
  const tokens = new Map()
  return {
    clear: auth => tokens.delete(fingerprint(auth)),
    async get(auth) {
      if (!auth.appKey || !auth.secretKey) throw httpError('증권사 앱키와 시크릿키가 필요합니다.', 403)
      const key = fingerprint(auth)
      const cached = tokens.get(key)
      if (cached?.promise) return cached.promise
      if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
      const promise = issue(auth).then(({ token, expiresIn }) => {
        if (!token) throw httpError('증권사 인증 응답에 접근 토큰이 없습니다.')
        tokens.set(key, { token, expiresAt: Date.now() + (Number(expiresIn) || 86400) * 1000 })
        return token
      }).catch(error => { tokens.delete(key); throw error })
      tokens.set(key, { promise })
      return promise
    },
  }
}

export function createThrottle(intervalMs) {
  const next = new Map()
  return async auth => {
    const key = fingerprint(auth), now = Date.now()
    const at = Math.max(now, next.get(key) || 0)
    next.set(key, at + intervalMs)
    if (at > now) await delay(at - now)
    if (next.size > 500) for (const [key, time] of next) if (time < now) next.delete(key)
  }
}
