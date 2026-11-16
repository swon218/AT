import {credentialVersion,digest,personalAuth} from './personalBroker.js'

// Common authentication boundary only. Order identifiers, response parsers and
// exchange contracts belong to the individual broker adapters.
export const tradingCredentialVersion=(account,broker,auth=personalAuth(account,broker))=>
  digest([credentialVersion(account,broker,auth),account.tradingCredentialEpochs?.[broker]??account.tradingCredentialEpoch??null])
