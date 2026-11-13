import {BROKERS} from './brokers.js'

export const CREDENTIAL_MAX_LENGTH = 4096
export const brokerCredentialFields = broker => [broker === 'toss' ? 'tossApiKey' : `${broker}AppKey`, `${broker}SecretKey`]
export const emptyBrokerCredentials = () => Object.fromEntries(BROKERS.flatMap(({id}) => brokerCredentialFields(id)).map(field => [field, '']))
const versionPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
export function savedBrokerStatus(value) {
  const configured = Object.fromEntries(BROKERS.map(({id}) => [`${id}Configured`, value?.[`${id}Configured`] === true]))
  const brokerStored = Object.fromEntries(BROKERS.map(({id}) => [id, value?.brokerStored?.[id] === true || configured[`${id}Configured`]]))
  const hasVersion = value && Object.hasOwn(value, 'settingsVersion') && (value.settingsVersion === null || versionPattern.test(value.settingsVersion))
  const lifecycleReady = Boolean(hasVersion && BROKERS.every(({id}) => typeof value?.brokerStored?.[id] === 'boolean'))
  return {...configured, brokerStored, settingsVersion: hasVersion ? value.settingsVersion : null, lifecycleReady}
}
export const brokerIsStored = (broker, status) => status?.brokerStored?.[broker] === true || status?.[`${broker}Configured`] === true

export function brokerSettingsState(broker, status, credentials) {
  const stored = brokerIsStored(broker, status)
  return {
    saved: status?.[`${broker}Configured`] === true,
    stored,
    dirty: !stored && brokerCredentialFields(broker).some(field => Boolean(credentials[field]?.trim())),
  }
}

// Submit only editable broker fields. Hidden integrations are omitted, never reset.
export function brokerSettingsPayload(credentials, status) {
  const fields = BROKERS.filter(({id}) => !brokerIsStored(id, status)).flatMap(({id}) => brokerCredentialFields(id))
  return {...Object.fromEntries(fields.map(field => [field, credentials[field]?.trim() || '']).filter(([,value]) => value)), expectedVersion: status.settingsVersion}
}

export function brokerSettingsInputError(credentials, status) {
  for (const {id, shortName} of BROKERS) {
    const values = brokerCredentialFields(id).map(field => credentials[field]?.trim() || '')
    if (values.some(Boolean) && brokerIsStored(id, status)) return `${shortName} 기존 API 키를 삭제한 후 다시 등록해 주세요.`
    if (values.some(value => value.length > CREDENTIAL_MAX_LENGTH)) return `${shortName} API 정보는 항목당 ${CREDENTIAL_MAX_LENGTH}자 이하로 입력해 주세요.`
    if (values.some(Boolean) && !values.every(Boolean)) return `${shortName} API 정보 두 항목을 모두 입력해 주세요.`
  }
  return ''
}

export function reconcileBrokerDrafts(credentials, status, clearBroker) {
  const next = {...credentials}
  for (const {id} of BROKERS) if (id === clearBroker || brokerIsStored(id, status)) for (const field of brokerCredentialFields(id)) next[field] = ''
  return next
}
