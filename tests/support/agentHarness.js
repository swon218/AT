import Fastify from 'fastify'
import { spawn } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { registerAgentRoutes, createAgentBridge } from '../../server/agent.js'
import { testDatabase } from './agentDatabase.js'

export async function startHarness({ port = 13000, pythonPort = 18010 } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Test harness is forbidden in production')
  const secret = 'local-fixture-only-'.repeat(3)
  const { db, store } = await testDatabase()
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } })
  const userA = randomUUID(), userB = randomUUID()
  await db.query('INSERT INTO auth.users VALUES($1),($2)', [userA, userB])
  registerAgentRoutes(app, { store, cookieSecret: secret, internalSecret: secret,
    publicOrigin: 'http://127.0.0.1:15173', secureCookie: false,
    authenticate: async token => {
      if (token === 'Bearer fixture-user-a') return userA
      if (token === 'Bearer fixture-user-b') return userB
      throw Object.assign(new Error('invalid_authentication'), { statusCode: 401 })
    }, bridge: createAgentBridge({ base: `http://127.0.0.1:${pythonPort}`, secret }) })
  app.get('/api/health', async () => ({ ok: true, test_fixture: true }))
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
    return { app, db, store, close, base: `http://127.0.0.1:${port}`, userA, userB }
  } catch (exc) { await close(); throw exc }
}
