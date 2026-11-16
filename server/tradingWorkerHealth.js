// An enabled flag is operator permission, not evidence that a worker is alive.
// The existing authenticated loopback tick is the only readiness signal.
export function createTradingWorkerHealth({now=Date.now,ttlMs=210000}={}) {
  let seen=0,healthy=false
  return {seen(){seen=now()},settled(ok){healthy=ok===true},ready(){return healthy&&seen>0&&seen<=now()&&now()-seen<ttlMs}}
}
export const tradingWorkerHealth=createTradingWorkerHealth()
