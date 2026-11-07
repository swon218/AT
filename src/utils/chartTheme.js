import { getTheme, subscribeTheme } from '../services/theme.js'

export function chartPalette(theme = getTheme(), kind = 'trading') {
  if (theme === 'light') return {
    background: '#ffffff', text: '#526984', grid: '#e4ebf4', border: '#cfd9e7',
    separator: '#b0c0d4', separatorHover: '#245fc5', crosshair: '#778ba5', label: '#405f85',
    up: '#c6324a', down: '#245fc5', wickUp: '#c6324a', wickDown: '#245fc5', price: '#526984',
  }
  return kind === 'index' ? {
    background: '#071d2d', text: '#87a8c6', grid: '#102e42', border: '#17354b',
    separator: '#17354b', separatorHover: '#2e6080', crosshair: '#6585a4', label: '#18374e',
    up: '#ff455d', down: '#369bff', price: '#60798f',
  } : {
    background: '#0c1a2b', text: '#70849e', grid: '#152941', border: '#1d334d',
    separator: '#607895', separatorHover: 'rgba(75, 134, 255, .88)', crosshair: '#4d6787', label: '#315f9c',
    up: '#ff5c69', down: '#397ff5', wickUp: '#ff7a84', wickDown: '#5c99ff', price: '#758ca9',
  }
}

export function chartThemeOptions(palette) {
  return {
    layout: { background: { type: 'solid', color: palette.background }, textColor: palette.text,
      panes: { separatorColor: palette.separator, separatorHoverColor: palette.separatorHover } },
    grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
    crosshair: { vertLine: { color: palette.crosshair, labelBackgroundColor: palette.label }, horzLine: { color: palette.crosshair, labelBackgroundColor: palette.label } },
    rightPriceScale: { borderColor: palette.border }, timeScale: { borderColor: palette.border },
  }
}

// Subscribes once per live chart and never changes data, ranges, or network state.
export function bindChartTheme(chart, updateSeries, { kind = 'trading', get = getTheme, subscribe = subscribeTheme } = {}) {
  const update = () => {
    const palette = chartPalette(get(), kind)
    chart.applyOptions(chartThemeOptions(palette))
    chart.panes().forEach((_, index) => chart.priceScale('right', index).applyOptions({ borderColor: palette.border }))
    updateSeries?.(palette)
  }
  update()
  return subscribe(update)
}
