const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export async function getMarketSession(signal) {
  const response = await fetch(`${API_BASE_URL}/api/public/market/session`, { signal })
  if (!response.ok) throw new Error('장 상태 확인 불가')
  return response.json()
}
