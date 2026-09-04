import { config } from './config.js'
import { createHash } from 'node:crypto'

const tokenCache = new Map()
const INVALID_TOKEN_CODES = new Set([8003, 8005, 8006, 8009, 8015, 8016])

function normalizeReturnCode(value) {
  if (value === undefined || value === null || value === '') return null
  const code = Number(String(value).trim())
  return Number.isFinite(code) ? code : null
}

function isInvalidTokenResponse(response, body) {
  if (response.status === 401) return true
  const returnCode = normalizeReturnCode(body.return_code)
  if (INVALID_TOKEN_CODES.has(returnCode)) return true
  const message = String(body.return_msg || body.message || '')
  return /\[(?:8003|8005|8006|8009|8015|8016):/i.test(message)
}

async function readJson(response, label) {
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { message: text } }
  if (!response.ok || (body.return_code && String(body.return_code) !== '0')) {
    const error = new Error(body.return_msg || body.message || `${label} 요청에 실패했습니다. (${response.status})`)
    error.statusCode = response.status
    error.returnCode = normalizeReturnCode(body.return_code)
    error.invalidToken = isInvalidTokenResponse(response, body)
    throw error
  }
  return body
}

function parseKiwoomExpiry(expiresDt) {
  if (!expiresDt) return Date.now() + 23 * 60 * 60 * 1000
  const digits = String(expiresDt).replace(/\D/g, '')
  if (digits.length < 14) return Date.now() + 23 * 60 * 60 * 1000
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}+09:00`
  const time = new Date(iso).getTime()
  return Number.isFinite(time) ? time : Date.now() + 23 * 60 * 60 * 1000
}

function credentialCacheKey(appKey, secretKey) {
  return createHash('sha256').update(`${appKey}\0${secretKey}`).digest('hex')
}

async function getAccessToken({ appKey, secretKey }) {
  if (!appKey || !secretKey) throw new Error('키움 API 키가 설정되지 않았습니다.')
  const cacheKey = credentialCacheKey(appKey, secretKey)
  const cached = tokenCache.get(cacheKey)
  if (cached?.token && Date.now() < cached.expiresAt - 10 * 60 * 1000) return { token: cached.token, cacheKey }
  if (cached?.promise) return { token: (await cached.promise).token, cacheKey }

  const promise = (async () => {
    const response = await fetch(`${config.kiwoomHost}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: appKey,
        secretkey: secretKey,
      }),
    })
    const body = await readJson(response, '키움 인증')
    if (!body.token) throw new Error('키움 인증 응답에 토큰이 없습니다.')
    return { token: body.token, expiresAt: parseKiwoomExpiry(body.expires_dt) }
  })()

  tokenCache.set(cacheKey, { promise })
  try {
    const issued = await promise
    tokenCache.set(cacheKey, issued)
    return { token: issued.token, cacheKey }
  } catch (error) {
    if (tokenCache.get(cacheKey)?.promise === promise) tokenCache.delete(cacheKey)
    throw error
  }
}

export async function requestKiwoomWithCredentials({ appKey, secretKey, apiId, endpoint, body, retry = true }) {
  const { token, cacheKey } = await getAccessToken({ appKey, secretKey })
  try {
    const response = await fetch(`${config.kiwoomHost}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        authorization: `Bearer ${token}`,
        'cont-yn': 'N',
        'next-key': '',
        'api-id': apiId,
      },
      body: JSON.stringify(body),
    })
    return await readJson(response, `키움 ${apiId}`)
  } catch (error) {
    if (!retry || !error.invalidToken) throw error

    const cached = tokenCache.get(cacheKey)
    if (cached?.token === token) tokenCache.delete(cacheKey)
    return requestKiwoomWithCredentials({ appKey, secretKey, apiId, endpoint, body, retry: false })
  }
}

export async function requestKiwoom({ apiId, endpoint, body }) {
  return requestKiwoomWithCredentials({
    appKey: config.kiwoomAppKey,
    secretKey: config.kiwoomSecretKey,
    apiId,
    endpoint,
    body,
  })
}
