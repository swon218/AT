import { seoulTimestamp } from './chartTime.js'

export function tradingConnectionStage(row,evidence,now=Date.now()) {
  if(!row)return 'checking'
  if(row.status==='unconfigured')return 'unconfigured'
  if(row.status==='failed')return 'failed'
  if(row.status==='expired'||row.connected&&!(row.expiresAt>now))return 'expired'
  if(evidence===false)return 'checking'
  return row.connected?'connected':'failed'
}
export function orderTradingConfigs(configs,watchlist) {
  const rank=new Map(watchlist.map((row,index)=>[row.code,index]))
  return [...configs].sort((a,b)=>(rank.get(a.code)??Infinity)-(rank.get(b.code)??Infinity)||a.code.localeCompare(b.code))
}

const seoulDate=seconds=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(seconds*1000))
// Mark the bar containing the actual fill; never add OHLC or a fabricated fill.
// An execution outside the supplied chart remains in the execution table only.
export function executionChartMarkers(trades,candles,palette={}, {executionMode='LIVE'}={}) {
  if(!candles.length)return []
  const intraday=typeof candles[0].time==='number'
  const timeFor=value=>{
    const seconds=typeof value==='string'?seoulTimestamp(value):null
    if(seconds===null)return null
    const day=seoulDate(seconds)
    if(!intraday)return candles.find(c=>c.time===day)?.time??null
    const candidates=candles.filter(c=>seoulDate(c.time)===day&&c.time<=seconds)
    const last=candidates.at(-1)
    if(!last)return null
    const index=candles.indexOf(last),next=candles[index+1]
    if(!next&&seconds>last.time+3600)return null
    return last.time
  }
  const markers=[],prefix=executionMode==='BROWSER_SIMULATION'?'':'실제 '
  for(const [i,t] of trades.entries()) {
    const entry=timeFor(t.entryAt),exit=timeFor(t.exitAt)
    if(entry!==null)markers.push({id:`execution-entry-${t.id||i}`,time:entry,position:'belowBar',shape:'arrowUp',color:palette.price||'#6266df',text:`${prefix}진입 #${i+1}`})
    if(exit!==null)markers.push({id:`execution-exit-${t.id||i}`,time:exit,position:'aboveBar',shape:t.reason==='stop_loss'?'square':'arrowDown',color:t.reason==='stop_loss'?(palette.down||'#3879d6'):(palette.up||'#d63e53'),text:`${prefix}${t.reason==='take_profit'?'익절':t.reason==='stop_loss'?'손절':'청산'} #${i+1}`})
  }
  return markers.sort((a,b)=>a.time<b.time?-1:a.time>b.time?1:0)
}
