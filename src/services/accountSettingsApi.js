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

async function authorizedRequest(path, options = {}) {
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) throw new Error('로그인이 필요합니다.')

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

export function getIntegrationSettings() {
  return authorizedRequest('/api/account/settings')
}

export function saveIntegrationSettings(settings) {
  return authorizedRequest('/api/account/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}
