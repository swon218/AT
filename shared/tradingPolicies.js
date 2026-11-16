const regular='KRX_REGULAR'
const policies={
  kiwoom:{version:'krx-cash-v1',route:'KRX',quoteMarket:'KRX',chartMarket:'KRX',tradingWindow:regular,
    routeLabel:'KRX 지정',quoteLabel:'KRX 체결 시세',chartLabel:'KRX 캔들',
    entryOrder:'KRX 현금 지정가 · 60초 후 잔량 취소 확인',exitOrder:'KRX 현금 시장가'},
  toss:{version:'toss-default-sor-v2',route:'SOR',quoteMarket:'PROVIDER',chartMarket:'PROVIDER',tradingWindow:regular,
    routeLabel:'토스 기본 SOR · KRX 지정 아님',quoteLabel:'토스 제공 시세 · 거래소 미제공',chartLabel:'토스 제공 캔들 · 거래소 미제공',
    entryOrder:'토스 기본 SOR 현금 지정가 DAY · 60초 후 잔량 취소 확인',exitOrder:'토스 기본 SOR 현금 시장가 DAY'},
  nh:{version:'nh-krx-cash-v2',route:'KRX',quoteMarket:'KRX',chartMarket:'KRX',tradingWindow:regular,
    routeLabel:'KRX 지정',quoteLabel:'KRX 체결 시세',chartLabel:'KRX 캔들',
    entryOrder:'NH KRX 현금 지정가 · 60초 후 잔량 취소 확인',exitOrder:'NH KRX 현금 시장가'},
}
export const tradingExecutionPolicy=broker=>policies[broker]?structuredClone(policies[broker]):null
export function resolveTradingPolicy(snapshot,broker) {
  const current=tradingExecutionPolicy(broker),stored=snapshot?.executionPolicy
  if(!current)return null
  // Only the already-deployed KRX Kiwoom V1 contract has an implicit legacy form.
  if(!stored)return broker==='kiwoom'?current:null
  return ['version','route','quoteMarket','chartMarket','tradingWindow'].every(key=>stored[key]===current[key])?structuredClone(stored):null
}
