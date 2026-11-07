import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { getTheme, serverSnapshot, setTheme, subscribeTheme } from '../services/theme'

export default function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, serverSnapshot)
  const host = useRef(null)
  useLayoutEffect(() => {
    const header = host.current.closest('header')
    const measure = () => document.documentElement.style.setProperty('--app-header-height', `${header.getBoundingClientRect().height}px`)
    const observer = new ResizeObserver(measure)
    measure(); observer.observe(header)
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--app-header-height') }
  }, [])
  const choices = [['light', '라이트'], ['dark', '다크']]
  return <div ref={host} className="theme-switch" role="group" aria-label="화면 테마">
    {choices.map(([value, label], index) => <button type="button" key={value} aria-pressed={theme === value} onClick={() => setTheme(value)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
      setTheme(choices[target][0])
      event.currentTarget.parentElement.children[target].focus()
    }}>{label}</button>)}
  </div>
}
