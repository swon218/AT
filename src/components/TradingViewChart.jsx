import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries, createChart, createSeriesMarkers,
} from 'lightweight-charts'
import { getBrokerCandleResponse } from '../services/kiwoomMarketApi'
import { calculateBollinger, calculateEma, calculateMacd, calculateRsi, calculateSma, indicatorDisplayName, isLowerIndicator } from '../utils/indicators'
import { advancedSeries } from '../utils/advancedIndicators'
import { ADVANCED_BY_ID, validAdvancedConfig } from '../utils/advancedIndicatorCatalog'
import { advancedPlot, alignedPlot } from '../utils/indicatorPlots'
import { gapSafeSeries, isQuarantined } from '../utils/dataQuality'
import { bindChartTheme, chartPalette, chartThemeOptions } from '../utils/chartTheme'
import { normalizeChartCandles } from '../utils/chartCandles'
import { formatChartTime, formatChartTick } from '../utils/chartTime'
import { backtestChartMarkers, backtestEventLabel } from '../utils/backtestPresentation'

const won = (value) => new Intl.NumberFormat('ko-KR').format(Math.round(value))
const volumeFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const formatVolume = value => Number.isFinite(value) ? volumeFormatter.format(value) : '—'
const EMPTY = []
const advancedValid = config => Object.hasOwn(ADVANCED_BY_ID, config.id) && validAdvancedConfig(config)

export default function TradingViewChart({ stock, period, indicators = [], credentialScope = 'guest', broker = 'kiwoom', candles: suppliedCandles, onSourceChange, onMetadataChange, backtestEvents = EMPTY }) {
  const containerRef = useRef(null)
  const scrollContentRef = useRef(null)
  const manualBottomResizeRef = useRef(false)
  const stopResizeRef = useRef(null)
  const paneLayoutsRef = useRef({})
  const rightScaleWidthRef = useRef(72)
  const backtestEventsRef = useRef(backtestEvents)
  const backtestRuntimeRef = useRef(null)
  const [eventInspection, setEventInspection] = useState(null)
  backtestEventsRef.current = backtestEvents
  const inspectedEvents = eventInspection?.source === backtestEvents ? eventInspection.events : EMPTY
  const [loaded, setLoaded] = useState(null)
  const sourceKey = JSON.stringify([stock?.code, period, credentialScope, broker])
  const data = loaded?.key === sourceKey && loaded.supplied === suppliedCandles ? loaded.candles : EMPTY
  const [legend, setLegend] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [manualExtraHeight, setManualExtraHeight] = useState(null)
  const indicatorKey = JSON.stringify(indicators)
  const lowerIndicatorCount = indicators.filter(config => isLowerIndicator(config) && (!Object.hasOwn(ADVANCED_BY_ID, config.id) || advancedValid(config))).length
  const defaultExtraHeight = Math.max(0, (lowerIndicatorCount - 1) * 112)
  const scrollContentStyle = { height: `calc(100% + ${manualExtraHeight ?? defaultExtraHeight}px)`, minHeight: lowerIndicatorCount ? `${260 + lowerIndicatorCount * 90}px` : undefined }

  useEffect(() => {
    setManualExtraHeight(null)
    return () => stopResizeRef.current?.()
  }, [lowerIndicatorCount])

  const startBottomResize = (event) => {
    const content = scrollContentRef.current
    const viewport = content?.parentElement
    if (!content || !viewport) return
    event.preventDefault()
    stopResizeRef.current?.()
    const startY = event.clientY
    const startExtraHeight = Math.max(0, content.offsetHeight - viewport.clientHeight)
    const move = (moveEvent) => {
      manualBottomResizeRef.current = true
      setManualExtraHeight(Math.min(900, Math.max(0, startExtraHeight + moveEvent.clientY - startY)))
    }
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      stopResizeRef.current = null
    }
    stopResizeRef.current = stop
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  }

  useEffect(() => {
    let active = true
    const controller=new AbortController()
    const setData = candles => setLoaded({ key: sourceKey, supplied: suppliedCandles, candles })
    setData(EMPTY)
    setLegend(null)
    setError('')
    if (suppliedCandles !== undefined) {
      const candles = normalizeChartCandles(suppliedCandles,period)
      setData(candles)
      setLegend(candles.at(-1) ?? null)
      setLoading(false)
      return () => { active = false }
    }
    if (!stock?.code) return () => { active = false }

    setLoading(true)
    getBrokerCandleResponse(broker, stock.code, period, 200, {signal:controller.signal})
      .then((payload) => {
        if (!active) return
        const rows = Array.isArray(payload) ? payload : payload.items || []
        onSourceChange?.(payload.sourceBroker || broker)
        onMetadataChange?.({key:sourceKey,sourceBroker:payload.sourceBroker||broker,meta:payload.meta||null,returnedCount:rows.length})
        const candles = normalizeChartCandles(rows,period)
        setData(candles)
        setLegend(candles.at(-1) ?? null)
      })
      .catch(error => { if (active) { setData([]); setError(error.message); onMetadataChange?.({key:sourceKey,sourceBroker:broker,error:true}) } })
      .finally(() => active && setLoading(false))

    return () => { active = false;controller.abort() }
  }, [sourceKey, suppliedCandles, onSourceChange, onMetadataChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container || data.length === 0) return undefined

    const palette = chartPalette()
    const colors = chartThemeOptions(palette)
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        ...colors.layout,
        fontFamily: "Inter, 'Noto Sans KR', sans-serif", fontSize: 11, attributionLogo: true,
        panes: {
          enableResize: true,
          ...colors.layout.panes,
        },
      },
      localization: { locale: 'ko-KR', priceFormatter: (price) => won(price),timeFormatter:time=>formatChartTime(time,period.endsWith('분')) },
      grid: colors.grid,
      crosshair: {
        mode: CrosshairMode.Normal,
        ...colors.crosshair,
      },
      rightPriceScale: { ...colors.rightPriceScale, visible: true, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: {
        ...colors.timeScale, timeVisible: period.endsWith('분'),
        secondsVisible: false, rightOffset: 5, barSpacing: period === '월' ? 8 : 6,
        tickMarkFormatter:(time,type)=>formatChartTick(time,type,period.endsWith('분')),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    })
    const themedPriceLines = []
    const addThemedPriceLine = (series, options) => {
      const line = series.createPriceLine({ ...options, axisLabelColor: chartPalette().background })
      themedPriceLines.push(line)
    }
    rightScaleWidthRef.current = Math.max(56, chart.priceScale('right', 0).width())

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up, downColor: palette.down, wickUpColor: palette.wickUp,
      wickDownColor: palette.wickDown, borderUpColor: palette.up, borderDownColor: palette.down,
      priceLineColor: palette.price,
    })
    // Keep reported suspension closes in indicator calculations, matching the
    // backtest, but draw whitespace for candles without a valid OHLC range.
    candleSeries.setData(data.map(({ volume, ...candle }) => candle.open > 0 && candle.high > 0 && candle.low > 0 ? candle : { time: candle.time }))
    const eventMarkers = createSeriesMarkers(candleSeries, backtestChartMarkers(backtestEventsRef.current, palette))
    const backtestRuntime = { markers: eventMarkers }
    backtestRuntimeRef.current = backtestRuntime

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'custom', formatter: formatVolume, minMove: 1 }, priceScaleId: 'right',
      lastValueVisible: true, priceLineVisible: false,
      autoscaleInfoProvider: (original) => {
        const info = original()
        if (!info) return null
        return {
          ...info,
          priceRange: {
            minValue: 0,
            maxValue: Math.max(1, info.priceRange.maxValue),
          },
        }
      },
    }, 1)
    volumeSeries.priceScale().applyOptions({
      visible: true,
      borderVisible: true,
      borderColor: palette.border,
      scaleMargins: { top: 0.12, bottom: 0.05 },
    })
    volumeSeries.setData(data.map((item) => !Number.isFinite(item.volume) ? { time: item.time } : ({
      time: item.time, value: item.volume,
      color: item.close >= item.open ? 'rgba(255,92,105,.42)' : 'rgba(57,127,245,.42)',
    })))

    const plot = (calculate, line = true) => gapSafeSeries(data, calculate, line)

    const enabled = new Map(indicators.map((config) => [config.id, config]))
    const maConfig = enabled.get('ma')
    if (maConfig) {
      const movingAverage = maConfig.type === 'EMA' ? calculateEma : calculateSma
      const shortPeriod = Math.max(1, Number(maConfig.shortPeriod ?? maConfig.period) || 5)
      const longPeriod = Math.max(shortPeriod + 1, Number(maConfig.longPeriod) || 20)
      const common = { lineWidth: 2, priceLineVisible: false, lastValueVisible: false }
      const shortSeries = chart.addSeries(LineSeries, { ...common, color: maConfig.shortColor || maConfig.color || '#f4c542' })
      const longSeries = chart.addSeries(LineSeries, { ...common, color: maConfig.longColor || '#4b86ff' })
      shortSeries.setData(plot(segment => movingAverage(segment, shortPeriod)))
      longSeries.setData(plot(segment => movingAverage(segment, longPeriod)))
    }

    const bollingerConfig = enabled.get('bollinger')
    if (bollingerConfig) {
      const bands = Object.fromEntries(['upper', 'middle', 'lower'].map(key => [key, plot(segment => calculateBollinger(segment, Math.max(1, Number(bollingerConfig.period) || 20), Math.max(0.1, Number(bollingerConfig.multiplier) || 2))[key])]))
      const common = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false }
      const upper = chart.addSeries(LineSeries, { ...common, color: bollingerConfig.upperColor })
      const middle = chart.addSeries(LineSeries, { ...common, color: bollingerConfig.middleColor, lineStyle: 2 })
      const lower = chart.addSeries(LineSeries, { ...common, color: bollingerConfig.lowerColor })
      upper.setData(bands.upper)
      middle.setData(bands.middle)
      lower.setData(bands.lower)
    }

    const volumeMaConfig = enabled.get('volume-ma')
    if (volumeMaConfig) {
      const series = chart.addSeries(LineSeries, {
        color: volumeMaConfig.color, lineWidth: 2, priceScaleId: 'right',
        priceFormat: { type: 'custom', formatter: formatVolume, minMove: 1 },
        priceLineVisible: false, lastValueVisible: false,
      }, 1)
      series.setData(gapSafeSeries(data.map(bar => Number.isFinite(bar.volume) ? bar : { ...bar, quality: 'quarantined' }),
        segment => calculateSma(segment, Math.max(1, Number(volumeMaConfig.period) || 20), 'volume')))
    }

    let nextPane = 2
    const rsiConfig = enabled.get('rsi')
    if (rsiConfig) {
      const rsiValues = plot(segment => calculateRsi(segment, Math.max(1, Number(rsiConfig.period) || 14)))
      const series = chart.addSeries(LineSeries, {
        color: rsiConfig.color, lineWidth: 2, priceScaleId: 'right',
        priceFormat: { type: 'custom', formatter: (value) => value.toFixed(1), minMove: 0.1 },
        priceLineVisible: false, lastValueVisible: false,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, nextPane)
      series.setData(rsiValues)
      addThemedPriceLine(series, { price: Number(rsiConfig.upper), color: rsiConfig.upperColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, axisLabelTextColor: rsiConfig.upperColor, title: '' })
      addThemedPriceLine(series, { price: Number(rsiConfig.lower), color: rsiConfig.lowerColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, axisLabelTextColor: rsiConfig.lowerColor, title: '' })
      const currentRsi = rsiValues.at(-1)?.value
      if (Number.isFinite(currentRsi)) addThemedPriceLine(series, { price: currentRsi, color: rsiConfig.color, lineVisible: false, axisLabelVisible: true, axisLabelTextColor: rsiConfig.color, title: '' })
      nextPane += 1
    }

    const macdConfig = enabled.get('macd')
    if (macdConfig) {
      const fast = Math.max(1, Number(macdConfig.fast) || 12)
      const slow = Math.max(fast + 1, Number(macdConfig.slow) || 26)
      const signalPeriod = Math.max(1, Number(macdConfig.signal) || 9)
      const values = Object.fromEntries(['macd', 'signal', 'histogram'].map(key => [key, plot(segment => calculateMacd(segment, fast, slow, signalPeriod)[key], key !== 'histogram')]))
      const macd = chart.addSeries(LineSeries, { color: macdConfig.macdColor, lineWidth: 2, priceScaleId: 'right', priceLineVisible: false, lastValueVisible: true }, nextPane)
      const signal = chart.addSeries(LineSeries, { color: macdConfig.signalColor, lineWidth: 2, priceScaleId: 'right', priceLineVisible: false, lastValueVisible: true }, nextPane)
      const histogram = chart.addSeries(HistogramSeries, { priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false }, nextPane)
      macd.setData(values.macd)
      signal.setData(values.signal)
      histogram.setData(values.histogram.map((point) => ({ ...point, color: point.value >= 0 ? macdConfig.positiveColor : macdConfig.negativeColor })))
      nextPane += 1
    }

    const paneKeys = ['main', 'volume']
    if (rsiConfig) paneKeys.push('rsi')
    if (macdConfig) paneKeys.push('macd')
    const paneLegends = []
    let trendMarkers
    for (const config of indicators.filter(advancedValid)) {
      const values = advancedSeries(data, config)
      if (config.id === 'supertrend') {
        for (const [direction, color] of [[1, config.upColor], [-1, config.downColor]]) {
          const line = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
          line.setData(alignedPlot(data, values.supertrend, i => values.supertrend_direction[i] === direction))
        }
        if (config.showFlips) trendMarkers = createSeriesMarkers(candleSeries, data.flatMap(({ time }, i) => {
          const direction = values.supertrend_flip[i]
          return direction ? [{ time, position: direction === 1 ? 'belowBar' : 'aboveBar', shape: 'circle', size: 0.55,
            color: direction === 1 ? config.upColor : config.downColor, text: direction === 1 ? '상승 전환' : '하락 전환' }] : []
        }))
        continue
      }
      if (!isLowerIndicator(config)) continue
      const spec = advancedPlot(config)
      const format = value => !Number.isFinite(value) ? '—' : spec.unit === '주' ? `${formatVolume(value)}주`
        : `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${spec.unit}`
      const options = { priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false,
        priceFormat: { type: 'custom', minMove: spec.unit === '주' ? 1 : 0.01, formatter: format } }
      if (spec.bounded) options.autoscaleInfoProvider = () => ({ priceRange: { minValue: 0, maxValue: 100 } })
      const plotLines = spec.lines.map(([key, color, title]) => {
        const line = chart.addSeries(LineSeries, { ...options, color, lineWidth: 2 }, nextPane)
        line.setData(alignedPlot(data, values[key]))
        return { line, key, title }
      })
      const anchor = plotLines[0]?.line || chart.addSeries(LineSeries, { ...options, color: 'transparent' }, nextPane)
      if (!plotLines.length) anchor.setData(data.map(({ time }) => ({ time, value: 50 })))
      for (const price of spec.levels) addThemedPriceLine(anchor, { price, color: palette.border, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, axisLabelTextColor: palette.text })
      const badge = document.createElement('div')
      badge.className = 'tv-volume-legend'
      const update = i => { badge.textContent = [indicatorDisplayName(config), ...plotLines.map(({ key, title }) => `${title === 'ATR_PERCENT' ? 'ATR%' : title} ${format(values[key][i])}`)].join(' · ') }
      update(data.length - 1)
      paneLegends.push({ paneIndex: nextPane, badge, update })
      paneKeys.push(config.id)
      nextPane += 1
    }
    const capturePaneLayouts = () => {
      chart.panes().forEach((pane, index) => {
        const key = paneKeys[index]
        if (key) paneLayoutsRef.current[key] = { height: pane.getHeight(), stretchFactor: pane.getStretchFactor() }
      })
    }
    const restorePaneLayouts = () => {
      const panes = chart.panes()
      panes.forEach((pane, index) => {
        const savedLayout = paneLayoutsRef.current[paneKeys[index]]
        if (Number.isFinite(savedLayout?.stretchFactor)) pane.setStretchFactor(savedLayout.stretchFactor)
      })
    }

    const setDefaultPaneLayout = () => {
      const panes = chart.panes()
      if (panes.length < 2) return
      panes[0].setStretchFactor(3)
      panes[1].setStretchFactor(1)
      for (let index = 2; index < panes.length; index += 1) panes[index].setStretchFactor(1)
    }

    setDefaultPaneLayout()
    restorePaneLayouts()
    const unbindTheme = bindChartTheme(chart, palette => {
      candleSeries.applyOptions({ upColor: palette.up, downColor: palette.down, wickUpColor: palette.wickUp, wickDownColor: palette.wickDown,
        borderUpColor: palette.up, borderDownColor: palette.down, priceLineColor: palette.price })
      themedPriceLines.forEach(line => line.applyOptions({ axisLabelColor: palette.background }))
      eventMarkers.setMarkers(backtestChartMarkers(backtestEventsRef.current, palette))
    })
    const volumeLegendElement = document.createElement('div')
    const volumeLegendValue = document.createElement('b')
    volumeLegendElement.className = 'tv-volume-legend'
    volumeLegendElement.append('거래량 ', volumeLegendValue)
    volumeLegendValue.textContent = isQuarantined(data.at(-1)) ? '—' : formatVolume(data.at(-1)?.volume)
    chart.timeScale().fitContent()
    const scaleWidthFrame = requestAnimationFrame(() => {
      rightScaleWidthRef.current = Math.max(56, chart.priceScale('right', 0).width())
    })
    const moveCrosshair = (param) => {
      const time = typeof param.time === 'object' && param.time
        ? `${param.time.year}-${String(param.time.month).padStart(2, '0')}-${String(param.time.day).padStart(2, '0')}` : param.time
      const index = data.findIndex(row => row.time === time)
      const nextLegend = index < 0 ? data.at(-1) : data[index]
      setLegend(nextLegend)
      volumeLegendValue.textContent = isQuarantined(nextLegend) ? '—' : formatVolume(nextLegend.volume)
      paneLegends.forEach(({ update }) => update(index < 0 ? data.length - 1 : index))
      if (backtestEventsRef.current.length) {
        const events = backtestEventsRef.current
        const exact = events.find(event => `backtest-${event.id}` === String(param.hoveredObjectId))
        setEventInspection({ source: events, events: exact ? [exact] : events.filter(event => event.date === time) })
      }
    }
    chart.subscribeCrosshairMove(moveCrosshair)
    chart.subscribeClick(moveCrosshair)

    let previousContainerWidth = container.clientWidth
    let previousContainerHeight = container.clientHeight
    let resizeFrame = null
    const resizeChart = () => {
      resizeFrame = null
      const width = container.clientWidth
      const height = container.clientHeight
      if (width <= 0 || height <= 0) return
      if (width === previousContainerWidth && height === previousContainerHeight) return
      const panes = chart.panes()
      const previousLastPaneHeight = panes.at(-1)?.getHeight() ?? 90
      chart.resize(width, height, true)
      rightScaleWidthRef.current = Math.max(56, chart.priceScale('right', 0).width())
      if (manualBottomResizeRef.current && panes.length > 2) {
        panes.at(-1)?.setHeight(Math.max(90, previousLastPaneHeight + height - previousContainerHeight))
        manualBottomResizeRef.current = false
      }
      previousContainerWidth = width
      previousContainerHeight = height
    }
    // Follow the latest layout each frame without resizing inside the observer loop.
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame === null) resizeFrame = requestAnimationFrame(resizeChart)
    })
    resizeObserver.observe(container)
    const paneResizeObserver = new ResizeObserver(capturePaneLayouts)
    // Chart panes are mounted by Lightweight Charts during its first paint.
    const captureFrame = requestAnimationFrame(() => {
      chart.panes().forEach((pane, index) => {
        const element = pane.getHTMLElement()
        if (!element) return
        paneResizeObserver.observe(element)
        const badge = index === 1 ? volumeLegendElement : paneLegends.find(item => item.paneIndex === index)?.badge
        // Use the chart's native separators. Extra content directly on its
        // table rows can shift the plot and price-scale columns out of alignment.
        if (badge) element.cells?.[1]?.append(badge)
      })
    })
    document.addEventListener('pointerup', capturePaneLayouts)

    return () => {
      unbindTheme()
      capturePaneLayouts()
      cancelAnimationFrame(captureFrame)
      cancelAnimationFrame(scaleWidthFrame)
      paneResizeObserver.disconnect()
      document.removeEventListener('pointerup', capturePaneLayouts)
      resizeObserver.disconnect()
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      volumeLegendElement.remove()
      paneLegends.forEach(({ badge }) => badge.remove())
      chart.unsubscribeCrosshairMove(moveCrosshair)
      chart.unsubscribeClick(moveCrosshair)
      eventMarkers.detach()
      if (backtestRuntimeRef.current === backtestRuntime) backtestRuntimeRef.current = null
      trendMarkers?.detach()
      chart.remove()
    }
  }, [data, period, indicatorKey])

  useEffect(() => {
    backtestRuntimeRef.current?.markers.setMarkers(backtestChartMarkers(backtestEvents, chartPalette()))
  }, [backtestEvents, data, indicatorKey])

  if (!stock) return <div className="chart-empty"/>
  if (loading) return <div className="chart-empty"><span className="loading-ring"/></div>
  if (error) return <div className="chart-empty data-message error" role="alert">{error}</div>
  if (data.length === 0) return <div className="chart-empty data-message" role="status">제공된 캔들이 없습니다.</div>

  return (
    <div className="tv-chart-root" onKeyDown={event => { if (event.key === 'Escape') setEventInspection(null) }} onWheelCapture={(event) => {
      const root = event.currentTarget
      const bounds = root.getBoundingClientRect()
      const isRightScale = event.clientX >= bounds.right - rightScaleWidthRef.current
      if (!isRightScale || root.scrollHeight <= root.clientHeight) return
      event.preventDefault()
      event.stopPropagation()
      root.scrollTop += event.deltaY
    }}>
      {legend && <div className="tv-legend">{isQuarantined(legend) ? <span>{formatChartTime(legend.time,period.endsWith('분'))} · 가격 오류 격리</span> : <><span>시 <b>{won(legend.open)}</b></span><span>고 <b className="up">{won(legend.high)}</b></span><span>저 <b className="down">{won(legend.low)}</b></span><span>종 <b>{won(legend.close)}</b></span>{legend.quality === 'corrected' && <span>1원 보정</span>}</>}</div>}
      {indicators.length > 0 && <div className="tv-indicator-badges">{indicators.map((config) => <span key={config.id}>{indicatorDisplayName(config)}</span>)}</div>}
      {!!backtestEvents.length && <label className="tv-backtest-picker">거래 마커<select aria-label="백테스트 마커 상세" value={inspectedEvents.length === 1 ? inspectedEvents[0].id : ''} onChange={event => setEventInspection({ source: backtestEvents, events: backtestEvents.filter(item => item.id === event.target.value) })}><option value="">날짜·가격·수량 확인</option>{backtestEvents.map(event => <option key={event.id} value={event.id}>#{event.tradeId} {event.date} {backtestEventLabel(event)}</option>)}</select></label>}
      {!!inspectedEvents.length && <div className="tv-backtest-detail" role="status" aria-label="거래 마커 상세">{inspectedEvents.map(event => <div key={event.id}><strong>{backtestEventLabel(event)} · 거래 #{event.tradeId}</strong><span>{event.date} · {new Intl.NumberFormat('ko-KR', {maximumFractionDigits:6}).format(event.price)}원 · {event.quantity}주</span><span>{event.reason}</span>{event.ambiguous && !event.reason?.includes('순서 불명확') && <b>일봉 내 순서 불명확 · 손절 우선 가정</b>}</div>)}</div>}
      <div ref={scrollContentRef} className="tv-chart-scroll-content" style={scrollContentStyle}>
        <div ref={containerRef} className="tv-chart-canvas" aria-label={`${stock.name} TradingView 캔들 차트`}/>
        {lowerIndicatorCount > 0 && <div className="tv-bottom-pane-resizer" role="separator" aria-orientation="horizontal" aria-label="마지막 보조지표 높이 조절" title="드래그하여 마지막 보조지표 높이 조절" onPointerDown={startBottomResize} onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          manualBottomResizeRef.current = true
          setManualExtraHeight((current) => Math.min(900, Math.max(0, (current ?? defaultExtraHeight) + (event.key === 'ArrowDown' ? 20 : -20))))
        }} tabIndex={0}><span/></div>}
      </div>
    </div>
  )
}
