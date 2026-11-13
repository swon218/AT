import { supabase } from './supabaseClient'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
const integrationChannelName = 'atlas-account-settings'
const allowedBrokers = ['kiwoom','toss','nh','kb']
let notificationSource
const source = () => notificationSource ||= `${Date.now()}:${Math.random()}`

// Origin-scoped hints only. Every receiver re-reads authenticated server state.
export function notifyIntegrationChange(userId, brokers) {
  if (typeof window === 'undefined' || !window.BroadcastChannel) return
  const affected = allowedBrokers.filter(broker => brokers.includes(broker))
  if (!affected.length) return
  const channel = new BroadcastChannel(integrationChannelName)
  channel.postMessage({type:'changed',userId,brokers:affected,source:source()})
  channel.close()
}

export function subscribeIntegrationChanges(callback) {
  if (typeof window === 'undefined' || !window.BroadcastChannel) return () => {}
  const channel = new BroadcastChannel(integrationChannelName)
  const receive = ({data}) => {
    if (data?.type !== 'changed' || data.source === source() || typeof data.userId !== 'string' || data.userId.length > 128 || !Array.isArray(data.brokers)) return
    const brokers = allowedBrokers.filter(broker => data.brokers.includes(broker))
    if (brokers.length) callback({type:'changed',userId:data.userId,brokers})
  }
  channel.addEventListener('message',receive)
  return () => {channel.removeEventListener('message',receive);channel.close()}
}

async function parsePayload(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('VPS 계정 설정 API 주소를 확인해 주세요.')
  }
}

async function authorizedRequest(path, options = {}, expectedUserId) {
  const { data } = await supabase.auth.getSession()
  options.signal?.throwIfAborted()
  const accessToken = data.session?.access_token
  if (!accessToken) throw Object.assign(new Error('로그인이 필요합니다.'), {status:401})
  if (expectedUserId && data.session?.user?.id !== expectedUserId) throw Object.assign(new Error('로그인 사용자가 변경되었습니다.'), {status:401})

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  })
  const payload = await parsePayload(response)
  if (!response.ok) {
    const error = new Error(payload.error || '계정 설정 요청을 처리하지 못했습니다.')
    error.status = response.status
    error.code = payload.code
    throw error
  }
  return payload
}

export async function getBrokerConnection(broker, expectedUserId, signal) {
  const { data } = await supabase.auth.getSession()
  signal?.throwIfAborted()
  if (!data.session?.access_token || data.session.user?.id !== expectedUserId) throw new Error('로그인이 필요합니다.')
  const response = await fetch(`${API_BASE_URL}/api/account/connections/${broker}`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` }, signal, cache: 'no-store',
  })
  if (!response.ok) throw new Error('연결 상태를 확인할 수 없습니다.')
  const payload = await response.json()
  return { connected: payload.connected === true, expiresAt: payload.expiresAt }
}

async function boundedSettingsRequest(path, options, expectedUserId, timeoutMs) {
  const signal = options.signal
  const controller = new AbortController()
  const callerAbort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', callerAbort, {once:true})
  if (signal?.aborted) callerAbort()
  const mutation = options.method && options.method !== 'GET'
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(mutation ? '저장 결과를 확인하지 못했습니다. 상태를 다시 조회해 주세요.' : 'API 저장 상태 조회 시간이 초과되었습니다. 다시 확인해 주세요.'), {code:mutation ? 'settings_mutation_timeout' : 'settings_read_timeout'})), timeoutMs)
  let rejectAbort
  try {
    // Bound session restoration as well as fetch; a suspended auth promise
    // must not leave every key input and the retry control loading forever.
    return await new Promise((resolve,reject) => {
      rejectAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', rejectAbort, {once:true})
      if (controller.signal.aborted) { rejectAbort(); return }
      authorizedRequest(path, {...options, signal:controller.signal, cache:'no-store'}, expectedUserId).then(resolve,reject)
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', callerAbort)
    controller.signal.removeEventListener('abort', rejectAbort)
  }
}

export function getIntegrationSettings(expectedUserId, signal) {
  return boundedSettingsRequest('/api/account/settings', {signal}, expectedUserId, 12_000)
}

async function settingsMutation(method, path, body, expectedUserId, {signal} = {}) {
  try {
    return await boundedSettingsRequest(path, {method, body:JSON.stringify(body), signal}, expectedUserId, 15_000)
  } catch (error) {
    error.resultUnknown = !error.status || error.status >= 500
    throw error
  }
}

export function saveIntegrationSettings(settings, expectedUserId, options) {
  return settingsMutation('PUT', '/api/account/settings', settings, expectedUserId, options)
}

export function deleteIntegrationSettings(broker, expectedVersion, expectedUserId, options) {
  if (!['kiwoom','toss','nh','kb'].includes(broker)) throw new Error('삭제할 증권사를 확인해 주세요.')
  return settingsMutation('DELETE', `/api/account/settings/${broker}`, {expectedVersion}, expectedUserId, options)
}

export function kakaoConnectionRequest(action, userId, { body, signal } = {}) {
  return authorizedRequest(`/api/account/kakao${action ? `/${action}` : ''}`, {
    method: action ? 'POST' : 'GET',
    ...(action ? { body: JSON.stringify(body ?? {}) } : {}),
    signal,
    cache: 'no-store',
  }, userId)
}

export function kakaoLaunchUrl(value) {
  const expected = new URL(API_BASE_URL || window.location.origin, window.location.origin)
  const url = new URL(value)
  if (url.origin !== expected.origin || url.username || url.password || url.hash
    || url.pathname !== '/api/account/kakao/authorize' || !/^(?:m\.)?[\w-]{43}$/.test(url.searchParams.get('t') ?? '')) {
    throw new Error('카카오 인증 주소를 확인할 수 없습니다.')
  }
  return url
}
