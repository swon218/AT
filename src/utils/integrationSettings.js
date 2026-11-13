import {BROKERS} from './brokers.js'

export const CREDENTIAL_MAX_LENGTH = 4096
export const brokerCredentialFields = broker => [broker === 'toss' ? 'tossApiKey' : `${broker}AppKey`, `${broker}SecretKey`]
export const emptyBrokerCredentials = () => Object.fromEntries(BROKERS.flatMap(({id}) => brokerCredentialFields(id)).map(field => [field, '']))
export const savedBrokerStatus = value => Object.fromEntries(BROKERS.map(({id}) => [`${id}Configured`, value?.[`${id}Configured`] === true]))

export function brokerSettingsState(broker, status, credentials, clearBrokers = []) {
  const deletion = clearBrokers.includes(broker)
  return {
    saved: status?.[`${broker}Configured`] === true,
    dirty: deletion || brokerCredentialFields(broker).some(field => Boolean(credentials[field]?.trim())),
    deletion,
  }
}

// Submit only editable broker fields. Hidden integrations are omitted, never reset.
export function brokerSettingsPayload(credentials, clearBrokers = []) {
  const clear = BROKERS.map(broker => broker.id).filter(id => clearBrokers.includes(id))
  const fields = BROKERS.filter(({id}) => !clear.includes(id)).flatMap(({id}) => brokerCredentialFields(id))
  return {...Object.fromEntries(fields.map(field => [field, credentials[field]?.trim() || '']).filter(([,value]) => value)), clearBrokers: clear}
}

export function brokerSettingsInputError(credentials, status, clearBrokers = []) {
  for (const {id, shortName} of BROKERS) {
    if (clearBrokers.includes(id)) continue
    const values = brokerCredentialFields(id).map(field => credentials[field]?.trim() || '')
    if (values.some(value => value.length > CREDENTIAL_MAX_LENGTH)) return `${shortName} API 정보는 항목당 ${CREDENTIAL_MAX_LENGTH}자 이하로 입력해 주세요.`
    if (values.some(Boolean) && !status?.[`${id}Configured`] && !values.every(Boolean)) return `${shortName} API 정보 두 항목을 모두 입력해 주세요.`
  }
  return ''
}
