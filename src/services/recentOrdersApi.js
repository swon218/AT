import { supabase } from './supabaseClient'

const base = import.meta.env.VITE_API_BASE_URL ?? ''

export async function getRecentOrders({ period, before, day, userId, accountRefs = {}, selected, broker, id, signal }) {
  const { data } = await supabase?.auth.getSession() ?? { data: {} }
  signal?.throwIfAborted()
  const token = data?.session?.access_token
  if (!token || data.session.user?.id !== userId) throw Object.assign(new Error('로그인 세션을 확인해 주세요.'), { status: 401 })
  const query = new URLSearchParams(Object.entries(accountRefs).map(([broker, value]) => [`${broker}Account`, value]))
  query.set('from', period.start)
  query.set('to', period.end)
  if (before) query.set('before', before)
  if (day) query.set('day', day)
  if (selected) query.set('brokers', selected.join(','))
  const path = broker && id ? `/api/account/orders/history/${encodeURIComponent(broker)}/${encodeURIComponent(id)}` : '/api/account/orders/history'
  const response = await fetch(`${base}${path}?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal })
  let payload
  try { payload = await response.json() } catch { throw new Error('주문내역 API 응답을 확인해 주세요.') }
  if (!response.ok) throw Object.assign(new Error(payload.error || '주문내역을 조회하지 못했습니다.'), { status: response.status, missingBrokers: payload.missingBrokers })
  if (id ? payload?.item?.id !== id : !payload?.window || !Array.isArray(payload.items) || !Array.isArray(payload.brokers)) {
    throw new Error('주문내역 API 응답을 확인해 주세요.')
  }
  return payload
}
