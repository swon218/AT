import { DEFAULT_BACKTEST } from './backtest.js'
import { EXECUTION_SETTING_KEYS, strategyDraftDefinition } from '../services/strategyRepository.js'

export const strategyFingerprint = draft => JSON.stringify([draft.strategyName,draft.indicatorConfigs,strategyDraftDefinition(draft.backtestSettings)])

export function emptyStrategyDraft(owner, resetVersion = 0) {
  return {owner,indicatorConfigs:[],strategyName:'',backtestSettings:structuredClone(DEFAULT_BACKTEST),selected:null,baseline:'',message:'',error:'',resetVersion}
}

export function resetStrategyDraft(draft, full = false) {
  const next = emptyStrategyDraft(draft.owner,draft.resetVersion || 0)
  for (const key of full ? ['symbol'] : EXECUTION_SETTING_KEYS) if (Object.hasOwn(draft.backtestSettings,key)) next.backtestSettings[key] = draft.backtestSettings[key]
  if (strategyFingerprint(next) === strategyFingerprint(draft) && !draft.selected
      && JSON.stringify(next.backtestSettings) === JSON.stringify(draft.backtestSettings)) return draft
  next.resetVersion++
  return next
}

export function removeDraftIndicator(draft, id) {
  return {...draft,indicatorConfigs:draft.indicatorConfigs.filter(item => item.id !== id),
    backtestSettings:{...draft.backtestSettings,entryConditions:(draft.backtestSettings.entryConditions || []).filter(condition => condition.indicatorId !== id && condition.right?.indicatorId !== id)},message:'',error:''}
}
