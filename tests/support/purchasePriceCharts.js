// Test-only instrumentation around the installed native chart. No fixture code
// is imported from the production application entry point.
import {createChart as actualCreateChart,CandlestickSeries} from '../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs'
export * from '../../node_modules/lightweight-charts/dist/lightweight-charts.production.mjs'
let created=0,removed=0
const live=new Map()

export function createChart(container,options){
  const chart=actualCreateChart(container,options),id=++created,entry={chart,candles:null,privateLines:new Set()}
  live.set(id,entry);container.dataset.chartInstance=String(id)
  const add=chart.addSeries.bind(chart),remove=chart.remove.bind(chart)
  chart.addSeries=(definition,...args)=>{
    const series=add(definition,...args)
    if(definition===CandlestickSeries){
      entry.candles=series
      const createLine=series.createPriceLine.bind(series),removeLine=series.removePriceLine.bind(series)
      series.createPriceLine=options=>{
        const line=createLine(options)
        if(options.id==='atlas-personal-average-price')entry.privateLines.add(line)
        return line
      }
      series.removePriceLine=line=>{entry.privateLines.delete(line);removeLine(line)}
    }
    return series
  }
  chart.remove=()=>{removed++;live.delete(id);remove()}
  return chart
}

export function purchaseChartReport(){
  return {created,removed,live:[...live].map(([id,{chart,candles,privateLines}])=>({id,
    timeRange:chart.timeScale().getVisibleLogicalRange(),priceRange:candles?.priceScale().getVisibleRange(),
    background:chart.options().layout.background.color,panes:chart.panes().length,
    candleCount:candles?.data().length,paneHeight:chart.panes()[0]?.getHeight(),
    lines:[...privateLines].map(line=>({...line.options(),coordinate:candles.priceToCoordinate(line.options().price)})),
  }))}
}

export function zoomPurchaseFixtureCharts(){
  for(const {chart} of live.values())chart.timeScale().setVisibleLogicalRange({from:20,to:45})
}
