import { supabase } from './supabaseClient'

const base = import.meta.env.VITE_API_BASE_URL ?? ''

export async function getRecentOrders({ accountRefs = {}, selected, broker, id, signal } = {}) {
  const { data } = await supabase?.auth.getSession() ?? { data: {} }
  const token = data?.session?.access_token
  if (!token) throw Object.assign(new Error('로그인이 필요합니다.'), { status: 401 })
  const query = new URLSearchParams(Object.entries(accountRefs).map(([broker, value]) => [`${broker}Account`, value]))
  if (selected) query.set('brokers', selected.join(','))
  const path = broker && id ? `/api/account/orders/recent/${encodeURIComponent(broker)}/${encodeURIComponent(id)}` : '/api/account/orders/recent'
  const response = await fetch(`${base}${path}?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal })
  let payload
  try { payload = await response.json() } catch { throw new Error('주문내역 API 응답을 확인해 주세요.') }
  if (!response.ok) throw Object.assign(new Error(payload.error || '주문내역을 조회하지 못했습니다.'), { status: response.status, missingBrokers: payload.missingBrokers })
  return payload
}
