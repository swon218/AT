import { useEffect, useState } from 'react'

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'full',
})
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export default function DashboardWelcome() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer
    const refresh = () => {
      clearTimeout(timer)
      setNow(new Date())
      timer = setTimeout(refresh, 1000 - (Date.now() % 1000))
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh()
      else clearTimeout(timer)
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  return (
    <section className="welcome guest-welcome dashboard-welcome">
      <div><p>{dateFormatter.format(now)}</p><h1>통합 대시보드</h1></div>
      <time className="dashboard-clock" dateTime={now.toISOString()} aria-label={`한국 표준시 ${timeFormatter.format(now)}`}>
        <strong>{timeFormatter.format(now)}</strong><small>KST</small>
      </time>
    </section>
  )
}
