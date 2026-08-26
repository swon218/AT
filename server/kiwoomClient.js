import { config } from './config.js'
import { createHash } from 'node:crypto'

const tokenCache = new Map()

async function readJson(response, label) {
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { message: text } }
  if (!response.ok || (body.return_code && String(body.return_code) !== '0')) {
    throw new Error(body.return_msg || body.message || `${label} 요청에 실패했습니다. (${response.status})`)
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
  tokenCache.set(cacheKey, { token: body.token, expiresAt: parseKiwoomExpiry(body.expires_dt) })
  return { token: body.token, cacheKey }
}

export async function requestKiwoomWithCredentials({ appKey, secretKey, apiId, endpoint, body }) {
  const { token, cacheKey } = await getAccessToken({ appKey, secretKey })
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
  if (response.status === 401) {
    tokenCache.delete(cacheKey)
  }
  return readJson(response, `키움 ${apiId}`)
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
