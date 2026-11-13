import {normalizeChartTime} from './chartTime.js'
import {isQuarantined} from './dataQuality.js'
export function normalizeChartCandles(rows,period='일'){
  const candles=new Map()
  for(const row of Array.isArray(rows)?rows:[]){
    if(!row||typeof row!=='object'||Array.isArray(row))continue
    const time=normalizeChartTime(row.time??row.timestamp??row.date,{intraday:period.endsWith('분')})
    if(time===null)continue
    if(isQuarantined(row)||['open','high','low','close'].some(k=>row[k]==null||row[k]===''||!Number.isFinite(Number(row[k])))){
      candles.set(time,{time,quality:'quarantined'});continue
    }
    const volume=row.volume==null||row.volume===''?null:Number(row.volume)
    candles.set(time,{time,quality:row.quality,open:Math.abs(Number(row.open)),high:Math.abs(Number(row.high)),low:Math.abs(Number(row.low)),close:Math.abs(Number(row.close)),volume:Number.isFinite(volume)&&volume>=0?volume:null})
  }
  return [...candles.values()].sort((a,b)=>typeof a.time==='number'?a.time-b.time:a.time.localeCompare(b.time))
}
