const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export async function getPublicNews(query = '국내 증시', display = 6) {
  const params = new URLSearchParams({ query, display: String(display) })
  const response = await fetch(`${API_BASE_URL}/api/public/news?${params}`)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || '뉴스를 불러오지 못했습니다.')
  return Array.isArray(payload) ? payload : payload.items ?? []
}
