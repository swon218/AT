import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyBrokerCredentials,savedBrokerStatus,brokerSettingsState,brokerSettingsPayload,brokerSettingsInputError,CREDENTIAL_MAX_LENGTH} from '../src/utils/integrationSettings.js'

test('saved state is server metadata only; typing and deletion remain explicitly unsaved',()=>{
  const fields={...emptyBrokerCredentials(),kiwoomAppKey:'invalid-fixture-key',kiwoomSecretKey:'invalid-fixture-secret'}
  const initial=savedBrokerStatus()
  assert.deepEqual(brokerSettingsState('kiwoom',initial,fields),{saved:false,dirty:true,deletion:false})
  const stored=savedBrokerStatus({kiwoomConfigured:true,kiwoomConnected:false,telegramConfigured:true})
  assert.deepEqual(brokerSettingsState('kiwoom',stored,emptyBrokerCredentials()),{saved:true,dirty:false,deletion:false})
  assert.deepEqual(brokerSettingsState('kiwoom',stored,fields),{saved:true,dirty:true,deletion:false})
  assert.deepEqual(brokerSettingsState('kiwoom',stored,fields,['kiwoom']),{saved:true,dirty:true,deletion:true})
  assert.equal(savedBrokerStatus({kiwoomConfigured:false}).kiwoomConfigured,false)
  assert.equal(savedBrokerStatus({kiwoomConfigured:'true'}).kiwoomConfigured,false)
  assert.ok(!Object.hasOwn(stored,'telegramConfigured'))
})
test('editable payload omits hidden integrations and empty inputs rather than replacing them',()=>{
  const fields={...emptyBrokerCredentials(),telegramBotToken:'hidden-must-not-submit',nhAppKey:'  new-key ',nhSecretKey:'new-secret'}
  assert.deepEqual(brokerSettingsPayload(fields),{nhAppKey:'new-key',nhSecretKey:'new-secret',clearBrokers:[]})
  assert.deepEqual(brokerSettingsPayload(fields,['nh','telegram']),{clearBrokers:['nh']})
  assert.deepEqual(brokerSettingsPayload(emptyBrokerCredentials()),{clearBrokers:[]})
})
test('first save needs both editable fields; stored pairs allow one-field replacement; length checks do not authenticate keys',()=>{
  const fields={...emptyBrokerCredentials(),tossApiKey:'invalid-fixture'}
  assert.match(brokerSettingsInputError(fields,savedBrokerStatus()),/두 항목/)
  assert.equal(brokerSettingsInputError(fields,savedBrokerStatus({tossConfigured:true})), '')
  assert.equal(brokerSettingsInputError({...fields,tossSecretKey:'also-invalid'},savedBrokerStatus()),'')
  assert.match(brokerSettingsInputError({...fields,tossApiKey:'x'.repeat(CREDENTIAL_MAX_LENGTH+1)},savedBrokerStatus({tossConfigured:true})),/4096/)
  assert.equal(brokerSettingsInputError(fields,savedBrokerStatus(),['toss']),'')
})
