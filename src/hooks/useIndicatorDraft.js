import { useRef, useState } from 'react'
import { createIndicatorConfig, INDICATOR_DEFAULTS, INDICATOR_LIMIT } from '../utils/indicators'
import { EXECUTION_SETTING_KEYS, loadStrategy } from '../services/strategyRepository'
import { emptyStrategyDraft as empty, removeDraftIndicator, resetStrategyDraft, strategyFingerprint as fingerprint } from '../utils/strategyDraft'

export default function useIndicatorDraft(userId, library) {
  const owner = userId || null
  const [state, setState] = useState(() => empty(owner))
  const account = useRef({ owner })
  if (account.current.owner !== owner) account.current = { owner }
  const token = account.current
  let draft = state
  if (state.owner !== owner) { draft = empty(owner); setState(draft) }
  const dirty = draft.baseline ? fingerprint(draft) !== draft.baseline : fingerprint(draft) !== fingerprint(empty(owner))
  const change = patch => setState(previous => ({ ...previous, message: '', error: '', ...patch }))
  const confirmDiscard = () => !dirty || window.confirm('저장하지 않은 변경 내용을 버릴까요?')
  const newStrategy = () => {
    if (library.busy || !confirmDiscard()) return
    setState(previous => resetStrategyDraft(previous))
  }
  const resetBacktest = () => {
    if (library.busy) return
    setState(previous => resetStrategyDraft(previous,true))
  }
  const select = id => {
    if (library.busy || !confirmDiscard()) return
    if (!id) { setState(previous => resetStrategyDraft(previous)); return }
    const row = library.rows.find(item => item.id === id)
    try {
      const payload = loadStrategy(row)
      const execution = Object.fromEntries(EXECUTION_SETTING_KEYS.filter(key => Object.hasOwn(draft.backtestSettings,key)).map(key => [key,draft.backtestSettings[key]]))
      const next = { ...draft, selected: { id: row.id, revision: row.revision }, strategyName: payload.name, indicatorConfigs: payload.indicators, backtestSettings: { ...empty(owner).backtestSettings,...execution,...payload.backtest_settings }, resetVersion:draft.resetVersion+1,message: '저장한 전략을 불러왔습니다.', error: '' }
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
    if (!draft.selected) { if (confirmDiscard()) setState(previous => resetStrategyDraft(previous)); return }
    if (!window.confirm('저장한 전략을 삭제할까요? 주식 주문과 실험실의 저장 목록에서 함께 삭제됩니다.')) return
    try {
      await library.remove(draft.selected)
      if (account.current === token) setState(previous => ({...resetStrategyDraft(previous),message:'전략을 삭제했습니다.'}))
    } catch (error) { if (account.current === token) change({ error: error.message }) }
  }
  const selectedRow = library.rows.find(item => item.id === draft.selected?.id)
  const stale = draft.selected && !library.loading && !library.error && (!selectedRow || selectedRow.revision !== draft.selected.revision)
  return {
    indicatorConfigs: draft.indicatorConfigs,
    strategyName: draft.strategyName,
    backtestSettings: draft.backtestSettings,
    resetVersion:draft.resetVersion,
    onNewStrategy:newStrategy,
    onResetBacktest:resetBacktest,
    strategyStorage: { ...library, selectedId: draft.selected?.id || '', dirty, stale, message: draft.message, draftError: draft.error, compatibilityNotice:draft.backtestSettings.legacy ? '이전 지표 청산·비용 설정은 보존되며 새 계산에는 적용하지 않습니다. 새 백테스트에는 익절·손절 설정이 필요합니다.' : '',onSelect: select, onSave: save, onDelete: remove,onNewStrategy:newStrategy,onNew:newStrategy },
    onBacktestSettingsChange: update => setState(previous => ({ ...previous, backtestSettings: typeof update === 'function' ? update(previous.backtestSettings) : update, message: '', error: '' })),
    onStrategyNameChange: strategyName => change({ strategyName }),
    onAddIndicator: id => setState(previous => {
      const configs = previous.indicatorConfigs
      if (!Object.hasOwn(INDICATOR_DEFAULTS, id) || configs.length >= INDICATOR_LIMIT || configs.some(item => item.id === id)) return previous
      return { ...previous, indicatorConfigs: [...configs, createIndicatorConfig(id)], message: '', error: '' }
    }),
    onUpdateIndicator: (id, patch) => change({ indicatorConfigs: draft.indicatorConfigs.map(item => item.id === id ? { ...item, ...patch } : item) }),
    onRemoveIndicator: id => setState(previous => removeDraftIndicator(previous,id)),
    onResetIndicators: () => change({ indicatorConfigs: draft.indicatorConfigs.map(item => createIndicatorConfig(item.id)) }),
    onDeleteIndicators: remove,
  }
}
