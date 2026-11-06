// Local fixture only. All authentication, calendar and broker reads are injected;
// it cannot submit orders or contact a real broker.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import Fastify from 'fastify'
import { createRecentOrderHandlers, registerRecentOrderRoutes } from '../server/recentOrders.js'
import { normalizeHistoryOrder } from '../server/brokerOrderHistory.js'

const days = ['2026-11-06', '2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02']
const app = Fastify()
registerRecentOrderRoutes(app, createRecentOrderHandlers({
  now: () => Date.parse('2026-11-06T23:00:00+09:00'), calendar: async () => ({ days, timezone: 'Asia/Seoul' }),
  authenticate: async request => {
    const id = request.headers.authorization?.slice(7)
    if (!/^qa-(alice|bob|partial|empty|missing)$/.test(id || '')) throw Object.assign(new Error(), { statusCode: 401 })
    return { user: { id }, status: { kiwoomConfigured: true, tossConfigured: true, nhConfigured: true, kbConfigured: id !== 'qa-missing' },
      credentials: { kiwoomAppKey: 'fixture', kiwoomSecretKey: 'fixture', tossApiKey: 'fixture', tossSecretKey: 'fixture', nhAppKey: 'fixture', nhSecretKey: 'fixture', kbAppKey: 'fixture', kbSecretKey: 'fixture' } }
  },
  readBroker: async (broker, owner, _, requestedRef) => {
    if (owner.user.id === 'qa-alice') await new Promise(resolve => setTimeout(resolve, 2000))
    if (owner.user.id === 'qa-partial' && broker === 'kb') throw new Error('fixture failure')
    const accounts = broker === 'nh' ? [{ id: 'a'.repeat(32), label: '검증 계좌 A · ***1111' }, { id: 'b'.repeat(32), label: '검증 계좌 B · ***2222' }] : [{ id: 'a'.repeat(32), label: '검증용 API 연결 계좌' }]
    const selectedAccountRef = requestedRef || (accounts.length === 1 ? accounts[0].id : '')
    if (!selectedAccountRef) return { status: 'accountRequired', accounts, selectedAccountRef: '', items: [] }
    return { status: 'ready', accounts, selectedAccountRef, items: owner.user.id === 'qa-empty' ? [] : [0, 1, 2].map(i => normalizeHistoryOrder(broker, selectedAccountRef, days[i], String(i + 1), {
      symbol: '005930', side: 'buy', name: `${owner.user.id === 'qa-alice' ? '사용자 A' : '사용자 B'} 검증종목`, accountLabel: accounts.find(a => a.id === selectedAccountRef)?.label,
      orderedAt: broker === 'nh' ? null : `${days[i]}T09:30:00+09:00`, quantity: 10, filledQuantity: 4,
      cancelled: i === 0, pending: i > 0, orderPrice: 70000, averageFilledPrice: broker === 'kb' ? null : 70500,
      executions: broker === 'kiwoom' ? [{ id: 'fixture-fill', at: `${days[i]}T09:30:01+09:00`, quantity: 4, price: 70500 }] : [],
    })) }
  },
}))
const server = await createServer({ configFile: false, envDir: false, plugins: [
  { name: 'recent-orders-fixture', enforce: 'pre', load(id) {
    if (id.replaceAll('\\', '/').endsWith('/src/services/supabaseClient.js')) return `let token = ''; export const setQaUser = value => { token = value }; export const supabase = {auth:{getSession: async () => ({data:{session:token?{access_token:token}:null}})}}`
  }, configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith('/api/account/orders/recent')) return next()
      const result = await app.inject({ method: 'GET', url: req.url, headers: req.headers })
      res.writeHead(result.statusCode, result.headers); res.end(result.body)
    })
  } }, react(),
], server: { host: '127.0.0.1', port: 15176, strictPort: true } })
await server.listen()
console.log('Recent-orders fixture: http://127.0.0.1:15176/tests/recentOrders.html')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void Promise.all([server.close(), app.close()]).then(() => process.exit(0)) })
