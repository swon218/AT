import { useCallback, useEffect, useState } from 'react'
import { createIndicatorConfig } from '../utils/indicators'
import { DEFAULT_BACKTEST } from '../utils/backtest'

// Drafts stay separate until database-backed strategy storage is available.
export default function useIndicatorDraft(userId) {
  const [indicatorConfigs, setIndicatorConfigs] = useState([])
  const [strategyName, setStrategyName] = useState('')
  const [backtestSettings, setBacktestSettings] = useState(() => structuredClone(DEFAULT_BACKTEST))
  const clear = useCallback(() => {
    setIndicatorConfigs([])
    setStrategyName('')
    setBacktestSettings(structuredClone(DEFAULT_BACKTEST))
  }, [])

  useEffect(() => { clear() }, [userId, clear])

  return {
    indicatorConfigs,
    strategyName,
    backtestSettings,
    onBacktestSettingsChange: setBacktestSettings,
    onStrategyNameChange: setStrategyName,
    onAddIndicator: (id) => setIndicatorConfigs((items) => items.some((item) => item.id === id) ? items : [...items, createIndicatorConfig(id)]),
    onUpdateIndicator: (id, patch) => setIndicatorConfigs((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item)),
    onRemoveIndicator: (id) => setIndicatorConfigs((items) => items.filter((item) => item.id !== id)),
    onResetIndicators: () => setIndicatorConfigs((items) => items.map((item) => createIndicatorConfig(item.id))),
    onDeleteIndicators: clear,
  }
}
