import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getMarketSession } from '../services/marketSessionApi'

const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const calendarDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })
const time = value => clock.format(new Date(value))

function useMarketSession() {
  const [state, setState] = useState({ loading: true })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let timer, active
    function stop() {
      clearTimeout(timer)
      const request = active
      active = undefined
      request?.abort()
    }
    async function refresh() {
      if (document.hidden || active) return
      clearTimeout(timer)
      const controller = new AbortController()
      active = controller
      let delay = 30_000
      setState(previous => ({ ...previous, loading: true }))
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
        const data = await getMarketSession(signal)
        if (controller.signal.aborted) return
        const untilTransition = Date.parse(data.transitionAt) - Date.parse(data.serverNow)
        if (!data.phase || !Number.isFinite(untilTransition) || untilTransition <= 0) throw new Error('Invalid market session')
        delay = Math.min(delay, untilTransition)
        setState({ data, loading: false })
      } catch {
        if (!controller.signal.aborted) setState({ error: true, loading: false })
      } finally {
        if (active === controller) {
          active = undefined
          if (!document.hidden) timer = setTimeout(refresh, delay)
        }
      }
    }
    function onVisibility() {
      if (document.hidden) stop()
      else refresh()
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [attempt])
  return { ...state, retry: () => setAttempt(value => value + 1) }
}

function sessionDetail(data) {
  if (data.currentSession) {
    return `${time(data.currentSession.endAt)} 종료${data.phase === 'preMarket' ? ' · NXT' : ''}`
  }
  const next = data.nextSession
  if (!next) return '다음 거래 일정 확인 필요'
  if (data.phase === 'waiting') return `다음: ${next.label} ${time(next.startAt)}`
  return `다음 거래: ${calendarDate.format(new Date(next.startAt))} · ${time(next.startAt)} · ${next.label}`
}

export default function MarketSessionCard() {
  const { data, loading, error, retry } = useMarketSession()
  const warning = error || data?.stale
  const phase = data?.phase
  const tone = warning ? 'stale' : phase === 'regularMarket' ? 'open' : data?.currentSession ? 'after-hours' : ''
  return <article className="panel dashboard-summary-card summary-session" aria-busy={loading}>
    <div className="summary-card-heading"><h2>장 상태</h2><small>KRX · NXT</small></div>
    <div className={`summary-session-state ${tone}`} role="status">
      <span className="session-dot"/><strong>{data?.label ?? (error ? '장 상태 확인 불가' : '불러오는 중')}</strong>
    </div>
    <p className="summary-session-detail">
      {data ? sessionDetail(data) : error ? '운영 일정을 불러오지 못했습니다.' : '오늘의 운영 일정 확인 중'}
    </p>
    <div className={`summary-card-footer${warning ? ' summary-warning' : ''}`}>
      <span title="KRX·NXT 통합 일정입니다. 장전·장후 시간외종가 거래는 제외됩니다.">
        토스증권 운영 일정 기준{data?.stale && <><br/>일정 갱신 지연</>}
      </span>
      {warning && <button type="button" onClick={retry} disabled={loading} aria-label="장 상태 다시 조회"><RefreshCw size={12}/></button>}
    </div>
  </article>
}
