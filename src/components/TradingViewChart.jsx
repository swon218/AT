import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart,
} from 'lightweight-charts'
import { getKiwoomCandles } from '../services/kiwoomMarketApi'
import { calculateBollinger, calculateEma, calculateMacd, calculateRsi, calculateSma, indicatorDisplayName } from '../utils/indicators'

const won = (value) => new Intl.NumberFormat('ko-KR').format(Math.round(value))
const volumeFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const formatVolume = (value) => volumeFormatter.format(Math.max(0, Number(value) || 0))

function normalizeCandles(rows) {
  return rows
    .map((row) => {
      const rawTime = row.time ?? row.timestamp ?? row.date
      const time = typeof rawTime === 'number'
        ? rawTime
        : /^\d{4}-\d{2}-\d{2}$/.test(rawTime ?? '')
          ? rawTime
          : Math.floor(new Date(rawTime).getTime() / 1000)
      return {
        time, open: Math.abs(Number(row.open)), high: Math.abs(Number(row.high)), low: Math.abs(Number(row.low)),
        close: Math.abs(Number(row.close)), volume: Math.abs(Number(row.volume ?? 0)),
      }
    })
    .filter((row) => row.time && [row.open, row.high, row.low, row.close].every(Number.isFinite))
    .sort((a, b) => String(a.time).localeCompare(String(b.time), undefined, { numeric: true }))
}

export default function TradingViewChart({ stock, period, indicators = [] }) {
  const containerRef = useRef(null)
  const scrollContentRef = useRef(null)
  const manualBottomResizeRef = useRef(false)
  const paneLayoutsRef = useRef({})
  const rightScaleWidthRef = useRef(72)
  const [data, setData] = useState([])
  const [legend, setLegend] = useState(null)
  const [loading, setLoading] = useState(false)
  const [manualExtraHeight, setManualExtraHeight] = useState(null)
  const indicatorKey = JSON.stringify(indicators)
  const lowerIndicatorCount = indicators.filter((config) => config.id === 'rsi' || config.id === 'macd').length
  const defaultExtraHeight = lowerIndicatorCount > 1 ? (lowerIndicatorCount - 1) * 170 : 0
  const scrollContentStyle = manualExtraHeight != null
    ? { height: `calc(100% + ${manualExtraHeight}px)` }
    : { height: lowerIndicatorCount > 1 ? `${100 + ((lowerIndicatorCount - 1) * 20)}%` : '100%' }

  useEffect(() => setManualExtraHeight(null), [lowerIndicatorCount])

  const startBottomResize = (event) => {
    const content = scrollContentRef.current
    const viewport = content?.parentElement
    if (!content || !viewport) return
    event.preventDefault()
    const startY = event.clientY
    const startExtraHeight = Math.max(0, content.offsetHeight - viewport.clientHeight)
    const move = (moveEvent) => {
      manualBottomResizeRef.current = true
      setManualExtraHeight(Math.min(900, Math.max(0, startExtraHeight + moveEvent.clientY - startY)))
    }
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
  }

  useEffect(() => {
    let active = true
    setData([])
    setLegend(null)
    if (!stock?.code) return () => { active = false }

    setLoading(true)
    getKiwoomCandles(stock.code, period, 200)
      .then((rows) => {
        if (!active) return
        const candles = normalizeCandles(rows)
        setData(candles)
        setLegend(candles.at(-1) ?? null)
      })
      .catch(() => active && setData([]))
      .finally(() => active && setLoading(false))

    return () => { active = false }
  }, [stock?.code, period])

  useEffect(() => {
    const container = containerRef.current
    if (!container || data.length === 0) return undefined

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: '#0c1a2b' }, textColor: '#70849e',
        fontFamily: "Inter, 'Noto Sans KR', sans-serif", fontSize: 11, attributionLogo: true,
        panes: {
          enableResize: true,
          separatorColor: '#607895',
          separatorHoverColor: 'rgba(75, 134, 255, .88)',
        },
      },
      localization: { locale: 'ko-KR', priceFormatter: (price) => won(price) },
      grid: { vertLines: { color: '#152941' }, horzLines: { color: '#152941' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4d6787', labelBackgroundColor: '#315f9c' },
        horzLine: { color: '#4d6787', labelBackgroundColor: '#315f9c' },
      },
      rightPriceScale: { visible: true, borderColor: '#1d334d', scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: {
        borderColor: '#1d334d', timeVisible: period.endsWith('분'),
        secondsVisible: false, rightOffset: 5, barSpacing: period === '월' ? 8 : 6,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    })
    rightScaleWidthRef.current = Math.max(56, chart.priceScale('right', 0).width())

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ff5c69', downColor: '#397ff5', wickUpColor: '#ff7a84',
      wickDownColor: '#5c99ff', borderUpColor: '#ff5c69', borderDownColor: '#397ff5',
      priceLineColor: '#758ca9',
    })
    candleSeries.setData(data.map(({ volume, ...candle }) => candle))

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
      borderColor: '#1d334d',
      scaleMargins: { top: 0.12, bottom: 0.05 },
    })
    volumeSeries.setData(data.map((item) => ({
      time: item.time, value: item.volume,
      color: item.close >= item.open ? 'rgba(255,92,105,.42)' : 'rgba(57,127,245,.42)',
    })))

    const enabled = new Map(indicators.map((config) => [config.id, config]))
    const maConfig = enabled.get('ma')
    if (maConfig) {
      const movingAverage = maConfig.type === 'EMA' ? calculateEma : calculateSma
      const shortPeriod = Math.max(1, Number(maConfig.shortPeriod ?? maConfig.period) || 5)
      const longPeriod = Math.max(shortPeriod + 1, Number(maConfig.longPeriod) || 20)
      const common = { lineWidth: 2, priceLineVisible: false, lastValueVisible: false }
      const shortSeries = chart.addSeries(LineSeries, { ...common, color: maConfig.shortColor || maConfig.color || '#f4c542' })
      const longSeries = chart.addSeries(LineSeries, { ...common, color: maConfig.longColor || '#4b86ff' })
      shortSeries.setData(movingAverage(data, shortPeriod))
      longSeries.setData(movingAverage(data, longPeriod))
    }

    const bollingerConfig = enabled.get('bollinger')
    if (bollingerConfig) {
      const bands = calculateBollinger(data, Math.max(1, Number(bollingerConfig.period) || 20), Math.max(0.1, Number(bollingerConfig.multiplier) || 2))
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
      series.setData(calculateSma(data, Math.max(1, Number(volumeMaConfig.period) || 20), 'volume'))
    }

    let nextPane = 2
    const rsiConfig = enabled.get('rsi')
    if (rsiConfig) {
      const rsiValues = calculateRsi(data, Math.max(1, Number(rsiConfig.period) || 14))
      const series = chart.addSeries(LineSeries, {
        color: rsiConfig.color, lineWidth: 2, priceScaleId: 'right',
        priceFormat: { type: 'custom', formatter: (value) => value.toFixed(1), minMove: 0.1 },
        priceLineVisible: false, lastValueVisible: false,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, nextPane)
      series.setData(rsiValues)
      series.createPriceLine({ price: Number(rsiConfig.upper), color: rsiConfig.upperColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, axisLabelColor: '#0c1a2b', axisLabelTextColor: rsiConfig.upperColor, title: '' })
      series.createPriceLine({ price: Number(rsiConfig.lower), color: rsiConfig.lowerColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, axisLabelColor: '#0c1a2b', axisLabelTextColor: rsiConfig.lowerColor, title: '' })
      const currentRsi = rsiValues.at(-1)?.value
      if (Number.isFinite(currentRsi)) series.createPriceLine({ price: currentRsi, color: rsiConfig.color, lineVisible: false, axisLabelVisible: true, axisLabelColor: '#0c1a2b', axisLabelTextColor: rsiConfig.color, title: '' })
      nextPane += 1
    }

    const macdConfig = enabled.get('macd')
    if (macdConfig) {
      const fast = Math.max(1, Number(macdConfig.fast) || 12)
      const slow = Math.max(fast + 1, Number(macdConfig.slow) || 26)
      const signalPeriod = Math.max(1, Number(macdConfig.signal) || 9)
      const values = calculateMacd(data, fast, slow, signalPeriod)
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
    chart.panes().slice(1).forEach((pane) => pane.getHTMLElement()?.classList.add('atlas-chart-pane-divider'))
    const volumePaneElement = chart.panes()[1]?.getHTMLElement()
    const volumeLegendElement = document.createElement('div')
    const volumeLegendValue = document.createElement('b')
    volumeLegendElement.className = 'tv-volume-legend'
    volumeLegendElement.append('거래량 ', volumeLegendValue)
    volumeLegendValue.textContent = formatVolume(data.at(-1)?.volume)
    volumePaneElement?.append(volumeLegendElement)
    chart.timeScale().fitContent()
    const scaleWidthFrame = requestAnimationFrame(() => {
      rightScaleWidthRef.current = Math.max(56, chart.priceScale('right', 0).width())
    })
    chart.subscribeCrosshairMove((param) => {
      const point = param.seriesData.get(candleSeries)
      const volumePoint = param.seriesData.get(volumeSeries)
      const fallback = data.at(-1)
      const nextLegend = point?.open ? { ...point, volume: volumePoint?.value ?? fallback.volume } : fallback
      setLegend(nextLegend)
      volumeLegendValue.textContent = formatVolume(nextLegend.volume)
    })

    let previousContainerWidth = container.clientWidth
    let previousContainerHeight = container.clientHeight
    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width)
      const height = Math.floor(entry.contentRect.height)
      if (width === previousContainerWidth && height === previousContainerHeight) return
      const panes = chart.panes()
      const previousLastPaneHeight = panes.at(-1)?.getHeight() ?? 90
      chart.resize(width, height)
      rightScaleWidthRef.current = Math.max(56, chart.priceScale('right', 0).width())
      if (manualBottomResizeRef.current && panes.length > 2) {
        panes.at(-1)?.setHeight(Math.max(90, previousLastPaneHeight + height - previousContainerHeight))
        manualBottomResizeRef.current = false
      }
      previousContainerWidth = width
      previousContainerHeight = height
    })
    resizeObserver.observe(container)
    let captureEnabled = false
    const paneResizeObservers = chart.panes().map((pane) => {
      const observer = new ResizeObserver(() => { if (captureEnabled) capturePaneLayouts() })
      const element = pane.getHTMLElement()
      if (element) observer.observe(element)
      return observer
    })
    const captureFrame = requestAnimationFrame(() => { captureEnabled = true })
    document.addEventListener('pointerup', capturePaneLayouts)

    return () => {
      capturePaneLayouts()
      cancelAnimationFrame(captureFrame)
      cancelAnimationFrame(scaleWidthFrame)
      paneResizeObservers.forEach((observer) => observer.disconnect())
      document.removeEventListener('pointerup', capturePaneLayouts)
      resizeObserver.disconnect()
      volumeLegendElement.remove()
      chart.remove()
    }
  }, [data, period, indicatorKey])

  if (!stock) return <div className="chart-empty"/>
  if (loading) return <div className="chart-empty"><span className="loading-ring"/></div>
  if (data.length === 0) return <div className="chart-empty"/>

  return (
    <div className="tv-chart-root" onWheelCapture={(event) => {
      const root = event.currentTarget
      const bounds = root.getBoundingClientRect()
      const isRightScale = event.clientX >= bounds.right - rightScaleWidthRef.current
      if (!isRightScale || root.scrollHeight <= root.clientHeight) return
      event.preventDefault()
      event.stopPropagation()
      root.scrollTop += event.deltaY
    }}>
      {legend && <div className="tv-legend"><span>시 <b>{won(legend.open)}</b></span><span>고 <b className="up">{won(legend.high)}</b></span><span>저 <b className="down">{won(legend.low)}</b></span><span>종 <b>{won(legend.close)}</b></span></div>}
      {indicators.length > 0 && <div className="tv-indicator-badges">{indicators.map((config) => <span key={config.id}>{indicatorDisplayName(config)}</span>)}</div>}
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
