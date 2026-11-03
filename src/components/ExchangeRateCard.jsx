import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
const INTERVAL = 60_000
const won = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const kst = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function useExchangeRate() {
  const [state, setState] = useState({ loading: true })
  const retry = useRef(null)

  useEffect(() => {
    let activeRequest, timer
    function stop() {
      clearTimeout(timer)
      const request = activeRequest
      activeRequest = undefined
      request?.abort()
    }

    async function refresh() {
      if (document.hidden || activeRequest) return
      clearTimeout(timer)
      const controller = new AbortController()
      activeRequest = controller
      setState(previous => ({ ...previous, loading: true }))
      try {
        const response = await fetch(`${API_BASE_URL}/api/public/market/toss/exchange-rate`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        })
        if (!response.ok) throw new Error('Exchange rate unavailable')
        const data = await response.json()
        if (!Number.isFinite(data.midRate) || data.midRate <= 0 ||
            !Number.isFinite(Date.parse(data.validFrom)) || !Number.isFinite(Date.parse(data.validUntil))) {
          throw new Error('Invalid exchange rate')
        }
        if (!controller.signal.aborted) setState({ data, loading: false })
      } catch {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: true }))
      } finally {
        if (activeRequest === controller) {
          activeRequest = undefined
          if (!document.hidden) timer = setTimeout(refresh, INTERVAL)
        }
      }
    }

    function onVisibility() {
      if (document.hidden) stop()
      else refresh()
    }

    retry.current = refresh
    refresh()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      retry.current = null
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return { ...state, retry: () => retry.current?.() }
}

export default function ExchangeRateCard() {
  const { data, loading, error, retry } = useExchangeRate()
  const [expiredWindow, setExpiredWindow] = useState()
  const validUntil = data?.validUntil
  useEffect(() => {
    if (!validUntil) return
    const timer = setTimeout(() => setExpiredWindow(validUntil), Math.min(2_147_483_647, Math.max(0, Date.parse(validUntil) - Date.now())))
    return () => clearTimeout(timer)
  }, [validUntil])
  const stale = data && (data.stale || error || expiredWindow === validUntil || Date.now() >= Date.parse(validUntil))
  return <article className="panel dashboard-summary-card summary-fx" aria-busy={loading}>
    <div className="summary-card-heading"><h2>원/달러</h2><small>1 USD</small></div>
    <strong className={`summary-fx-value${data ? ' has-rate' : ''}`}>{data ? <>{won.format(data.midRate)}<small>원</small></> : '—'}</strong>
    <p className="summary-fx-source">토스증권 매매기준율 · 1분 갱신</p>
    <div className={`summary-card-footer${stale || error ? ' summary-warning' : ''}`}>
      <span role="status">
        {data ? <>{stale && <>갱신 지연<br/></>}<time dateTime={data.validFrom}>{kst.format(new Date(data.validFrom))} KST</time> 기준</>
          : loading ? '불러오는 중' : '환율 조회 실패'}
      </span>
      {(stale || error) && <button type="button" disabled={loading} onClick={retry} aria-label="환율 다시 조회"><RefreshCw size={12}/></button>}
    </div>
  </article>
}
