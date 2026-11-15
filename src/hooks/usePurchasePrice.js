import { useEffect, useRef, useState } from 'react'
import { derivePurchasePrice, isPurchasePriceFresh, PURCHASE_PRICE_FRESH_MS } from '../utils/purchasePrice'

export default function usePurchasePrice({ userId, broker, configured, credentialVersion, accountId, stockCode, summary, status, receivedAt, onRefresh }) {
  const scope = JSON.stringify([userId, broker, configured, credentialVersion, accountId, stockCode])
  const [enabledScope, setEnabledScope] = useState(null)
  const [, setClock] = useState(0)
  const enabled = enabledScope === scope
  const latest = useRef(null)
  latest.current = { enabled, status, receivedAt, onRefresh }
  const assessment = derivePurchasePrice({ userId, broker, configured, accountId, stockCode, summary, status })
  const fresh = isPurchasePriceFresh(receivedAt, Date.now())

  // The scope guard hides the old value during render, before effect cleanup.
  useEffect(() => { setEnabledScope(null) }, [scope])
  useEffect(() => {
    if (!enabled || status !== 'ready') return undefined
    const due = Math.max(100, PURCHASE_PRICE_FRESH_MS - (Date.now() - receivedAt))
    const timer = setTimeout(() => {
      setClock(Date.now())
      if (!document.hidden) onRefresh?.()
    }, due)
    return () => clearTimeout(timer)
  }, [enabled, status, receivedAt, onRefresh])
  useEffect(() => {
    const resume = () => {
      const current = latest.current
      if (!current.enabled || document.hidden || current.status === 'loading') return
      setClock(Date.now())
      if (!isPurchasePriceFresh(current.receivedAt, Date.now())) current.onRefresh?.()
    }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => { window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume) }
  }, [])

  const waiting = enabled && assessment.available && !fresh
  const toggle = () => {
    if (enabled) { setEnabledScope(null); return }
    if (!assessment.available) return
    setEnabledScope(scope)
    if (!isPurchasePriceFresh(receivedAt, Date.now())) onRefresh?.()
  }
  return {
    price: enabled && assessment.available && fresh ? assessment.price : null,
    control: {
      enabled, available: assessment.available,
      status: waiting ? 'loading' : assessment.status,
      message: waiting ? '보유정보 확인 중' : assessment.status === 'ready'
        ? '현재 보유분 평균 매입가입니다. 과거 수정주가와 기준이 다를 수 있습니다.' : assessment.message,
      onToggle: toggle,
      onRetry: userId && configured && ['error', 'scopeMismatch', 'quantityMissing', 'priceMissing', 'quantityBasisUnsupported'].includes(assessment.status) ? onRefresh : undefined,
    },
  }
}
