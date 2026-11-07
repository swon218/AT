import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { Moon, Sun } from 'lucide-react'
import { getTheme, serverSnapshot, setTheme, subscribeTheme } from '../services/theme'

const choices = [['light', '밝은 화면', Sun], ['dark', '어두운 화면', Moon]]

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
  return <div ref={host} className="theme-switch" role="group" aria-label="화면 테마">
    {choices.map(([value, label, Icon], index) => <button type="button" key={value} aria-label={label} aria-pressed={theme === value} onClick={() => setTheme(value)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
      setTheme(choices[target][0])
      event.currentTarget.parentElement.children[target].focus()
    }}>
      <Icon aria-hidden="true" focusable="false" />
      <span className="theme-switch-tooltip" aria-hidden="true">{label}</span>
    </button>)}
  </div>
}
