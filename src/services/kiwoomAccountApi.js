import { supabase } from './supabaseClient'
import { getBroker } from '../utils/brokers'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export async function getKiwoomAccountSummary() {
  return getBrokerAccountSummary('kiwoom')
}

export async function getBrokerAccountSummary(broker, symbol = '', accountId = '', { signal, userId } = {}) {
  if (!supabase) throw new Error('Supabase 환경 설정을 확인해 주세요.')
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) throw new Error('로그인이 필요합니다.')
  if (userId && data.session?.user?.id !== userId) throw new Error('계정이 변경되었습니다. 다시 확인해 주세요.')
  signal?.throwIfAborted()

  const selectedBroker = getBroker(broker).id
  const query = `?${new URLSearchParams({ symbol, ...(accountId ? { accountId } : {}) })}`
  const deadline = AbortSignal.timeout(25_000)
  let response
  try {
    response = await fetch(`${API_BASE_URL}/api/account/${selectedBroker}/summary${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(deadline.aborted ? '보유정보 조회 시간이 초과했습니다. 다시 확인해 주세요.' : '보유정보를 확인할 수 없습니다. 연결 상태를 확인해 주세요.')
  }
  const text = await response.text()
  let payload = {}
  try { payload = text ? JSON.parse(text) : {} } catch { throw new Error('증권사 계좌조회 API 응답을 확인해 주세요.') }
  if (!response.ok) throw new Error(payload.error || '계좌 정보를 불러오지 못했습니다.')
  // Older Kiwoom summaries predate the broker field. The authenticated route
  // identifies this provider; never overwrite an explicitly different broker.
  return selectedBroker === 'kiwoom' && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.broker === undefined
    ? { ...payload, broker: 'kiwoom' } : payload
}
