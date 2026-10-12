import { config } from './config.js'
import { createThrottle, createTokenCache, fetchJson, httpError } from './brokerHttp.js'

const hosts = new Set(['https://api.nhplug.com:8443', 'https://moapi.nhplug.com:8443'])
const failedMessage = /실패|오류|불가|없습니다.*(권한|계좌)|유효하지|입력하|초과|잘못|거절|미등록|만료|부족|미신청/
export function validateNhResponse(body) {
  const message = body.message || {}
  const text = String(message.usr_msg || body.rsp_msg || '')
  if (['E', 'F'].includes(message.msg_lv_code) || failedMessage.test(text)) {
    throw httpError(`NH API: ${text || '요청이 거절되었습니다.'}`)
  }
  return body
}

export function createNhClient({ fetcher = fetch, host = config.nhHost, throttle = createThrottle(250) } = {}) {
  if (!hosts.has(host)) throw httpError('NH_API_HOST는 공식 나무 PLUG 운영/모의 주소만 사용할 수 있습니다.', 503)
  const tokens = createTokenCache(async auth => {
    const url = new URL('https://api.nhplug.com:8443/oauth2/token')
    url.search = new URLSearchParams({ appkey: auth.appKey, appsecretkey: auth.secretKey, grant_type: 'client_credentials', scope: 'oob' })
    const { body } = await fetchJson(fetcher, url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'NH 인증')
    return { token: body.access_token, expiresIn: body.expires_in }
  })
  async function request(auth, path, input = {}, { cts = '', write = false, retry = true } = {}) {
    if (!/^\/(krstock\/(quote|inquiry|order)\/v1\/[A-Za-z]+|n2\/acctinfo)$/.test(path)) throw httpError('지원하지 않는 NH API 경로입니다.', 400)
    const token = await tokens.get(auth)
    await throttle(auth)
    const base = path === '/n2/acctinfo' || path.includes('/quote/') ? 'https://api.nhplug.com:8443' : host
    try {
      const { body, response } = await fetchJson(fetcher, `${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(cts ? { cts, cts_flag: 'Y' } : {}) },
        body: JSON.stringify({ Input_0: input }),
      }, 'NH')
      validateNhResponse(body)
      return { ...body, continuation: response.headers.get('cts_flag') === 'Y' ? response.headers.get('cts') || '' : '', hasMore: response.headers.get('cts_flag') === 'Y' }
    } catch (error) {
      if (error.statusCode === 401) {
        tokens.clear(auth)
        if (!write && retry) return request(auth, path, input, { cts, retry: false })
      }
      throw error
    }
  }
  return { request, simulated: host.includes('moapi.') }
}
export const nhClient = createNhClient()
