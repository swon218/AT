import { useEffect, useRef, useState } from 'react'
import { AreaSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart } from 'lightweight-charts'
import { RefreshCw } from 'lucide-react'
import { getKiwoomIndex } from '../services/kiwoomMarketApi'

const periods = [['1d', '1일'], ['1w', '1주'], ['1m', '1개월'], ['3m', '3개월'], ['1y', '1년']]
const point = value => value == null ? '—' : value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = value => value == null ? '—' : `${value > 0 ? '+' : ''}${point(value)}`
const volume = value => value == null ? '—' : value.toLocaleString('ko-KR')
const dateLabel = value => value ? value.replace('T', ' ').slice(0, 16) : ''
const chartTime = value => value.includes('T') ? Math.floor(Date.parse(value) / 1000) : value
function formatTime(time, intraday) {
  if (typeof time === 'number') return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(time * 1000))
  const date = typeof time === 'string' ? time : `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
  return intraday ? date : date.slice(5).replace('-', '/')
}

function IndexPlot({ data }) {
  const containerRef = useRef(null)
  const [hover, setHover] = useState(null)
  useEffect(() => {
    const container = containerRef.current
    if (!container || !data.candles.length) return undefined
    setHover(null)
    const intraday = data.period === '1d'
    const rising = data.changeRate >= 0
    const color = rising ? '#ff455d' : '#369bff'
    const chart = createChart(container, {
      width: container.clientWidth, height: container.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#071d2d' }, textColor: '#87a8c6', fontSize: 10, fontFamily: 'inherit', panes: { separatorColor: '#17354b', separatorHoverColor: '#2e6080', enableResize: false } },
      grid: { vertLines: { color: '#102e42' }, horzLines: { color: '#102e42' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#6585a4', labelBackgroundColor: '#18374e' }, horzLine: { color: '#6585a4', labelBackgroundColor: '#18374e' } },
      rightPriceScale: { borderColor: '#17354b', minimumWidth: 66, scaleMargins: { top: .12, bottom: .08 } },
      timeScale: { borderColor: '#17354b', timeVisible: intraday, secondsVisible: false, rightOffset: 2, tickMarkFormatter: time => formatTime(time, intraday) },
      localization: { locale: 'ko-KR', timeFormatter: time => formatTime(time, intraday) },
      handleScroll: false, handleScale: false,
    })
    const series = chart.addSeries(AreaSeries, { lineColor: color, topColor: rising ? '#ff455d45' : '#369bff45', bottomColor: '#071d2d00', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: .01 } })
    const bars = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1)
    series.setData(data.candles.map(row => ({ time: chartTime(row.time), value: row.close })))
    bars.setData(data.candles.map((row, i) => ({ time: chartTime(row.time), value: row.volume, color: row.close >= (data.candles[i - 1]?.close ?? row.close) ? '#ef5265b0' : '#419cffb0' })).filter(row => row.value !== null))
    if (intraday && data.change !== null) series.createPriceLine({ price: data.price - data.change, color: '#60798f', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '전일' })
    chart.panes()[1]?.setHeight(78)
    const byTime = new Map(data.candles.map(row => [String(chartTime(row.time)), row]))
    chart.subscribeCrosshairMove(event => {
      const key = typeof event.time === 'object' && event.time ? `${event.time.year}-${String(event.time.month).padStart(2, '0')}-${String(event.time.day).padStart(2, '0')}` : String(event.time)
      setHover(byTime.get(key) ?? null)
    })
    chart.timeScale().fitContent()
    let frame = null
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (container.clientWidth && container.clientHeight) { chart.resize(container.clientWidth, container.clientHeight, true); chart.panes()[1]?.setHeight(78); chart.timeScale().fitContent() }
      })
    })
    observer.observe(container)
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); chart.remove() }
  }, [data])
  return <>
    <div className="index-chart-readout">{hover ? <><span>{dateLabel(hover.time)}</span><b>{point(hover.close)}</b></> : <span>{data.period === '1d' ? '최근 거래일 · 1분 간격' : '일별 지수'}</span>}</div>
    <div className="index-chart-canvas" ref={containerRef} role="img" aria-label={`${data.name} ${periods.find(([id]) => id === data.period)?.[1]} 지수 차트, 마지막 지수 ${point(data.candles.at(-1)?.close)}`}/>
    <div className="index-chart-volume"><span>{hover ? '선택 구간 거래량' : '최근 거래일 거래량'}</span><b>{volume(hover ? hover.volume : data.volume)}<small> 주</small></b></div>
  </>
}

export default function MarketIndexChart({ credentialScope }) {
  const [symbol, setSymbol] = useState('kospi')
  const [period, setPeriod] = useState('1d')
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState({})
  const key = `${credentialScope}:${symbol}:${period}`
  const current = state.key === key ? state : { loading: true }
  const data = current.data
  useEffect(() => {
    const controller = new AbortController()
    let timer, inFlight = false
    setState({ key, loading: true })
    const load = async () => {
      if (inFlight || controller.signal.aborted) return
      clearTimeout(timer)
      inFlight = true
      try {
        const payload = await getKiwoomIndex(symbol, period, controller.signal)
        if (!controller.signal.aborted) setState({ key, data: payload, loading: false })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, key, loading: false, error: error.message }))
      } finally {
        inFlight = false
        if (!controller.signal.aborted) timer = setTimeout(() => { if (!document.hidden) load() }, 30_000)
      }
    }
    const onVisible = () => { if (!document.hidden) load() }
    load()
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [key, symbol, period, revision])

  return <article className="panel dashboard-index-panel" aria-labelledby="index-chart-title">
    <div className="index-panel-heading"><h2 id="index-chart-title">주요 지수 차트</h2><div className="index-symbol-tabs" role="group" aria-label="지수 선택">
      {[['kospi', '코스피'], ['kosdaq', '코스닥']].map(([id, label]) => <button type="button" key={id} aria-pressed={symbol === id} onClick={() => setSymbol(id)}>{label}</button>)}
    </div></div>
    <div className="index-quote"><strong>{point(data?.price)}</strong><span className={data?.changeRate > 0 ? 'up' : data?.changeRate < 0 ? 'down' : ''}>{data ? `${data.changeRate > 0 ? '▲ ' : data.changeRate < 0 ? '▼ ' : ''}${point(data.change == null ? null : Math.abs(data.change))} (${signed(data.changeRate)}%)` : current.error ? '조회 실패' : '지수 조회 중'}</span></div>
    <div className="index-period-tabs" role="group" aria-label="지수 조회 기간">{periods.map(([id, label]) => <button type="button" key={id} aria-pressed={period === id} onClick={() => setPeriod(id)}>{label}</button>)}</div>
    <div className="index-chart-body" aria-busy={current.loading}>
      {data ? <IndexPlot data={data}/> : current.error ? <div className="index-chart-message" role="alert"><span>{current.error}</span><button type="button" onClick={() => setRevision(v => v + 1)}><RefreshCw size={14}/> 다시 시도</button></div> : <div className="index-chart-message" role="status"><span className="loading-ring"/><span>지수를 불러오고 있습니다.</span></div>}
    </div>
    <div className={`index-chart-footer${current.error ? ' has-error' : ''}`} role="status">{data && <span>{current.error ? '갱신 실패 · 마지막 수신값 표시' : `${dateLabel(data.asOf)} 기준`}</span>}<span>키움증권 · 30초 갱신</span></div>
  </article>
}
