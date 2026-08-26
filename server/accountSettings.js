import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'
import { decryptCredentials, encryptCredentials } from './credentialCrypto.js'

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
}

const authClient = config.supabaseUrl && config.supabasePublishableKey
  ? createClient(config.supabaseUrl, config.supabasePublishableKey, clientOptions)
  : null

const adminClient = config.supabaseUrl && config.supabaseSecretKey
  ? createClient(config.supabaseUrl, config.supabaseSecretKey, clientOptions)
  : null

const credentialFields = [
  'kiwoomAppKey',
  'kiwoomSecretKey',
  'tossApiKey',
  'tossSecretKey',
  'telegramBotToken',
]

function ensureConfigured() {
  if (!authClient || !adminClient || !config.credentialEncryptionKey) {
    const error = new Error('VPS의 계정 보안 저장 기능이 아직 설정되지 않았습니다.')
    error.statusCode = 503
    throw error
  }
}

export async function authenticateAccountRequest(request) {
  ensureConfigured()
  const authorization = request.headers.authorization || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!token) {
    const error = new Error('로그인이 필요합니다.')
    error.statusCode = 401
    throw error
  }

  const { data, error: authError } = await authClient.auth.getUser(token)
  if (authError || !data.user) {
    const error = new Error('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.')
    error.statusCode = 401
    throw error
  }
  return data.user
}

function configuredStatus(row) {
  return {
    kiwoomConfigured: Boolean(row?.kiwoom_configured),
    tossConfigured: Boolean(row?.toss_configured),
    telegramConfigured: Boolean(row?.telegram_configured),
  }
}

export async function getAccountSettings(request) {
  const user = await authenticateAccountRequest(request)
  const { data, error } = await adminClient
    .from('user_integrations')
    .select('kiwoom_configured,toss_configured,telegram_configured')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) throw error
  return configuredStatus(data)
}

export async function updateAccountSettings(request) {
  const user = await authenticateAccountRequest(request)
  const input = request.body && typeof request.body === 'object' ? request.body : {}
  const replacements = Object.fromEntries(
    credentialFields
      .map((field) => [field, typeof input[field] === 'string' ? input[field].trim() : ''])
      .filter(([, value]) => value),
  )

  if (Object.keys(replacements).length === 0) {
    const error = new Error('저장할 API 키 또는 토큰을 입력해 주세요.')
    error.statusCode = 400
    throw error
  }

  const { data: existing, error: readError } = await adminClient
    .from('user_integrations')
    .select('credentials_ciphertext,credentials_iv,credentials_auth_tag')
    .eq('user_id', user.id)
    .maybeSingle()
  if (readError) throw readError

  const currentCredentials = existing
    ? decryptCredentials(user.id, {
        ciphertext: existing.credentials_ciphertext,
        iv: existing.credentials_iv,
        authTag: existing.credentials_auth_tag,
      })
    : {}
  const credentials = { ...currentCredentials, ...replacements }
  const encrypted = encryptCredentials(user.id, credentials)
  const row = {
    user_id: user.id,
    credentials_ciphertext: encrypted.ciphertext,
    credentials_iv: encrypted.iv,
    credentials_auth_tag: encrypted.authTag,
    kiwoom_configured: Boolean(credentials.kiwoomAppKey && credentials.kiwoomSecretKey),
    toss_configured: Boolean(credentials.tossApiKey && credentials.tossSecretKey),
    telegram_configured: Boolean(credentials.telegramBotToken),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await adminClient
    .from('user_integrations')
    .upsert(row, { onConflict: 'user_id' })
    .select('kiwoom_configured,toss_configured,telegram_configured')
    .single()
  if (error) throw error

  return configuredStatus(data)
}

export async function getAuthenticatedCredentials(request) {
  const user = await authenticateAccountRequest(request)
  const { data, error } = await adminClient
    .from('user_integrations')
    .select('credentials_ciphertext,credentials_iv,credentials_auth_tag,kiwoom_configured,toss_configured,telegram_configured')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) throw error
  if (!data) return { user, credentials: {}, status: configuredStatus(null) }

  const credentials = decryptCredentials(user.id, {
    ciphertext: data.credentials_ciphertext,
    iv: data.credentials_iv,
    authTag: data.credentials_auth_tag,
  })
  return { user, credentials, status: configuredStatus(data) }
}
