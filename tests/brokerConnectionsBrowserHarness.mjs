// Isolated App fixture. envDir:false and the Supabase replacement prevent real
// authentication or broker access. Every /api request is handled locally.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import Fastify from 'fastify'
import { createAccountConnectionHandler, registerAccountConnectionRoutes, CONNECTION_BROKERS } from '../server/accountConnections.js'
import { createAccountConnectionCache } from '../server/accountConnectionCache.js'

if (process.env.NODE_ENV === 'production') throw new Error('Fixture is forbidden in production')
const cache = createAccountConnectionCache(), app = Fastify()
const metrics = { requests: 0, probes: Object.fromEntries(CONNECTION_BROKERS.map(b => [b, 0])) }
const accounts = new Map()
function account(id) {
  if (!/^qa-(all|partial|new|slow)$/.test(id || '')) throw Object.assign(new Error(), { statusCode: 401 })
  if (!accounts.has(id)) accounts.set(id, { user: { id },
    status: Object.fromEntries(CONNECTION_BROKERS.map(b => [`${b}Configured`, id !== 'qa-new'])),
    credentials: Object.fromEntries(CONNECTION_BROKERS.flatMap(b => [[b === 'toss' ? 'tossApiKey' : `${b}AppKey`, 'fixture'], [`${b}SecretKey`, 'fixture']])),
  })
  if (id === 'qa-partial') accounts.get(id).credentials.tossSecretKey = 'invalid-fixture'
  return accounts.get(id)
}
registerAccountConnectionRoutes(app, createAccountConnectionHandler({ cache, authenticate: async request => structuredClone(account(request.headers.authorization?.slice(7))),
  probe: async (broker, auth, signal) => {
    metrics.probes[broker]++
    if (auth.secretKey === 'invalid-fixture') throw new Error('Fixture rejection')
    // Slow KB verifies the other brokers can render first.
    if (broker === 'kb') await new Promise(resolve => { const timer = setTimeout(resolve, 1500); signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
    return true
  },
}))
app.route({ method: ['GET', 'PUT'], url: '/api/account/settings', handler: async request => {
  const data = account(request.headers.authorization?.slice(7))
  if (request.method === 'PUT') {
    const input = request.body || {}, changed = []
    for (const broker of CONNECTION_BROKERS) {
      const fields = [broker === 'toss' ? 'tossApiKey' : `${broker}AppKey`, `${broker}SecretKey`]
      if (input.clearBrokers?.includes(broker)) { fields.forEach(field => delete data.credentials[field]); data.status[`${broker}Configured`] = false; changed.push(broker) }
      else if (fields.some(field => input[field])) {
        fields.forEach(field => { if (input[field]) data.credentials[field] = input[field] })
        data.status[`${broker}Configured`] = fields.every(field => data.credentials[field]); changed.push(broker)
      }
    }
    cache.invalidate(data.user.id, changed)
  }
  return data.status
} })

const supabaseFixture = `
let id = 'qa-all'; const listeners = new Set();
const session = () => id ? {access_token:id,user:{id,email:id+'@fixture.invalid'}} : null;
export const setQaUser = value => {id=value; for(const callback of listeners) callback('SIGNED_IN',session())};
export const initialRecoveryRequest = {requested:false,failed:false}; export const isSupabaseConfigured = true;
export const supabase = {auth:{initialize:async()=>({}), getSession:async()=>({data:{session:session()}}),
 onAuthStateChange:callback=>{listeners.add(callback);return {data:{subscription:{unsubscribe:()=>listeners.delete(callback)}}}},
 signOut:async()=>{setQaUser('');return {}}},
 from:table=>{const result=()=>({data:table==='profiles'?{nickname:'모의 사용자'}:[],error:null});
 const q={select:()=>q,eq:()=>q,order:()=>q,update:()=>q,maybeSingle:async()=>result(),single:async()=>result(),then:(resolve,reject)=>Promise.resolve(result()).then(resolve,reject)};return q}};
`
const server = await createServer({ configFile: false, envDir: false,
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
  plugins: [{ name: 'broker-connections-fixture', enforce: 'pre', load(id) {
    if (id.replaceAll('\\', '/').endsWith('/src/services/supabaseClient.js')) return supabaseFixture
  }, configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url === '/__qa/metrics') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(metrics)) }
      if (!req.url.startsWith('/api/')) return next()
      if (!req.url.startsWith('/api/account/connections/') && !req.url.startsWith('/api/account/settings')) {
        res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'fixture_no_external_access' }))
      }
      if (req.url.startsWith('/api/account/connections/')) metrics.requests++
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const payload = chunks.length ? Buffer.concat(chunks) : undefined
      const result = await app.inject({ method: req.method, url: req.url, headers: req.headers, payload })
      res.writeHead(result.statusCode, result.headers); res.end(result.body)
    })
  } }, react()], server: { host: '127.0.0.1', port: 15177, strictPort: true },
})
await server.listen()
console.log('Connection fixture: http://127.0.0.1:15177/tests/brokerConnections.html')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void Promise.all([server.close(), app.close()]).then(() => process.exit(0)) })
