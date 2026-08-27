import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config, publicConfigurationStatus } from './config.js'
import { getRankings } from './rankings.js'
import { getCandles } from './charts.js'
import { getNews } from './news.js'
import { getAccountSettings, getAuthenticatedCredentials, updateAccountSettings } from './accountSettings.js'
import { placeKiwoomOrder } from './orders.js'
import { getKiwoomAccountSummary } from './kiwoomAccount.js'
import { requestKiwoom, requestKiwoomWithCredentials } from './kiwoomClient.js'
import { getTossCandles } from './tossCharts.js'
import { getTossAccountSummary } from './tossAccount.js'
import { placeTossOrder } from './tossOrders.js'

const app = Fastify({ logger: true })
await app.register(cors, {
  origin: config.frontendOrigin,
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})

app.get('/api/health', async () => ({ ok: true, ...publicConfigurationStatus() }))

async function marketRequestContext(request) {
  const authorization = request.headers.authorization || ''
  if (!authorization.startsWith('Bearer ')) return { requester: requestKiwoom, cacheScope: 'operator' }

  const { user, credentials, status } = await getAuthenticatedCredentials(request)
  if (!status.kiwoomConfigured || !credentials.kiwoomAppKey || !credentials.kiwoomSecretKey) {
    return { requester: requestKiwoom, cacheScope: 'operator' }
  }
  return {
    cacheScope: `user:${user.id}`,
    requester: (definition) => requestKiwoomWithCredentials({
      appKey: credentials.kiwoomAppKey,
      secretKey: credentials.kiwoomSecretKey,
      ...definition,
    }),
  }
}

async function tossMarketCredentials(request) {
  const authorization = request.headers.authorization || ''
  if (!authorization.startsWith('Bearer ')) {
    return { apiKey: config.tossApiKey, secretKey: config.tossSecretKey, cacheScope: 'operator' }
  }

  const { user, credentials, status } = await getAuthenticatedCredentials(request)
  if (!status.tossConfigured || !credentials.tossApiKey || !credentials.tossSecretKey) {
    return { apiKey: config.tossApiKey, secretKey: config.tossSecretKey, cacheScope: 'operator' }
  }
  return { apiKey: credentials.tossApiKey, secretKey: credentials.tossSecretKey, cacheScope: `user:${user.id}` }
}

app.get('/api/public/market/kiwoom/rankings', async (request, reply) => {
  try {
    const type = String(request.query.type || 'realtime')
    const limit = Math.min(20, Math.max(1, Number(request.query.limit) || 20))
    return { items: await getRankings(type, limit, await marketRequestContext(request)) }
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
    return { items: await getCandles(symbol, interval, limit, await marketRequestContext(request)) }
  } catch (error) {
    request.log.error({ error: error.message }, 'Kiwoom candles failed')
    return reply.code(502).send({ error: error.message })
  }
})

app.get('/api/public/market/toss/candles', async (request, reply) => {
  try {
    const symbol = String(request.query.symbol || '')
    const interval = String(request.query.interval || '일')
    const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 200))
    return { items: await getTossCandles(symbol, interval, limit, await tossMarketCredentials(request)) }
  } catch (error) {
    request.log.error({ error: error.message }, 'Toss candles failed')
    return reply.code(error.statusCode || 502).send({ error: error.message })
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

app.get('/api/account/settings', async (request, reply) => {
  try {
    return await getAccountSettings(request)
  } catch (error) {
    request.log.error({ error: error.message }, 'Account settings lookup failed')
    return reply.code(error.statusCode || 500).send({ error: error.message })
  }
})

app.put('/api/account/settings', async (request, reply) => {
  try {
    return await updateAccountSettings(request)
  } catch (error) {
    request.log.error({ error: error.message }, 'Account settings update failed')
    return reply.code(error.statusCode || 500).send({ error: error.message })
  }
})

app.get('/api/account/kiwoom/summary', async (request, reply) => {
  try {
    return await getKiwoomAccountSummary(request)
  } catch (error) {
    request.log.error({ error: error.message }, 'Kiwoom account summary failed')
    return reply.code(error.statusCode || 502).send({ error: error.message })
  }
})

app.get('/api/account/toss/summary', async (request, reply) => {
  try {
    return await getTossAccountSummary(request)
  } catch (error) {
    request.log.error({ error: error.message }, 'Toss account summary failed')
    return reply.code(error.statusCode || 502).send({ error: error.message })
  }
})

app.post('/api/orders/kiwoom', async (request, reply) => {
  try {
    return await placeKiwoomOrder(request)
  } catch (error) {
    request.log.error({ error: error.message }, 'Kiwoom order failed')
    return reply.code(error.statusCode || 502).send({ error: error.message })
  }
})

app.post('/api/orders/toss', async (request, reply) => {
  try {
    return await placeTossOrder(request)
  } catch (error) {
    request.log.error({ error: error.message }, 'Toss order failed')
    return reply.code(error.statusCode || 502).send({ error: error.message })
  }
})

try {
  await app.listen({ port: config.port, host: config.host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
