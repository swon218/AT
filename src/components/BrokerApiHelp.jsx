import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './BrokerApiHelp.css'

// The same portal/viewport positioning approach as AlertHelp, with a separate
// state machine so the settings-specific pin behavior does not change other help.
function placeHelp(trigger, popup) {
  const anchor = trigger.getBoundingClientRect()
  const viewport = window.visualViewport
  const padding = 8, gap = 4
  const left = (viewport?.offsetLeft ?? 0) + padding
  const top = (viewport?.offsetTop ?? 0) + padding
  const right = left + (viewport?.width ?? document.documentElement.clientWidth) - padding * 2
  const bottom = top + (viewport?.height ?? document.documentElement.clientHeight) - padding * 2
  popup.style.maxWidth = `${Math.max(0, right - left)}px`
  popup.style.maxHeight = `${Math.max(0, bottom - top)}px`
  const { width, height } = popup.getBoundingClientRect()
  const below = bottom - anchor.bottom, above = anchor.top - top
  const y = below < height + gap && above > below ? anchor.top - height - gap : anchor.bottom + gap
  popup.style.left = `${Math.max(left, Math.min(anchor.left, right - width))}px`
  popup.style.top = `${Math.max(top, Math.min(y, bottom - height))}px`
}

export default function BrokerApiHelp() {
  const id = useId()
  const trigger = useRef(null), popup = useRef(null), closeTimer = useRef(null)
  const triggerHovered = useRef(false), popupHovered = useRef(false), keyboardFocused = useRef(false)
  const [mode, setMode] = useState('closed')
  const open = mode !== 'closed', pinned = mode === 'pinned'

  const cancelClose = () => clearTimeout(closeTimer.current)
  const close = () => { cancelClose(); popupHovered.current = false; setMode('closed') }
  const preview = () => { cancelClose(); setMode(current => current === 'pinned' ? current : 'preview') }
  const leave = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      if (!triggerHovered.current && !popupHovered.current && !keyboardFocused.current) {
        setMode(current => current === 'pinned' ? current : 'closed')
      }
    }, 180)
  }

  useEffect(() => () => clearTimeout(closeTimer.current), [])
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      if (trigger.current && popup.current) placeHelp(trigger.current, popup.current)
    }
    const outside = event => {
      if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close()
    }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // The parent settings dialog also listens for Escape. Dismiss only this
      // help on the first Escape, without closing or submitting the settings.
      event.stopPropagation()
      close()
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(popup.current)
    const viewport = window.visualViewport
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  return <>
    <button ref={trigger} type="button" className="broker-api-help-trigger"
      aria-label="증권사 API 발급 및 저장 상태 안내" aria-describedby={open ? id : undefined}
      aria-controls={id} aria-expanded={open} aria-pressed={pinned}
      onPointerEnter={event => { if (event.pointerType === 'mouse') { triggerHovered.current = true; preview() } }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') { triggerHovered.current = false; leave() } }}
      onFocus={event => { keyboardFocused.current = event.currentTarget.matches(':focus-visible'); if (keyboardFocused.current) preview() }}
      onBlur={() => { keyboardFocused.current = false; leave() }}
      onClick={event => {
        event.stopPropagation()
        cancelClose()
        popupHovered.current = false
        if (event.detail > 0) keyboardFocused.current = false
        setMode(current => current === 'pinned' ? 'closed' : 'pinned')
      }}>
      <span aria-hidden="true">!</span>
    </button>
    {createPortal(<div ref={popup} id={id} role="tooltip" hidden={!open} className="broker-api-help-popup"
      data-pinned={pinned}
      onPointerEnter={event => { if (event.pointerType === 'mouse') { popupHovered.current = true; cancelClose() } }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') { popupHovered.current = false; leave() } }}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <section><h3>API 발급 및 IP 등록</h3>
        <p>키움증권과 토스증권은 각 증권사에서 API 키를 발급받은 뒤, API 이용 설정에서 아래 서버 IP를 등록해 주세요.</p>
        <p className="broker-api-help-ip">등록할 IP: <code>187.127.206.251</code></p>
      </section>
      <section><h3>저장 상태와 연결 상태</h3>
        <p>개인설정의 초록색 체크는 API 정보가 저장되었다는 뜻입니다.</p>
        <p>키의 유효성이나 실제 연결 성공을 의미하지 않습니다.</p>
        <p>실제 연결 여부는 좌측 하단 ‘사용자 API 범위’에서 확인할 수 있습니다.</p>
      </section>
    </div>, document.body)}
  </>
}
