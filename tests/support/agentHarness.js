import Fastify from 'fastify'
import { spawn } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {readFile} from 'node:fs/promises'
import { registerAgentRoutes, createAgentBridge } from '../../server/agent.js'
import { testDatabase } from './agentDatabase.js'
import { registerScreenRoutes, createScreenBridge } from '../../server/screener.js'
import {registerAdminEval} from '../../server/adminEval.js'

export async function startHarness({ port = 13000, pythonPort = 18010, publicOrigin = 'http://127.0.0.1:15173', dataService, adminEvaluation=false } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Test harness is forbidden in production')
  const secret = 'local-fixture-only-'.repeat(3)
  const { db, store } = await testDatabase()
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } })
  const userA = randomUUID(), userB = randomUUID()
  await db.query('INSERT INTO auth.users VALUES($1),($2)', [userA, userB])
  const authenticate=async token=>{if(token==='Bearer fixture-user-a')return userA;if(token==='Bearer fixture-user-b')return userB;throw Object.assign(new Error('invalid_authentication'),{statusCode:401})}
  registerAgentRoutes(app, { store, cookieSecret: secret, internalSecret: secret,
    dataService:dataService||{status:()=>({}),read:async()=>({status:'error',code:'fixture_data_not_configured'})},
    alertStore:async()=>({watchlist:[],rules:[],history:[]}),
    publicOrigin, secureCookie: false,
    authenticate, bridge: createAgentBridge({ base: `http://127.0.0.1:${pythonPort}`, secret }) })
  let evaluationStore
  if(adminEvaluation){
    await db.exec(await readFile(new URL('../../deploy/AI_EVAL_SUPABASE.sql',import.meta.url),'utf8'))
    await db.exec(await readFile(new URL('../../deploy/ADMIN_EVAL_UI_SUPABASE.sql',import.meta.url),'utf8'))
    await db.query('insert into admin_users(user_id) values($1),($2)',[userA,userB])
    evaluationStore=async(action,actor,payload={})=>{
      try{return(await db.query('select atlas_eval_rpc($1,$2,$3) value',[action,actor,JSON.stringify(payload)])).rows[0].value}
      catch(error){throw Object.assign(new Error(error.message),{statusCode:error.message.includes('admin_forbidden')?403:error.message.includes('eval_not_found')?404:409})}
    }
    registerAdminEval(app,{store:evaluationStore,authenticate,origin:publicOrigin})
  }
  app.get('/api/health', async () => ({ ok: true, test_fixture: true }))
  registerScreenRoutes(app, { publicOrigin, bridge: createScreenBridge({ base: `http://127.0.0.1:${pythonPort}`, secret }) })
  app.setNotFoundHandler(async (_, reply) => reply.code(503).send({ error: 'test_fixture_no_broker_access' }))
  await app.listen({ port, host: '127.0.0.1' })
  const python = process.env.AI_TEST_PYTHON || fileURLToPath(new URL('../../.venv-ai/Scripts/python.exe', import.meta.url))
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
  const child = spawn(python, ['-m', 'ai_agent.tests.dev_service', '--port', String(pythonPort), '--callback-port', String(port)], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...env, NODE_ENV: 'test', ATLAS_TEST_HARNESS: '1' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  let diagnostics = ''
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-1000) })
  const close = async () => { child.kill(); await app.close(); await db.close() }
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Test Python exited: ' + diagnostics)
      try {
        const res = await fetch(`http://127.0.0.1:${pythonPort}/health`, { headers: { 'X-Atlas-Internal': secret } })
        if (res.ok) { ready = true; break }
      } catch { /* Wait for fixture service only. */ }
      await pause(100)
    }
    if (!ready) throw new Error('Test Python startup timed out: ' + diagnostics)
    return { app, db, store, close, evaluationStore, base: `http://127.0.0.1:${port}`, userA, userB }
  } catch (exc) { await close(); throw exc }
}
