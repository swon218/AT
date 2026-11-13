import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyBrokerCredentials,savedBrokerStatus,brokerIsStored,brokerSettingsState,brokerSettingsPayload,brokerSettingsInputError,reconcileBrokerDrafts,CREDENTIAL_MAX_LENGTH} from '../src/utils/integrationSettings.js'

const version = '11111111-1111-4111-8111-111111111111'
const snapshot = (extra={}) => savedBrokerStatus({settingsVersion:null,brokerStored:{kiwoom:false,toss:false,nh:false,kb:false},...extra})

test('typing never becomes saved; complete server metadata restores a saved lock independently of connection',()=>{
  const draft={...emptyBrokerCredentials(),kiwoomAppKey:'invalid-fixture-key',kiwoomSecretKey:'invalid-fixture-secret'}
  const initial=snapshot()
  assert.equal(initial.lifecycleReady,true)
  assert.deepEqual(brokerSettingsState('kiwoom',initial,draft),{saved:false,stored:false,dirty:true})
  const stored=snapshot({settingsVersion:version,kiwoomConfigured:true,kiwoomConnected:false,brokerStored:{kiwoom:true,toss:false,nh:false,kb:false}})
  assert.deepEqual(brokerSettingsState('kiwoom',stored,draft),{saved:true,stored:true,dirty:false})
  assert.deepEqual(reconcileBrokerDrafts(draft,stored),emptyBrokerCredentials())
  assert.equal(brokerSettingsInputError(draft,stored),'키움 기존 API 키를 삭제한 후 다시 등록해 주세요.')
})

test('legacy or malformed status stays fail-closed; a legacy partial pair remains locked and deletable',()=>{
  for(const status of [savedBrokerStatus(),savedBrokerStatus({kiwoomConfigured:true}),savedBrokerStatus({settingsVersion:'not-a-version',brokerStored:{kiwoom:false,toss:false,nh:false,kb:false}}),savedBrokerStatus({settingsVersion:version})])assert.equal(status.lifecycleReady,false)
  const legacy=savedBrokerStatus({kiwoomConfigured:true})
  assert.equal(brokerIsStored('kiwoom',legacy),true)
  const partial=snapshot({settingsVersion:version,brokerStored:{kiwoom:false,toss:false,nh:true,kb:false}})
  assert.deepEqual(brokerSettingsState('nh',partial,emptyBrokerCredentials()),{saved:false,stored:true,dirty:false})
  assert.equal(partial.lifecycleReady,true)
})

test('registration payload omits locked and hidden values and cannot emit the legacy deletion field',()=>{
  const status=snapshot({settingsVersion:version,kiwoomConfigured:true,brokerStored:{kiwoom:true,toss:false,nh:false,kb:false}})
  const fields={...emptyBrokerCredentials(),kiwoomAppKey:'stale-must-not-submit',telegramBotToken:'hidden-must-not-submit',nhAppKey:' new-key ',nhSecretKey:'new-secret',clearBrokers:['kiwoom']}
  assert.deepEqual(brokerSettingsPayload(fields,status),{nhAppKey:'new-key',nhSecretKey:'new-secret',expectedVersion:version})
  assert.deepEqual(brokerSettingsPayload(emptyBrokerCredentials(),snapshot()),{expectedVersion:null})
  assert.ok(!Object.hasOwn(savedBrokerStatus({telegramConfigured:true}),'telegramConfigured'))
})

test('new registration requires both fields and safe lengths but deliberately does not authenticate fixture keys',()=>{
  const fields={...emptyBrokerCredentials(),tossApiKey:'invalid-fixture'}
  assert.match(brokerSettingsInputError(fields,snapshot()),/두 항목/)
  assert.equal(brokerSettingsInputError({...fields,tossSecretKey:'also-invalid'},snapshot()),'')
  assert.match(brokerSettingsInputError({...fields,tossApiKey:'x'.repeat(CREDENTIAL_MAX_LENGTH+1)},snapshot()),/4096/)
})

test('delete reconciliation clears only its broker and newly stored brokers, preserving unrelated unsaved drafts',()=>{
  const fields={...emptyBrokerCredentials(),kiwoomAppKey:'old-fixture',kiwoomSecretKey:'old-fixture-secret',tossApiKey:'new-toss-fixture',nhAppKey:'new-nh-fixture'}
  const afterDelete=snapshot({settingsVersion:version})
  const reconciled=reconcileBrokerDrafts(fields,afterDelete,'kiwoom')
  assert.equal(reconciled.kiwoomAppKey,'');assert.equal(reconciled.kiwoomSecretKey,'')
  assert.equal(reconciled.tossApiKey,fields.tossApiKey);assert.equal(reconciled.nhAppKey,fields.nhAppKey)
  const otherTabSaved=snapshot({settingsVersion:version,tossConfigured:true,brokerStored:{kiwoom:false,toss:true,nh:false,kb:false}})
  assert.equal(reconcileBrokerDrafts(reconciled,otherTabSaved).tossApiKey,'')
  assert.equal(reconcileBrokerDrafts(reconciled,otherTabSaved).nhAppKey,fields.nhAppKey)
  assert.equal(brokerSettingsState('kiwoom',afterDelete,reconciled).stored,false)
})
