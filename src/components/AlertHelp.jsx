import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const viewportPadding = 8
const gap = 4

function positionHelp(trigger, tooltip) {
  const anchor = trigger.getBoundingClientRect()
  const { width, height } = tooltip.getBoundingClientRect()
  const viewport = window.visualViewport
  const left = (viewport?.offsetLeft ?? 0) + viewportPadding
  const top = (viewport?.offsetTop ?? 0) + viewportPadding
  const right = left + (viewport?.width ?? document.documentElement.clientWidth) - 2 * viewportPadding
  const bottom = top + (viewport?.height ?? document.documentElement.clientHeight) - 2 * viewportPadding
  const roomBelow = bottom - anchor.bottom
  const roomAbove = anchor.top - top
  const preferAbove = roomBelow < height + gap && roomAbove > roomBelow
  const anchorY = preferAbove ? anchor.top - height - gap : anchor.bottom + gap

  tooltip.style.left = `${Math.max(left, Math.min(anchor.left + (anchor.width - width) / 2, right - width))}px`
  tooltip.style.top = `${Math.max(top, Math.min(anchorY, bottom - height))}px`
}

export default function AlertHelp({ label, children, active, setActive, persistent = false, symbol = '?', triggerClassName = 'alert-help-trigger', contentClassName = '' }) {
  const id = useId()
  const trigger = useRef(null)
  const tooltip = useRef(null)
  const closeTimer = useRef(null)
  const open = active?.id === id

  function show(pin = false) {
    clearTimeout(closeTimer.current)
    setActive(current => {
      if (persistent) return { id, pinned: true }
      if (current?.id === id && current.pinned) return pin ? null : current
      return { id, pinned: pin }
    })
  }

  function dismiss(onlyUnpinned = false) {
    clearTimeout(closeTimer.current)
    setActive(current => current?.id === id && (!onlyUnpinned || !current.pinned) ? null : current)
  }

  function leave(event) {
    if (persistent) return
    if (event.pointerType !== 'mouse') return
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!trigger.current?.matches(':focus-visible')) dismiss(true)
    }, 180)
  }

  useEffect(() => () => clearTimeout(closeTimer.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => positionHelp(trigger.current, tooltip.current)
    const outside = event => {
      if (!trigger.current.contains(event.target) && !tooltip.current.contains(event.target)) dismiss()
    }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    }
    const viewport = window.visualViewport
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, children])

  return <>
    <button ref={trigger} type="button" className={triggerClassName} aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open}
      onPointerEnter={event => { if (event.pointerType === 'mouse') show() }} onPointerLeave={leave}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) show() }}
      onBlur={() => { if (!persistent && !trigger.current.matches(':hover') && !tooltip.current.matches(':hover')) dismiss() }}
      onClick={() => show(true)}><span aria-hidden="true">{symbol}</span></button>
    {createPortal(<div ref={tooltip} id={id} role="tooltip" className={`alert-help-tooltip ${contentClassName}`} hidden={!open}
      onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}>{children}</div>, document.body)}
  </>
}
