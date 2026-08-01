const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

async function getPublicMarketData(path, params) {
  const query = new URLSearchParams(params)
  const response = await fetch(`${API_BASE_URL}${path}?${query}`)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || '공개 시장조회 API를 불러오지 못했습니다.')
  return Array.isArray(payload) ? payload : payload.items ?? payload.data ?? []
}

// 이 경로는 VPS가 운영자 키움 키를 사용하되 시장조회만 허용해야 합니다.
// 주문, 계좌, 잔고 경로와 라우터/권한을 반드시 분리합니다.
export function getKiwoomRankings(type = 'realtime', limit = 20) {
  return getPublicMarketData('/api/public/market/kiwoom/rankings', { type, limit: String(limit) })
}

export function getKiwoomCandles(symbol, interval = '일', limit = 200) {
  return getPublicMarketData('/api/public/market/kiwoom/candles', { symbol, interval, limit: String(limit) })
}
