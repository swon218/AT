import test from 'node:test'
import assert from 'node:assert/strict'
import {tradingCredentialVersion} from './tradingBrokerCommon.js'
test('per-broker registration epochs preserve legacy active keys and isolate unrelated key mutations',()=>{
 const account={user:{id:'fixture-owner'},credentials:{kiwoomAppKey:'fixture-k',kiwoomSecretKey:'fixture-s',tossApiKey:'fixture-t',tossSecretKey:'fixture-ts'},status:{kiwoomConfigured:true,tossConfigured:true},tradingCredentialEpoch:'legacy-epoch'}
 const original=tradingCredentialVersion(account,'kiwoom')
 const migrated={...account,tradingCredentialEpochs:{kiwoom:'legacy-epoch',toss:'legacy-epoch'}}
 assert.equal(tradingCredentialVersion(migrated,'kiwoom'),original)
 const tossChanged={...migrated,tradingCredentialEpoch:'new-global',tradingCredentialEpochs:{...migrated.tradingCredentialEpochs,toss:'toss-generation-2'}}
 assert.equal(tradingCredentialVersion(tossChanged,'kiwoom'),original)
 assert.notEqual(tradingCredentialVersion(tossChanged,'toss'),tradingCredentialVersion(migrated,'toss'))
 const reRegistered={...tossChanged,tradingCredentialEpochs:{...tossChanged.tradingCredentialEpochs,kiwoom:'kiwoom-generation-2'}}
 assert.notEqual(tradingCredentialVersion(reRegistered,'kiwoom'),original)
})
