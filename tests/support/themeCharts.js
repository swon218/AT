import { createChart as createActualChart } from 'lightweight-charts'
export * from 'lightweight-charts'
let created = 0, removed = 0, updates = 0
const live = new Map()
export function createChart(container, options) {
  const chart = createActualChart(container, options), id = ++created
  container.dataset.chartInstance = String(id)
  live.set(id, chart)
  const apply = chart.applyOptions.bind(chart), remove = chart.remove.bind(chart)
  chart.applyOptions = options => { updates++; apply(options) }
  chart.remove = () => { removed++; live.delete(id); remove() }
  return chart
}
export function chartReport() {
  return { created, removed, updates, live: [...live].map(([id, chart]) => ({ id,
    range: chart.timeScale().getVisibleLogicalRange(), background: chart.options().layout.background.color,
    text: chart.options().layout.textColor, grid: chart.options().grid.vertLines.color, panes: chart.panes().length,
  })) }
}
export function zoomFixtureCharts() { for (const chart of live.values()) chart.timeScale().setVisibleLogicalRange({ from: 40, to: 85 }) }
