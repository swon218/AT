import assert from 'node:assert/strict'
import test from 'node:test'
import { BROKERS } from '../src/utils/brokers.js'
import { summarizeAssets, toggleAssetBroker } from '../src/utils/assetSummary.js'

const ready = (estimatedAssets, profit = 0, orderableAmount = 0) => ({ status: 'ready', summary: { estimatedAssets, totalEvaluationProfit: profit, orderableAmount, holdings: [{ code: '005930', name: '삼성전자', quantity: 1 }] } })

test('all 15 nonempty broker selections show only selected balances and keep duplicate stocks separate', () => {
  const ids = BROKERS.map(({ id }) => id)
  const accounts = Object.fromEntries(ids.map((id, index) => [id, ready((index + 1) * 100, (index - 2) * 10, (index + 1) * 20)]))
  for (let mask = 1; mask < 16; mask++) {
    const selected = ids.filter((_, index) => mask & (1 << index))
    const result = summarizeAssets(selected, accounts)
    for (const key of ['estimatedAssets', 'totalEvaluationProfit', 'orderableAmount']) {
      assert.deepEqual(result.metrics[key], { value: selected.reduce((sum, id) => sum + accounts[id].summary[key], 0), count: selected.length })
    }
    assert.equal(result.readyCount, selected.length)
    assert.deepEqual(result.holdings.map(item => item.broker), selected)
    assert.equal(result.holdings.length, selected.length)
  }
})

test('failed, pending, unconnected and account-required summaries are never included', () => {
  for (const status of ['guest', 'unconfigured', 'loading', 'error', 'accountRequired']) {
    const result = summarizeAssets(['kiwoom', 'nh'], { kiwoom: ready(100, -20), nh: { ...ready(999), status } })
    assert.deepEqual(result.metrics.estimatedAssets, { value: 100, count: 1 })
    assert.deepEqual(result.metrics.totalEvaluationProfit, { value: -20, count: 1 })
    assert.equal(result.holdings.length, 1)
  }
  assert.deepEqual(summarizeAssets(['kb'], {}).metrics.estimatedAssets, { value: null, count: 0 })
})

test('missing amounts stay unknown, true zero is valid, and each metric has its own completeness', () => {
  const result = summarizeAssets(['kiwoom', 'toss', 'nh', 'kb'], { kiwoom: ready(0, 0, 0), toss: ready(100, -10, 20), nh: ready(null, null, null), kb: ready(NaN, Infinity, null) })
  assert.deepEqual(result.metrics.estimatedAssets, { value: 100, count: 2 })
  assert.deepEqual(result.metrics.totalEvaluationProfit, { value: -10, count: 2 })
  assert.deepEqual(result.metrics.orderableAmount, { value: 20, count: 2 })
  assert.deepEqual(summarizeAssets(['nh'], { nh: ready(null, null, null) }).metrics.orderableAmount, { value: null, count: 0 })
  assert.deepEqual(summarizeAssets(['kiwoom'], { kiwoom: ready(0) }).metrics.estimatedAssets, { value: 0, count: 1 })
})

test('broker toggles allow 1 to 4 selections and never deselect the last broker', () => {
  let selected = BROKERS.map(({ id }) => id)
  for (const id of ['kiwoom', 'toss', 'nh']) selected = toggleAssetBroker(selected, id)
  assert.deepEqual(selected, ['kb'])
  assert.deepEqual(toggleAssetBroker(selected, 'kb'), ['kb'])
  for (const id of ['nh', 'toss', 'kiwoom']) selected = toggleAssetBroker(selected, id)
  assert.equal(selected.length, 4)
  assert.deepEqual(toggleAssetBroker(selected, 'unknown'), selected)
})
