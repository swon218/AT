import { timingSafeEqual } from 'node:crypto'
import { createTradingStore } from './tradingStore.js'
import { authenticateAccountRequest, getStoredTradingAccount } from './accountSettings.js'
import { createAccountConnectionHandler } from './accountConnections.js'
import { personalAuth, accountRef as makeAccountRef } from './personalBroker.js'
import { createTradingBrokerGateway, tradingCredentialVersion as credentialVersion } from './tradingBrokerGateway.js'
import { createTradingEngine, initialTradingState } from './tradingEngine.js'
import { createAgentBridge } from './agent.js'
import { readLabData } from './lab.js'
import { validateTradingSpec } from '../shared/tradingV1.js'
import { config } from './config.js'

const brokers = ['kiwoom', 'toss', 'nh', 'kb']
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }) }
export const tradingFlags = () => ({ workerEnabled: process.env.ATLAS_TRADING_WORKER_ENABLED === 'true', liveEnabled: process.env.ATLAS_TRADING_LIVE_ENABLED === 'true', paperEnabled: false })
const productionGateway = () => createTradingBrokerGateway({loadAccount:getStoredTradingAccount,settings:{liveEnabled:()=>tradingFlags().liveEnabled,workerEnabled:()=>tradingFlags().workerEnabled,kiwoomOrdersEnabled:()=>config.kiwoomOrdersEnabled}})
const safeKeys = ['phase','reason','checkedAt','lastCheckedAt','position','closedTrades','signalDay','missedSignalDay','markPrice','markAt','cycle','entryCount','lastClosedAt','unmanagedQuantity','priority']
const safePosition = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => ['quantity','averagePrice','costMicros','entryAt','adoptedAt','entryQuantity','initialCostMicros','adopted','soldQuantity','proceedsMicros'].includes(key)))
const safeStrategy = row => row && ({id:row.id,name:row.name,revision:row.revision,schema_version:row.schema_version,indicators:row.indicators,backtest_settings:row.backtest_settings})
function safeState(state = {}) {
  const out = Object.fromEntries(safeKeys.filter(key => Object.hasOwn(state,key)).map(key => [key,state[key]]))
  if (out.position) out.position = safePosition(out.position)
  if (Array.isArray(out.closedTrades)) out.closedTrades = out.closedTrades.slice(-200).map(row => Object.fromEntries(Object.entries(row).filter(([key]) => ['id','entryAt','adoptedAt','exitAt','decisionAt','entryPrice','exitPrice','quantity','pnl','reason','costs','adopted'].includes(key))))
  return out
}
export function tradingDisplay(context, flags, capabilities) {
  return {
    flags, capabilities,
    watchlist: (context.watchlist || []).map(row => ({ code:row.code,name:row.name })),
    strategies: (context.strategies || []).map(safeStrategy),
    configs: (context.configs || []).map(row => ({ id:row.id,code:row.code,revision:row.revision,spec:row.spec,updated_at:row.updated_at })),
    sessions: (context.sessions || []).map(row => ({ id:row.id,config_id:row.config_id,code:row.code,broker:row.broker,account_ref:row.account_ref,mode:row.mode,status:row.status,revision:row.revision,
      snapshot:{spec:row.snapshot?.spec,strategy:safeStrategy(row.snapshot?.strategy)},state:safeState(row.state),stop_requested:row.stop_requested,abandon_requested:row.abandon_requested,created_at:row.created_at,updated_at:row.updated_at })),
    intents: (context.intents || []).map(row => ({ id:row.id,session_id:row.session_id,side:row.side,quantity:row.quantity,price:row.price,status:row.status,filled_quantity:row.filled_quantity,cumulative_quantity:row.cumulative_quantity,cumulative_notional:row.cumulative_notional,created_at:row.created_at,updated_at:row.updated_at })),
    events: (context.events || []).map(row => ({ id:row.id,session_id:row.session_id,kind:row.kind,code:row.code,created_at:row.created_at })),
  }
}

export function createTradingController({ store = createTradingStore(), loadAccount = getStoredTradingAccount, gateway = productionGateway(), flags = tradingFlags,
  connection, now = Date.now } = {}) {
  const connect = connection || createAccountConnectionHandler({authenticate:request => loadAccount(request.ownerId)})
  const capabilityList = () => Object.fromEntries(brokers.map(broker => [broker,gateway.capabilities(broker)]))
  const context = owner => store.call('context',owner,{})
  async function current(owner, spec, {requireOrders=true}={}) {
    const capability = gateway.capabilities(spec.broker)
    if (!capability?.supported || requireOrders&&capability.ordersEnabled === false) fail('trading_broker_orders_disabled',409)
    const account = await loadAccount(owner)
    const auth = personalAuth(account,spec.broker)
    const inspected = await gateway.inspect({account,broker:spec.broker,accountRef:spec.accountRef,symbol:spec.code,signal:AbortSignal.timeout(25000)})
    if (!inspected.complete || !inspected.eligible) fail(inspected.reason || 'trading_account_unavailable',409)
    const version = credentialVersion(account,spec.broker,auth)
    const latest = await loadAccount(owner)
    if (version !== credentialVersion(latest,spec.broker,personalAuth(latest,spec.broker))) fail('trading_credentials_changed',409)
    return {account,inspected,version}
  }
  const modeAllowed = mode => {
    const f = flags()
    if (mode !== 'LIVE' || !f.workerEnabled || !f.liveEnabled) fail('trading_disabled',409)
  }
  return {
    async context(owner) { return tradingDisplay(await context(owner),flags(),capabilityList()) },
    async connections(owner) {
      const account = await loadAccount(owner)
      return Object.fromEntries(await Promise.all(brokers.map(async broker => {
        const saved = Boolean(account.status?.[`${broker}Configured`])
        if (!saved) return [broker,{status:'unconfigured',connected:false,expiresAt:now(),accounts:[]}]
        try {
          const result = await connect({ownerId:owner},broker)
          const latest=await loadAccount(owner)
          const auth=personalAuth(latest,broker)
          const connected=result.connected&&credentialVersion(latest,broker,auth)===credentialVersion(account,broker,personalAuth(account,broker))
          const accounts=connected&&broker==='kiwoom'?[{ref:makeAccountRef(latest,broker,auth,'linked'),label:'본인 API 연결 계좌'}]:[]
          return [broker,{...result,connected,expiresAt:connected?result.expiresAt:now(),status:connected?'connected':'failed',accounts}]
        } catch { return [broker,{status:'failed',connected:false,expiresAt:now(),accounts:[]}] }
      })))
    },
    async save(owner,input) {
      const ctx = await context(owner), spec = input?.spec
      if (!ctx.watchlist?.some(row => row.code === spec?.code)) fail('trading_watchlist_required',403)
      const strategy = ctx.strategies?.find(row => row.id === spec.strategyId && Number(row.revision) === Number(spec.strategyRevision))
      if (!strategy) fail('trading_strategy_changed',409)
      let checked
      try { checked = validateTradingSpec(spec,strategy) } catch { fail('trading_invalid_strategy') }
      const capability = gateway.capabilities(spec.broker)
      if (!capability?.supported) fail('trading_broker_unsupported',409)
      await current(owner,checked.spec,{requireOrders:false})
      await store.call('save_config',owner,{id:input.id,expectedRevision:input.expectedRevision,spec:checked.spec})
      return this.context(owner)
    },
    async preview(owner,input) {
      modeAllowed(input.mode)
      const ctx = await context(owner), config = ctx.configs?.find(row => row.id === input.configId && Number(row.revision) === Number(input.configRevision))
      if (!config) fail('trading_config_changed',409)
      if (!ctx.watchlist?.some(row => row.code === config.code)) fail('trading_watchlist_required',403)
      const strategy = ctx.strategies?.find(row => row.id === config.spec.strategyId && Number(row.revision) === Number(config.spec.strategyRevision))
      if (!strategy) fail('trading_strategy_changed',409)
      const checked = validateTradingSpec(config.spec,strategy), {inspected,version} = await current(owner,checked.spec)
      if (inspected.openOrders?.length) fail('trading_external_order_conflict',409)
      const manage = checked.spec.entryAction === 'manage'
      if (!manage && inspected.holdingQuantity !== 0) fail('trading_external_holding_conflict',409)
      if (manage && (!(inspected.holdingQuantity >= checked.spec.manageQuantity) || !(inspected.sellableQuantity >= checked.spec.manageQuantity) || !(inspected.averagePrice > 0))) fail('trading_holding_invalid',409)
      const initialState = initialTradingState({adoptedQuantity:manage?checked.spec.manageQuantity:0,averagePrice:manage?inspected.averagePrice:null,totalHoldingQuantity:inspected.holdingQuantity,now:now()})
      const preview = await store.call('preview_start',owner,{configId:config.id,configRevision:config.revision,mode:input.mode,credentialVersion:version,initialState,accountLabel:'본인 API 연결 계좌'})
      return {id:preview.id,expiresAt:preview.expiresAt,summary:{code:config.code,broker:config.spec.broker,accountLabel:'본인 API 연결 계좌',strategy:checked.strategy,spec:checked.spec,mode:input.mode,
        holding:manage?{quantity:checked.spec.manageQuantity,averagePrice:inspected.averagePrice}:null,
        entryMethod:'KRX 현금 지정가 · 60초 후 미체결 취소 확인',exitMethod:'KRX 현금 시장가',session:'KRX 정규장',stopPolicy:'신규 진입 중단 · 체결 보유분 익절·손절 관리 유지'}}
    },
    async start(owner,input) {
      if (!uuid(input.previewId) || !uuid(input.requestId) || input.confirmed !== true) fail('trading_confirmation_required')
      if(await store.call('start_read',owner,{requestId:input.requestId}))return this.context(owner)
      // The one-use preview and its config/strategy revision are checked under the DB lock.
      const result = await store.call('preview_read',owner,{previewId:input.previewId})
      modeAllowed(result.mode)
      const {inspected,version} = await current(owner,result.spec)
      if (version !== result.credentialVersion || inspected.openOrders?.length) fail('trading_preview_changed',409)
      if (result.spec.entryAction !== 'manage' && inspected.holdingQuantity !== 0) fail('trading_external_holding_conflict',409)
      if (result.spec.entryAction === 'manage' && (inspected.holdingQuantity !== result.initialState.unmanagedQuantity + result.spec.manageQuantity || inspected.averagePrice !== Number(result.initialState.position?.costMicros)/1e6/result.spec.manageQuantity || inspected.sellableQuantity<result.spec.manageQuantity)) fail('trading_preview_changed',409)
      modeAllowed(result.mode)
      if(gateway.capabilities(result.spec.broker).ordersEnabled===false)fail('trading_broker_orders_disabled',409)
      await store.call('start',owner,input)
      return this.context(owner)
    },
    async stop(owner,input) {
      if (!uuid(input.sessionId) || typeof input.abandon !== 'boolean' || !Number.isInteger(input.expectedRevision)) fail('trading_invalid_request')
      await store.call('stop',owner,input)
      return this.context(owner)
    },
    async chart(owner,{sessionId,configId,interval}) {
      if ((uuid(sessionId)?1:0)+(uuid(configId)?1:0)!==1 || sessionId&&configId || !['1분','5분','10분','15분','30분','60분','일','주','월'].includes(interval)) fail('invalid_chart_query')
      const ctx = await context(owner), config = configId&&ctx.configs?.find(row => row.id === configId)
      const session = sessionId?ctx.sessions?.find(row => row.id === sessionId):config&&{code:config.code,broker:config.spec.broker,account_ref:config.spec.accountRef}
      if (!session) fail('trading_not_found',404)
      const account = await loadAccount(owner)
      personalAuth(account,session.broker)
      const result = await gateway.candles({account,broker:session.broker,accountRef:session.account_ref,symbol:session.code,interval,signal:AbortSignal.timeout(25000)})
      if ((result.metadata?.sourceBroker || result.metadata?.source) !== session.broker || result.metadata?.fallback) fail('trading_personal_chart_required',409)
      return {candles:result.candles,metadata:result.metadata}
    },
  }
}

export function registerTradingRoutes(app,options = {}) {
  const controller = options.controller || createTradingController(options), authenticate = options.authenticate || authenticateAccountRequest
  const origin = options.origin ?? process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:5173'
  const secret = options.secret ?? process.env.ATLAS_TRADING_INTERNAL_SECRET ?? ''
  const engine = options.engine || createTradingEngine({store:options.store || createTradingStore(),gateway:options.gateway || productionGateway(),loadAccount:options.loadAccount || getStoredTradingAccount,
    calendar:() => createAgentBridge().call('/calendar/alert-session'),readDaily:readLabData,flags:tradingFlags})
  for (const [method,path,action] of [['GET','','context'],['GET','/connections','connections'],['POST','/config','save'],['POST','/preview','preview'],['POST','/start','start'],['POST','/stop','stop'],['GET','/chart','chart']]) {
    app.route({method,url:`/api/agent/trading${path}`,logLevel:'silent',handler:async(request,reply) => {
      reply.header('Cache-Control','private, no-store')
      try {
        if (request.headers.origin && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') fail('origin_forbidden',403)
        const user = await authenticate(request)
        return await controller[action](user.id,method==='GET'?request.query:request.body || {})
      } catch (error) {
        const code = /^trading_[a-z_]+$/.test(error.code || error.message) ? error.code || error.message : error.statusCode === 401 ? 'authentication_required':'trading_unavailable'
        return reply.code(error.statusCode || 503).send({error:code})
      }
    }})
  }
  app.post('/api/internal/trading/tick',{logLevel:'silent'},async(request,reply) => {
    reply.header('Cache-Control','no-store')
    const token = request.headers['x-atlas-trading'] || ''
    if (request.headers.origin || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip) || secret.length<32 || Buffer.byteLength(token)!==Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(token),Buffer.from(secret))) return reply.code(401).send({error:'unauthorized'})
    try { return await engine.tick() } catch { return reply.code(503).send({error:'trading_tick_unavailable'}) }
  })
}
