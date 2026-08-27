import { createHash } from 'node:crypto'
import { config } from './config.js'

const tokenCache = new Map()
const accountCache = new Map()

function credentialKey(apiKey, secretKey) {
  return createHash('sha256').update(`${apiKey}\0${secretKey}`).digest('hex')
}

async function readJson(response, label) {
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { message: text } }
  if (!response.ok) {
    const message = body.error?.message || body.error_description || body.message || `${label} 요청에 실패했습니다. (${response.status})`
    const error = new Error(message)
    error.statusCode = response.status
    error.code = body.error?.code || body.error || ''
    throw error
  }
  return body
}

async function issueAccessToken({ apiKey, secretKey }) {
  const response = await fetch(`${config.tossHost}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: secretKey,
    }),
  })
  const body = await readJson(response, '토스 인증')
  if (!body.access_token) throw new Error('토스 인증 응답에 액세스 토큰이 없습니다.')
  return {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 86400) * 1000,
  }
}

async function getAccessToken({ apiKey, secretKey, forceRefresh = false }) {
  if (!apiKey || !secretKey) throw new Error('토스 API 키가 설정되지 않았습니다.')
  const key = credentialKey(apiKey, secretKey)
  const cached = tokenCache.get(key)
  if (!forceRefresh && cached?.token && Date.now() < cached.expiresAt - 10 * 60 * 1000) return { token: cached.token, key }
  if (!forceRefresh && cached?.promise) return { token: (await cached.promise).token, key }

  const promise = issueAccessToken({ apiKey, secretKey })
  tokenCache.set(key, { promise })
  try {
    const issued = await promise
    tokenCache.set(key, issued)
    return { token: issued.token, key }
  } catch (error) {
    tokenCache.delete(key)
    throw error
  }
}

export async function requestTossWithCredentials({ apiKey, secretKey, path, method = 'GET', query, body, accountSeq, retry = true }) {
  const { token, key } = await getAccessToken({ apiKey, secretKey })
  const url = new URL(path, config.tossHost)
  Object.entries(query || {}).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
  })
  const headers = { Authorization: `Bearer ${token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (accountSeq !== undefined && accountSeq !== null) headers['X-Tossinvest-Account'] = String(accountSeq)

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401 && retry) {
    tokenCache.delete(key)
    return requestTossWithCredentials({ apiKey, secretKey, path, method, query, body, accountSeq, retry: false })
  }
  return readJson(response, `토스 ${method} ${path}`)
}

export async function getTossBrokerageAccount({ apiKey, secretKey }) {
  const key = credentialKey(apiKey, secretKey)
  const cached = accountCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.account

  const payload = await requestTossWithCredentials({ apiKey, secretKey, path: '/api/v1/accounts' })
  const accounts = Array.isArray(payload.result) ? payload.result : []
  const account = accounts.find((item) => item.accountType === 'BROKERAGE') || accounts[0]
  if (account?.accountSeq === undefined || account?.accountSeq === null) {
    const error = new Error('토스증권에서 사용할 수 있는 종합매매 계좌를 찾지 못했습니다.')
    error.statusCode = 404
    throw error
  }
  accountCache.set(key, { at: Date.now(), account })
  return account
}

export function requestToss({ path, method, query, body, accountSeq }) {
  return requestTossWithCredentials({
    apiKey: config.tossApiKey,
    secretKey: config.tossSecretKey,
    path,
    method,
    query,
    body,
    accountSeq,
  })
}
