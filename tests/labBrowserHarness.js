// Explicit fixture launcher: no .env, real broker keys, or production DB reads.
import Fastify from 'fastify'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = await mkdtemp(path.join(root, 'data/lab-browser-'))
if (!path.resolve(temp).startsWith(path.join(root, 'data') + path.sep)) throw new Error('Fixture path escaped data directory')
const python = process.platform === 'win32' ? path.join(root, '.venv-lab/Scripts/python.exe') : path.join(root, '.venv-lab/bin/python')
process.env.LAB_DB_PATH = path.join(temp, 'fixture.sqlite')
process.env.LAB_PYTHON = python
execFileSync(python, ['-c', `
import sys
from datetime import date,timedelta
sys.path.insert(0, 'lab')
from store import connect,save_rows
db=connect(sys.argv[1])
for code,name,price in [('005930','삼성전자',70000),('000660','SK하이닉스',150000)]:
    rows=[dict(date=str(date(2025,1,1)+timedelta(days=i)),open=price+i,high=price+i+100,low=price+i-100,close=price+i+50,volume=10000+i) for i in range(100)]
    save_rows(db,code,name,'KOSPI',rows,'2025-01-01','2025-04-30')
with db:
    db.execute("INSERT INTO symbols(code,name,market,source) VALUES('00680K','미수집 우선주','KOSPI','FDR:NAVER')")
db.close()
`, process.env.LAB_DB_PATH], { cwd: root, windowsHide: true })

const { registerLabRoutes } = await import('../server/lab.js')
const app = Fastify()
let mode = 'normal', requests = [], releases = []
app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/')) requests.push(request.url)
  if (mode === 'catalog-error' && request.url === '/api/public/lab/symbols') return reply.code(503).send({ error: 'fixture 실험실 종목 목록 실패' })
  if (mode === 'candles-error' && request.url.includes('/lab/candles?symbol=005930')) return reply.code(503).send({ error: 'fixture 실험실 일봉 조회 실패' })
  if (mode === 'candles-delayed' && request.url.includes('/lab/candles?symbol=005930')) await new Promise(resolve => releases.push(resolve))
})
registerLabRoutes(app)
app.get('/api/public/market/kiwoom/rankings', async (request, reply) => {
  if (request.query.limit === '1' && mode === 'ranking-error') return reply.code(502).send({ error: 'fixture 순위 실패' })
  if (request.query.limit === '1' && mode === 'ranking-delayed') await new Promise(resolve => releases.push(resolve))
  return { items: [{ code: '000660', name: 'SK하이닉스', market: 'KOSPI' }] }
})
const catalog = [{ code: '035420', name: 'NAVER', market: 'KOSPI' }, { code: '005930', name: '삼성전자', market: 'KOSPI' }]
app.get('/api/public/market/kiwoom/catalog', async () => ({ items: catalog, updatedAt: Date.now(), stale: false }))
app.get('/api/public/market/kiwoom/quote', async request => catalog.find(stock => stock.code === request.query.symbol) || {})
app.get('/api/public/market/kiwoom/candles', async () => ({ items: [], sourceBroker: 'kiwoom' }))
app.get('/api/public/company/:symbol', async () => ({ status: 'ready', data: {} }))
app.post('/__qa/mode/:mode', async request => {
  for (const release of releases) release()
  releases = []; requests = []; mode = request.params.mode
  return { mode }
})
app.post('/__qa/release', async () => { for (const release of releases) release(); releases = []; return { ok: true } })
app.get('/__qa/requests', async () => requests)
await app.listen({ host: '127.0.0.1', port: 15175 })
const vite = await createServer({ root, configFile: false, envDir: false, plugins: [react()],
  define: { 'import.meta.env.VITE_API_BASE_URL': '""', 'import.meta.env.VITE_SUPABASE_URL': '""', 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '""' },
  server: { host: '127.0.0.1', port: 15174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:15175', '/__qa': 'http://127.0.0.1:15175' } } })
await vite.listen()
console.log('Lab fixture ready: http://127.0.0.1:15174/tests/labScope.html')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  for (const release of releases) release()
  await vite.close(); await app.close(); await rm(temp, { recursive: true, force: true }); process.exit(0)
})
