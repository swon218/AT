import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config, publicConfigurationStatus } from './config.js'
import { getRankings } from './rankings.js'
import { getCandles } from './charts.js'
import { getNews } from './news.js'

const app = Fastify({ logger: true })
await app.register(cors, { origin: config.frontendOrigin, methods: ['GET'] })

app.get('/api/health', async () => ({ ok: true, ...publicConfigurationStatus() }))

app.get('/api/public/market/kiwoom/rankings', async (request, reply) => {
  try {
    const type = String(request.query.type || 'realtime')
    const limit = Math.min(20, Math.max(1, Number(request.query.limit) || 20))
    return { items: await getRankings(type, limit) }
  } catch (error) {
    request.log.error({ error: error.message }, 'Kiwoom rankings failed')
    return reply.code(502).send({ error: error.message })
  }
})

app.get('/api/public/market/kiwoom/candles', async (request, reply) => {
  try {
    const symbol = String(request.query.symbol || '')
    const interval = String(request.query.interval || '일')
    const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 200))
    return { items: await getCandles(symbol, interval, limit) }
  } catch (error) {
    request.log.error({ error: error.message }, 'Kiwoom candles failed')
    return reply.code(502).send({ error: error.message })
  }
})

app.get('/api/public/news', async (request, reply) => {
  try {
    const query = String(request.query.query || '국내 증시').slice(0, 100)
    const display = Math.min(10, Math.max(1, Number(request.query.display) || 6))
    return { items: await getNews(query, display) }
  } catch (error) {
    request.log.error({ error: error.message }, 'Naver news failed')
    return reply.code(502).send({ error: error.message })
  }
})

try {
  await app.listen({ port: config.port, host: config.host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
