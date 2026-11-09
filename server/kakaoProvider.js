const AUTH = 'https://kauth.kakao.com'
const API = 'https://kapi.kakao.com'
const idPattern = /^[1-9][0-9]{0,18}$/

export class KakaoFailure extends Error {
  constructor(kind) {
    super(kind)
    this.kind = kind
  }
}

// Kakao's Long ID can exceed Number.MAX_SAFE_INTEGER. Never match on rounded numbers.
function kakaoId(payload) {
  if (typeof payload?.id !== 'string' || !idPattern.test(payload.id)) throw new KakaoFailure('unavailable')
  return payload.id
}

export function createKakaoProvider(config, request = fetch) {
  const { kakaoRestKey, kakaoClientSecret, kakaoAdminKey, kakaoRedirectUri } = config
  const base = { client_id: kakaoRestKey, client_secret: kakaoClientSecret }
  const post = (body, headers = {}) => ({ method: 'POST', headers, body: new URLSearchParams(body) })

  async function call(url, options, mode) {
    let response, data
    try {
      response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) })
      data = JSON.parse(await response.text(), (key, value, context) => (
        key === 'id' && typeof value === 'number'
          ? (context?.source ?? (Number.isSafeInteger(value) ? String(value) : null))
          : value
      ))
    } catch {
      throw new KakaoFailure('unavailable')
    }
    if (response.ok && data && typeof data === 'object' && !Array.isArray(data) && data.code == null && data.error == null) return data
    if (mode === 'refresh' && data?.error_code === 'KOE322') throw new KakaoFailure('revoked')
    if (mode === 'identity') {
      if (data?.code === -401) throw new KakaoFailure('expired')
      if (data?.code === -101 || data?.code === -103) throw new KakaoFailure('revoked')
    }
    if (mode === 'unlink' && data?.code === -101) throw new KakaoFailure('unlinked')
    throw new KakaoFailure('unavailable')
  }

  function tokens(data, previous) {
    const ttl = (value) => Number.isInteger(value) && value > 0 && value <= 366 * 86400
    const expiry = (value) => new Date(Date.now() + 1000 * value).toISOString()
    const token = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value)
    if (!token(data.access_token) || !ttl(data.expires_in)
      || (data.refresh_token != null && (!token(data.refresh_token) || !ttl(data.refresh_token_expires_in)))
      || (!data.refresh_token && !previous?.refresh)) throw new KakaoFailure('unavailable')
    return {
      access: data.access_token,
      refresh: data.refresh_token ?? previous.refresh,
      access_until: expiry(data.expires_in),
      refresh_until: data.refresh_token ? expiry(data.refresh_token_expires_in) : previous.refresh_until,
      scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter((scope) => /^[\w.-]{1,100}$/.test(scope)).slice(0, 30) : previous?.scopes ?? [],
    }
  }

  return {
    authorize(state, replace) {
      const params = new URLSearchParams({ response_type: 'code', client_id: kakaoRestKey, redirect_uri: kakaoRedirectUri, state })
      if (replace) params.set('prompt', 'login')
      return `${AUTH}/oauth/authorize?${params}`
    },
    async exchange(code) {
      const data = await call(`${AUTH}/oauth/token`, post({ ...base, grant_type: 'authorization_code', redirect_uri: kakaoRedirectUri, code }), 'exchange')
      return tokens(data)
    },
    async identity(access) {
      return kakaoId(await call(`${API}/v2/user/me?property_keys=%5B%5D`, { headers: { Authorization: `Bearer ${access}` } }, 'identity'))
    },
    async refresh(previous) {
      const data = await call(`${AUTH}/oauth/token`, post({ ...base, grant_type: 'refresh_token', refresh_token: previous.refresh }), 'refresh')
      return tokens(data, previous)
    },
    async unlink(id) {
      try {
        const data = await call(`${API}/v1/user/unlink`, post({ target_id_type: 'user_id', target_id: id }, { Authorization: `KakaoAK ${kakaoAdminKey}` }), 'unlink')
        return kakaoId(data) === id
      } catch (error) {
        return error.kind === 'unlinked'
      }
    },
  }
}
