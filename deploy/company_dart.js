import { config } from '../server/config.js'
import { configuredCompanyDart } from '../server/companyDart.js'
import { createDartClient, DartError } from '../server/dartClient.js'
import { dateInKorea, normalizeAccounts, normalizeFiling, selectReports } from '../server/dartData.js'

async function run([command, argument]) {
  if (command === 'probe') {
    // One representative public company; no Supabase writes or ZIP download.
    const dart = createDartClient({ key: config.openDartKey, reserve: async () => true })
    const corp = '00126380'
    const profile = await dart('company.json', { corp_code: corp })
    const list = await dart('list.json', { corp_code: corp, pblntf_detail_ty: 'A001', page_count: 10,
      bgn_de: dateInKorea(-550).replaceAll('-', ''), end_de: dateInKorea().replaceAll('-', ''), last_reprt_at: 'Y' })
    const reports = selectReports((list?.list || []).map(item => normalizeFiling(item, corp)), Number(profile?.acc_mt))
    const report = reports[0]
    if (!profile?.corp_name || !report) throw new DartError('dart_probe_data_unavailable')
    const payload = await dart('fnlttSinglAcntAll.json', { corp_code: corp, fs_div: 'CFS',
      bsns_year: report.fiscalYear, reprt_code: report.reportCode })
    const accounts = normalizeAccounts(payload, report, corp, 'CFS')
    if (!accounts.length) throw new DartError('dart_probe_data_unavailable')
    return { profile: 'ok', filings: 'ok', statements: 'ok', reportPeriod: report.periodEnd, recognizedAccounts: accounts.length }
  }
  const dart = configuredCompanyDart()
  if (command === 'sync-codes') return { refreshed: await dart.syncCodes() }
  if (command === 'refresh') {
    const limit = Number(argument ?? 4)
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new DartError('dart_invalid_limit')
    const result = await dart.refresh(limit)
    if (result.errors.length) process.exitCode = 1
    return result
  }
  if (command === 'verify' && /^[0-9][0-9A-Z]{5}$/.test(argument ?? '')) {
    const first = await dart.read(argument, {})
    await dart.drain()
    const second = await dart.read(argument, {})
    await dart.drain()
    const third = await configuredCompanyDart().read(argument, {})
    if (second.status !== 'ready' || third.status !== 'ready' || third.checkedAt !== second.checkedAt || !third.data?.company) {
      throw new DartError(second.error || 'dart_verification_incomplete')
    }
    return { first: first.status, saved: second.status, reused: third.status, checkedAt: third.checkedAt }
  }
  throw new DartError('usage: sync-codes | refresh [1..12] | verify SYMBOL | probe')
}

try { console.log(JSON.stringify(await run(process.argv.slice(2)))) }
catch (error) {
  console.error(error instanceof DartError ? error.code : 'dart_command_failed')
  process.exitCode = 1
}
