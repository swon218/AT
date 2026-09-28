import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../lab/store.py', import.meta.url))
const dbPath = process.env.LAB_DB_PATH || fileURLToPath(new URL('../data/lab.sqlite', import.meta.url))
const python = process.env.LAB_PYTHON || (process.platform === 'win32'
  ? fileURLToPath(new URL('../.venv-lab/Scripts/python.exe', import.meta.url)) : 'python3')

export function registerLabRoutes(app, read = readLabData) {
  app.get('/api/public/lab/symbols', async (request, reply) => {
    try { return await read() }
    catch (error) {
      request.log.error({ error: error.message }, 'Lab database read failed')
      return reply.code(503).send({ error: '실험실 데이터 저장소를 읽지 못했습니다. VPS의 Python·DB 설정을 확인하세요.' })
    }
  })
  app.get('/api/public/lab/candles', async (request, reply) => {
    const code = String(request.query.symbol || '')
    if (!/^[0-9][0-9A-Z]{5}$/.test(code)) return reply.code(400).send({ error: '6자리 종목코드를 입력하세요.' })
    try {
      const result = await read(code)
      if (!result.items.length) return reply.code(404).send({ error: '이 종목의 수집된 일봉이 없습니다. 초기 수집 또는 수집 오류를 확인하세요.' })
      return result
    } catch (error) {
      request.log.error({ error: error.message }, 'Lab candles read failed')
      return reply.code(503).send({ error: '실험실 일봉을 읽지 못했습니다. 잠시 후 다시 시도하세요.' })
    }
  })
}

const cache = new Map()
const pending = new Map()
async function readLabData(code = '') {
  const previous = cache.get(code)
  if (previous && previous.expires > Date.now()) return previous.value
  if (pending.has(code)) return pending.get(code)
  if (pending.size >= 4) throw new Error('Lab reader busy')
  const promise = (async () => {
    const args = [script, '--db', path.resolve(dbPath)]
    if (code) args.push('--symbol', code)
    const { stdout } = await execute(python, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    const value = JSON.parse(stdout)
    if (cache.size >= 100) cache.delete(cache.keys().next().value)
    cache.set(code, { value, expires: Date.now() + 60_000 })
    return value
  })()
  pending.set(code, promise)
  try { return await promise } finally { pending.delete(code) }
}
