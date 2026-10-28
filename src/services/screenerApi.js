const messages = {
  screen_unavailable: '조건검색 서버에 연결할 수 없습니다. 서버 배포 또는 연결 상태를 확인해 주세요.',
  screen_data_not_ready: '일봉 데이터를 읽을 수 없습니다. 수집 상태를 확인한 뒤 다시 시도해 주세요.',
  invalid_screen_query: '조건의 기간과 숫자를 확인해 주세요. MACD의 단기 기간은 장기 기간보다 작아야 합니다.',
  snapshot_changed: '수집 데이터가 갱신되었습니다. 처음부터 다시 검색해 주세요.',
  screen_data_changed: '검색 중 데이터가 갱신되었습니다. 다시 검색해 주세요.',
  screen_snapshot_unverified: '데이터의 일관성을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  screen_busy: '다른 조건을 계산하고 있습니다. 잠시 후 다시 시도해 주세요.',
  screen_rate_limited: '조회가 많습니다. 잠시 후 다시 시도해 주세요.',
  calendar_unverified: '거래일 달력을 확인할 수 없어 검색을 중지했습니다.',
  screen_origin_forbidden: '검색 요청의 웹 주소 설정을 확인해 주세요.',
}
export async function screenerApi(query, signal) {
  let response
  try { response = await fetch('/api/screener', { method: query ? 'POST' : 'GET', headers: query ? { 'Content-Type': 'application/json' } : {}, ...(query ? { body: JSON.stringify(query) } : {}), signal }) }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Error(messages.screen_unavailable) }
  let data
  try { data = await response.json() } catch { throw new Error(messages.screen_unavailable) }
  if (!response.ok) throw new Error(messages[data.error] || messages.screen_unavailable)
  if (query && (!Array.isArray(data.items) || !data.coverage || typeof data.snapshot_id !== 'string')) throw new Error(messages.screen_unavailable)
  return data
}
