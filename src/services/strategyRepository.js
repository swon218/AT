import { INDICATOR_DEFAULTS } from '../utils/indicators.js'
import { DEFAULT_BACKTEST, RULES, validateIndicators } from '../utils/backtest.js'

const fields = 'id,user_id,name,indicators,backtest_settings,schema_version,revision,created_at,updated_at'
export const STRATEGY_CONFLICT = '다른 탭에서 변경되었거나 삭제된 전략입니다. 목록을 새로고침하고 다시 불러오거나, 이름을 바꿔 복사 저장하세요.'

// A strategy is reusable across stocks. The selected stock and test date window
// belong to the workspace, not the saved strategy.
export function strategyPayload({ name, indicators, backtest_settings = DEFAULT_BACKTEST }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('전략 이름을 1~100자로 입력하세요.')
  if (!Array.isArray(indicators) || !indicators.length || indicators.length > 5) throw new Error('보조지표를 1개 이상 추가하세요.')
  const configs = indicators.map(item => {
    const defaults = item && Object.hasOwn(INDICATOR_DEFAULTS, item.id) && INDICATOR_DEFAULTS[item.id]
    if (!defaults) throw new Error('지원하지 않는 지표입니다.')
    return Object.fromEntries([['id', item.id], ...Object.entries(defaults).map(([key, fallback]) => {
      const value = item[key] ?? fallback
      if (typeof fallback === 'number') {
        if (value === '' || !['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value))) throw new Error('지표 숫자 설정을 확인하세요.')
        return [key, Number(value)]
      }
      if (typeof value !== 'string' || (key.toLowerCase().includes('color') && !/^#[0-9a-f]{6}$/i.test(value))) throw new Error('지표 색상 설정을 확인하세요.')
      return [key, value]
    })])
  })
  validateIndicators(configs)
  if (!backtest_settings || typeof backtest_settings !== 'object' || Array.isArray(backtest_settings)) throw new Error('백테스트 설정을 확인하세요.')
  const settings = {}
  for (const [key, min, max] of [['initialCapital', 1000, 10_000_000_000], ['feePct', 0, 5], ['taxPct', 0, 5], ['slippagePct', 0, 5]]) {
    const value = backtest_settings[key] ?? DEFAULT_BACKTEST[key]
    if (value === '' || !['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error('초기 자금·수수료·세금·슬리피지 설정을 확인하세요.')
    settings[key] = Number(value)
  }
  for (const side of ['entry', 'exit']) {
    const mode = backtest_settings[`${side}Mode`] ?? DEFAULT_BACKTEST[`${side}Mode`]
    const rules = backtest_settings[side] ?? []
    if (!['all', 'any'].includes(mode) || !Array.isArray(rules) || rules.length > RULES.length || rules.some(id => !RULES.some(rule => rule.id === id && configs.some(c => c.id === rule.indicator)))) throw new Error('매매 조건에 필요한 지표와 조건 조합을 확인하세요.')
    settings[`${side}Mode`] = mode
    settings[side] = [...new Set(rules)]
  }
  return { name: name.trim(), indicators: configs, backtest_settings: settings, schema_version: 1 }
}

export function strategyError(error) {
  if (error?.code === '23505') return '같은 이름의 전략이 있습니다. 다른 이름을 입력하세요.'
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
