import { useRef, useState } from 'react'
import { createIndicatorConfig } from '../utils/indicators'
import { DEFAULT_BACKTEST, RULES } from '../utils/backtest'
import { strategyPayload } from '../services/strategyRepository'

const empty = owner => ({ owner, indicatorConfigs: [], strategyName: '', backtestSettings: structuredClone(DEFAULT_BACKTEST), selected: null, baseline: '', message: '', error: '' })
const fingerprint = draft => JSON.stringify([draft.strategyName, draft.indicatorConfigs, Object.fromEntries(Object.entries(draft.backtestSettings).filter(([key]) => !['symbol', 'start', 'end'].includes(key)))])

export default function useIndicatorDraft(userId, library) {
  const owner = userId || null
  const [state, setState] = useState(() => empty(owner))
  const account = useRef({ owner })
  if (account.current.owner !== owner) account.current = { owner }
  const token = account.current
  let draft = state
  if (state.owner !== owner) { draft = empty(owner); setState(draft) }
  const dirty = draft.baseline ? fingerprint(draft) !== draft.baseline : !!(draft.strategyName || draft.indicatorConfigs.length)
  const change = patch => setState(previous => ({ ...previous, message: '', error: '', ...patch }))
  const confirmDiscard = () => !dirty || window.confirm('저장하지 않은 변경 내용을 버릴까요?')
  const select = id => {
    if (library.busy || !confirmDiscard()) return
    if (!id) { setState({ ...empty(owner), backtestSettings: { ...structuredClone(DEFAULT_BACKTEST), symbol: draft.backtestSettings.symbol, start: draft.backtestSettings.start, end: draft.backtestSettings.end } }); return }
    const row = library.rows.find(item => item.id === id)
    try {
      if (!row || row.schema_version !== 1) throw new Error('전략을 불러올 수 없습니다. 목록을 새로고침해 주세요.')
      const payload = strategyPayload(row)
      const next = { ...draft, selected: { id: row.id, revision: row.revision }, strategyName: payload.name, indicatorConfigs: payload.indicators, backtestSettings: { ...draft.backtestSettings, ...payload.backtest_settings }, message: '저장한 전략을 불러왔습니다.', error: '' }
      next.baseline = fingerprint(next)
      setState(next)
    } catch (error) { change({ error: error.message }) }
  }
  const save = async (copy = false) => {
    const snapshot = fingerprint(draft)
    change({})
    try {
      const row = await library.save({ name: draft.strategyName, indicators: draft.indicatorConfigs, backtest_settings: draft.backtestSettings }, copy ? null : draft.selected)
      if (account.current === token) setState(previous => ({ ...previous, selected: { id: row.id, revision: row.revision }, baseline: snapshot, message: '전략을 저장했습니다. 두 탭에서 불러올 수 있습니다.', error: '' }))
    } catch (error) { if (account.current === token) change({ error: error.message }) }
  }
  const remove = async () => {
    if (library.busy) return
    if (!draft.selected) { if (confirmDiscard()) setState(empty(owner)); return }
    if (!window.confirm('저장한 전략을 삭제할까요? 주식 주문과 실험실의 저장 목록에서 함께 삭제됩니다.')) return
    try {
      await library.remove(draft.selected)
      if (account.current === token) setState({ ...empty(owner), message: '전략을 삭제했습니다.' })
    } catch (error) { if (account.current === token) change({ error: error.message }) }
  }
  const selectedRow = library.rows.find(item => item.id === draft.selected?.id)
  const stale = draft.selected && !library.loading && !library.error && (!selectedRow || selectedRow.revision !== draft.selected.revision)
  return {
    indicatorConfigs: draft.indicatorConfigs,
    strategyName: draft.strategyName,
    backtestSettings: draft.backtestSettings,
    strategyStorage: { ...library, selectedId: draft.selected?.id || '', dirty, stale, message: draft.message, draftError: draft.error, onSelect: select, onSave: save, onDelete: remove },
    onBacktestSettingsChange: update => setState(previous => ({ ...previous, backtestSettings: typeof update === 'function' ? update(previous.backtestSettings) : update, message: '', error: '' })),
    onStrategyNameChange: strategyName => change({ strategyName }),
    onAddIndicator: id => change({ indicatorConfigs: draft.indicatorConfigs.some(item => item.id === id) ? draft.indicatorConfigs : [...draft.indicatorConfigs, createIndicatorConfig(id)] }),
    onUpdateIndicator: (id, patch) => change({ indicatorConfigs: draft.indicatorConfigs.map(item => item.id === id ? { ...item, ...patch } : item) }),
    onRemoveIndicator: id => {
      const ruleIds = RULES.filter(rule => rule.indicator === id).map(rule => rule.id)
      change({ indicatorConfigs: draft.indicatorConfigs.filter(item => item.id !== id), backtestSettings: { ...draft.backtestSettings, entry: draft.backtestSettings.entry.filter(rule => !ruleIds.includes(rule)), exit: draft.backtestSettings.exit.filter(rule => !ruleIds.includes(rule)) } })
    },
    onResetIndicators: () => change({ indicatorConfigs: draft.indicatorConfigs.map(item => createIndicatorConfig(item.id)) }),
    onDeleteIndicators: remove,
  }
}
