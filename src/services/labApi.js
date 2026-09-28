const base = import.meta.env.VITE_API_BASE_URL ?? ''

// Historical data is public and never obtains or sends brokerage credentials.
async function read(path, signal) {
  let response
  try { response = await fetch(`${base}/api/public/lab/${path}`, { signal, credentials: 'omit' }) }
  catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('실험실 서버에 연결하지 못했습니다. 네트워크와 VPS API를 확인하세요.')
  }
  let body
  try { body = await response.json() }
  catch { throw new Error('실험실 API가 준비되지 않았습니다. VPS 백엔드 배포를 확인하세요.') }
  if (!response.ok) throw new Error(body.error || '일봉 데이터를 불러오지 못했습니다.')
  return body
}

export const getLabSymbols = (signal) => read('symbols', signal)
export const getLabCandles = (symbol, signal) => read(`candles?symbol=${encodeURIComponent(symbol)}`, signal)
