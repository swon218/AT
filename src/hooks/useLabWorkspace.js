import { useEffect, useState } from 'react'
import { getKiwoomRankings } from '../services/kiwoomMarketApi'
import { getLabSymbols } from '../services/labApi'

export default function useLabWorkspace(enabled) {
  const [selection, setSelection] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState('')
  const [initialError, setInitialError] = useState('')
  const [initialRetry, setInitialRetry] = useState(0)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const symbol = selection?.code
  const catalogMessage = catalog && !catalog.ready ? catalog.message || '검색용 종목 목록이 없습니다. VPS 수집 상태를 확인하세요.' : ''

  useEffect(() => {
    if (!enabled || symbol) return
    const controller = new AbortController()
    setInitialError('')
    // The ranking picks the initial identity. Candles always come from the lab database.
    getKiwoomRankings('realtime', 1, controller.signal).then(stocks => {
      if (controller.signal.aborted) return
      if (!stocks[0]?.code) throw new Error('실시간조회 순위에 종목이 없습니다.')
      setSelection(current => current ?? stocks[0])
    }).catch(error => {
      if (!controller.signal.aborted) setInitialError(`첫 종목을 불러오지 못했습니다. 종목을 검색해 선택해 주세요. (${error.message})`)
    })
    return () => controller.abort()
  }, [enabled, symbol, initialRetry])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setCatalogError('')
    getLabSymbols(controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog(value)
    }).catch(error => { if (!controller.signal.aborted) setCatalogError(error.message) })
    return () => controller.abort()
  }, [enabled, refreshVersion])

  function refresh() {
    setRefreshVersion(value => value + 1)
  }

  function selectStock(stock) {
    setSelection({ ...stock })
    if (stock.code === symbol) refresh()
  }

  function refreshData() {
    refresh()
    if (!symbol) setInitialRetry(value => value + 1)
  }

  return { selection, catalog, catalogError, catalogMessage, initialError: symbol ? '' : initialError, refreshVersion, selectStock, refresh, refreshData }
}
