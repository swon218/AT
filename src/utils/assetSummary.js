import { BROKERS } from './brokers.js'

export const ASSET_METRICS = [
  { key: 'estimatedAssets', label: '총 자산' },
  { key: 'totalEvaluationProfit', label: '평가손익' },
  { key: 'orderableAmount', label: '주문가능금액' },
]

export const hasAmount = value => typeof value === 'number' && Number.isFinite(value)

export function toggleAssetBroker(selected, broker) {
  if (!BROKERS.some(item => item.id === broker)) return selected
  if (!selected.includes(broker)) return [...selected, broker]
  return selected.length > 1 ? selected.filter(id => id !== broker) : selected
}

export function summarizeAssets(selected, accounts) {
  const ready = BROKERS.filter(({ id }) => selected.includes(id) && accounts[id]?.status === 'ready')
  const metrics = Object.fromEntries(ASSET_METRICS.map(({ key }) => {
    const values = ready.map(({ id }) => accounts[id].summary[key]).filter(hasAmount)
    return [key, { value: values.length ? values.reduce((total, value) => total + value, 0) : null, count: values.length }]
  }))
  const holdings = ready.flatMap(({ id }) => (accounts[id].summary.holdings || []).map(item => ({ ...item, broker: id })))
  return { metrics, holdings, readyCount: ready.length }
}
