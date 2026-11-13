import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'
import { decryptCredentials, encryptCredentials } from './credentialCrypto.js'
import { invalidateCredentials } from './credentialInvalidation.js'

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

const brokerFields = { kiwoom: ['kiwoomAppKey','kiwoomSecretKey'], toss: ['tossApiKey','tossSecretKey'], nh: ['nhAppKey','nhSecretKey'], kb: ['kbAppKey','kbSecretKey'] }
const brokers = Object.keys(brokerFields)
const versionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const settingsError = (code, message, statusCode = 409) => Object.assign(new Error(message), {code, statusCode, safeSettingsError: true})
const conflict = () => settingsError('settings_conflict','설정이 변경되었습니다. 최신 상태를 다시 불러온 후 시도해 주세요.')

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
    nhConfigured: Boolean(row?.nh_configured),
    kbConfigured: Boolean(row?.kb_configured),
    telegramConfigured: Boolean(row?.telegram_configured),
  }
}

function storedBrokers(credentials) {
  return Object.fromEntries(brokers.map(broker => [broker, brokerFields[broker].some(field => Boolean(credentials[field]))]))
}
function displayStatus(row, credentials) {
  return {...configuredStatus(row), settingsVersion: row?.settings_version ?? null, brokerStored: storedBrokers(credentials)}
}
async function readStored(user, client) {
  let result
  try {
    result = await client.from('user_integrations')
      .select('credentials_ciphertext,credentials_iv,credentials_auth_tag,kiwoom_configured,toss_configured,nh_configured,kb_configured,telegram_configured,settings_version')
      .eq('user_id', user.id).maybeSingle()
  } catch { throw settingsError('settings_unavailable','저장 상태를 확인하지 못했습니다. 다시 시도해 주세요.',503) }
  if (result.error) throw settingsError('settings_unavailable','저장 상태를 확인하지 못했습니다. 서버 업데이트 상태를 확인한 후 다시 시도해 주세요.',503)
  const row = result.data
  if (row && !versionPattern.test(row.settings_version ?? '')) throw settingsError('settings_unavailable','개인설정 업데이트가 필요합니다. 잠시 후 상태를 다시 확인해 주세요.',503)
  let credentials = {}
  if (row) {
    try { credentials = decryptCredentials(user.id,{ciphertext:row.credentials_ciphertext,iv:row.credentials_iv,authTag:row.credentials_auth_tag}) }
    catch { throw settingsError('settings_unavailable','저장된 보안 정보를 확인하지 못했습니다. 관리자에게 문의해 주세요.',503) }
  }
  return {row,credentials}
}
function expectedVersion(input) {
  if (!Object.hasOwn(input,'expectedVersion') || input.expectedVersion !== null && !versionPattern.test(input.expectedVersion ?? '')) throw conflict()
  return input.expectedVersion
}
function checkVersion(row, expected) {
  if ((row?.settings_version ?? null) !== expected) throw conflict()
}
async function commitStored(user, client, credentials, expected, changed, invalidate) {
  let encrypted
  try { encrypted = encryptCredentials(user.id,credentials) }
  catch { throw settingsError('settings_unavailable','보안 정보를 저장할 수 없습니다. 관리자에게 문의해 주세요.',503) }
  const row={credentials_ciphertext:encrypted.ciphertext,credentials_iv:encrypted.iv,credentials_auth_tag:encrypted.authTag,
    ...Object.fromEntries(brokers.map(broker=>[`${broker}_configured`,brokerFields[broker].every(field=>Boolean(credentials[field]))])),telegram_configured:Boolean(credentials.telegramBotToken)}
  let result
  try { result = await client.rpc('atlas_broker_credentials_cas',{p_user_id:user.id,p_expected_version:expected,p_row:row}) }
  catch { invalidate(user.id,changed); throw settingsError('settings_result_unknown','저장 결과를 확인하지 못했습니다. 상태를 다시 조회해 주세요.',504) }
  if (result.error) {
    if (result.error.code === '40001') throw conflict()
    invalidate(user.id,changed)
    throw settingsError('settings_unavailable','설정을 저장하지 못했습니다. 상태를 다시 확인한 후 시도해 주세요.',503)
  }
  const version = result.data?.version
  // Even an ambiguous response must not leave a stale connection success alive.
  invalidate(user.id,changed)
  if (!versionPattern.test(version ?? '')) throw settingsError('settings_result_unknown','저장 결과를 확인하지 못했습니다. 상태를 다시 조회해 주세요.',504)
  return displayStatus({...row,settings_version:version},credentials)
}

export async function getAccountSettings(request, { client = adminClient, authenticate = authenticateAccountRequest } = {}) {
  const user=await authenticate(request), {row,credentials}=await readStored(user,client)
  return displayStatus(row,credentials)
}

export async function updateAccountSettings(request, { client = adminClient, authenticate = authenticateAccountRequest, invalidate = invalidateCredentials } = {}) {
  const user = await authenticate(request)
  const input = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
  const expected = expectedVersion(input)
  if (input.clearBrokers?.length || input.telegramBotToken?.trim?.()) throw settingsError('separate_delete_required','키 삭제는 증권사별 삭제 확인을 통해 진행해 주세요.',400)
  const {row,credentials}=await readStored(user,client)
  checkVersion(row,expected)
  const stored=storedBrokers(credentials), replacements={}, changed=[]
  for (const broker of brokers) {
    const values=brokerFields[broker].map(field=>{
      const value=input[field]
      if (value !== undefined && typeof value !== 'string') throw settingsError('invalid_credentials','API 정보를 문자열로 입력해 주세요.',400)
      return value?.trim() || ''
    })
    if (!values.some(Boolean)) continue
    if (stored[broker]) throw settingsError('credentials_already_saved','기존 API 키를 삭제한 후 다시 등록해 주세요.')
    if (!values.every(Boolean)) throw settingsError('credentials_pair_required','해당 증권사의 API 정보 두 항목을 모두 입력해 주세요.',400)
    if (values.some(value=>value.length>4096)) throw settingsError('credentials_too_long','API 정보는 항목당 4096자 이하로 입력해 주세요.',400)
    brokerFields[broker].forEach((field,index)=>{replacements[field]=values[index]})
    changed.push(broker)
  }
  if (!changed.length) throw settingsError('credentials_required','등록할 API 정보를 입력해 주세요.',400)
  return commitStored(user,client,{...credentials,...replacements},expected,changed,invalidate)
}

export async function deleteAccountBroker(request, { client = adminClient, authenticate = authenticateAccountRequest, invalidate = invalidateCredentials } = {}) {
  const user=await authenticate(request), broker=request.params?.broker
  if (!brokers.includes(broker)) throw settingsError('invalid_broker','증권사를 확인해 주세요.',400)
  const expected=expectedVersion(request.body||{}), {row,credentials}=await readStored(user,client)
  checkVersion(row,expected)
  if (!storedBrokers(credentials)[broker]) return displayStatus(row,credentials)
  const next={...credentials}
  for (const field of brokerFields[broker]) delete next[field]
  return commitStored(user,client,next,expected,[broker],invalidate)
}

export function registerAccountSettingsRoutes(app,dependencies) {
  for(const [method,path,handler] of [['get','/api/account/settings',getAccountSettings],['put','/api/account/settings',updateAccountSettings],['delete','/api/account/settings/:broker',deleteAccountBroker]]){
    app[method](path,{logLevel:'silent',onRequest:async(request,reply)=>{
      if(!/^Bearer\s+\S+$/i.test(request.headers.authorization||''))return reply.header('Cache-Control','private, no-store').code(401).send({code:'authentication_required',error:'로그인이 필요합니다.'})
    },errorHandler(error,_request,reply){
      reply.header('Cache-Control','private, no-store')
      return reply.code(error.statusCode===413?413:400).send({code:'invalid_settings_request',error:'설정 요청 형식을 확인해 주세요.'})
    }},async(request,reply)=>{
      reply.header('Cache-Control','private, no-store')
      try{return await handler(request,dependencies)}
      catch(error){
        const status=error.safeSettingsError?error.statusCode:[401,403].includes(error.statusCode)?error.statusCode:503
        return reply.code(status).send({code:error.safeSettingsError?error.code:status===401?'authentication_required':'settings_unavailable',error:error.safeSettingsError?error.message:status===401?'로그인이 필요합니다.':'설정 요청을 처리하지 못했습니다. 상태를 다시 확인해 주세요.'})
      }
    })
  }
}

export async function getAuthenticatedCredentials(request, { client = adminClient, authenticate = authenticateAccountRequest } = {}) {
  const user = await authenticate(request)
  const { data, error } = await client
    .from('user_integrations')
    .select('credentials_ciphertext,credentials_iv,credentials_auth_tag,kiwoom_configured,toss_configured,nh_configured,kb_configured,telegram_configured')
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
