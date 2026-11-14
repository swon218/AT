import { INDICATOR_DEFAULTS, INDICATOR_LIMIT } from '../utils/indicators.js'
import { DEFAULT_BACKTEST, RULES, validateIndicators } from '../utils/backtest.js'
import { normalizeRiskSettings, validateEntryConditions } from '../utils/entryConditions.js'

const fields = 'id,user_id,name,indicators,backtest_settings,schema_version,revision,created_at,updated_at'
export const STRATEGY_CONFLICT = '다른 탭에서 변경되었거나 삭제된 전략입니다. 목록을 새로고침하고 다시 불러오거나, 이름을 바꿔 복사 저장하세요.'

// Execution inputs belong to each workspace, never to the reusable definition.
export const EXECUTION_SETTING_KEYS = ['symbol', 'start', 'end', 'initialQuantity', 'quantityMode']
export const STRATEGY_SETTING_KEYS = ['entryMode', 'entryConditions', 'takeProfitPct', 'stopLossPct', 'legacy']
export const strategyDraftDefinition = settings => Object.fromEntries(STRATEGY_SETTING_KEYS.filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]))

function normalizeLegacy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = { schemaVersion: 1 }
  for (const side of ['entry','exit']) if (Array.isArray(value[side])) result[side] = value[side].filter(id => typeof id === 'string' && id.length <= 80).slice(0, RULES.length)
  for (const key of ['entryMode','exitMode']) if (['all','any'].includes(value[key])) result[key] = value[key]
  for (const key of ['initialCapital','feePct','taxPct','slippagePct']) if (value[key] !== '' && value[key] != null && ['number','string'].includes(typeof value[key]) && Number.isFinite(Number(value[key]))) result[key] = Number(value[key])
  return result
}

export function migrateLegacySettings(indicators, settings = {}) {
  const configs = Object.fromEntries(indicators.map(config => [config.id,config]))
  const entryConditions = []
  const add = (indicatorId,left,operator,right) => { if (configs[indicatorId]) entryConditions.push({indicatorId,enabled:true,left,operator,right}) }
  for (const id of [...new Set(settings.entry || [])]) {
    if (id.startsWith('ma-') && RULES.some(rule => rule.id === id)) add('ma','short',id.includes('cross') ? id.endsWith('up') ? 'crossUp' : 'crossDown' : id.endsWith('up') ? 'gt' : 'lt',{type:'series',field:'long'})
    else if (id === 'bb-low' || id === 'bb-high') add('bollinger','close',id === 'bb-low' ? 'lte' : 'gte',{type:'series',field:id === 'bb-low' ? 'lower' : 'upper'})
    else if (id === 'volume-high' || id === 'volume-low') add('volume-ma','volume',id === 'volume-high' ? 'gt' : 'lt',{type:'series',field:'average'})
    else if (id === 'rsi-low' || id === 'rsi-high') add('rsi','rsi',id === 'rsi-low' ? 'lte' : 'gte',{type:'constant',value:configs.rsi?.[id === 'rsi-low' ? 'lower' : 'upper']})
    else if (id.startsWith('macd-') && RULES.some(rule => rule.id === id)) add('macd','macd',id.includes('cross') ? id.endsWith('up') ? 'crossUp' : 'crossDown' : id.endsWith('up') ? 'gt' : 'lt',{type:'series',field:'signal'})
  }
  return {entryMode:settings.entryMode === 'any' ? 'any' : 'all',entryConditions,takeProfitPct:'',stopLossPct:'',legacy:normalizeLegacy(settings)}
}

export function strategyPayload({ name, indicators = [], backtest_settings = DEFAULT_BACKTEST, schema_version }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('전략 이름을 1~100자로 입력하세요.')
  if (!Array.isArray(indicators) || indicators.length > INDICATOR_LIMIT) throw new Error(`보조지표는 최대 ${INDICATOR_LIMIT}개까지 추가할 수 있습니다.`)
  const configs = indicators.map(item => {
    const defaults = item && Object.hasOwn(INDICATOR_DEFAULTS, item.id) && INDICATOR_DEFAULTS[item.id]
    if (!defaults) throw new Error('지원하지 않는 지표입니다.')
    return Object.fromEntries([['id', item.id], ...Object.entries(defaults).map(([key, fallback]) => {
      const value = item[key] ?? fallback
      if (typeof fallback === 'number') {
        if (value === '' || !['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value))) throw new Error('지표 숫자 설정을 확인하세요.')
        return [key, Number(value)]
      }
      if (typeof fallback === 'boolean' && typeof value === 'boolean') return [key, value]
      if (typeof value !== 'string' || (key.toLowerCase().includes('color') && !/^#[0-9a-f]{6}$/i.test(value))) throw new Error('지표 표시·색상 설정을 확인하세요.')
      return [key, value]
    })])
  })
  validateIndicators(configs)
  if (!backtest_settings || typeof backtest_settings !== 'object' || Array.isArray(backtest_settings)) throw new Error('백테스트 설정을 확인하세요.')
  if (schema_version != null && ![1,2].includes(schema_version)) throw new Error('지원하지 않는 전략 버전입니다.')
  const source = schema_version === 1 ? migrateLegacySettings(configs,backtest_settings) : backtest_settings
  const entryMode = source.entryMode ?? 'all'
  if (!['all','any'].includes(entryMode)) throw new Error('진입 조건의 모두/하나 이상 방식을 확인하세요.')
  const entryConditions = validateEntryConditions(configs,{...source,entryConditions:source.entryConditions ?? []},{requireEntry:false})
  const risk = normalizeRiskSettings(source,{allowIncomplete:true})
  const settings = {entryMode,entryConditions,...risk}
  const legacy = normalizeLegacy(source.legacy)
  if (legacy) settings.legacy = legacy
  if (!configs.length && !entryConditions.length && risk.takeProfitPct === '' && risk.stopLossPct === '') throw new Error('보조지표, 진입 조건 또는 익절·손절 중 하나 이상을 설정하세요.')
  return { name: name.trim(), indicators: configs, backtest_settings: settings, schema_version: 2 }
}

export function loadStrategy(row) {
  if (!row || ![1,2].includes(row.schema_version)) throw new Error('전략을 불러올 수 없습니다. 목록을 새로고침해 주세요.')
  return strategyPayload(row)
}

export function strategyError(error) {
  if (error?.code === '23505') return '같은 이름의 전략이 있습니다. 다른 이름을 입력하세요.'
  if (error?.code === '23514') return '전략 설정 또는 저장 형식을 확인해 주세요. 새 전략 저장 SQL이 적용되지 않았다면 관리자에게 문의하세요.'
  if (['42P01', 'PGRST205', '42703'].includes(error?.code)) return '전략 저장 테이블이 준비되지 않았습니다. 관리자가 Supabase 전략 SQL을 실행해야 합니다.'
  if (['42501', 'PGRST301', 'PGRST302'].includes(error?.code)) return '전략 접근 권한을 확인할 수 없습니다. 다시 로그인하거나 관리자에게 문의하세요.'
  return '전략 요청에 실패했습니다. 연결 상태를 확인하고 다시 시도하세요.'
}

export function createStrategyRepository(client) {
  async function authorize(userId) {
    if (!client || !userId) throw new Error('로그인 후 전략을 저장하고 불러올 수 있습니다.')
    const { data, error } = await client.auth.getSession()
    if (error || data.session?.user?.id !== userId) throw new Error('로그인 정보가 변경되었습니다. 다시 로그인해 주세요.')
  }
  function check(result) {
    if (result.error) throw new Error(strategyError(result.error))
    return result.data
  }
  return {
    async list(userId) {
      await authorize(userId)
      const rows = []
      for (let from = 0; ; from += 200) {
        const page = check(await client.from('strategies').select(fields).eq('user_id', userId).order('updated_at', { ascending: false }).order('id').range(from, from + 199))
        rows.push(...page)
        if (page.length < 200) return rows
      }
    },
    async save(userId, input, selected = null) {
      const payload = strategyPayload(input)
      await authorize(userId)
      const query = selected
        ? client.from('strategies').update(payload).eq('user_id', userId).eq('id', selected.id).eq('revision', selected.revision)
        : client.from('strategies').insert({ ...payload, user_id: userId })
      const row = check(await query.select(fields).maybeSingle())
      if (!row) throw new Error(STRATEGY_CONFLICT)
      return row
    },
    async remove(userId, selected) {
      await authorize(userId)
      const row = check(await client.from('strategies').delete().eq('user_id', userId).eq('id', selected.id).eq('revision', selected.revision).select('id').maybeSingle())
      if (!row) throw new Error(STRATEGY_CONFLICT)
    },
  }
}
