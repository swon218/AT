import { supabase } from './supabaseClient'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export async function getKiwoomAccountSummary() {
  return getBrokerAccountSummary('kiwoom')
}

export async function getBrokerAccountSummary(broker, symbol = '') {
  if (!supabase) throw new Error('Supabase 환경 설정을 확인해 주세요.')
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) throw new Error('로그인이 필요합니다.')

  const selectedBroker = broker === 'toss' ? 'toss' : 'kiwoom'
  const query = selectedBroker === 'toss' && symbol ? `?${new URLSearchParams({ symbol })}` : ''
  const response = await fetch(`${API_BASE_URL}/api/account/${selectedBroker}/summary${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const text = await response.text()
  let payload = {}
  try { payload = text ? JSON.parse(text) : {} } catch { throw new Error('증권사 계좌조회 API 응답을 확인해 주세요.') }
  if (!response.ok) throw new Error(payload.error || '계좌 정보를 불러오지 못했습니다.')
  return payload
}
