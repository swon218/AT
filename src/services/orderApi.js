import { supabase } from './supabaseClient'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export async function placeKiwoomOrder(order) {
  return placeBrokerOrder('kiwoom', order)
}

export async function placeBrokerOrder(broker, order) {
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) throw new Error('로그인이 필요합니다.')

  const selectedBroker = broker === 'toss' ? 'toss' : 'kiwoom'
  const response = await fetch(`${API_BASE_URL}/api/orders/${selectedBroker}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(order),
  })
  const text = await response.text()
  let payload = {}
  try { payload = text ? JSON.parse(text) : {} } catch { throw new Error('주문 API 응답을 확인해 주세요.') }
  if (!response.ok) throw new Error(payload.error || '주문 요청을 처리하지 못했습니다.')
  return payload
}
