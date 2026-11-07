import { createHash } from 'node:crypto'
import { getAuthenticatedCredentials } from './accountSettings.js'
import { accountConnectionCache } from './accountConnectionCache.js'
import { requestKiwoomWithCredentials } from './kiwoomClient.js'
import { requestTossWithCredentials } from './tossClient.js'
import { nhClient, validateNhResponse } from './nhClient.js'
import { kbClient } from './kbClient.js'
import { stockCode, validSymbol } from './brokerHttp.js'

export const CONNECTION_BROKERS = ['kiwoom', 'toss', 'nh', 'kb']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const amount = value => (typeof value === 'string' || typeof value === 'number') &&
  /^[+-]?\d+(?:\.\d+)?$/.test(String(value).replace(/,/g, '').trim()) && Number.isFinite(Number(String(value).replace(/,/g, '')))
const failure = () => { throw new Error('Invalid account evidence') }

function nhSuccess(payload) {
  if (!object(payload)) failure()
  validateNhResponse(payload)
  // NH documents that rsp_cd alone is not a success criterion.
  if (!/조회.*(?:완료|계속)|정상.*(?:처리|조회)/.test(String(payload.rsp_msg || payload.message?.usr_msg || ''))) failure()
}

export function createAccountProbe({ kiwoom = requestKiwoomWithCredentials, toss = requestTossWithCredentials, nh = nhClient, kb = kbClient } = {}) {
  return async (broker, auth, signal) => {
    if (broker === 'kiwoom') {
      const result = await kiwoom({ ...auth, apiId: 'kt00001', endpoint: '/api/dostk/acnt', body: { qry_tp: '2' }, retry: false, signal })
      if (!object(result) || !['0', 0].includes(result.return_code) || !amount(result.entr)) failure()
    } else if (broker === 'toss') {
      // Fresh personal account response, bypassing the client's 5-minute account cache.
      const result = await toss({ ...auth, path: '/api/v1/accounts', retry: false, signal })
      if (!object(result) || result.error != null || result.success === false || !Array.isArray(result.result) ||
        !result.result.some(row => row?.accountType === 'BROKERAGE' && typeof row.accountNo === 'string' && /^\d+$/.test(row.accountNo) &&
          /^\d+$/.test(String(row.accountSeq ?? '')) && Number.isSafeInteger(Number(row.accountSeq)) && Number(row.accountSeq) > 0)) failure()
    } else if (broker === 'nh') {
      const accounts = await nh.request(auth, '/n2/acctinfo', {}, { retry: false, signal })
      nhSuccess(accounts)
      const own = Array.isArray(accounts.Output_0) && accounts.Output_0.find(row =>
        (nh.simulated ? ['03'] : ['01', '02']).includes(row?.acct_type) && /^\d{11}$/.test(String(row.acct_no || '')))
      if (!own) failure()
      // This local choice never reads or updates the user's order-account selection.
      const result = await nh.request(auth, '/krstock/inquiry/v1/balance', {
        act_no: own.acct_no, bnc_bse_cd: '1', ltg_aot_dit_cd: '9', aet_bse: '1', qut_dit_cd: 'KRX', aly_qut_cd: '1',
      }, { retry: false, signal })
      nhSuccess(result)
      const total = object(result.Output_0) && amount(result.Output_0.dca)
      // Totals can occur only on the last page. A valid first-page holding proves access.
      const holding = Array.isArray(result.Output_1) && result.Output_1.length > 0 && result.Output_1.every(row =>
        object(row) && validSymbol(stockCode(row.iem_cd)) && amount(row.itg_bnc_qty))
      if (!total && !holding) failure()
    } else if (broker === 'kb') {
      // kb.request validates resultCode=200 and processFlag=A before returning dataBody.
      const result = await kb.request(auth, 'ssqm2952', { excg_mktpr_ccd: 'K' }, { retry: false, signal })
      if (!object(result) || !amount(result.dy_tfnd)) failure()
    } else failure()
    return true
  }
}

function personalAuth(account, broker) {
  const credentials = account.credentials || {}
  const key = credentials[broker === 'toss' ? 'tossApiKey' : `${broker}AppKey`]
  const secretKey = credentials[`${broker}SecretKey`]
  if (!account.status?.[`${broker}Configured`] || !key || !secretKey) return null
  return broker === 'toss' ? { apiKey: key, secretKey } : { appKey: key, secretKey }
}
const versionOf = auth => auth && createHash('sha256').update(JSON.stringify(auth)).digest('hex')

export function createAccountConnectionHandler({ authenticate = getAuthenticatedCredentials, probe = createAccountProbe(), cache = accountConnectionCache, now = Date.now } = {}) {
  return async (request, broker) => {
    const account = await authenticate(request)
    const auth = personalAuth(account, broker)
    if (!auth) {
      cache.invalidate(account.user.id, [broker])
      return { connected: false, expiresAt: now() + 60_000 }
    }
    const version = versionOf(auth)
    const result = await cache.check(account.user.id, broker, version, signal => probe(broker, auth, signal))
    // Re-read the owning encrypted row after a slow read: a replacement/deletion in
    // another request or process must not turn an obsolete key into a new success.
    const latest = await authenticate(request)
    const current = latest.user.id === account.user.id && versionOf(personalAuth(latest, broker)) === version && result.current()
    return { connected: current && result.connected, expiresAt: current ? result.expiresAt : now() }
  }
}

export function registerAccountConnectionRoutes(app, handler = createAccountConnectionHandler()) {
  for (const broker of CONNECTION_BROKERS) app.get(`/api/account/connections/${broker}`, { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    if (!/^Bearer\s+\S+$/i.test(request.headers.authorization || '')) return reply.code(401).send({ error: '로그인이 필요합니다.' })
    try { return await handler(request, broker) }
    catch (error) {
      const status = error.statusCode === 401 ? 401 : 503
      return reply.code(status).send({ error: status === 401 ? '로그인이 필요합니다.' : '연결 상태를 확인할 수 없습니다.' })
    }
  })
}
