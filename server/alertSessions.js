import { readFile } from 'node:fs/promises'
import { alertCode, koreanAlertDay } from '../shared/alertRules.js'

export async function readAlertAfterMarket(date, filename = process.env.ATLAS_ALERT_NXT_SESSIONS_FILE) {
  if (!filename) return null
  try {
    // The operator supplies the officially checked window and eligible symbols for each date.
    const entry = JSON.parse(await readFile(filename, 'utf8'))?.[date]
    const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)
    if (!time(entry?.start) || !time(entry.end) || entry.start >= entry.end || !Array.isArray(entry.symbols)
      || !entry.symbols.length || !entry.symbols.every(code => typeof code === 'string' && alertCode.test(code))) return null
    return { date, market: 'NXT', phase: 'after', open: `${date}T${entry.start}+09:00`, close: `${date}T${entry.end}+09:00`,
      symbols: [...new Set(entry.symbols)] }
  } catch { return null }
}

export function activeAlertSession(session, at) {
  return session?.date === koreanAlertDay(at) && !session.closed && session.previous < session.date
    && Date.parse(session.open) <= at && at < Date.parse(session.close)
}

export function selectAlertSession(regular, after, at) {
  if (activeAlertSession(regular, at)) return { ...regular, market: 'KRX', phase: 'regular' }
  if (!regular || regular.closed || after?.date !== regular.date || !(Date.parse(after.open) >= Date.parse(regular.close))) return null
  const session = { ...after, previous: regular.previous }
  return activeAlertSession(session, at) ? session : null
}
