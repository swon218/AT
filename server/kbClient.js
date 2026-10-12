import { config } from './config.js'
import { createThrottle, createTokenCache, fetchJson, httpError } from './brokerHttp.js'

export function validateKbResponse(body) {
  const h = body.dataHeader
  if (!h || String(h.resultCode) !== '200' || h.processFlag !== 'A') {
    throw httpError(`KB API: ${h?.processMessage || h?.resultMessage || '응답의 처리 결과를 확인할 수 없습니다.'}`)
  }
  if (!body.dataBody || typeof body.dataBody !== 'object') throw httpError('KB API 응답에 데이터가 없습니다.')
  return body.dataBody
}

export function createKbClient({ fetcher = fetch, ip = config.kbClientIp, mac = config.kbClientMac, throttle = createThrottle(150) } = {}) {
  function header() {
    if (!ip || !mac) throw httpError('VPS에 KB_CLIENT_IP와 KB_CLIENT_MAC을 설정해 주세요.', 503)
    return { ipAddr: ip, macAddr: mac }
  }
  const tokens = createTokenCache(async auth => {
    // Detailed B2C TR specification uses dataHeader/dataBody and grantType.
    const { body } = await fetchJson(fetcher, `${config.kbHost}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataHeader: header(), dataBody: { appKey: auth.appKey, appSecret: auth.secretKey, grantType: 'client_credentials' } }),
    }, 'KB 인증')
    const data = validateKbResponse(body)
    return { token: data.access_token, expiresIn: data.expires_in }
  })
  async function request(auth, code, input, { write = false, retry = true } = {}) {
    if (!['ssam1801', 'ssam1802', 'ssqm1801', 'ssqm1802', 'ssqm2952', 'ivs11560', 'ivu10140'].includes(code)) throw httpError('지원하지 않는 KB API 경로입니다.', 400)
    const dataHeader = header(), token = await tokens.get(auth)
    await throttle(auth)
    try {
      const { body } = await fetchJson(fetcher, `${config.kbHost}/api/v1/${code}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dataHeader, dataBody: input }),
      }, 'KB')
      return validateKbResponse(body)
    } catch (error) {
      if (error.statusCode === 401) {
        tokens.clear(auth)
        if (!write && retry) return request(auth, code, input, { retry: false })
      }
      throw error
    }
  }
  return { request }
}
export const kbClient = createKbClient()
