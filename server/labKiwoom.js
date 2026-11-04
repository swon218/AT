import { pathToFileURL } from 'node:url'
import { requestKiwoom } from './kiwoomClient.js'

export async function readLabKiwoom(code, start, end, source, request = requestKiwoom) {
  if (!/^[0-9][0-9A-Z]{5}$/.test(code) || ![start, end].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day)) || start > end
    || !['KIWOOM:KA10081:ADJUSTED:KRX', 'KIWOOM:KA10081:ADJUSTED:SOR'].includes(source)) {
    throw new Error('Invalid daily history request')
  }
  const rows = new Map()
  const seen = new Set()
  const stk_cd = source.endsWith(':SOR') ? code + '_AL' : code
  const number = (value, signedPrice) => {
    const input = String(value ?? '').trim().replaceAll(',', '')
    if (!/^[+-]?\d+(\.\d+)?$/.test(input) || !Number.isFinite(Number(input)) || (!signedPrice && Number(input) < 0)) {
      throw new Error('Invalid daily history value')
    }
    return signedPrice ? Math.abs(Number(input)) : Number(input)
  }
  let nextKey = ''
  for (let page = 0; page < 20; page++) {
    const result = await request({ apiId: 'ka10081', endpoint: '/api/dostk/chart', timeoutMs: 12_000,
      body: { stk_cd, base_dt: end.replaceAll('-', ''), upd_stkpc_tp: '1' },
      returnPage: true, contYn: nextKey ? 'Y' : 'N', nextKey })
    const data = result.body.stk_dt_pole_chart_qry
    if (!Array.isArray(data)) throw new Error('Missing daily history list')
    let reachedStart = false
    for (const raw of data) {
      const dt = String(raw.dt)
      if (!/^\d{8}$/.test(dt)) throw new Error('Invalid daily history date')
      const date = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6)}`
      if (date <= start) reachedStart = true
      if (date < start || date > end) continue
      const row = { date, open: number(raw.open_pric, true), high: number(raw.high_pric, true),
        low: number(raw.low_pric, true), close: number(raw.cur_prc, true), volume: number(raw.trde_qty, false) }
      if (rows.has(date) && JSON.stringify(row) !== JSON.stringify(rows.get(date))) throw new Error('Conflicting daily history pages')
      rows.set(date, row)
    }
    if (reachedStart || result.contYn !== 'Y') return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date))
    nextKey = result.nextKey
    if (!nextKey || seen.has(nextKey) || !data.length) throw new Error('Daily history cursor did not advance')
    seen.add(nextKey)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('Daily history page limit exceeded')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await readLabKiwoom(...process.argv.slice(2)))) }
  catch { console.error('Kiwoom daily history request failed'); process.exitCode = 1 }
}
