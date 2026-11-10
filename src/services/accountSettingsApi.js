import { supabase } from './supabaseClient'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

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
  if (!accessToken) throw new Error('로그인이 필요합니다.')
  if (expectedUserId && data.session?.user?.id !== expectedUserId) throw new Error('로그인 사용자가 변경되었습니다.')

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  })
  const payload = await parsePayload(response)
  if (!response.ok) throw new Error(payload.error || '계정 설정 요청을 처리하지 못했습니다.')
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

export function getIntegrationSettings() {
  return authorizedRequest('/api/account/settings')
}

export function saveIntegrationSettings(settings, expectedUserId) {
  return authorizedRequest('/api/account/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }, expectedUserId)
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
