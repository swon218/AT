import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'

export const alertError = (code, statusCode) => Object.assign(new Error(code), { statusCode })

export function createAlertStore(settings = config) {
  const db = settings.supabaseUrl && settings.supabaseSecretKey
    ? createClient(settings.supabaseUrl, settings.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }) : null
  return async (action, p = {}) => {
    if (!db) throw alertError('alert_unavailable', 503)
    const { data, error } = await db.rpc('atlas_alert_rpc', { action, p }).abortSignal(AbortSignal.timeout(7000))
    if (!error) return data
    const code = ['alert_dispatch_in_progress', 'alert_kakao_required', 'alert_watchlist_required', 'alert_expired', 'alert_invalid']
      .find(value => value === error.message)
    throw alertError(code ?? 'alert_unavailable', !code ? 503 : code === 'alert_invalid' ? 400 : 409)
  }
}

export function alertSettings(settings = config) {
  let historyUrl = null
  try {
    const origin = new URL(settings.frontendOrigin)
    if (origin.protocol === 'https:' && origin.origin === settings.frontendOrigin) {
      historyUrl = new URL('/?agent=alerts#alert-history', origin).href
    }
  } catch { /* The approved domain must be explicitly configured. */ }
  const dailyLimit = Number(process.env.ATLAS_ALERT_DAILY_LIMIT || '50')
  const consent = process.env.ATLAS_ALERT_CONSENT_ENABLED === 'true'
  const marketApproved = process.env.ATLAS_ALERT_MARKET_APPROVED === 'true'
  const messageApproved = process.env.ATLAS_ALERT_KAKAO_APPROVED === 'true'
  const credentials = { appKey: process.env.ATLAS_ALERT_KIWOOM_APP_KEY, secretKey: process.env.ATLAS_ALERT_KIWOOM_SECRET_KEY }
  const enabled = Boolean(marketApproved && messageApproved && consent && historyUrl && credentials.appKey && credentials.secretKey
    && settings.kiwoomHost === 'https://api.kiwoom.com' && settings.kakaoRestKey && settings.kakaoClientSecret
    && settings.kakaoAdminKey && settings.credentialEncryptionKey && settings.supabaseUrl && settings.supabaseSecretKey
    && Number.isInteger(dailyLimit) && dailyLimit >= 1 && dailyLimit <= 1000
    && process.env.ATLAS_ALERT_WORKER_ENABLED === 'true')
  return { enabled, consent, credentials, dailyLimit, historyUrl }
}
