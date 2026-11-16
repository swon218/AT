import { BROWSER_TRADING_MODE, browserTradingAccountRef } from '../utils/browserTradingEngine.js'

const brokers = ['kiwoom','toss','nh','kb']
export const browserAccountRef = browserTradingAccountRef
const active = row => !['stopped','completed'].includes(row.status)
const aborted = signal => { if (signal?.aborted) throw new DOMException('조회가 중단되었습니다.', 'AbortError') }

// These local action names deliberately never reach tradingApi or any HTTP
// writer. The only injected external dependency is the read-only market reader.
export function createBrowserTradingRuntime({ userId, engine, market, now = Date.now, visible = () => true, available = () => true, credentialRevision = 0 }) {
  if (!engine || !market || !userId) throw new Error('browser_trading_dependencies_required')
  let disposed = false, job = null, controller = null, cursor = 0, lastTick = 0
  let revision=credentialRevision
  const scope = () => `browser:${userId}:${revision}`
  function guard(owner, signal) {
    aborted(signal)
    if (disposed || owner !== userId) throw new Error('로그인 사용자가 변경되었습니다.')
  }
  async function tick() {
    if (disposed || !visible() || !available()) return engine.context()
    if (job) return job
    if (now() - lastTick < 10_000) return engine.context()
    lastTick = now()
    const runs = engine.context().sessions.filter(active)
    if (!runs.length) return engine.context()
    controller = new AbortController()
    const signal = controller.signal, version=revision
    // Bound every cycle; rotate through long lists instead of unbounded fanout.
    const targets = Array.from({length:Math.min(2,runs.length)},(_,i)=>runs[(cursor+i)%runs.length])
    cursor = (cursor + targets.length) % runs.length
    job = (async () => {
      for (const run of targets) {
        if (disposed || signal.aborted || !visible() || !available()) break
        try {
          const observation = await market.evaluate({broker:run.broker,symbol:run.code,strategy:run.snapshot.strategy,scope:scope(),signal})
          if (!disposed && version===revision && !signal.aborted && visible() && available()) engine.evaluate(run.id, observation)
        } catch (error) {
          if (!disposed && version===revision && !signal.aborted && visible() && available() && error.name !== 'AbortError') engine.fail(run.id, error.message)
        }
      }
      return engine.context()
    })().finally(()=>{ job=null; controller=null })
    return job
  }
  async function api(path = '', { userId: owner, body, signal } = {}) {
    guard(owner, signal)
    const url = new URL(`http://browser.local${path || '/'}`)
    const action = url.pathname
    if (body && !['/config','/preview','/start','/stop'].includes(action)) throw new Error('지원하지 않는 실행 요청입니다.')
    if (body?.mode && body.mode !== BROWSER_TRADING_MODE) throw new Error('실행 범위가 일치하지 않습니다.')
    if (body && action !== '/stop' && !available()) throw new Error('관심종목과 전략을 다시 확인한 뒤 실행해 주세요.')
    if (action === '/' && !body) return engine.context()
    if (action === '/connections' && !body) return Object.fromEntries(brokers.map(broker=>[broker,{
      status:'connected',connected:true,expiresAt:now()+120_000,
      accounts:[{ref:browserAccountRef(broker),label:'운용 계정'}],
    }]))
    if (action === '/config' && body) return engine.save(body)
    if (action === '/preview' && body) return engine.preview(body)
    if (action === '/start' && body) { const result=engine.start(body);lastTick=0;void tick();return result }
    if (action === '/stop' && body) return engine.stop(body)
    if (action === '/session' && !body) {
      const context=engine.context(), id=url.searchParams.get('sessionId')
      const row=context.sessions.find(run=>run.id===id)
      if(!row)throw new Error('실행 기록을 찾을 수 없습니다.')
      return {...context,sessions:[row],intents:[],events:context.events.filter(event=>event.session_id===id)}
    }
    if (action === '/chart' && !body) {
      const run=engine.context().sessions.find(row=>row.id===url.searchParams.get('sessionId'))
      if(!run)throw new Error('실행 기록을 찾을 수 없습니다.')
      const version=revision
      const result=await market.chart({broker:run.broker,symbol:run.code,period:url.searchParams.get('interval')||'15분',indicators:run.snapshot.strategy.indicators,scope:scope(),signal})
      guard(owner,signal)
      if(version!==revision)throw new DOMException('조회 범위가 변경되었습니다.','AbortError')
      return result
    }
    throw new Error('지원하지 않는 실행 요청입니다.')
  }
  return {
    api,tick,
    activate(){disposed=false},
    setCredentialRevision(next){if(next!==revision){revision=next;controller?.abort();lastTick=0}},
    suspend(reason='screen_closed'){controller?.abort();engine.suspend(reason)},
    dispose(){disposed=true;controller?.abort();engine.suspend('screen_closed')},
  }
}
