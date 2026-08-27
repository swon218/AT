import { supabase } from './supabaseClient'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

async function getPublicMarketData(path, params) {
  const query = new URLSearchParams(params)
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  const response = await fetch(`${API_BASE_URL}${path}?${query}`, { headers })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || '공개 시장조회 API를 불러오지 못했습니다.')
  return Array.isArray(payload) ? payload : payload.items ?? payload.data ?? []
}

// 게스트는 VPS 운영자 키를, 로그인 후 개인 키움 키를 저장한 사용자는 본인 키를 사용합니다.
// 주문과 계좌 조회는 별도의 인증 필수 경로로 분리합니다.
export function getKiwoomRankings(type = 'realtime', limit = 20) {
  return getPublicMarketData('/api/public/market/kiwoom/rankings', { type, limit: String(limit) })
}

export function getKiwoomCandles(symbol, interval = '일', limit = 200) {
  return getPublicMarketData('/api/public/market/kiwoom/candles', { symbol, interval, limit: String(limit) })
}

export function getBrokerCandles(broker, symbol, interval = '일', limit = 200) {
  const selectedBroker = broker === 'toss' ? 'toss' : 'kiwoom'
  return getPublicMarketData(`/api/public/market/${selectedBroker}/candles`, { symbol, interval, limit: String(limit) })
}
