// Test-only instrumentation around the installed chart, never bundled by the app entry.
import {createChart as actualCreateChart,CandlestickSeries} from '../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs'
export * from '../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs'
let legacy=false,created=0,removed=0,lastLabel='',ticks=new Set()
const live=new Map()
export function setLegacy(value){legacy=value}
export function createChart(container,options){
  const opts={...options,localization:{...options.localization},timeScale:{...options.timeScale}}
  if(legacy){delete opts.localization.timeFormatter;delete opts.timeScale.tickMarkFormatter}
  else{
    const time=opts.localization.timeFormatter,tick=opts.timeScale.tickMarkFormatter
    opts.localization.timeFormatter=value=>{lastLabel=time(value);return lastLabel}
    opts.timeScale.tickMarkFormatter=(...args)=>{const result=tick(...args);ticks.add(result);return result}
  }
  lastLabel='';ticks=new Set()
  const chart=actualCreateChart(container,opts),id=++created,entry={chart,series:[],candles:null}
  live.set(id,entry)
  const add=chart.addSeries.bind(chart),remove=chart.remove.bind(chart)
  chart.addSeries=(definition,...args)=>{
    const series=add(definition,...args);entry.series.push(series)
    if(definition===CandlestickSeries)entry.candles=series
    return series
  }
  chart.remove=()=>{removed++;live.delete(id);remove()}
  return chart
}
export function showCrosshair(clock){
  for(const {chart,candles} of live.values()){
    const data=candles.data(),row=clock==='date'?data.at(-1):data.find(row=>typeof row.time==='number'&&new Date((row.time+9*3600)*1000).toISOString().slice(11,16)===clock)
    if(!row)return
    chart.timeScale().fitContent()
    chart.setCrosshairPosition(row.close,row.time,candles)
  }
}
export function reportCharts(){return {created,removed,label:lastLabel,ticks:[...ticks].slice(-18),live:[...live.values()].map(({chart,candles,series})=>({panes:chart.panes().length,first:candles.data()[0]?.time,last:candles.data().at(-1)?.time,count:candles.data().length,background:chart.options().layout.background.color,aligned:series.every(s=>s.data().every(row=>candles.data().some(c=>c.time===row.time)))}))}}
