import assert from 'node:assert/strict'
import test from 'node:test'
import { readLabKiwoom } from './labKiwoom.js'

const raw = (dt, overrides = {}) => ({
  dt, open_pric: '+100', high_pric: '+110', low_pric: '-90', cur_prc: '+105', trde_qty: '2,000', ...overrides,
})
const source = 'KIWOOM:KA10081:ADJUSTED:SOR'

test('daily worker requests adjusted SOR with a bounded read-only continuation', async () => {
  const requests = []
  const result = await readLabKiwoom('0126Z0', '2026-10-28', '2026-10-30', source, async definition => {
    requests.push(definition)
    const first = requests.length === 1
    return {
      body: { stk_dt_pole_chart_qry: first ? [raw('20261030'), raw('20261029')] : [raw('20261029'), raw('20261028')] },
      contYn: 'Y', nextKey: first ? 'page2' : 'page3',
    }
  })
  assert.deepEqual(result.map(r => r.date), ['2026-10-28', '2026-10-29', '2026-10-30'])
  assert.deepEqual(result[0], { date: '2026-10-28', open: 100, high: 110, low: 90, close: 105, volume: 2000 })
  assert.deepEqual(requests.map(r => [r.apiId, r.endpoint, r.contYn, r.nextKey]), [
    ['ka10081', '/api/dostk/chart', 'N', ''], ['ka10081', '/api/dostk/chart', 'Y', 'page2'],
  ])
  assert.deepEqual(requests[0].body, { stk_cd: '0126Z0_AL', base_dt: '20261030', upd_stkpc_tp: '1' })
})

test('malformed volume and invalid code are rejected before prices can be published', async () => {
  await assert.rejects(readLabKiwoom('005930', '2026-10-30', '2026-10-30', source, async () =>
    ({ body: { stk_dt_pole_chart_qry: [raw('20261030', { trde_qty: '' })] } })), /Invalid daily history value/)
  await assert.rejects(readLabKiwoom('005930_AL', '2026-10-30', '2026-10-30', source), /Invalid daily history request/)
})
