export const WATCHLIST_LIMIT = 20
export const WATCHLIST_LIMIT_MESSAGE = '관심종목은 최대 20개까지 등록할 수 있습니다.'

export function watchlistCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase().replace(/^A(?=\d{6}$)/, '') : ''
  return /^[0-9][0-9A-Z]{5}$/.test(code) ? code : ''
}

function check(result, action) {
  const { data, error } = result
  if (!error && Array.isArray(data)) return data
  if (error?.code === 'P0001' && error.message === 'watchlist_limit') throw new Error(WATCHLIST_LIMIT_MESSAGE)
  if (['42P01', '42883', '42703', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.code)) {
    throw new Error('관심종목 저장소가 준비되지 않았습니다. 관리자가 Supabase 관심종목 SQL을 적용해야 합니다.')
  }
  if (['42501', 'PGRST301', 'PGRST302'].includes(error?.code)) {
    throw new Error('관심종목 접근 권한을 확인할 수 없습니다. 다시 로그인하거나 관리자에게 문의해 주세요.')
  }
  throw new Error(`관심종목 ${action}에 실패했습니다. 잠시 후 다시 시도해 주세요.`)
}

export function createWatchlistRepository(client) {
  async function authorize(userId) {
    if (!client || !userId) throw new Error('로그인 후 관심종목을 이용해 주세요.')
    const { data, error } = await client.auth.getSession()
    if (error || data.session?.user?.id !== userId) throw new Error('로그인 정보가 변경되었습니다. 다시 로그인해 주세요.')
  }

  return {
    async list(userId, signal) {
      await authorize(userId)
      const query = client.from('watchlist_items').select('code,name,created_at')
        .eq('user_id', userId).order('created_at', { ascending: false }).order('code')
      return check(await (signal ? query.abortSignal(signal) : query), '조회')
    },
    async setSaved(userId, stock, saved) {
      const code = watchlistCode(stock.code)
      const name = typeof stock.name === 'string' ? stock.name.trim() : ''
      if (!code || (saved && (!name || Array.from(name).length > 100))) throw new Error('종목 정보를 확인해 주세요.')
      await authorize(userId)
      return check(await client.rpc('set_watchlist_item', {
        p_expected_user: userId, p_code: code, p_saved: saved, p_name: saved ? name : null,
      }), saved ? '등록' : '삭제')
    },
  }
}
