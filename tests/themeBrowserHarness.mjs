// All APIs, authentication and account data are synthetic. No real provider calls.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { setTimeout as delay } from 'node:timers/promises'
import { orderPeriodWindow } from '../src/utils/orderPeriod.js'
if (process.env.NODE_ENV === 'production') throw new Error('Fixture is forbidden in production')
const requests = {}, stock = { code: '005930', name: '검증 삼성전자', market: 'KOSPI', price: 71000, change: 1.2, volume: 500000 }
const candles = Array.from({ length: 180 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), open: 65000 + i * 30, high: 65800 + i * 30, low: 64400 + i * 30, close: 65200 + i * 30 + Math.sin(i / 5) * 300, volume: 10000 + i * 50 }))
const symbol = { ...stock, ready: true, source: 'FDR:NAVER', updated_at: '2026-11-07T03:00:00+09:00' }
const room = { id: '1', title: '테마 검증 대화', question_count: 1, updated_at: '2026-11-07T09:00:00+09:00' }
const news = { id: 'fixture-news', title: '테마 검증을 위한 시장 뉴스', description: '밝은 화면과 어두운 화면에서 본문과 배지를 확인합니다.', url: 'https://news.naver.com', link: 'https://news.naver.com', originalLink: 'https://news.naver.com', publishedAt: '2026-11-07T09:00:00+09:00', category: 'market', source: '모의 뉴스' }
const ranked = [stock, { ...stock, code: '035420', name: '검증 NAVER' }]
const watchlists = new Map()
const faults = new Map()
const supabase = `let id=sessionStorage.getItem('atlas.qa.user')||'';const listeners=new Set();const session=()=>id?{access_token:'fixture-'+id,user:{id,email:'theme@fixture.invalid'}}:null;
export const setQaUser=value=>{id=value;sessionStorage.setItem('atlas.qa.user',id);for(const fn of listeners)fn(id?'SIGNED_IN':'SIGNED_OUT',session())};
const request=(params,body)=>fetch('/__qa/watchlist?'+new URLSearchParams(params),body?{method:'POST',body:JSON.stringify(body)}:{}).then(res=>res.json());
export const setQaWatchlistFault=fault=>request({user:id},{fault});
export const initialRecoveryRequest={requested:false,failed:false};export const isSupabaseConfigured=true;
export const supabase={
  auth:{initialize:async()=>({}),getSession:async()=>({data:{session:session()}}),onAuthStateChange:fn=>{listeners.add(fn);return{data:{subscription:{unsubscribe:()=>listeners.delete(fn)}}}},signOut:async()=>{setQaUser('');return{}}},
  rpc:(_name,body)=>request({user:id},body),
  from:table=>{
    let user=id;
    const result=()=>table==='watchlist_items'?request({user}):{data:table==='profiles'?{nickname:'테마 검증 사용자'}:[],error:null};
    const q={select:()=>q,eq:(_column,value)=>{user=value;return q},order:()=>q,update:()=>q,abortSignal:()=>q,maybeSingle:async()=>result(),single:async()=>result(),then:(a,b)=>Promise.resolve(result()).then(a,b)};
    return q
  }
};`
async function watchlistResponse(user, body) {
  if (!user) return { error: { code: '42501' } }
  if (!watchlists.has(user)) watchlists.set(user, user === 'qa-full'
    ? Array.from({ length: 20 }, (_, index) => ({
      code: String(index + 1).padStart(6, '0'), name: `검증 종목 ${index + 1}`,
    })) : [])
  const rows = watchlists.get(user)
  if (body?.fault) { faults.set(user, body.fault); return { data: [] } }
  if (!body) {
    if (faults.get(user) === 'delay') {
      faults.delete(user)
      await delay(8_000) // Do not cancel the fixture response on account change.
    } else if (faults.get(user) === 'missing') {
      faults.delete(user)
      return { error: { code: 'PGRST205' } }
    }
    return { data: rows }
  }
  if (body.p_expected_user !== user) return { error: { code: '42501' } }
  if (faults.get(user) === 'write') {
    faults.delete(user)
    return { error: { code: 'fixture_write_failure' } }
  }
  const hasStock = rows.some(row => row.code === body.p_code)
  if (body.p_saved && !hasStock && rows.length === 20) return { error: { code: 'P0001', message: 'watchlist_limit' } }
  const next = body.p_saved
    ? hasStock ? rows : [{ code: body.p_code, name: body.p_name }, ...rows]
    : rows.filter(row => row.code !== body.p_code)
  watchlists.set(user, next)
  return { data: next }
}
function accountSummary(path, params, authorization) {
  const holding = { ...stock, quantity: 1, tradableQuantity: 1, averagePrice: 70000, currentPrice: 71000, evaluationAmount: 71000, evaluationProfit: 1000, profitRate: 1.4 }
  const summary = { estimatedAssets: 100000, totalPurchaseAmount: 70000, totalEvaluationAmount: 71000, totalEvaluationProfit: 1000, cash: 29000, orderableAmount: 29000 }
  const scenario = authorization?.match(/fixture-qa-holdings-(0|1|3|4|6)$/)
  if (!scenario) return { ...summary, holdings: [holding] }

  const count = Number(scenario[1])
  const broker = path.split('/')[3]
  if (count === 6 && broker === 'nh') {
    const accounts = [{ id: 'qa-nh-a', label: '모의 NH 계좌 A' }, { id: 'qa-nh-b', label: '모의 NH 계좌 B' }]
    const selected = accounts.find(account => account.id === params.get('accountId'))
    return {
      ...summary, accounts, accountRequired: !selected,
      holdings: selected ? [{ ...holding, code: '000660', name: selected.label, quantity: 7 }] : [],
    }
  }
  const brokers = ['kiwoom', 'toss', 'kb']
  const holdings = Array.from({ length: count }, (_, index) => ({
    ...holding, code: String(index + 1).padStart(6, '0'),
    name: `검증 보유종목 ${index + 1}`, quantity: index + 1,
  })).filter((_, index) => brokers[index % brokers.length] === broker)
  return { ...summary, holdings }
}
async function response(path, params, method, authorization) {
  if (path.endsWith('/catalog')) return { items: [stock, { ...stock, code: '000660', name: '검증 SK하이닉스' }], updatedAt: Date.now(), stale: false }
  if (path.endsWith('/rankings')) return params.get('type') === 'favorites' ? { error: 'unexpected_favorites_ranking' } : { items: ranked }
  if (path.endsWith('/quote')) return ranked.find(item => item.code === params.get('symbol')) || { error: 'mock_quote_unavailable' }
  if (path.endsWith('/candles')) return path.includes('/lab/') ? { items: candles, symbol, quality: { corrected: 0, quarantined: 0, issues: [] } } : { items: candles, sourceBroker: 'kiwoom' }
  if (path.endsWith('/symbols')) return { ready: true, items: [symbol], run: { failed: 0 } }
  if (path.endsWith('/indices')) return { symbol: params.get('symbol'), name: '코스피', period: params.get('period'), price: 3200, change: 20, changeRate: .65, volume: 200000, asOf: '2026-11-07T15:30:00+09:00', candles: candles.map((c, i) => ({ time: c.time, close: 3000 + i, volume: c.volume })) }
  if (path.startsWith('/api/public/news/')) return { items: [news], total: 1, hasMore: false, nextStart: null, fetchedAt: new Date().toISOString(), category: params.get('category') || 'all' }
  if (path === '/api/account/settings') {
    const configured = !authorization?.endsWith('qa-other')
    return { kiwoomConfigured: configured, tossConfigured: configured, nhConfigured: configured, kbConfigured: configured }
  }
  if (path.startsWith('/api/account/connections/')) return { connected: true, expiresAt: Date.now() + 60000 }
  if (/\/api\/account\/[^/]+\/summary/.test(path)) return accountSummary(path, params, authorization)
  if (path.startsWith('/api/account/orders/history')) {
    const start = params.get('from'), end = params.get('to'), day = params.get('day')
    if (start === '2024-01-01') await delay(2_000)
    const brokers = (params.get('brokers') || 'kiwoom,toss,nh,kb').split(',')
    const window = orderPeriodWindow({ start, end }, params.get('before'))
    const scenario = authorization?.endsWith('qa-holdings-1')
    const nhAccounts = [{ id: 'a'.repeat(32), label: '주문 계좌 A' }, { id: 'b'.repeat(32), label: '주문 계좌 B' }]
    const selectedNH = nhAccounts.find(({ id }) => id === params.get('nhAccount'))
    const accountRef = 'c'.repeat(32)
    const order = (broker, date, index) => ({
      id: `qa-${broker}-${date}-${index}`, broker, name: `검증 체결 ${index + 1}`, symbol: stock.code,
      date, accountRef: broker === 'nh' ? selectedNH?.id : accountRef, accountLabel: selectedNH?.label || '검증용 API 연결 계좌',
      orderedAt: broker === 'nh' ? null : `${date}T12:${String(index).padStart(2, '0')}:00+09:00`,
      side: 'buy', quantity: 1, filledQuantity: 1, averageFilledPrice: 71000, status: 'filled',
    })
    if (day) {
      const broker = path.split('/').at(-2)
      if (day < start || day > end || (broker === 'nh' ? !selectedNH : params.get(`${broker}Account`) !== accountRef)) return { error: '검증 상세 요청 범위 오류' }
      const item = order(broker, day, Number(path.split('-').at(-1)))
      return { item: { ...item, executions: [{ id: 'fixture-fill', at: `${day}T12:00:00+09:00`, quantity: 1, price: 71000 }] } }
    }
    const items = scenario ? [...window.days].reverse().flatMap(date => [
      ...(brokers.includes('nh') && selectedNH ? [order('nh', date, 0)] : []),
      ...(brokers.includes('toss') ? [0, 1].map(index => order('toss', date, index)) : []),
    ]) : []
    return { items, window, brokers: brokers.map(broker => {
      if (scenario && broker === 'nh') return { broker, accounts: nhAccounts, selectedAccountRef: selectedNH?.id, status: selectedNH ? 'ready' : 'accountRequired' }
      if (scenario && broker === 'kb') return { broker, status: 'error', error: 'timeout' }
      return { broker, status: 'ready', selectedAccountRef: accountRef }
    }) }
  }
  if (path === '/api/agent/status') return { authenticated: true, configured: true, remaining: 2, used: 0, limit: 2 }
  if (path === '/api/agent/rooms') return method === 'POST' ? room : { rooms: [room] }
  if (path === '/api/agent/rooms/1/messages') return { room, question_count: 1, requests: [], messages: [
    { id: '1', role: 'user', content: '테마 전환 후에도 이 대화가 유지되나요?', created_at: room.updated_at },
    { id: '2', role: 'assistant', content: '현재 대화와 입력 중인 초안을 유지하면서 화면 테마만 변경합니다.', created_at: room.updated_at },
  ] }
  if (path === '/api/screener') return { ready: true, quality_ready: true, universe: 2, cutoff: '2026-11-06', latest_bar: '2026-11-06' }
  return { error: 'theme_fixture_unavailable' }
}
const server = await createServer({ configFile: false, envDir: false, define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') }, plugins: [
  { name: 'theme-fixture', enforce: 'pre', load(id) { if (id.replaceAll('\\', '/').endsWith('/src/services/supabaseClient.js')) return supabase },
    transform(code, id) { if (/\/(TradingViewChart|MarketIndexChart)\.jsx$/.test(id.replaceAll('\\', '/'))) return code.replace("from 'lightweight-charts'", "from '/tests/support/themeCharts.js'") },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url === '/__qa/metrics') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(requests)) }
      if (!req.url.startsWith('/api/') && !req.url.startsWith('/__qa/watchlist?')) return next()
      const url = new URL(req.url, 'http://fixture.invalid'), path = url.pathname
      requests[path] = (requests[path] || 0) + 1
      let text = ''; for await (const chunk of req) text += chunk
      const payload = path === '/__qa/watchlist'
        ? await watchlistResponse(url.searchParams.get('user'), text ? JSON.parse(text) : null)
        : await response(path, url.searchParams, req.method, req.headers.authorization)
      res.writeHead(payload.error ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload))
    }) },
  }, react(),
], server: { host: '127.0.0.1', port: 15178, strictPort: true } })
await server.listen()
console.log('Theme fixture: http://127.0.0.1:15178/tests/themeBrowser.html')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().then(() => process.exit(0)) })
