import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config, publicConfigurationStatus } from './config.js'
import { getRankings } from './rankings.js'
import { registerChartRoutes } from './chartRoutes.js'
import { registerNewsRoutes } from './news.js'
import { registerAccountConnectionRoutes } from './accountConnections.js'
import { registerRecentOrderRoutes } from './recentOrders.js'
import { registerOpenOrderRoutes } from './openOrders.js'
import { getAuthenticatedCredentials, registerAccountSettingsRoutes } from './accountSettings.js'
import { placeKiwoomOrder } from './orders.js'
import { getKiwoomAccountSummary } from './kiwoomAccount.js'
import { marketRequestContext } from './marketContext.js'
import { registerStockSearchRoutes, warmStockSearchCatalog } from './stockSearch.js'
import { getTossAccountSummary } from './tossAccount.js'
import { placeTossOrder } from './tossOrders.js'
import { registerLabRoutes } from './lab.js'
import { registerMarketIndexRoutes } from './marketIndices.js'
import { registerMarketSummaryRoutes } from './marketSummary.js'
import { registerExchangeRateRoutes } from './exchangeRate.js'
import { createMarketSessions } from './marketSession.js'
import { registerMarketCalendarRoutes } from './marketCalendar.js'
import { registerAddedBrokerRoutes } from './addedBrokers.js'
import { registerAgentRoutes } from './agent.js'
import { registerAdminEval } from './adminEval.js'
import { registerScreenRoutes } from './screener.js'
import { registerCompanyDartRoutes } from './companyDart.js'
import { kakaoSafeRequestLog, registerKakaoConnectionRoutes } from './kakaoConnection.js'

const app = Fastify({ logger: { serializers: { req: kakaoSafeRequestLog } } })
await app.register(cors, {
  origin: config.frontendOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})

app.get('/api/health', async () => ({ ok: true, ...publicConfigurationStatus() }))
registerLabRoutes(app)
registerStockSearchRoutes(app)
registerMarketIndexRoutes(app)
registerMarketSummaryRoutes(app, { sessions: createMarketSessions() })
registerMarketCalendarRoutes(app)
registerExchangeRateRoutes(app)
registerAddedBrokerRoutes(app)
registerRecentOrderRoutes(app)
registerOpenOrderRoutes(app)
registerAgentRoutes(app)
registerAdminEval(app)
registerScreenRoutes(app)
registerNewsRoutes(app)
registerAccountConnectionRoutes(app)
registerCompanyDartRoutes(app)
registerKakaoConnectionRoutes(app)

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

registerChartRoutes(app,{tossContext:tossMarketCredentials})

registerAccountSettingsRoutes(app)

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

let closing=false
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
  if(closing)return
  closing=true
  void app.close().then(()=>process.exit(0),()=>process.exit(1))
})

try {
  await app.listen({ port: config.port, host: config.host })
  void warmStockSearchCatalog().catch(error => app.log.warn({ error: error.message }, 'Stock catalog warmup failed; next catalog request will retry'))
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
